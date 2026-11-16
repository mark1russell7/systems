import { describe, expect, it } from "vitest";
import { LIFT, faultArgs, optionArgs } from "./lab.ts";

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

  it("gives no option that the caller did not set, so each default of the injector holds", () => {
    expect(optionArgs({})).toEqual([]);
    expect(optionArgs({ code: "host" })).toEqual(["--code", "host"]);
  });

  it("limits a black hole or a reject to a protocol, and turns a reject at a router toward the peer", () => {
    expect(optionArgs({ protocol: "udp" })).toEqual(["--protocol", "udp"]);
    expect(faultArgs("blackhole", "target", PEER, [], { direction: "in", protocol: "icmp" })).toEqual([
      INJECT,
      "blackhole",
      PEER,
      "--direction",
      "in",
      "--protocol",
      "icmp",
    ]);
    // a host that is down behind the gateway: the gateway answers each packet that it forwards to the host
    const toward = { hop: "gw", toward: "target" } as const;
    const host = { direction: "out", protocol: "all", code: "host", peers: ["10.0.1.2"] } as const;
    expect(faultArgs("reject", toward, "10.0.1.3", ["--via", "eth1"], host)).toEqual([
      INJECT,
      "reject",
      "10.0.1.2",
      "--direction",
      "out",
      "--protocol",
      "all",
      "--code",
      "host",
      "--via",
      "eth1",
    ]);
    expect(faultArgs("reject", toward, "10.0.1.3", ["--via", "eth1"], host, true)[1]).toBe("clear-reject");
  });

  it("limits an MTU drop to a protocol only when the options name one, and lifts the same rule", () => {
    expect(faultArgs("mtu", "target", PEER, [], { above: 1200 })).toEqual([INJECT, "mtu", PEER, "--above", "1200"]);
    expect(faultArgs("mtu", GW, PEER, VIA, { above: 1200, protocol: "all" })).toEqual([INJECT, "mtu", PEER, "--protocol", "all", "--above", "1200", ...VIA]);
    expect(faultArgs("mtu", GW, PEER, VIA, { above: 1200, protocol: "all" }, true)).toEqual([
      INJECT,
      "clear-mtu",
      PEER,
      "--protocol",
      "all",
      "--above",
      "1200",
      ...VIA,
    ]);
  });

  it("lets the handshake of a reset pass, at an end and at a router", () => {
    expect(optionArgs({ handshake: "pass" })).toEqual(["--handshake", "pass"]);
    expect(faultArgs("rst", "target", PEER, [], { handshake: "pass" })).toEqual([INJECT, "rst", PEER, "--handshake", "pass"]);
    expect(faultArgs("rst", GW, PEER, VIA, { handshake: "pass" }, true)).toEqual([INJECT, "clear-rst", PEER, "--handshake", "pass", ...VIA]);
  });
});
