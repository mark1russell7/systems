import type { Machine } from "@mark1russell7/algebra";
import { detection, machineProblems, overValues, timerOf } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import { ZTUNNEL_HBONE } from "./ztunnel.ts";

/** This function gives the values of the knobs of a document at its defaults. A knob at its off value has no bound. */
const defaults = (doc: Machine) => (name: string) => {
  const knob = doc.knobs[name];
  if (knob === undefined || knob.unit === null || knob.default === null) return undefined;
  return { value: knob.off !== undefined && knob.default === knob.off ? ("infinite" as const) : knob.default, unit: knob.unit };
};

const transition = (id: string) => ZTUNNEL_HBONE.transitions.find((t) => t.id === id);

describe("the HBONE connection of ztunnel 1.31.3", () => {
  const doc = ZTUNNEL_HBONE;
  const values = defaults(doc);

  it("is a consistent document over Linux TCP, with the keepalive of ztunnel", () => {
    expect(machineProblems(doc)).toEqual([]);
    expect(doc.over?.machine).toBe("systems.machine.linux-tcp");
    expect(doc.over?.states).toEqual({ connecting: "SYN_SENT", ready: "ESTABLISHED", draining: "ESTABLISHED" });
    const lower = overValues(doc, values, () => undefined);
    expect(lower("keepidle")).toEqual({ value: 180, unit: "s" });
    expect(lower("keepintvl")).toEqual({ value: 180, unit: "s" });
    expect(lower("keepcnt")).toEqual({ value: 9, unit: "count" });
    // no TCP_USER_TIMEOUT: the knob of the socket below stays at its default
    expect(doc.over?.sets["tcp_user_timeout"]).toBeUndefined();
  });

  it("gives the constants of the build: a connect of 10 s, a PING 10 s after each PONG, and 20 s for the PONG", () => {
    for (const name of ["connect_timeout", "ping_interval", "ping_timeout"]) expect(doc.knobs[name]?.scope, name).toBe("build");
    expect(timerOf(doc, "connect", values).duration).toEqual({ value: 10, unit: "s" });
    expect(timerOf(doc, "ping", values).duration).toEqual({ value: 10, unit: "s" });
    // a failure at a time in the cycle is found 20 s to 30 s later
    expect(timerOf(doc, "pong", values)).toMatchObject({ duration: { value: 30, unit: "s" }, early: { value: 10, unit: "s" }, lateness: { value: 0.02, unit: "s" } });
    expect(timerOf(doc, "release", values).duration).toEqual({ value: 300, unit: "s" });
    expect(timerOf(doc, "deadline", values).duration).toEqual({ value: 25, unit: "s" });
  });

  it("finds a black hole on a busy connection by its PONG, because data does not put a PING off", () => {
    const ready = detection(doc, { state: "ready", inFlight: true }, { name: "blackhole", passes: [] }, values);
    // the sleep before a PING starts again at each PONG: it is no detector
    expect(ready.detectors.map((detector) => detector.timer)).toEqual(["pong"]);
    expect(ready.first?.duration).toEqual({ value: 30, unit: "s" });
    // no event of the data arms the wait for the PONG again
    expect(doc.timers["pong"]?.arms).toEqual(["enter:ready", "rx.pong"]);
    const connecting = detection(doc, { state: "connecting", inFlight: true }, { name: "blackhole", passes: [] }, values);
    expect(connecting.first).toMatchObject({ timer: "connect", duration: { value: 10, unit: "s" } });
  });

  it("gives each flow of the app a FIN at the end of the connection, and closes the app of a failed connect at once", () => {
    for (const id of ["zt.pong-timeout", "zt.reset", "zt.deadline", "zt.del-workload", "zt.policy-denied"]) expect(transition(id)?.emits, id).toContain("tx.app-fin");
    expect(transition("zt.reset")).toMatchObject({ to: "ended", on: ["peer.rst", "peer.fin"] });
    expect(transition("zt.connect-failed")).toMatchObject({ from: "connecting", to: "ended", emits: ["tx.app-close"] });
    expect(transition("zt.connect-failed")?.timer).toBeUndefined();
    // SIGTERM: a GOAWAY, then the end of what is left at the deadline
    expect(transition("zt.stop")).toMatchObject({ to: "draining", emits: ["tx.goaway"], timer: "deadline" });
    // no idle timeout and no maximum age: the only timer of an open connection with a stream is the PING
    expect(Object.keys(doc.timers).sort()).toEqual(["connect", "deadline", "grace", "ping", "pong", "release"]);
  });

  it("ends a drain at the first of its deadline and the grace of the pod: a deadline past the grace does not come", () => {
    expect(timerOf(doc, "grace", values).duration).toEqual({ value: 30, unit: "s" });
    expect(doc.knobs["grace"]?.scope).toBe("pod");
    // both timers start at SIGTERM, and the guard of each end names the side of the line
    for (const name of ["deadline", "grace"]) expect(doc.timers[name]?.arms, name).toEqual(["app.stop"]);
    expect(transition("zt.deadline")).toMatchObject({ from: "draining", on: "timer.deadline", guard: "deadline < grace" });
    expect(transition("zt.killed")).toMatchObject({ from: "draining", to: "ended", on: "timer.grace", guard: "grace <= deadline", emits: ["tx.app-fin"] });
  });
});
