import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { overValues, timerOf } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import { ETCD_SERVER, GRPC_GO_SERVER, GRPC_JS, LINUX_TCP } from "../index.ts";

/** This function gives the values of the knobs of a document at its defaults, with some knobs changed. A knob at its off value has no bound. */
const valuesOf =
  (doc: Machine, changed: Readonly<Record<string, number>> = {}): KnobValues =>
  (name) => {
    const knob = doc.knobs[name];
    if (knob === undefined || knob.unit === null) return undefined;
    const value = changed[name] ?? knob.default;
    if (value === null) return name === "hz" ? { value: 1000, unit: "Hz" } : undefined;
    return { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  };

const seconds = (extent: { value: number | "infinite"; unit: string } | { unknown: string } | undefined): number | "infinite" => {
  if (extent === undefined) throw new Error("no bound");
  if ("unknown" in extent) throw new Error(extent.unknown);
  if (extent.value === "infinite") return "infinite";
  return extent.unit === "ms" ? extent.value / 1000 : extent.value;
};

/** This function gives the time at which the keepalive of Linux aborts an idle socket of a server, from the last received segment. */
const keepaliveAbort = (doc: Machine, changed: Readonly<Record<string, number>> = {}): number | "infinite" =>
  seconds(timerOf(LINUX_TCP, "keepalive", overValues(doc, valuesOf(doc, changed), valuesOf(LINUX_TCP))).duration);

describe("the gRPC documents", () => {
  it("gives grpc-js no keepalive, no deadline and no TCP keepalive at the defaults", () => {
    const values = valuesOf(GRPC_JS);
    expect(seconds(timerOf(GRPC_JS, "keepalive", values).duration)).toBe("infinite");
    expect(seconds(timerOf(GRPC_JS, "deadline", values).duration)).toBe("infinite");
    // a PING waits 20 s for its ACK when the keepalive is on
    expect(seconds(timerOf(GRPC_JS, "ping_timeout", values).duration)).toBe(20);
    expect(GRPC_JS.over?.sets).toEqual({});
    // the reconnect: 1 s, then 1.6 times longer, up to 120 s, with a jitter of 20 % that compounds
    const reconnect = (fired: number) => timerOf(GRPC_JS, "reconnect", values, fired);
    expect(seconds(reconnect(0).duration)).toBe(1);
    expect(seconds(reconnect(2).duration)).toBeCloseTo(2.56, 9);
    expect(seconds(reconnect(20).duration)).toBe(120);
    // the first wait has no jitter: the lateness is one step of Node only
    expect(seconds(reconnect(0).early)).toBe(0);
    const slack = Number(GRPC_JS.knobs["slack"]!.default);
    expect(seconds(reconnect(0).lateness)).toBeCloseTo(slack, 9);
    // the second wait: 1.6 s ± 20 %. The third: from 1.28² to 1.92² s, the jitter of each wait in the next
    expect(seconds(reconnect(1).early)).toBeCloseTo(0.32, 9);
    expect(seconds(reconnect(2).early)).toBeCloseTo(2.56 - 1.6384, 9);
    expect(seconds(reconnect(2).lateness)).toBeCloseTo(3.6864 - 2.56 + slack, 9);
    // at the cap: 120 s ± 20 %
    expect(seconds(reconnect(20).early)).toBeCloseTo(24, 9);
    expect(seconds(reconnect(20).lateness)).toBeCloseTo(24 + slack, 9);
  });

  it("aborts an idle connection of a server of grpc-go 30 s after the last data: TCP_USER_TIMEOUT 20 s over the keepalive of Go", () => {
    // K + k·I with k = max(1, ceil((20 - 15) / 15)) = 1
    expect(keepaliveAbort(GRPC_GO_SERVER)).toBe(30);
    const lower = overValues(GRPC_GO_SERVER, valuesOf(GRPC_GO_SERVER), valuesOf(LINUX_TCP));
    expect(lower("tcp_user_timeout")).toEqual({ value: 20000, unit: "ms" });
    // O25: a TCP_USER_TIMEOUT above the window of the keepalive (15 + 9 × 15 = 150 s) makes the abort later, not earlier
    expect(keepaliveAbort(GRPC_GO_SERVER, { keepalive_timeout: 160 })).toBe(165);
    expect(keepaliveAbort(GRPC_GO_SERVER, { keepalive_timeout: 140 })).toBe(150);
  });

  it("gives etcd no TCP_USER_TIMEOUT, behind cmux, and a keepalive idle of 30 s: 165 s", () => {
    expect(keepaliveAbort(ETCD_SERVER)).toBe(165);
    const lower = overValues(ETCD_SERVER, valuesOf(ETCD_SERVER), valuesOf(LINUX_TCP));
    expect(seconds(timerOf(LINUX_TCP, "user_timeout", lower).duration)).toBe("infinite");
    // etcd lets a client ping each 5 s with a stream open; the server of the harness, each 5 min
    expect([ETCD_SERVER.knobs["min_time"]?.default, GRPC_GO_SERVER.knobs["min_time"]?.default]).toEqual([5, 300]);
  });

  it("closes a connection with no read Time + Timeout after its last read: 2 h and 20 s", () => {
    for (const doc of [GRPC_GO_SERVER, ETCD_SERVER]) {
      const values = valuesOf(doc);
      expect(seconds(timerOf(doc, "keepalive", values).duration), doc.id).toBe(7200);
      expect(seconds(timerOf(doc, "ping_timeout", values).duration), doc.id).toBe(20);
      expect(seconds(timerOf(doc, "max_age", values).duration), doc.id).toBe("infinite");
    }
  });
});
