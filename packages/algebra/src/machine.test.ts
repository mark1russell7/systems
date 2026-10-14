import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.ts";
import { machineProblems, machineSchema } from "./machine.ts";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SLUGS = ["ioredis-status", "linux-tcp", "nf-conntrack-tcp", "redis-client"];

const machine = async (slug: string): Promise<Machine> =>
  machineSchema.parse(JSON.parse(await readFile(join(fixtures, `${slug}.json`), "utf8")));

describe("a machine document", () => {
  it("holds four machines, each a consistent mark1russell7.machine/1 document", async () => {
    for (const slug of SLUGS) {
      const doc = await machine(slug);
      expect(doc.format, slug).toBe("mark1russell7.machine/1");
      expect(machineProblems(doc), slug).toEqual([]);
    }
    // the format is a contract: a document in another format is refused
    const tcp = JSON.parse(await readFile(join(fixtures, "linux-tcp.json"), "utf8")) as Machine;
    expect(machineSchema.safeParse({ ...tcp, format: "jarvis.machine/1" }).success).toBe(false);
  });

  it("checks what a machine says of the machine it runs on: its states, its end, what it sets", async () => {
    const ioredis = await machine("ioredis-status");
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

  it("lets only a timer with a backoff read how many times it has fired", async () => {
    const tcp = await machine("linux-tcp");
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
