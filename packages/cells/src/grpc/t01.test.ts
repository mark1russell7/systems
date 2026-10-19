import { describe, expect, it } from "vitest";
import { ETCD_SERVER, GRPC_GO_SERVER, GRPC_JS } from "@mark1russell7/machines";
import { RUNS } from "../catalog.ts";
import {
  ETCD_PORT,
  GRPC_HOLD,
  GRPC_PORT,
  GRPC_O17_RETRIES,
  GRPC_MIN_TIME,
  GRPC_ROUTER,
  POLICY_HOLD,
  SILENT_WINDOW,
  T01_GRPC,
  T01_GRPC_ARRAY_ALIASES,
  T01_GRPC_ARRAY_SPECS,
  T01_GRPC_ARRAY_WAITING,
  T01_GRPC_BORDER_SPECS,
  T01_GRPC_POLICY_SPECS,
  T01_GRPC_SPECS,
  T01_GRPC_WAITING,
  grpcTarget,
} from "./t01.ts";

const lowOf = (plan: string): number => {
  const prediction = cell(plan).prediction;
  if (prediction.detects !== true) throw new Error(`${plan} detects nothing`);
  return prediction.low.value;
};

const cell = (plan: string) => {
  const found = T01_GRPC.find((each) => each.name.startsWith(`${plan} grpc-js-1.14 to `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan over grpc-js-1.14 in T01, at the defaults (plan.json): the servers grpc-go-server and etcd-3.6, and caddy-2.11. */
const PLAN = [13, 38, 39, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209] as const;

describe("the gRPC catalog of T01", () => {
  it("gives each cell of the plan at the defaults a cell or a reason to wait, once", () => {
    const named = [...T01_GRPC_SPECS.map((spec) => spec.plan), ...T01_GRPC_WAITING.map((each) => each.plan)];
    expect(named.sort()).toEqual(PLAN.map((n) => `T01.defaults.${n}`).sort());
    for (const each of T01_GRPC) {
      expect(each.probe.driver, each.name).toMatchObject({ name: "grpc" });
      expect(each.runs, each.name).toBe(RUNS);
    }
  });

  it("starts the server of the harness and etcd from their images, each held by a shell", () => {
    const go = grpcTarget("grpc-go");
    expect(go).toMatchObject({ subject: { kind: "shipped", name: "grpc-go" }, port: GRPC_PORT, program: "grpc-go-server", lines: true });
    expect(go.command?.[2]).toBe(`grpc-go-server --port ${GRPC_PORT} & echo $! > /tmp/server.pid; while :; do sleep 3600; done`);
    const etcd = grpcTarget("etcd");
    expect(etcd).toMatchObject({ subject: { kind: "shipped", name: "etcd" }, port: ETCD_PORT, program: "etcd", ready: "serving client traffic insecurely" });
    // a setting of the server is a flag, in the unit of its document
    expect(grpcTarget("grpc-go", { keepalive_timeout: 160, listener_keepcnt: 9 }).command?.[2]).toContain("--keepalive-timeout 160s --listener-keepalive-count 9");
    expect(grpcTarget("etcd", { keepalive_time: 10 }).command?.[2]).toContain("--grpc-keepalive-interval 10s");
    expect(() => grpcTarget("etcd", { listener_keepidle: 10 })).toThrow("the etcd server has no flag for listener_keepidle");
    // each cell at the defaults starts its server at its defaults
    for (const spec of T01_GRPC_SPECS) expect(cell(spec.plan).target.command, spec.plan).toEqual(grpcTarget(spec.server).command);
  });

  it("finds nothing at the client for a silent fault: grpc-js has no keepalive and no deadline", () => {
    expect(GRPC_JS.knobs["keepalive_time"]).toMatchObject({ default: 0, off: 0 });
    for (const plan of ["T01.defaults.38", "T01.defaults.196", "T01.defaults.201", "T01.defaults.164"])
      expect(cell(plan).prediction, plan).toMatchObject({ detects: false, window: { value: SILENT_WINDOW, unit: "s" } });
  });

  it("ends a call at once for a reset, a killed server or a refused connect", () => {
    for (const plan of ["T01.defaults.198", "T01.defaults.162"]) expect(cell(plan).prediction, plan).toMatchObject({ detects: true, errno: "ECONNRESET", from: "request-sent" });
    for (const plan of ["T01.defaults.199", "T01.defaults.163"]) {
      // Go closes the socket of a killed server with a FIN: each run of a fin has its own server
      expect(cell(plan).prediction, plan).toMatchObject({ detects: true, errno: "EOF", from: "peer-closed" });
      expect(cell(plan).environments, plan).toBe(RUNS);
    }
    for (const plan of ["T01.defaults.205", "T01.defaults.168"])
      expect(cell(plan).prediction, plan).toMatchObject({ detects: true, errno: "UNAVAILABLE", from: "client-start", driver: { ends: { ev: "fail", where: { n: 1 }, name: "name" } } });
  });

  it("gives up in the kernel on an unreachable host, recovers a stall, and gets a held reply after its hold", () => {
    for (const plan of ["T01.defaults.200", "T01.defaults.197"])
      expect(cell(plan).prediction, plan).toMatchObject({ detects: true, timer: "retrans_giveup", errno: "EHOSTUNREACH", from: "first-retransmission" });
    for (const plan of ["T01.defaults.202", "T01.defaults.165"]) {
      const stall = cell(plan).prediction;
      if (stall.detects !== false || stall.recovers === undefined) throw new Error("a stall");
      expect(stall.recovers.low.value, plan).toBeGreaterThan(1);
    }
    const held = cell("T01.defaults.206");
    expect(held.prediction).toMatchObject({ detects: false, replies: { low: { value: GRPC_HOLD, unit: "s" } } });
    expect(held.probe.driver).toEqual({ name: "grpc", hold: { value: GRPC_HOLD, unit: "s" } });
  });

  it("keeps an idle connection for 300 s: no timer of grpc-js or of the server acts in the window", () => {
    for (const plan of ["T01.defaults.203", "T01.defaults.166"]) expect(cell(plan).prediction, plan).toMatchObject({ detects: false, window: { value: 300, unit: "s" } });
    // the keepalive of each server comes after 2 h with no read
    for (const doc of [GRPC_GO_SERVER, ETCD_SERVER]) expect(doc.knobs["keepalive_time"]?.default, doc.id).toBe(7200);
  });

  it("gives each cell of the array stage a cell, an alias of its cell at the defaults, or the reason of that cell", () => {
    const named = [...T01_GRPC_ARRAY_SPECS.map((spec) => spec.plan), ...T01_GRPC_ARRAY_ALIASES.map((each) => each.plan), ...T01_GRPC_ARRAY_WAITING.map((each) => each.plan)];
    expect(named.sort()).toEqual(PLAN.map((n) => `T01.array.${n}`).sort());
    for (const alias of T01_GRPC_ARRAY_ALIASES) {
      expect(alias.is, alias.plan).toBe(alias.plan.replace(".array.", ".defaults."));
      expect(() => cell(alias.is), alias.plan).not.toThrow();
    }
    for (const each of T01_GRPC_ARRAY_WAITING) {
      const defaults = T01_GRPC_WAITING.find((wait) => wait.plan === each.plan.replace(".array.", ".defaults."));
      expect(defaults?.trigger, each.plan).toBe(each.trigger);
      expect(each.why, each.plan).toContain(defaults!.why);
    }
  });

  it("ends the call behind a frozen server at the keepalive of DP24, and measures the race of two deadlines under DP44", () => {
    // the PING keepalive_time after the first call, and the end keepalive_timeout (20 s) after it
    const keepalive = cell("T01.array.164").prediction;
    expect(keepalive).toMatchObject({ detects: true, timer: "keepalive", errno: "CLOSED", from: "last-data" });
    if (keepalive.detects !== true) throw new Error("a detection");
    expect(keepalive.high.value).toBeCloseTo(80.02, 9);
    expect(cell("T01.array.164").driverOptions).toEqual({ "grpc.keepalive_time_ms": 60000 });
    // against grpc-go the keepalive is at least its MinTime, 5 min: the PING breaks no policy
    expect(cell("T01.array.201").driverOptions).toEqual({ "grpc.keepalive_time_ms": 300000 });
    expect(GRPC_GO_SERVER.knobs["min_time"]?.default).toBe(300);
    // the deadline of grpc-js and the deadline of the call at grpc-go race: DEADLINE_EXCEEDED or CANCELLED (run 39272272260)
    const deadline = cell("T01.array.206").prediction;
    expect(deadline).toMatchObject({ detects: null, from: "request-sent" });
    if (deadline.detects !== null) throw new Error("a measurement");
    expect(deadline.why).toContain("CANCELLED");
    expect(GRPC_GO_SERVER.timers["call_deadline"]?.fires).toBe("timer.call-deadline");
  });

  it("places O03, O17 and O25 on the socket of the server, each with a setting inside and one outside", () => {
    const named = [...T01_GRPC_BORDER_SPECS.map((spec) => spec.plan), ...T01_GRPC_POLICY_SPECS.map((spec) => spec.plan)];
    expect(named.sort()).toEqual([163, 164, 165, 166, 209, 210, 225, 226, 229, 230, 231, 232].map((n) => `T01.border-off.${n}`));
    for (const spec of T01_GRPC_BORDER_SPECS) expect(cell(spec.plan).observer, spec.plan).toBe("server");
    // O03: the probes of the listener refresh the flow inside, and the router forgets it outside. Its
    // drop of a late packet from outside leaves each probe without an answer, until the keepalive aborts
    expect(cell("T01.border-off.163").prediction).toMatchObject({ detects: false });
    expect(cell("T01.border-off.163").topology?.hops[0]).toMatchObject({ kind: "router", form: "reset-next", idle: { value: GRPC_ROUTER.idle, unit: "s" } });
    // grpc-go: TCP_USER_TIMEOUT 20 s, thus the abort comes at the second firing: 45 + 15
    expect(cell("T01.border-off.164").prediction).toMatchObject({ detects: true, timer: "keepalive", errno: "ETIMEDOUT", from: "last-received" });
    expect(lowOf("T01.border-off.164")).toBeCloseTo(60, 1);
    expect(cell("T01.border-off.165").prediction).toMatchObject({ detects: false });
    // etcd: no TCP_USER_TIMEOUT, thus 30 + 9 × 15
    expect(cell("T01.border-off.166").prediction).toMatchObject({ detects: true, timer: "keepalive", errno: "ETIMEDOUT" });
    expect(lowOf("T01.border-off.166")).toBeCloseTo(165, 1);
    // O17: the close of gRPC 10 + 20 s after the last read, or the give-up of the kernel on the PING
    expect(cell("T01.border-off.209").prediction).toMatchObject({ detects: true, timer: "ping_timeout", errno: "CLOSED", from: "last-received" });
    expect(cell("T01.border-off.210").prediction).toMatchObject({ detects: true, timer: "retrans_giveup", errno: "ETIMEDOUT", from: "first-retransmission", low: { value: 51, unit: "s" } });
    expect(cell("T01.border-off.210").targetSysctls).toMatchObject({ "net.ipv4.tcp_retries2": String(GRPC_O17_RETRIES) });
    // O25: inside, the abort at 15 + 15; outside, U of 160 s moves it to 15 + 10 × 15, after the 150 s of the keepalive alone
    expect([lowOf("T01.border-off.225"), lowOf("T01.border-off.226")].map((low) => Math.round(low))).toEqual([30, 165]);
  });

  it("gives O26 a GOAWAY too_many_pings at the fourth PING outside, and none inside", () => {
    // grpc-go: MinTime 5 s by its flag, and a call held 30 s; etcd: its own 5 s, and a Watch
    expect(cell("T01.border-off.229").target.command?.[2]).toContain(`--min-time ${GRPC_MIN_TIME}s`);
    expect(cell("T01.border-off.229").probe.driver).toEqual({ name: "grpc", hold: { value: POLICY_HOLD, unit: "s" } });
    expect(cell("T01.border-off.231").probe.driver).toEqual({ name: "grpc", op: "watch" });
    expect(cell("T01.border-off.229").prediction).toMatchObject({ detects: false, replies: { low: { value: POLICY_HOLD, unit: "s" } } });
    expect(cell("T01.border-off.231").prediction).toMatchObject({ detects: false });
    for (const plan of ["T01.border-off.230", "T01.border-off.232"]) {
      // the first PING clears the strikes, and the third strike is the fourth PING: 4 × 4 s
      expect(cell(plan).prediction, plan).toMatchObject({ detects: true, errno: "too_many_pings", from: "last-data", driver: { ends: { ev: "error", name: "errno" } } });
      expect(Math.round(lowOf(plan)), plan).toBe(16);
      expect(cell(plan).driverOptions, plan).toEqual({ "grpc.keepalive_time_ms": 4000 });
    }
  });
});
