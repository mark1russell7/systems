import { describe, expect, it } from "vitest";
import type { Cell, KernelRecord, MiddleboxEvent, ProbeEvent, Run } from "./cell.ts";
import { endpointAfter, routesOf, templated, toxicBody } from "./lab.ts";
import { measure, socketOf } from "./observe.ts";
import { judge } from "./run.ts";
import { verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const CLIENT = 4026532620;
const TARGET = 4026532468;
const HOP = 4026532543;
const LOCAL = "172.21.0.3:38828";
const T = 34_484_658_806_857;
const topology = {
  targetPeer: "172.22.0.3",
  hops: { nat: { netns: HOP, client: "172.21.0.3", target: "172.22.0.2:6379" } },
};
const ROUTER: Cell = {
  name: "T03 reset-both",
  target: { image: "redis:7.4", port: 6379, ready: "Ready to accept connections" },
  sysctls: {},
  probe: { mode: "idle", keepalive: true },
  fault: "middlebox-forget",
  topology: { name: "T03", hops: [{ name: "nat", kind: "router", form: "reset-both", idle: s(5) }] },
  prediction: {
    detects: true,
    timer: "expire_established",
    errno: "ECONNRESET",
    from: "last-received",
    low: s(5),
    high: s(5.09),
  },
  runs: 11,
  environments: 2,
};
const k = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord => ({
  ev,
  mono,
  cookie: 11,
  netns: CLIENT,
  src: LOCAL,
  dst: "172.22.0.2:6379",
  err: 0,
  ...more,
});
const events: ProbeEvent[] = [
  { ev: "connected", t: T - 2_000_000, local: LOCAL },
  { ev: "sent", t: T - 1_500_000 },
  { ev: "ready", t: T, reply: "+PONG\r\n" },
];
const run = (more: Partial<Run>): Run => ({
  environment: 0,
  index: 0,
  events,
  fault: null,
  kernel: [],
  netns: CLIENT,
  targetNetns: TARGET,
  lost: 0,
  topology,
  ...more,
});
const destroy: MiddleboxEvent = {
  ev: "ct",
  t: T + 5_049_700_000,
  type: "DESTROY",
  state: "ESTABLISHED",
  orig: `${LOCAL}>172.22.0.2:6379`,
  hop: "nat",
};

describe("a run in a topology, measured from the records of each namespace", () => {
  it("times a reset at the forget from the last segment, and records when the router forgot", () => {
    const kernel = [k("rx", T - 50_000), k("rst_rx", T + 5_049_900_000), k("error", T + 5_050_000_000, { err: 104 })];
    const read = measure(ROUTER, run({ kernel, middlebox: [destroy] }));
    expect(read).toMatchObject({
      outcome: { kind: "error", errno: "ECONNRESET" },
      elapsed: s(5.05005),
      forgot: s(5.04975),
      bytes: 0,
      void: null,
      finding: null,
    });
    // a slow listing of the router near the detection breaks the bound of the lag
    const slow: MiddleboxEvent = { ev: "pump-slow", t: T + 4_990_000_000, took: 0.0312, hop: "nat" };
    expect(measure(ROUTER, run({ kernel, middlebox: [destroy, slow] })).void).toBe(
      "a listing of the router took 31.2 ms, longer than the bound of its prediction",
    );
    // a slow listing that ended before the expiry cannot delay the DESTROY
    const early: MiddleboxEvent = { ...slow, t: T + 3_000_000_000 };
    expect(measure(ROUTER, run({ kernel, middlebox: [destroy, early] })).void).toBeNull();
  });

  it("finds a forget in the window of a silent cell, though nothing detected it", () => {
    const silent: Cell = { ...ROUTER, prediction: { detects: false, window: s(15) } };
    const kernel = [k("rx", T - 50_000)];
    expect(measure(silent, run({ kernel })).finding).toBeNull();
    expect(measure(silent, run({ kernel, middlebox: [destroy] })).finding).toBe(
      "a router forgot the flow 5.04975 s after the last segment, where it should keep it",
    );
  });

  it("finds the socket of the target by the address of the last hop, and only the one that the run opened", () => {
    const server: Cell = { ...ROUTER, observer: "server" };
    const kernel = [
      // redis-cli in the namespace of the target: not the peer of the run
      k("state", T - 3_000_000, { netns: TARGET, cookie: 5, src: "127.0.0.1:6379", dst: "127.0.0.1:40000", old: 3, new: 1 }),
      k("state", T - 1_900_000, { netns: TARGET, cookie: 7, src: "172.22.0.2:6379", dst: "172.22.0.3:38828", old: 3, new: 1 }),
    ];
    expect(socketOf(server, run({ kernel }))).toEqual({ netns: TARGET, cookie: 7 });
    // a hop toward the target: the socket that the run connected, not one of the run before it
    const hop: Cell = { ...ROUTER, observer: { hop: "nat", toward: "target" } };
    const proxied = [
      k("destroy", T - 5_000_000, { netns: HOP, cookie: 3, src: "172.22.0.3:41000", dst: "172.22.0.2:6379" }),
      k("state", T - 1_800_000, { netns: HOP, cookie: 9, src: "172.22.0.3:41002", dst: "172.22.0.2:6379", old: 2, new: 1 }),
    ];
    expect(socketOf(hop, run({ kernel: proxied }))).toEqual({ netns: HOP, cookie: 9 });
    expect(socketOf({ ...ROUTER, observer: { hop: "nat", toward: "client" } }, run({ kernel: proxied }))).toBeUndefined();
  });

  it("times a reply from the first segment with data: a proxy can acknowledge the request first", () => {
    const sent = T + 300_000_000;
    const replies: Cell = {
      ...ROUTER,
      probe: { mode: "inflight", keepalive: false },
      fault: "toxic",
      prediction: { detects: false, window: s(2), replies: { low: s(0.1), high: s(0.101) } },
    };
    const kernel = [
      k("rx", T - 50_000),
      k("rx", sent + 40_100_000, { seg: { seq: 9, len: { value: 0, unit: "B" } } }),
      k("rx", sent + 100_400_000, { seg: { seq: 9, len: { value: 7, unit: "B" } } }),
    ];
    const read = measure(
      replies,
      run({
        events: [...events, { ev: "sent", t: sent }, { ev: "data", t: sent + 100_500_000, n: 7 }],
        kernel,
        fault: { t0: T + 100e6, t1: T + 101e6 },
      }),
    );
    expect(read).toMatchObject({ outcome: { kind: "answered" }, elapsed: s(0.1004), bytes: 7, void: null });
    expect(verdictOf(replies.prediction, [read])).toMatchObject({ decision: "holds" });
    // no data at all: the reply never came
    expect(measure(replies, run({ events: [...events, { ev: "sent", t: sent }], kernel: kernel.slice(0, 2), fault: { t0: T + 100e6, t1: T + 101e6 } })).finding).toBe(
      "the reply never came",
    );
  });

  it("times a toxic from the start of its commit, and voids a run whose commit took longer than the noise", () => {
    const timeout: Cell = {
      ...ROUTER,
      fault: "toxic",
      prediction: { detects: true, timer: "toxic timeout", errno: "EOF", from: "fault", low: s(2), high: s(2.001) },
    };
    const kernel = [k("rx", T - 50_000), k("state", T + 2_101_500_000, { old: 1, new: 8 })];
    const at = (commit: number) =>
      measure(timeout, run({ kernel, events: [...events, { ev: "eof", t: T + 2_101_600_000 }], fault: { t0: T + 100e6, t1: T + 100e6 + commit } }));
    expect(at(1e6)).toMatchObject({ outcome: { kind: "eof" }, elapsed: s(2.0015), void: null });
    expect(at(13.3e6).void).toBe("the commit of the fault took 13.3 ms, longer than the noise of the pipeline: its start is not known");
  });

  it("measures a cell with no band from its reference, and judges no warm-up run", () => {
    const only: Cell = {
      ...ROUTER,
      fault: "proxy-idle",
      prediction: { detects: null, window: s(10), why: "no machine document", from: "last-received" },
    };
    const kernel = [k("rx", T - 50_000), k("state", T + 5_003_000_000, { old: 1, new: 8 })];
    const read = measure(only, run({ kernel, events: [...events, { ev: "eof", t: T + 5_003_100_000 }] }));
    expect(read).toMatchObject({ outcome: { kind: "eof" }, elapsed: s(5.00305), void: null });
    expect(verdictOf(only.prediction, [read])).toMatchObject({
      decision: "measured",
      median: s(5.00305),
      why: "1 runs measured: 1 eof; median 5.00305 s from last-received, range [5.00305, 5.00305] s. no machine document",
    });
    const warm: Run = { ...run({ kernel: [] }), warmup: true };
    expect(judge(only, [run({ kernel, events: [...events, { ev: "eof", t: T + 5_003_100_000 }] }), warm]).measured).toHaveLength(1);
  });
});

describe("the chain of a topology", () => {
  it("routes the networks after each router through it, and finds the endpoint after each element", () => {
    const router = { kind: "router" } as const;
    const proxy = { kind: "proxy" } as const;
    // client → router → target: the client reaches network 1 through element 1
    expect(routesOf([router])).toEqual([{ from: 0, via: 1, networks: [1] }]);
    // client → proxy → router → target: the proxy reaches network 2 through the router
    expect(routesOf([proxy, router])).toEqual([{ from: 1, via: 2, networks: [2] }]);
    expect(routesOf([router, router])).toEqual([
      { from: 0, via: 1, networks: [1, 2] },
      { from: 1, via: 2, networks: [2] },
    ]);
    expect(endpointAfter([router], 0)).toBe(2);
    expect(endpointAfter([proxy, router], 0)).toBe(1);
    expect(endpointAfter([proxy, router], 1)).toBe(3);
    expect(endpointAfter([], 0)).toBe(1);
  });

  it("writes the next hop into the files of a proxy, and a toxic as the API of Toxiproxy takes it", () => {
    expect(templated("server redis {{next}}\nupstream {{next}}", "172.22.0.2:6379")).toBe(
      "server redis 172.22.0.2:6379\nupstream 172.22.0.2:6379",
    );
    expect(JSON.parse(toxicBody({ type: "latency", stream: "downstream", attributes: { latency: 100, jitter: 0 } }))).toEqual({
      name: "fault",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: 100, jitter: 0 },
    });
  });
});
