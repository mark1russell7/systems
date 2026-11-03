import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { handle, httpTransport, ndjson, pathOf } from "./http.ts";
import type { HttpKnobs } from "./http.ts";
import { FakeServer } from "./http/fake-server.ts";
import type { FakeConnection, FakeSocket } from "./http/fake-server.ts";
import type { Lifecycle, TransportImpl } from "./lifecycle.ts";
import type { CallerView, HeldWork, SeenEnd, StreamCall, TransportSubject } from "./testing.ts";
import { fakeClock, transportConformance } from "./testing.ts";

/**
 * SYS-4 and SYS-6: the conformance kit of a transport. A reference transport passes each case, and
 * each mutation of it fails the case of the part that it breaks. The HTTP transport passes the kit
 * on a fake server here, for its requests and for its upgraded connections, and for its streams. The
 * kit on real sockets and the real clock runs in CI only (HTTP_IT=1, src/http/http-it.test.ts).
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
  | "a close that throws the second time"
  | "a unary answer in the body of a stream"
  | "a stream that leaves the count at its first item"
  | "a failure after the first item as a status"
  | "a drain that does not wait for streams"
  | "a writer that drops the end of a cut";

interface Work {
  aborted: boolean;
  /** This flag tells that the work is the answer of a stream call. */
  readonly stream?: boolean;
}

/**
 * A reference transport: work in memory, a count from events, and a drain on the clock. A call
 * goes to `life.request`, and the reference writes its stream to a view of the caller.
 */
const reference =
  (mutation: Mutation = "none") =>
  (clock: Clock): TransportSubject => {
    let intake = true;
    let closes = 0;
    let life: Lifecycle | null = null;
    const works = new Set<Work>();
    const idle = new Set<() => void>();
    let polled = 0;
    // the works that hold the drain: a mutant drain does not wait for the answers of the streams
    const holding = (): number =>
      mutation === "a drain that does not wait for streams" ? [...works].filter((work) => work.stream !== true).length : works.size;
    if (mutation === "a count on a timer") {
      const poll = (): void => {
        polled = works.size;
        clock.after(50, poll);
      };
      poll();
    }
    const settle = (): void => {
      if (holding() === 0) for (const done of [...idle]) done();
    };
    const impl: TransportImpl = {
      start(_signal, given) {
        life = given;
      },
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
        if (holding() === 0 || deadline <= clock.now() || mutation === "a drain that ends at once") return Promise.resolve();
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
      call(call: StreamCall): CallerView {
        const view: { items: unknown[]; end: SeenEnd | null } = { items: [], end: null };
        const answer: Work = { aborted: false, stream: true };
        works.add(answer);
        const leave = (): void => {
          works.delete(answer);
          settle();
        };
        const events = life!.request(call.controller, call.route, call.work);
        void (async () => {
          if (!call.stream) {
            const { items, end } = await events.collect();
            view.items.push(...items);
            view.end = { kind: end.kind, inBand: mutation === "a unary answer in the body of a stream" };
            leave();
            return;
          }
          for await (const event of events) {
            if (event.kind === "item") {
              view.items.push(event.value);
              if (mutation === "a stream that leaves the count at its first item") leave();
              continue;
            }
            // an end after the first item goes in the body: the status went with the first item
            const inBand = view.items.length > 0 && !(mutation === "a failure after the first item as a status" && event.kind === "failed");
            if (!(mutation === "a writer that drops the end of a cut" && event.kind === "cut")) view.end = { kind: event.kind, inBand };
            break;
          }
          leave();
        })();
        return view;
      },
    };
  };

/** This function runs each case, and gives the names of the cases that fail. */
const failing = async (subject: (clock: Clock) => TransportSubject): Promise<string[]> => {
  const failed: string[] = [];
  for (const each of transportConformance(subject, { name: "mutant", slack: 30, closeBound: 100, streams: true }))
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

  it("adds a case for each part of the streams with the option streams", () => {
    const names = transportConformance(reference(), { name: "reference", streams: true }).map((each) => each.name);
    expect(names.slice(0, cases.length)).toEqual(cases.map((each) => each.name));
    expect(names.slice(cases.length)).toEqual([
      "reference: a unary call is a stream of one item: one value, and its end as the status",
      "reference: a stream stays in flight until its end, not until its first item",
      "reference: a failure after the first item ends the stream with an error line, not a status",
      "reference: a failure before the first item gets a status, not an error line",
      "reference: drain waits for an open stream, and the cooperative abort ends the stream with its end",
      "reference: drain cuts an open stream at its deadline, and the caller gets the end of the cut",
    ]);
  });

  it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
    await each.run();
  });

  const streamCases = transportConformance(reference(), { name: "reference", streams: true }).slice(cases.length);
  it.each(streamCases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
    await each.run();
  });

  it("refuses the option streams for a subject without call()", async () => {
    const { call: _call, ...plain } = reference()(fakeClock());
    const last = transportConformance(() => plain, { name: "plain", streams: true }).at(-1)!;
    await expect(last.run()).rejects.toThrow("plain: the option streams needs a subject that gives call()");
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
    ["a unary answer in the body of a stream", "a unary call is a stream of one item: one value, and its end as the status"],
    ["a stream that leaves the count at its first item", "a stream stays in flight until its end, not until its first item"],
    ["a failure after the first item as a status", "a failure after the first item ends the stream with an error line, not a status"],
    ["a drain that does not wait for streams", "drain waits for an open stream, and the cooperative abort ends the stream with its end"],
    ["a writer that drops the end of a cut", "drain cuts an open stream at its deadline, and the caller gets the end of the cut"],
  ])("finds a transport with %s", async (mutation, part) => {
    expect(await failing(reference(mutation))).toContain(part);
  });

  it("gives the message of the part that fails", async () => {
    const stop = transportConformance(reference("takes work after stopIntake"), { name: "queue" })[2]!;
    await expect(stop.run()).rejects.toThrow("queue: the transport took new work after stopIntake");
  });
});

const s = (value: number) => ({ value, unit: "s" });
const KNOBS: HttpKnobs = { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) };

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
    // `/call` gives the work of the kit to `handle`, thus to `life.request`, unary or as NDJSON
    const calls = new Map<string, StreamCall>();
    transport.mount((req, res, context) => {
      const call = pathOf(req.url) === "/call" ? calls.get(idOf(req.url)) : undefined;
      if (call === undefined) return false;
      // a function gives the route of the kit, because the route is not the method and the path of the request
      return handle(call.controller, () => call.route, (_req, signal) => call.work(signal), call.stream ? { stream: ndjson } : {})(req, res, context);
    });
    /** This function reads what the client of a call has: a unary answer at its end, or each whole line of a stream. */
    const viewOf = (connection: FakeConnection): CallerView => {
      const response = connection.response;
      if (response === null || !response.headersSent) return { items: [], end: null };
      const body = response.chunks.join("");
      if (response.statusCode !== 200 || !(response.getHeader("content-type") ?? "").includes("ndjson")) {
        if (!response.writableEnded) return { items: [], end: null };
        if (response.statusCode === 204) return { items: [], end: { kind: "done", inBand: false } };
        const value: unknown = JSON.parse(body);
        if (response.statusCode === 200) return { items: [value], end: { kind: "done", inBand: false } };
        return { items: [], end: { kind: (value as { end: SeenEnd["kind"] }).end, inBand: false } };
      }
      const items: unknown[] = [];
      let end: SeenEnd | null = null;
      // the part after the last newline is a line that did not end
      for (const line of body.split("\n").slice(0, -1)) {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null && "end" in value) end = { kind: (value as { end: SeenEnd["kind"] }).end, inBand: true };
        else items.push(value);
      }
      return { items, end };
    };
    return {
      impl: transport,
      call(call) {
        const id = String((next += 1));
        calls.set(id, call);
        const connection = server.connect();
        void connection.request(`/call?id=${id}`).catch(() => undefined);
        return {
          get items() {
            return viewOf(connection).items;
          },
          get end() {
            return viewOf(connection).end;
          },
        };
      },
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
    // the streams of a call are answers of requests, thus only the requests give them
    const cases = transportConformance(httpSubject(kind), { name: `http ${kind}`, streams: kind === "request" });
    it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
      await each.run();
    });
  }
});
