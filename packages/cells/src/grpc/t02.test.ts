import { describe, expect, it } from "vitest";
import { ENVOY_IMAGE, T02_GRPC, T02_GRPC_ALIASES, T02_GRPC_SPECS, T02_GRPC_WAITING, proxyHop } from "./t02.ts";

const cell = (plan: string) => {
  const found = T02_GRPC.find((each) => each.name.startsWith(`${plan} grpc-js-1.14 to `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan over grpc-js-1.14 in T02 (plan.json): one proxy and a server of grpc-go. */
const DEFAULTS = [31, 32, 33, 34, 35, 36, 41, 48] as const;
const ARRAY = [31, 32, 33, 34, 35, 36, 41, 48, 74, 75, 76, 77, 78, 79] as const;

describe("the gRPC catalog of T02", () => {
  it("gives each cell of the plan a cell, an alias or a reason to wait, once", () => {
    const named = T02_GRPC_SPECS.map((spec) => spec.plan).concat(T02_GRPC_ALIASES.map((each) => each.plan), T02_GRPC_WAITING.map((each) => each.plan));
    expect(named.sort()).toEqual([...DEFAULTS.map((n) => `T02.defaults.${n}`), ...ARRAY.map((n) => `T02.array.${n}`)].sort());
    for (const alias of T02_GRPC_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
    // each cell goes through one proxy
    for (const each of T02_GRPC) expect(each.topology?.hops, each.name).toHaveLength(1);
  });

  it("answers a reset at the server behind Envoy with the local reply of Envoy: UNAVAILABLE at once, on the open connection", () => {
    const reset = cell("T02.defaults.31");
    // the reset is at the server: it answers the request of Envoy, and Envoy answers the client
    expect(reset).toMatchObject({ fault: "rst", prediction: { detects: true, errno: "UNAVAILABLE", from: "request-sent" } });
    expect(reset).not.toHaveProperty("faultAt");
    if (reset.prediction.detects !== true) throw new Error("a detection");
    // two hops of 2 ms, and one step of Envoy and of Node
    expect(reset.prediction.high.value).toBeCloseTo(0.024, 6);
    expect(proxyHop("envoy")).toMatchObject({ image: ENVOY_IMAGE, ready: "starting main dispatch loop", program: "envoy" });
  });

  it("ends an idle connection at a stop of its proxy, and at the FIN of the server behind Toxiproxy", () => {
    expect(cell("T02.defaults.35")).toMatchObject({ fault: "hop-event", event: { hop: "toxiproxy", signal: "TERM" }, prediction: { errno: "EOF", from: "fault" } });
    expect(cell("T02.defaults.36")).toMatchObject({ fault: "hop-event", event: { hop: "docker-proxy", signal: "INT" }, prediction: { errno: "EOF", from: "fault" } });
    expect(cell("T02.defaults.48")).toMatchObject({ fault: "fin", prediction: { errno: "EOF", from: "peer-closed" } });
    // a stopped proxy and a killed server cannot serve the next run
    for (const plan of ["T02.defaults.35", "T02.defaults.36", "T02.defaults.48"]) expect(cell(plan).environments).toBe(cell(plan).runs);
    // the stop of a proxy ends the environment, thus its warm-up is a dry run
    for (const plan of ["T02.defaults.35", "T02.defaults.36"]) expect(cell(plan).fresh).toBe(true);
    // docker-proxy gets /dev/null on the fd of the pipe of its parent, and the script tells when it listens
    expect(proxyHop("docker-proxy").files?.["/proxy.sh"]).toContain("3>/dev/null");
  });

  it("drops the transport of an idle connection at the GOAWAY of Caddy, 5 min after the last stream", () => {
    const gap = cell("T02.defaults.41");
    expect(gap).toMatchObject({ fault: "none", probe: { mode: "idle" }, prediction: { detects: true, errno: "IDLE", from: "last-data", driver: { ends: { ev: "state", where: { to: "IDLE" } } } } });
    if (gap.prediction.detects !== true) throw new Error("a detection");
    expect([gap.prediction.low.value, gap.prediction.high.value]).toEqual([299.998, 300.022]);
    // h2c on the plain port of Caddy, stated in its configuration
    expect(proxyHop("caddy").files?.["/etc/caddy/Caddyfile"]).toContain("protocols h1 h2c");
  });

  it("stops the worker of nginx over grpc_read_timeout with a call in flight: 504 at the resume, thus UNAVAILABLE", () => {
    const stop = cell("T02.defaults.34");
    expect(stop).toMatchObject({
      fault: "hop-event",
      event: { hop: "nginx", signal: "STOP", inFlight: true },
      hold: { value: 90, unit: "s" },
      probe: { mode: "inflight", driver: { name: "grpc", hold: { value: 5, unit: "s" } } },
      prediction: { detects: true, errno: "UNAVAILABLE", from: "fault", driver: { ends: { ev: "error" } } },
    });
    if (stop.prediction.detects !== true) throw new Error("a detection");
    // the CONT at the end of the hold, then the 504: two hops of 2 ms, and one step of nginx and of Node
    expect([stop.prediction.low.value, stop.prediction.high.value]).toEqual([90, 90.024]);
    // the proxy thaws and serves the next run: no fresh environment
    expect(stop).not.toHaveProperty("fresh");
    expect(stop.environments).toBe(2);
    // the configuration of the hop keeps each timer of nginx at its built-in default, with one worker
    const conf = proxyHop("nginx").files?.["/etc/nginx/nginx.conf"] ?? "";
    expect(conf).toContain("http2 on;");
    expect(conf).not.toMatch(/keepalive_timeout|worker_processes|grpc_read_timeout/);
  });
});
