import { describe, expect, it } from "vitest";
import { LIFT, faultArgs } from "./lab.ts";

const INJECT = "/opt/harness/inject";
const PEER = "10.0.0.2";
/** This place is a router toward the client, with its device. */
const GW = { hop: "gw", toward: "client" } as const;
const VIA = ["--via", "eth0"] as const;

describe("the arguments of the injector for a network fault", () => {
  it("names the peer of the place, the options and the device of a router, and lifts with the same arguments", () => {
    expect(faultArgs("blackhole", "target", PEER, [])).toEqual([INJECT, "blackhole", PEER]);
    expect(faultArgs("reject", GW, PEER, VIA, { code: "host" }, true)).toEqual([INJECT, "clear-reject", PEER, "--code", "host", ...VIA]);
    // the peers of the options replace the peer of the place, in one commit
    expect(faultArgs("blackhole", "target", PEER, [], { peers: ["10.0.0.3", "10.0.0.4"] })).toEqual([INJECT, "blackhole", "10.0.0.3,10.0.0.4"]);
    // each fault lifts with its own action
    expect(new Set(Object.values(LIFT)).size).toBe(Object.keys(LIFT).length);
  });

  it("silences a hop with no peer and no option, and only a hop", () => {
    expect(faultArgs("silence", GW, PEER, VIA)).toEqual([INJECT, "silence"]);
    // the side of the hop has no effect: the silence is of the whole namespace
    expect(faultArgs("silence", { hop: "gw", toward: "target" }, "10.0.1.2", [], {}, true)).toEqual([INJECT, "clear-silence"]);
    expect(() => faultArgs("silence", "target", PEER, [])).toThrow("namespace of a hop");
    expect(() => faultArgs("silence", "client", PEER, [])).toThrow("namespace of a hop");
    expect(() => faultArgs("silence", GW, PEER, VIA, { direction: "in" })).toThrow("no options");
  });
});
