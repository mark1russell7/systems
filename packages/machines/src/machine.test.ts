import type { Machine } from "@mark1russell7/algebra";
import { algebraProblems, machineProblems, machineSchema } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import * as root from "./index.ts";
import { IOREDIS_STATUS, LINUX_TCP, MACHINES, MANIFESTATIONS } from "./index.ts";

describe("the machine documents", () => {
  it("holds each document once, by its identifier, each a consistent mark1russell7.machine/1 document", () => {
    const documents = Object.values(root).filter(
      (value): value is Machine => typeof value === "object" && value !== null && "format" in value,
    );
    expect(documents.length).toBe(17);
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
