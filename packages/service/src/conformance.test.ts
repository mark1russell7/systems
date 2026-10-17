import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { httpTransport, pathOf } from "./http.ts";
import type { HttpKnobs } from "./http.ts";
import { FakeServer } from "./http/fake-server.ts";
import type { FakeSocket } from "./http/fake-server.ts";
import type { TransportImpl } from "./lifecycle.ts";
import type { HeldWork, TransportSubject } from "./testing.ts";
import { transportConformance } from "./testing.ts";

/**
 * SYS-4: the conformance kit of a transport. A reference transport passes each case, and each
 * mutation of it fails the case of the part that it breaks. The HTTP transport passes the kit on a
 * fake server here, for its requests and for its upgraded connections. The kit on real sockets and
 * the real clock runs in CI only (HTTP_IT=1, src/http/http-it.test.ts).
 */

type Mutation =
  | "none"
  | "takes work after stopIntake"
  | "a drain that ignores its deadline"
  | "a drain that ends at once"
  | "a drain that throws"
  | "a drain that keeps the abort"
  | "a count that does not drop"
  | "a count on a timer"
  | "a close that keeps the work"
  | "a close that throws the second time";

interface Work {
  aborted: boolean;
}

/** A reference transport: work in memory, a count from events, and a drain on the clock. */
const reference =
  (mutation: Mutation = "none") =>
  (clock: Clock): TransportSubject => {
    let intake = true;
    let closes = 0;
    const works = new Set<Work>();
    const idle = new Set<() => void>();
    let polled = 0;
    if (mutation === "a count on a timer") {
      const poll = (): void => {
        polled = works.size;
        clock.after(50, poll);
      };
      poll();
    }
    const settle = (): void => {
      if (works.size === 0) for (const done of [...idle]) done();
    };
    const impl: TransportImpl = {
      start() {},
      stopIntake() {
        if (mutation !== "takes work after stopIntake") intake = false;
      },
      drain(deadline, signal) {
        if (mutation === "a drain that throws") throw new Error("the drain threw");
        const abort = (): void => {
          if (mutation === "a drain that keeps the abort") return;
          for (const work of works) work.aborted = true;
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        if (works.size === 0 || deadline <= clock.now() || mutation === "a drain that ends at once") return Promise.resolve();
        return new Promise<void>((resolve) => {
          const done = (): void => {
            idle.delete(done);
            cancel();
            resolve();
          };
          idle.add(done);
          const cancel = mutation === "a drain that ignores its deadline" ? () => {} : clock.after(Math.max(0, deadline - clock.now()), done);
        });
      },
      inFlight: () => (mutation === "a count on a timer" ? polled : works.size),
      close() {
        closes += 1;
        if (mutation === "a close that throws the second time" && closes > 1) throw new Error("the second close threw");
        intake = false;
        if (mutation !== "a close that keeps the work") works.clear();
        settle();
      },
    };
    return {
      impl,
      async offer() {
        return intake;
      },
      async hold(): Promise<HeldWork> {
        const work: Work = { aborted: false };
        works.add(work);
        return {
          release: async () => {
            if (mutation !== "a count that does not drop") works.delete(work);
            settle();
          },
          get aborted() {
            return work.aborted;
          },
        };
      },
    };
  };

/** This function runs each case, and gives the names of the cases that fail. */
const failing = async (subject: (clock: Clock) => TransportSubject): Promise<string[]> => {
  const failed: string[] = [];
  for (const each of transportConformance(subject, { name: "mutant", slack: 30, closeBound: 100 }))
    await each.run().catch(() => failed.push(each.name.replace("mutant: ", "")));
  return failed;
};

describe("transportConformance: the cases of the contract of a transport", () => {
  const cases = transportConformance(reference(), { name: "reference" });

  it("generates a case for each part of the contract", () => {
    expect(cases.map((each) => each.name)).toEqual([
      "reference: nothing is in flight after the start, and it takes new work",
      "reference: the count follows each work in flight from its events, with no move of the clock",
      "reference: stopIntake refuses new work, keeps the work in flight, and a second stop has no effect",
      "reference: drain ends at once when nothing is in flight",
      "reference: drain ends when the last work ends, before its deadline",
      "reference: drain holds to its deadline and not past it, and does not throw",
      "reference: drain gives the cooperative abort to the work in flight",
      "reference: drain with an aborted signal and a deadline in the past ends at once",
      "reference: close ends the work in flight, in its bound",
      "reference: close is idempotent: a second close has no effect",
      "reference: close right after the start ends in its bound",
      "reference: the stages in their sequence: stop intake, drain with its cooperative abort, close",
    ]);
    expect(transportConformance(reference(), { cooperative: false }).map((each) => each.name)).not.toContain(
      "transport: drain gives the cooperative abort to the work in flight",
    );
  });

  it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
    await each.run();
  });

  it.each<[Mutation, string]>([
    ["takes work after stopIntake", "stopIntake refuses new work, keeps the work in flight, and a second stop has no effect"],
    ["a drain that ignores its deadline", "drain holds to its deadline and not past it, and does not throw"],
    ["a drain that ends at once", "drain ends when the last work ends, before its deadline"],
    ["a drain that throws", "drain ends at once when nothing is in flight"],
    ["a drain that keeps the abort", "drain gives the cooperative abort to the work in flight"],
    ["a count that does not drop", "the count follows each work in flight from its events, with no move of the clock"],
    ["a count on a timer", "the count follows each work in flight from its events, with no move of the clock"],
    ["a close that keeps the work", "close ends the work in flight, in its bound"],
    ["a close that throws the second time", "close is idempotent: a second close has no effect"],
  ])("finds a transport with %s", async (mutation, part) => {
    expect(await failing(reference(mutation))).toContain(part);
  });

  it("gives the message of the part that fails", async () => {
    const stop = transportConformance(reference("takes work after stopIntake"), { name: "queue" })[2]!;
    await expect(stop.run()).rejects.toThrow("queue: the transport took new work after stopIntake");
  });
});

const s = (value: number) => ({ value, unit: "s" });
const KNOBS: HttpKnobs = { server_idle_close: s(65), idle_sweep: s(1), retry_after: s(1) };

interface Holder {
  readonly end: () => void;
  readonly aborted: () => boolean;
}

/** The HTTP transport on a fake server: `/ok` answers at once, and `/hold` and `/ws` hold until their release. */
const httpSubject =
  (kind: "request" | "upgrade") =>
  (clock: Clock): TransportSubject => {
    const server = new FakeServer();
    const transport = httpTransport(server.asServer, KNOBS, { listen: { port: 0 }, clock });
    const waiting = new Map<string, (holder: Holder) => void>();
    const idOf = (url: string | undefined): string => new URLSearchParams((url ?? "").split("?")[1] ?? "").get("id") ?? "";
    let next = 0;
    transport.mount((req, res) => {
      if (pathOf(req.url) !== "/ok") return false;
      res.writeHead(200).end("ok");
      return true;
    });
    transport.mount((req, res, context) => {
      if (pathOf(req.url) !== "/hold") return false;
      waiting.get(idOf(req.url))?.({ end: () => res.end("held"), aborted: () => context.signal.aborted });
      return true;
    });
    transport.upgrade("/ws", (req, socket, _head, context) => {
      waiting.get(idOf(req.url))?.({ end: () => socket.end(), aborted: () => context.signal.aborted });
    });
    return {
      impl: transport,
      async offer() {
        try {
          return (await server.request("/ok")).status === 200;
        } catch {
          return false;
        }
      },
      async hold() {
        const id = String((next += 1));
        const entered = new Promise<Holder>((resolve) => waiting.set(id, resolve));
        let ended: Promise<unknown>;
        if (kind === "request") ended = server.request(`/hold?id=${id}`).catch(() => undefined);
        else {
          const socket: FakeSocket = server.connect().upgrade(`/ws?id=${id}`);
          ended = new Promise((resolve) => socket.once("close", resolve));
        }
        const holder = await entered;
        return {
          release: async () => {
            holder.end();
            await ended;
          },
          get aborted() {
            return holder.aborted();
          },
        };
      },
    };
  };

describe("httpTransport passes the conformance kit on a fake server", () => {
  for (const kind of ["request", "upgrade"] as const) {
    const cases = transportConformance(httpSubject(kind), { name: `http ${kind}` });
    it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
      await each.run();
    });
  }
});
