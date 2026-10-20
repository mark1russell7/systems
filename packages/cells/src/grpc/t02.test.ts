import { describe, expect, it } from "vitest";
import { ENVOY_IMAGE, T02_GRPC, T02_GRPC_ALIASES, T02_GRPC_SPECS, T02_GRPC_WAITING, TRAEFIK_SPARE_PATH, proxyHop } from "./t02.ts";

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

  it("reloads Traefik in an idle gap: the reload sends nothing, and the GOAWAY of its idle timeout comes 180 s after the last stream", () => {
    const reload = cell("T02.array.77");
    expect(reload).toMatchObject({
      fault: "hop-event",
      event: { hop: "traefik", write: { path: TRAEFIK_SPARE_PATH, confirm: "Creating server" } },
      probe: { mode: "idle" },
      prediction: { detects: true, errno: "IDLE", from: "last-data", driver: { ends: { ev: "state", where: { to: "IDLE" } } } },
    });
    if (reload.prediction.detects !== true) throw new Error("a detection");
    // the late bound holds the observed lateness of Traefik (0.1 s), and it stays below the time of the
    // reload plus 180 s: a reload that armed the idle timer again would give a later IDLE
    expect([reload.prediction.low.value, reload.prediction.high.value]).toEqual([179.998, 180.112]);
    // the reload changes the spare router, and its undo writes it back: each run makes the same change
    const write = (reload.event as { write: { content: string; undo: string } }).write;
    expect(write.content).not.toBe(write.undo);
    const hop = proxyHop("traefik");
    expect(hop.files?.[TRAEFIK_SPARE_PATH]).toBe(write.undo);
    // the router to the server is in a file of its own, which the reload does not write
    expect(hop.files?.["/etc/traefik/dynamic/main.yml"]).toContain("h2c://{{next}}");
    // the proxy serves the next run
    expect(reload).not.toHaveProperty("fresh");
    expect(reload.environments).toBe(2);
  });
});
