import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { NODE_TIMER_EARLY, nodeTimerLateness } from "./timers.ts";

const AT = "undici 8.12.2 lib/handler/retry-handler.js";

/**
 * This document is one request through a `RetryAgent` of undici 8.12.2: the retries of a reply
 * whose status is retryable, for example 429 or 503. Each fact comes from the published package at
 * 8.12.2, with the file and the line. The defaults are 5 retries, a backoff from 500 ms with a factor
 * of 2, a cap of 30 s, and Retry-After read.
 *
 * - The delay of a retry is the Retry-After of the reply, capped by `maxTimeout`. A Retry-After
 *   longer than the cap does not stop the retries: the retry comes early. A reply without
 *   Retry-After gets the backoff, with no jitter.
 * - The agent gives up after `maxRetries` retries. The caller then gets `RequestRetryError`, with
 *   the status of the last reply. Thus the retry window of the caller is the sum of the delays.
 * - A POST and a PATCH are not retried.
 * - The delay is a native Node timer. It arms after the parse of the whole reply, thus it comes after
 *   the last segment by the handling time of the program. No source bounds that time, and this
 *   document does not hold it. The cells add it from a calibration (`HANDLING` in
 *   `packages/cells/src/http/race.ts`).
 *
 * The plain `Client` and `fetch` of undici, and the `fetch` of Node 24.21.0 (undici 7.29.1), send no
 * request again for a status. Their retry window is 0.
 */
export const UNDICI_RETRY: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "undici-retry-agent",
  title: "One request through a RetryAgent of undici 8.12.2",
  layer: "driver",
  version: "8.12.2",
  conditions: { undici: "8.12.2", node: "24.21.0", throwOnError: "true" },
  sources: [
    {
      ref: `${AT}:125-133 the defaults: retryAfter true, maxTimeout 30000, minTimeout 500, timeoutFactor 2, maxRetries 5, the methods GET HEAD OPTIONS PUT DELETE TRACE QUERY, the statusCodes 500 502 503 504 429`,
      rung: "implemented",
    },
    { ref: "undici 8.12.2 lib/dispatcher/retry-agent.js:18-27: a RetryAgent wraps a dispatcher with a RetryHandler", rung: "implemented" },
    {
      ref: `${AT}:331-351 the policy: a method or a status out of its lists is not retried, and a counter above maxRetries gives up`,
      rung: "implemented",
    },
    {
      ref: `${AT}:353-370 the delay: Retry-After in seconds times 1000, or an HTTP-date less the clock of the client (:13-16), capped by maxTimeout; 0 at once; else min(minTimeout * timeoutFactor^(counter - 1), maxTimeout); then setTimeout`,
      rung: "implemented",
    },
    { ref: `${AT}:380 the counter: one more at each reply`, rung: "implemented" },
    {
      ref: `${AT}:175-192 and :518-535 a retryable status with throwOnError drops the body of the reply, and the error goes to the policy`,
      rung: "implemented",
    },
    { ref: "undici 8.12.2 lib/core/errors.js:362-371 RequestRetryError: code UND_ERR_REQ_RETRY, statusCode, headers, data.count", rung: "implemented" },
    { ref: "RFC 9110 §10.2.3: Retry-After, as delay-seconds or an HTTP-date", rung: "normative" },
  ],
  states: {
    IDLE: { initial: true, pseudo: true },
    SENT: { note: "a send of the request waits for its reply" },
    WAITING: { note: "the delay of a retry: the Retry-After of the reply, or the backoff" },
    DONE: { final: true, note: "a reply whose status is not retryable goes to the caller" },
    FAILED: { final: true, note: "RequestRetryError (UND_ERR_REQ_RETRY), with the status of the last reply" },
  },
  events: {
    "req.dispatch": { kind: "app" },
    "rx.retryable": { kind: "rx", note: "a reply with a status of statusCodes, for example 429 with Retry-After" },
    "rx.final": { kind: "rx", note: "a reply with another status, for example 200" },
    "timer.retry": { kind: "timer" },
  },
  knobs: {
    maxRetries: { key: "undici RetryAgent maxRetries", scope: "client", unit: "count", default: 5 },
    minTimeout: { key: "undici RetryAgent minTimeout", scope: "client", unit: "ms", default: 500 },
    maxTimeout: { key: "undici RetryAgent maxTimeout", scope: "client", unit: "ms", default: 30000 },
    timeoutFactor: { key: "undici RetryAgent timeoutFactor", scope: "client", unit: "count", default: 2 },
    retry_after: {
      key: "Retry-After of the reply, in seconds",
      scope: "reply",
      unit: "s",
      default: null,
      note: "the server gives it. An HTTP-date counts on the clock of the client",
    },
    hz: {
      key: "CONFIG_HZ",
      scope: "global",
      unit: "Hz",
      default: null,
      note: "the HZ of the kernel, for the step of the coarse loop clock of libuv (timers.ts)",
    },
  },
  timers: {
    retry_after: {
      duration: { expr: "min(retry_after * 1000, maxTimeout)", unit: "ms" },
      lateness: nodeTimerLateness("min(retry_after * 1000, maxTimeout)"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:WAITING"],
      cancels: ["req.dispatch"],
      fires: "timer.retry",
      note: "setTimeout(cb, retryTimeout) with the Retry-After of the reply. It arms after the parse of the whole reply",
    },
    backoff: {
      duration: { expr: "min(minTimeout * pow(timeoutFactor, fired), maxTimeout)", unit: "ms" },
      lateness: nodeTimerLateness("min(minTimeout * pow(timeoutFactor, fired), maxTimeout)"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:WAITING"],
      cancels: ["req.dispatch"],
      fires: "timer.retry",
      backoff: { resets: ["req.dispatch"] },
      note: "a reply without Retry-After: 0.5, 1, 2, 4 and 8 s at the defaults, with no jitter",
    },
  },
  transitions: [
    { id: "ur.send", from: "IDLE", to: "SENT", on: "req.dispatch" },
    {
      id: "ur.wait",
      from: "SENT",
      to: "WAITING",
      on: "rx.retryable",
      guard: "the count of replies is maxRetries or less, the method is in its list, and no part of the body went to the caller",
      source: "retry-handler.js:331-351, :380, :581-584",
    },
    {
      id: "ur.give-up",
      from: "SENT",
      to: "FAILED",
      on: "rx.retryable",
      guard: "the count of replies is above maxRetries, or the method is not in its list (POST, PATCH)",
      errno: "UND_ERR_REQ_RETRY",
      source: "retry-handler.js:331-335, :347-350, :430-436",
    },
    {
      id: "ur.retry-after",
      from: "WAITING",
      to: "SENT",
      on: "timer.retry",
      timer: "retry_after",
      guard: "the reply had a Retry-After of 0 or more",
      emits: ["tx.request"],
      source: "retry-handler.js:353-365, :370",
    },
    {
      id: "ur.backoff",
      from: "WAITING",
      to: "SENT",
      on: "timer.retry",
      timer: "backoff",
      guard: "the reply had no Retry-After, or one in the past, or one that does not parse",
      emits: ["tx.request"],
      source: "retry-handler.js:361-370",
    },
    { id: "ur.done", from: "SENT", to: "DONE", on: "rx.final", source: "retry-handler.js:373-383" },
  ],
});
