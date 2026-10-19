import type { Machine } from "@mark1russell7/algebra";
import { algebraProblems, detection, machineProblems, machineSchema, timerOf } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import * as root from "./index.ts";
import { IOREDIS_STATUS, LINUX_TCP, MACHINES, MANIFESTATIONS, PGPOOL_SESSION, SUPAVISOR_CLIENT, SUPAVISOR_SERVER } from "./index.ts";

/** This function gives the values of the knobs of a document at its defaults. A knob at its off value has no bound. */
const defaults = (doc: Machine) => (name: string) => {
  const knob = doc.knobs[name];
  if (knob === undefined || knob.unit === null || knob.default === null) return undefined;
  return { value: knob.off !== undefined && knob.default === knob.off ? ("infinite" as const) : knob.default, unit: knob.unit };
};

describe("the machine documents", () => {
  it("holds each document once, by its identifier, each a consistent mark1russell7.machine/1 document", () => {
    const documents = Object.values(root).filter(
      (value): value is Machine => typeof value === "object" && value !== null && "format" in value,
    );
    expect(documents.length).toBe(30);
    expect(Object.keys(MACHINES).sort()).toEqual(documents.map((doc) => doc.id).sort());
    for (const [id, doc] of Object.entries(MACHINES)) {
      expect(doc.id, id).toBe(id);
      expect(doc.format, id).toBe("mark1russell7.machine/1");
      expect(machineSchema.safeParse(doc).success, id).toBe(true);
      expect(machineProblems(doc), id).toEqual([]);
      expect(algebraProblems(doc), id).toEqual([]);
      expect(doc.sources.length, id).toBeGreaterThan(0);
    }
    // the format is a contract: a document in another format is refused
    expect(machineSchema.safeParse({ ...LINUX_TCP, format: "another.machine/1" }).success).toBe(false);
  });

  it("names the machine below each document by its identifier in a graph, and each one is a document here", () => {
    for (const doc of Object.values(MACHINES)) {
      if (doc.over === undefined) continue;
      expect(doc.over.machine, doc.id).toMatch(/^systems\.machine\./);
      const lower = MACHINES[doc.over.machine.replace(/^systems\.machine\./, "")];
      expect(lower, doc.id).toBeDefined();
      // each state of the document is on a state of the machine below
      for (const state of Object.values(doc.over.states)) expect(lower!.states[state], `${doc.id} on ${state}`).toBeDefined();
    }
  });

  it("lets through only events of Linux TCP, for each manifestation", () => {
    expect(Object.keys(MANIFESTATIONS).sort()).toEqual(["blackhole", "freeze-process"]);
    for (const [name, events] of Object.entries(MANIFESTATIONS))
      for (const event of events) expect(LINUX_TCP.events[event], `${name}: ${event}`).toBeDefined();
  });

  it("checks what a machine says of the machine it runs on: its states, its end, what it sets", () => {
    const ioredis = IOREDIS_STATUS;
    expect(ioredis.over?.machine).toBe("systems.machine.linux-tcp");
    const wrong: Machine = {
      ...ioredis,
      over: {
        machine: "systems.machine.linux-tcp",
        states: { asleep: "ESTABLISHED" },
        sets: { keepidle: { knob: "nonesuch", unit: "s" } },
        ends: "stream.vanished",
      },
    };
    expect(machineProblems(wrong)).toEqual([
      "over: state asleep",
      "over: ends stream.vanished",
      "over: sets keepidle from knob nonesuch",
    ]);
  });

  it("gives Pgpool-II no timer that ends a query in flight, and a probe of the client each 30 s", () => {
    const doc = PGPOOL_SESSION;
    const values = (name: string) => {
      const knob = doc.knobs[name];
      if (knob === undefined || knob.unit === null || knob.default === null) return undefined;
      return { value: knob.off !== undefined && knob.default === knob.off ? ("infinite" as const) : knob.default, unit: knob.unit };
    };
    // a wait for the backend: the probe starts again each 30 s, thus it is no detector
    const waiting = detection(doc, { state: "waiting", inFlight: true }, { name: "blackhole", passes: [] }, values);
    expect(waiting.detectors).toEqual([]);
    expect(doc.timers["probe"]?.backoff).toEqual({ resets: ["enter:waiting"] });
    expect(timerOf(doc, "probe", values).duration).toEqual({ value: 30, unit: "s" });
    // between two queries: client_idle_limit is off at the defaults, and one tick after its limit when set
    expect(timerOf(doc, "client_idle_limit", values).duration).toEqual({ value: "infinite", unit: "s" });
    const set = (name: string) => (name === "client_idle_limit" ? { value: 12, unit: "s" } : values(name));
    expect(timerOf(doc, "client_idle_limit", set).duration).toEqual({ value: 13, unit: "s" });
    // the FIN of the backend ends the session with a FATAL error, and a reset with a request of failover
    expect(doc.transitions.find((t) => t.id === "pps.backend-eof")).toMatchObject({ to: "ended", errno: "XX000", emits: ["tx.error"] });
    expect(doc.transitions.find((t) => t.id === "pps.backend-error")).toMatchObject({ to: "ended", emits: ["tx.failover"] });
  });

  it("gives Supavisor a heartbeat of an idle client each 60 s, and no idle timer that ends a session", () => {
    const client = SUPAVISOR_CLIENT;
    const values = defaults(client);
    // between two transactions the heartbeat starts again each 60 s, thus it is no detector of the client
    const idle = detection(client, { state: "idle", inFlight: false }, { name: "blackhole", passes: [] }, values);
    expect(idle.detectors).toEqual([]);
    expect(timerOf(client, "heartbeat", values).duration).toEqual({ value: 60, unit: "s" });
    expect(client.timers["heartbeat"]?.backoff).toEqual({ resets: ["enter:idle"] });
    // client_idle_timeout fires an event that no clause takes: the document gives it no timer
    expect(Object.values(client.timers).some((timer) => "knob" in timer.duration && timer.duration.knob === "client_idle_timeout")).toBe(false);
    // a checkout waits 15 s for a server connection, then FATAL XX000
    expect(timerOf(client, "checkout_timeout", values).duration).toEqual({ value: 15000, unit: "ms" });
    expect(client.transitions.find((t) => t.id === "scl.checkout-timed-out")).toMatchObject({ to: "ended", errno: "XX000", emits: ["tx.error"] });
  });

  it("gives a server connection of Supavisor a connect of 5 s, FATAL 08006 at a failure, and no keepalive", () => {
    const server = SUPAVISOR_SERVER;
    const values = defaults(server);
    expect(timerOf(server, "connect_timeout", values).duration).toEqual({ value: 5000, unit: "ms" });
    expect(timerOf(server, "cooldown", values).duration).toEqual({ value: 2500, unit: "ms" });
    expect(server.transitions.find((t) => t.id === "ssv.connect-failed")).toMatchObject({ to: "ended", errno: "08006" });
    // the server socket has no keepalive: keepidle has no bound
    expect(values("keepalive_idle")).toEqual({ value: "infinite", unit: "s" });
    expect(server.over?.states["connecting"]).toBe("SYN_SENT");
  });

  it("lets only a timer with a backoff read how many times it has fired", () => {
    const tcp = LINUX_TCP;
    expect(tcp.timers["retransmit"]?.backoff).toEqual({ resets: ["rx.ack"] });
    const wrong: Machine = {
      ...tcp,
      knobs: { ...tcp.knobs, fired: { key: "fired", scope: "socket", unit: "count", default: 0 } },
      timers: {
        ...tcp.timers,
        retransmit: { ...tcp.timers["retransmit"]!, backoff: undefined },
        keepalive: { ...tcp.timers["keepalive"]!, backoff: { resets: ["rx.nonesuch"] } },
      },
    };
    expect(machineProblems(wrong)).toEqual([
      "knob fired: the name is a backoff timer's count of its firings",
      "timer retransmit: reads fired, but has no backoff",
      "timer keepalive: backoff resets on rx.nonesuch",
    ]);
  });
});
