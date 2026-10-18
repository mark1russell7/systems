import { describe, expect, it } from "vitest";
import type { Cell, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import { latestEndOf } from "./cell.ts";
import { measure } from "./observe.ts";

const s = (value: number) => ({ value, unit: "s" });
const NETNS = 4026532601;
const LOCAL = "172.22.0.3:40122";
const T = 400_000_000_000_000;
const at = (seconds: number) => T + Math.round(seconds * 1e9);

/** An idle connection of a pool behind a black hole: the keepalive of the pool checks it at a phase from its creation. */
const KEEPALIVE: Cell = {
  name: "T01.defaults.52 hikaricp-pgjdbc to postgresql, blackhole, idle: the keepalive of the pool",
  target: { image: "postgres:17.11", port: 5432, ready: "listening" },
  sysctls: {},
  probe: { mode: "idle", keepalive: false, driver: { name: "hikari" } },
  fault: "blackhole",
  prediction: { detects: true, timer: "validation_timeout", errno: "CLOSED", from: "first-sent", low: s(5), high: s(5.01), startsBy: s(120.2) },
  runs: 11,
  environments: 2,
};

const k = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord => ({
  ev,
  mono,
  cookie: 5124,
  netns: NETNS,
  src: LOCAL,
  dst: "172.22.0.2:5432",
  err: 0,
  ...more,
});
const data = (len: number) => ({ seg: { seq: 1, len: { value: len, unit: "B" } } });
const run = (kernel: KernelRecord[]): Run => ({
  environment: 0,
  index: 0,
  events: [
    { ev: "connecting", t: at(-1.3) },
    { ev: "sent", t: at(-1.3), n: 1 },
    { ev: "socket", t: at(-1.2), role: "pool", local: LOCAL },
    { ev: "connected", t: at(-1.2), local: LOCAL },
    { ev: "ack", t: at(-1.1), n: 1 },
    { ev: "ready", t: at(-1.1), reply: "ack" },
    { ev: "error", t: at(105.006), errno: "CLOSED", local: LOCAL },
  ] satisfies ProbeEvent[],
  fault: { t0: at(0), t1: at(0.001) },
  kernel,
  netns: NETNS,
  targetNetns: NETNS + 1,
  lost: 0,
});

describe("a band from the first segment with data that a socket sends after the fault", () => {
  it("times the close of an idle connection from the empty query of the keepalive of its pool", () => {
    const kernel = [
      k("rx", at(-1.1), data(64)),
      // the keepalive comes 100 s after the fault: its empty query, then its retransmissions
      k("tx", at(100), data(6)),
      k("retrans", at(100.201), { why: "tlp", ...data(6) }),
      k("retrans", at(100.402), { why: "rto", ...data(6) }),
      // the read timeout of 5 s: pgjdbc closes the socket, ESTABLISHED to FIN_WAIT1
      k("state", at(105.004), { old: 1, new: 4 }),
    ];
    const read = measure(KEEPALIVE, run(kernel));
    expect(read).toMatchObject({ elapsed: s(5.004), void: null, finding: null });
  });

  it("waits for the latest reference: the run lasts up to the keepalive and its band", () => {
    if (KEEPALIVE.prediction.detects !== true) throw new Error("a detection");
    expect(latestEndOf(KEEPALIVE.prediction)).toBeCloseTo(125.21, 6);
  });
});
