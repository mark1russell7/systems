import type { Machine } from "@mark1russell7/automata";
import { machineSchema } from "@mark1russell7/automata/schema";

/**
 * This document is one call of a program on a socket of Linux TCP: a deadline for each try, and a
 * retry after each deadline. It is a generic client that the program configures, as the
 * `RetryAgent` of undici is configured with its options. No system sets its knobs, thus no knob has
 * a default.
 *
 * - The deadline of a try is `timeout`. A timeout of 0 turns the deadline off, and the call waits
 *   for a layer below.
 * - After a deadline, the program waits `backoff`, and the wait doubles at each retry up to
 *   `backoff_cap`. This backoff has no jitter.
 * - The `retry` timer gives the time from the send of one try to the send of the next. Thus the sum of
 *   its first n waits is the start of try n + 1.
 * - The count of retries is the count of firings of `retry`. The caller gives it.
 */
export const DEADLINE_CALL: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "deadline-call",
  title: "One call of a program, with a deadline and retries after a capped exponential backoff",
  layer: "self",
  version: "1",
  sources: [
    {
      ref: "a deadline for each try, and retries after a backoff min(backoff × 2^n, cap), as a program configures them. The undici-retry-agent document of this package has the same backoff, min(minTimeout × timeoutFactor^n, maxTimeout)",
      rung: "derived",
    },
  ],
  states: {
    POOLED: { initial: true, note: "the connection waits in the pool, and no call is open" },
    WAITING: { note: "the request is sent, and the call waits for the reply" },
    DONE: { final: true },
    FAILED: { final: true },
  },
  events: {
    "app.send": { kind: "app" },
    "rx.reply": { kind: "rx" },
    "timer.deadline": { kind: "timer" },
    "timer.retry": { kind: "timer" },
    "socket.end": { kind: "local", note: "the socket below ends, with its errno" },
  },
  knobs: {
    timeout: { key: "the deadline of one try", scope: "call", unit: "ms", default: null, off: 0, note: "the program sets it. 0 turns it off" },
    backoff: { key: "the first wait between two tries", scope: "call", unit: "ms", default: null, note: "the program sets it" },
    backoff_cap: { key: "the longest wait between two tries", scope: "call", unit: "ms", default: null, note: "the program sets it" },
  },
  timers: {
    deadline: { duration: { knob: "timeout", unit: "ms" }, arms: ["enter:WAITING"], cancels: ["rx.reply"], fires: "timer.deadline" },
    retry: {
      duration: { expr: "timeout + min(backoff * pow(2, fired), backoff_cap)", unit: "ms" },
      arms: ["timer.deadline"],
      cancels: ["rx.reply"],
      fires: "timer.retry",
      backoff: { resets: ["enter:WAITING"] },
      note: "the time from the send of one try to the send of the next: its deadline, then the wait",
    },
  },
  over: { machine: "systems.machine.linux-tcp", states: { POOLED: "ESTABLISHED", WAITING: "ESTABLISHED" }, sets: {}, ends: "socket.end" },
  transitions: [
    { id: "dc.send", from: "POOLED", to: "WAITING", on: "app.send" },
    { id: "dc.reply", from: "WAITING", to: "DONE", on: "rx.reply" },
    { id: "dc.deadline", from: "WAITING", to: "FAILED", on: "timer.deadline", errno: "ETIMEDOUT" },
    { id: "dc.end", from: ["POOLED", "WAITING"], to: "FAILED", on: "socket.end" },
  ],
});
