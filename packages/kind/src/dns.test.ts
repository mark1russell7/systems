import { describe, expect, it } from "vitest";
import { cellOf } from "./cells.fixture.ts";
import { DNS_PORT, dnsCommands, planOf } from "./faults.ts";

const s = (value: number) => ({ value, unit: "s" }) as const;

describe("the trigger dns-blackhole", () => {
  const cell = { ...cellOf("dns-blackhole"), trigger: { kind: "dns-blackhole" as const, hold: s(6) } };

  it("drops the answers of DNS in each client pod for the hold, and the heal removes the drops", () => {
    expect(planOf(cell)).toEqual({
      inject: [{ do: "dns", target: "clients", on: true }],
      hold: s(6),
      heal: [{ do: "dns", target: "clients", on: false }],
      restore: [],
    });
    expect(() => planOf({ ...cell, trigger: { kind: "dns-blackhole" } })).toThrow(/a hold/);
  });

  it("drops each answer from port 53 on UDP and on TCP in INPUT, thus each query still goes out", () => {
    expect(DNS_PORT).toBe(53);
    expect(dnsCommands(true)).toEqual([
      ["iptables", "-I", "INPUT", "-p", "udp", "--sport", "53", "-j", "DROP"],
      ["iptables", "-I", "INPUT", "-p", "tcp", "--sport", "53", "-j", "DROP"],
    ]);
    expect(dnsCommands(false)).toEqual([
      ["iptables", "-D", "INPUT", "-p", "udp", "--sport", "53", "-j", "DROP"],
      ["iptables", "-D", "INPUT", "-p", "tcp", "--sport", "53", "-j", "DROP"],
    ]);
    // each word is plain, as the injector needs (`netns` of the lab)
    for (const word of [...dnsCommands(true), ...dnsCommands(false)].flat()) expect(word).toMatch(/^[A-Za-z0-9_.,:=/+-]+$/);
  });
});
