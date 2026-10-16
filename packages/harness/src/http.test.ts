import { describe, expect, it } from "vitest";
import type { Cell, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import { measure, requestOf } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const NETNS = 4026532583;
const LOCAL = "172.21.0.3:59222";
const T = 321_053_839_197_766;

/** A race of an HTTP client: a GET 6.5 s after the first reply, and the FIN of the server at S. */
const RACE: Cell = {
  name: "T01.defaults.77 go, a GET 6.5 s after the reply",
  target: { image: "node:24.21.0-alpine", port: 8080, ready: "listening", lines: true },
  sysctls: {},
  client: "go-http",
  probe: { mode: "gap", keepalive: false, http: { method: "GET", gap: s(6.5) } },
  fault: "none",
  prediction: {
    detects: true,
    timer: "keep_alive",
    errno: "EOF",
    from: "last-received",
    low: s(5.999),
    high: s(6.007),
    request: { connection: "new", retried: false, error: null },
  },
  runs: 11,
  environments: 2,
};

const k = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord => ({
  ev,
  mono,
  cookie: 2747400,
  netns: NETNS,
  src: LOCAL,
  dst: "172.21.0.2:8080",
  err: 0,
  ...more,
});
const run = (events: ProbeEvent[], kernel: KernelRecord[]): Run => ({
  environment: 0,
  index: 0,
  events,
  fault: null,
  kernel,
  netns: NETNS,
  targetNetns: NETNS + 1,
  lost: 0,
});
const first: ProbeEvent[] = [
  { ev: "conn", t: T - 2_100_000, n: 1, local: LOCAL },
  { ev: "connected", t: T - 2_000_000, local: LOCAL },
  { ev: "sent", t: T - 1_900_000, i: 1 },
  { ev: "request", t: T - 1_800_000, i: 1, local: LOCAL, reused: false },
  { ev: "response", t: T - 100_000, i: 1, status: 200 },
  { ev: "ready", t: T, reply: "200 OK" },
];
const reply = [k("rx", T - 1_400_000), k("rx", T - 50_000, { seg: { seq: 1, len: { value: 120, unit: "B" } } })];
const second = (reused: boolean, retry = false, error?: string): ProbeEvent[] => [
  { ev: "sent", t: T + 6_500_100_000, i: 2 },
  { ev: "request", t: T + 6_500_200_000, i: 2, local: reused ? LOCAL : "172.21.0.3:59224", reused },
  ...(retry ? [{ ev: "retry", t: T + 6_501_000_000, i: 2, local: "172.21.0.3:59226", reused: false }] : []),
  ...(error === undefined
    ? [
        { ev: "data", t: T + 6_502_000_000, i: 2, n: 3 },
        { ev: "replied", t: T + 6_502_000_000, i: 2, n: { value: 3, unit: "B" } },
      ]
    : [{ ev: "error", t: T + 6_502_000_000, i: 2, errno: error }]),
  { ev: "done", t: T + 6_502_100_000, i: 2 },
];

describe("an HTTP client measured against its cell", () => {
  it("reads the second request from the lines of the client: its connection, a retry, and its end", () => {
    expect(requestOf([...first, ...second(false)])).toEqual({
      connection: "new",
      retried: false,
      error: null,
      pending: false,
      gap: s(6.5001),
    });
    expect(requestOf([...first, ...second(true, true)])).toMatchObject({ connection: "reused", retried: true, error: null });
    expect(requestOf([...first, ...second(true, false, "EOF")])).toMatchObject({ connection: "reused", error: "EOF" });
    expect(requestOf(first)).toBeNull();
  });

  it("times the FIN of the server from the last segment of the first reply, in a gap", () => {
    const kernel = [...reply, k("state", T + 6_003_000_000, { old: 1, new: 8 })];
    const read = measure(RACE, run([...first, { ev: "eof", t: T + 6_003_100_000, local: LOCAL }, ...second(false)], kernel));
    expect(read).toMatchObject({ outcome: { kind: "eof" }, elapsed: s(6.00305), void: null, finding: null });
    expect(read.request).toMatchObject({ connection: "new", retried: false, error: null });
  });

  it("makes another outcome of the second request a finding", () => {
    const kernel = [...reply, k("state", T + 6_003_000_000, { old: 1, new: 8 })];
    const read = measure(RACE, run([...first, ...second(true, true)], kernel));
    expect(read.finding).toBe("the second request met: reused, a retry, a reply, not new, a reply");
    const verdict = verdictOf(RACE.prediction, [read]);
    expect(verdict.decision).toBe("fails");
    expect(verdict.requests).toEqual({ "reused, a retry, a reply": 1 });
  });

  it("times a close of the observer itself, when its pool closes an idle connection", () => {
    const dropped: Cell = {
      ...RACE,
      prediction: { ...RACE.prediction, timer: "idle_conn", errno: "CLOSED", low: s(5.5), high: s(5.5065) } as Cell["prediction"],
    };
    const kernel = [...reply, k("state", T + 5_501_000_000, { old: 1, new: 4 })];
    const read = measure(dropped, run([...first, { ev: "closed", t: T + 5_501_100_000, local: LOCAL }, ...second(false)], kernel));
    expect(read).toMatchObject({ outcome: { kind: "closed" }, elapsed: s(5.50105), void: null, finding: null });
  });

  it("keeps a kept connection silent from the first reply to the end of its window", () => {
    const kept: Cell = {
      ...RACE,
      probe: { ...RACE.probe, http: { method: "GET", gap: s(3) } },
      prediction: { detects: false, window: s(3.2), request: { connection: "reused", retried: false, error: null } },
    };
    const events = [...first, ...second(true)].map((event) => (event.t > T + 6e9 ? { ...event, t: event.t - 3_500_000_000 } : event));
    const read = measure(kept, run(events, reply));
    expect(read).toMatchObject({ outcome: { kind: "silent" }, finding: null, void: null });
    expect(verdictOf(kept.prediction, [read])).toMatchObject({ decision: "holds", requests: { "reused, a reply": 1 } });
  });
});
