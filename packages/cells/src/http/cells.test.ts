import type { Cell } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import { HTTP_CELLS, HTTP_SPECS } from "./catalog.ts";
import { HTTP_HARNESS_CELLS, NODE_IMAGE, SERVER_SCRIPT, nodeServer, optionsOf } from "./cells.ts";

const cell = (name: string): Cell => {
  const found = HTTP_HARNESS_CELLS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};

describe("the HTTP cells for the harness", () => {
  it("give each cell of the catalog a cell of the harness, with a name that no other catalog has", () => {
    expect(HTTP_HARNESS_CELLS).toHaveLength(HTTP_CELLS.length);
    expect(new Set(ALL.map((each) => each.name)).size).toBe(ALL.length);
    for (const each of HTTP_HARNESS_CELLS) {
      expect(each.target.image, each.name).toBe(NODE_IMAGE);
      expect(each.target.files?.["/srv/server.mjs"], each.name).toBe(SERVER_SCRIPT);
      expect(each.probe.http, each.name).toBeDefined();
      expect(["go-http", "http-agent", "undici"], each.name).toContain(each.client);
    }
  });

  it("starts the server with the flag of each setting, and holds it under a shell for a fin", () => {
    expect(nodeServer({ keepAliveTimeout: 6000, keepAliveTimeoutBuffer: 0 }).command).toEqual([
      "node",
      "/srv/server.mjs",
      "--port",
      "8080",
      "--keep-alive-timeout-ms",
      "6000",
      "--keep-alive-timeout-buffer-ms",
      "0",
    ]);
    const held = nodeServer({}, true);
    expect(held.command?.[0]).toBe("sh");
    expect(held.kill).toBeDefined();
    expect(cell("T01.defaults.30 agent idle, fin").environments).toBe(11);
    // the script needs nothing but Node: it goes into the stock image as one file
    expect(SERVER_SCRIPT).not.toMatch(/from "\.\//);
  });

  it("gives the settings of a client as the flags of its program, in their units", () => {
    const go = HTTP_SPECS.find((spec) => spec.name.startsWith("go idle, blackhole at the router"))!;
    expect(optionsOf(go)).toEqual({ "idle-conn-timeout-ms": 9000, "keepalive-ms": 3000, "keepalive-interval-ms": 1500 });
    expect(cell("T01.border-off.122 agent, agentKeepAliveTimeoutBuffer 100 ms against a hint of 6 (outside O01), a GET 5.85 s after the reply").probe.http).toEqual({
      method: "GET",
      gap: { value: 5.85, unit: "s" },
      options: { "timeout-ms": 10_000, "buffer-ms": 100 },
    });
  });

  it("gives a race its gap and the outcome of its second request", () => {
    const crossed = cell("T01.defaults.77 go, a POST 5.95 s after the reply, 100 ms latency");
    expect(crossed).toMatchObject({ fault: "none", latency: { value: 100, unit: "ms" }, probe: { mode: "gap" } });
    expect(crossed.prediction.request).toEqual({ connection: "reused", retried: false, error: "EOF" });
  });

  it("puts a T03 cell behind the router of its form, one at a time, with its fault at the router", () => {
    const rst = cell("T03.defaults.30 go, a GET in flight, rst at the router toward the client");
    expect(rst).toMatchObject({ faultAt: { hop: "nat", toward: "client" }, concurrency: 1 });
    expect(rst.topology?.hops[0]).toMatchObject({ kind: "router", form: "reset-next", idle: { value: 350, unit: "s" } });
    // the long segments of the reply come from the target: the MTU drop faces it
    const mtu = cell("T03.defaults.12 server, a long reply to a go GET, mtu-blackhole at the router toward the client, tcp_retries2 = 3");
    expect(mtu).toMatchObject({ observer: "server", faultAt: { hop: "nat", toward: "target" }, mtu: 1200, sysctls: {} });
    expect(mtu.targetSysctls).toMatchObject({ "net.ipv4.tcp_retries2": "3", "net.ipv4.tcp_mtu_probing": "0" });
    // the router sends the ICMP errors of a fault at it
    const icmp = cell("T03.defaults.37 undici, a GET in flight, unreachable-host at the router toward the client, tcp_retries2 = 3");
    expect(icmp.topology?.hops[0]?.sysctls).toEqual({ "net.ipv4.icmp_ratelimit": "0" });
    expect(icmp.targetSysctls).toBeUndefined();
    // a forget of the router has no fault at it
    expect(cell("T03.defaults.62 go, a GET 25 s after the reply, all timers scaled by 15").faultAt).toBeUndefined();
  });
});
