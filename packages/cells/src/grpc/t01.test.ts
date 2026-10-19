import { describe, expect, it } from "vitest";
import { ETCD_SERVER, GRPC_GO_SERVER, GRPC_JS } from "@mark1russell7/machines";
import { RUNS } from "../catalog.ts";
import {
  ETCD_PORT,
  GRPC_HOLD,
  GRPC_PORT,
  SILENT_WINDOW,
  T01_GRPC,
  T01_GRPC_ARRAY_ALIASES,
  T01_GRPC_ARRAY_SPECS,
  T01_GRPC_ARRAY_WAITING,
  T01_GRPC_SPECS,
  T01_GRPC_WAITING,
  grpcTarget,
} from "./t01.ts";

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
    // each cell of a server starts it at its defaults
    for (const each of T01_GRPC) expect(each.target.command, each.name).toEqual(grpcTarget(each.name.includes(" to etcd-3.6,") ? "etcd" : "grpc-go").command);
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

  it("ends the call behind a frozen server at the keepalive of DP24, and a held reply at the deadline of DP44", () => {
    // the PING keepalive_time after the first call, and the end keepalive_timeout (20 s) after it
    const keepalive = cell("T01.array.164").prediction;
    expect(keepalive).toMatchObject({ detects: true, timer: "keepalive", errno: "CLOSED", from: "last-data" });
    if (keepalive.detects !== true) throw new Error("a detection");
    expect(keepalive.high.value).toBeCloseTo(80.02, 9);
    expect(cell("T01.array.164").driverOptions).toEqual({ "grpc.keepalive_time_ms": 60000 });
    // against grpc-go the keepalive is at least its MinTime, 5 min: the PING breaks no policy
    expect(cell("T01.array.201").driverOptions).toEqual({ "grpc.keepalive_time_ms": 300000 });
    expect(GRPC_GO_SERVER.knobs["min_time"]?.default).toBe(300);
    const deadline = cell("T01.array.206").prediction;
    expect(deadline).toMatchObject({ detects: true, errno: "DEADLINE_EXCEEDED", from: "request-sent", low: { value: 4, unit: "s" } });
    if (deadline.detects !== true) throw new Error("a detection");
    expect(deadline.high.value).toBeLessThan(GRPC_HOLD);
  });
});
