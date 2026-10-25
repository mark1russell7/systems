import type { Machine } from "@mark1russell7/algebra";
import { timerOf } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import { ENVOY_HTTP2 } from "./envoy.ts";
import { ISTIO_SIDECAR_INBOUND, ISTIO_SIDECAR_OUTBOUND, PILOT_AGENT, istioSidecar } from "./istio.ts";

/** This function gives the values of the knobs of a document at its defaults. A knob at its off value has no bound. */
const defaults = (doc: Machine) => (name: string) => {
  const knob = doc.knobs[name];
  if (knob === undefined || knob.unit === null || knob.default === null) return undefined;
  return { value: knob.off !== undefined && knob.default === knob.off ? ("infinite" as const) : knob.default, unit: knob.unit };
};

const transition = (doc: Machine, id: string) => doc.transitions.find((t) => t.id === id);

describe("the sidecar of Istio 1.31.3", () => {
  it("builds both sides from the Envoy document, with the timeouts of Istio", () => {
    expect(istioSidecar("outbound")).toEqual(ISTIO_SIDECAR_OUTBOUND);
    for (const doc of [ISTIO_SIDECAR_OUTBOUND, ISTIO_SIDECAR_INBOUND]) {
      const values = defaults(doc);
      // the route and the stream have no timer at the defaults of Istio, and Envoy alone gives 15 s and 5 min
      expect(timerOf(doc, "route", values).duration, doc.id).toEqual({ value: "infinite", unit: "s" });
      expect(timerOf(doc, "stream_idle", values).duration, doc.id).toEqual({ value: "infinite", unit: "s" });
      expect(timerOf(ENVOY_HTTP2, "route", defaults(ENVOY_HTTP2)).duration).toEqual({ value: 15, unit: "s" });
      expect(values("connect_timeout"), doc.id).toEqual({ value: 10, unit: "s" });
      expect(timerOf(doc, "idle", values).duration, doc.id).toEqual({ value: 3600, unit: "s" });
      // a drained chain closes its connections 45 s later, and Envoy gets SIGKILL, not SIGTERM
      expect(timerOf(doc, "chain_drain", values).duration, doc.id).toEqual({ value: 45, unit: "s" });
      expect(transition(doc, "env.stop"), doc.id).toBeUndefined();
      expect(doc.events["app.stop"], doc.id).toBeUndefined();
      expect(transition(doc, "isc.killed"), doc.id).toMatchObject({ to: "ended", on: "app.kill", emits: ["tx.fin"] });
      // the next response of a drained chain carries the GOAWAY notice, and the final GOAWAY comes drain_timeout later
      expect(transition(doc, "isc.chain-drain"), doc.id).toMatchObject({ to: "marked", on: "local.chain-drain" });
      expect(transition(doc, "isc.chain-goaway"), doc.id).toMatchObject({ from: "marked", to: "draining", emits: ["tx.goaway"] });
      expect(doc.timers["drain"]?.arms, doc.id).toEqual(["enter:draining"]);
      expect(doc.sources.length, doc.id).toBeGreaterThan(ENVOY_HTTP2.sources.length);
    }
  });

  it("retries a failed connect and UNAVAILABLE on the outbound side 2 times, with the backoff of Envoy", () => {
    const doc = ISTIO_SIDECAR_OUTBOUND;
    const values = defaults(doc);
    expect(values("num_retries")).toEqual({ value: 2, unit: "count" });
    // a random wait below 25 ms, then below 50 ms: as early as the whole wait
    expect(timerOf(doc, "retry_backoff", values, 0)).toMatchObject({ duration: { value: 25, unit: "ms" }, early: { value: 25, unit: "ms" } });
    expect(timerOf(doc, "retry_backoff", values, 1).duration).toEqual({ value: 50, unit: "ms" });
    expect(timerOf(doc, "retry_backoff", values, 5).duration).toEqual({ value: 250, unit: "ms" });
    expect(transition(doc, "isc.retry")).toMatchObject({ from: "active", to: "active", on: ["upstream.connect-failure", "upstream.connect-timeout", "upstream.retriable"] });
    expect(transition(doc, "isc.retries-spent")).toMatchObject({ to: "idle", errno: "UNAVAILABLE" });
    // the reset of an open connection is not retried: the app gets the local reply UNAVAILABLE
    expect(transition(doc, "env.upstream-reset")).toMatchObject({ errno: "UNAVAILABLE", emits: ["tx.local-reply"] });
    expect(transition(doc, "isi.rbac-deny")).toBeUndefined();
  });

  it("retries nothing on the inbound side, and denies with PERMISSION_DENIED", () => {
    const doc = ISTIO_SIDECAR_INBOUND;
    expect(doc.timers["retry_backoff"]).toBeUndefined();
    expect(doc.knobs["num_retries"]).toBeUndefined();
    expect(doc.transitions.some((t) => t.id.startsWith("isc.retr"))).toBe(false);
    expect(transition(doc, "isi.inbound-refused")).toMatchObject({ on: "upstream.connect-failure", errno: "UNAVAILABLE", emits: ["tx.local-reply"] });
    expect(transition(doc, "isi.rbac-deny")).toMatchObject({ on: "local.rbac-deny", errno: "PERMISSION_DENIED", emits: ["tx.local-reply"] });
    expect(doc.sources.some((source) => source.ref.includes("route.go:1321-1341"))).toBe(true);
  });
});

describe("pilot-agent of Istio 1.31.3", () => {
  const values = defaults(PILOT_AGENT);

  it("drains at the preStop hook of a native sidecar, and kills Envoy at once at SIGTERM", () => {
    expect(transition(PILOT_AGENT, "pa.prestop-drain")).toMatchObject({ from: "running", to: "drained", on: "app.prestop", emits: ["tx.drain-listeners"] });
    expect(transition(PILOT_AGENT, "pa.kill-drained")).toMatchObject({ from: "drained", to: "ended", on: "app.sigterm", emits: ["tx.kill"] });
  });

  it("waits terminationDrainDuration without the preStop drain, or polls each 1 s after the minimum drain", () => {
    expect(timerOf(PILOT_AGENT, "termination_drain", values).duration).toEqual({ value: 5, unit: "s" });
    expect(timerOf(PILOT_AGENT, "minimum_drain", values).duration).toEqual({ value: 5, unit: "s" });
    expect(timerOf(PILOT_AGENT, "active_check", values, 3).duration).toEqual({ value: 1, unit: "s" });
    expect(PILOT_AGENT.knobs["exit_on_zero"]).toMatchObject({ unit: null, default: 0 });
    expect(transition(PILOT_AGENT, "pa.drain-done")).toMatchObject({ from: "draining", to: "ended", emits: ["tx.kill"] });
    expect(transition(PILOT_AGENT, "pa.zero")).toMatchObject({ from: "polling", to: "ended", emits: ["tx.kill"] });
    expect(PILOT_AGENT.over).toBeUndefined();
  });
});
