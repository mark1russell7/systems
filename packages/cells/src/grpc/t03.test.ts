import { describe, expect, it } from "vitest";
import { PRESETS } from "../mongo/t03.ts";
import { T01_GRPC } from "./t01.ts";
import { T03_GRPC, T03_GRPC_ALIASES, T03_GRPC_ARRAY_SPECS, T03_GRPC_SPECS, T03_GRPC_WAITING } from "./t03.ts";

const cell = (plan: string) => {
  const found = [...T01_GRPC, ...T03_GRPC].find((each) => each.name.startsWith(`${plan} grpc-js-1.14 to `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan over grpc-js-1.14 and grpc-go-server in T03 (plan.json). */
const DEFAULTS = [16, 17, 18, 19, 20, 26, 46, 47, 48, 49] as const;
const ARRAY = [16, 17, 18, 19, 20, 26, 46, 47, 48, 49, 68, 69] as const;

describe("the gRPC catalog of T03", () => {
  it("gives each cell of the plan a cell, an alias or a reason to wait, once", () => {
    const named = [...T03_GRPC_SPECS, ...T03_GRPC_ARRAY_SPECS].map((spec) => spec.plan).concat(T03_GRPC_ALIASES.map((each) => each.plan), T03_GRPC_WAITING.map((each) => each.plan));
    expect(named.sort()).toEqual([...DEFAULTS.map((n) => `T03.defaults.${n}`), ...ARRAY.map((n) => `T03.array.${n}`)].sort());
    for (const alias of T03_GRPC_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
    // each cell goes through one router of a cloud preset, at its own idle timeout
    for (const each of T03_GRPC) expect(each.topology?.hops, each.name).toHaveLength(1);
  });

  it("places a fault at the router toward the client: the same fault for the socket of the client as on the direct pair", () => {
    // an unreachable host at the router: the router sends the ICMP errors, at no rate limit
    const unreachable = cell("T03.defaults.17");
    expect(unreachable.faultAt).toEqual({ hop: "nat", toward: "client" });
    expect(unreachable.topology?.hops[0]).toMatchObject({ form: PRESETS.azureNat.form, sysctls: { "net.ipv4.icmp_ratelimit": "0" } });
    expect(unreachable.prediction).toEqual(cell("T01.defaults.200").prediction);
    expect(cell("T03.defaults.47").prediction).toEqual(cell("T01.defaults.198").prediction);
    expect(cell("T03.defaults.46").prediction).toEqual(cell("T01.defaults.202").prediction);
    expect(cell("T03.defaults.49").prediction).toEqual(cell("T01.defaults.199").prediction);
    // a black hole toward the client: grpc-js has no detector
    expect(cell("T03.defaults.18").prediction).toMatchObject({ detects: false });
    // a simplex drop toward the client: TCP_USER_TIMEOUT aborts the socket of the server, conntrack goes to CLOSE,
    // and the router resets the first retransmission of the client after the CLOSE timeout (run 39278390448: 53.4 s)
    const simplex = cell("T03.defaults.48");
    expect(simplex).toMatchObject({ drops: "to-client", prediction: { detects: true, errno: "ECONNRESET", from: "request-sent" } });
    if (simplex.prediction.detects !== true) throw new Error("a detection");
    // the eighth retransmission of the client, at 51 s to 57 s for each HZ
    expect(simplex.prediction.low.value).toBeGreaterThan(51);
    expect(simplex.prediction.low.value).toBeLessThan(53.4);
    expect(simplex.prediction.high.value).toBeGreaterThan(53.4);
    expect(simplex.prediction.high.value).toBeLessThan(58);
  });

  it("keeps an idle flow through each preset: the listener of grpc-go probes each 15 s", () => {
    expect(cell("T03.defaults.19").prediction).toMatchObject({ detects: false, window: { value: 700, unit: "s" } });
    expect(cell("T03.defaults.19").topology?.hops[0]).toMatchObject({ form: "silent-drop", idle: { value: PRESETS.gcp.idle, unit: "s" } });
    expect(cell("T03.array.68").prediction).toMatchObject({ detects: false, window: { value: 400, unit: "s" } });
    expect(cell("T03.defaults.20").prediction).toMatchObject({ detects: false, window: { value: 300, unit: "s" } });
  });
});
