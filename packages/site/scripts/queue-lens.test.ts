/**
 * The lenses of the accept queue agree with the cells AQ.1 to AQ.10: each count of the page is a count of
 * the cell, and each time of the page is inside the band of the cell. The page puts one half of the round
 * trip on each way of the path, and the cell puts the whole round trip on the egress of the target. Thus
 * a time at the target can differ by one half of the round trip. The slack of each band of the cell holds it.
 */
import { valueIn, type Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ACCEPT_QUEUE_SPECS, SERVICE_QUEUE_SPECS, synAckExpiry, synAckFiring, synAckWait, synGiveup, synWait, type QueueSpec } from "../../cells/src/accept-queue.ts";
import { HZ } from "../../cells/src/catalog.ts";
import { controlsOf, lanesOf, type Lens } from "../src/model/lens.ts";
import { QUEUE_DEFAULTS, listenBacklog, queueLenses, queueModel, type QueueSettings } from "../src/model/lenses/accept-queue.ts";
import { ms, s } from "../src/model/path.ts";

/** This round trip is the latency of the cells with `latency`: 20 ms on the egress of the target. */
const RTT = ms(20);
const HALF = 0.01;

/** This function gives the two ends of a band in seconds. */
const seconds = (band: { readonly low: Quantity; readonly high: Quantity }): { low: number; high: number } => ({ low: valueIn(band.low, "s"), high: valueIn(band.high, "s") });

/** This function checks that a time is inside a band of a cell, with a margin for the rounding of the band. */
const inside = (at: number, band: { readonly low: Quantity; readonly high: Quantity }, what: string): void => {
  const { low, high } = seconds(band);
  expect(at, `${what}: ${at} in ${low} to ${high}`).toBeGreaterThanOrEqual(low - 1e-6);
  expect(at, `${what}: ${at} in ${low} to ${high}`).toBeLessThanOrEqual(high + 1e-6);
};

/** This function gives the value of a flag of the client of a cell. */
const flag = (spec: QueueSpec, name: string): number => {
  const i = spec.flags.indexOf(name);
  const value = spec.flags[i + 1];
  if (i < 0 || value === undefined) throw new Error(`${spec.plan} has no ${name}`);
  return Number(value);
};

/** This function gives a connection of a cell by its name. */
const connection = (spec: QueueSpec, name: string) => {
  const found = spec.queue.connections.find((c) => c.name === name);
  if (found === undefined) throw new Error(`${spec.plan} has no connection ${name}`);
  return found;
};

const spec = (plan: string): QueueSpec => {
  const found = [...ACCEPT_QUEUE_SPECS, ...SERVICE_QUEUE_SPECS].find((s) => s.plan === plan);
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the settings of the burst of the cells AQ.5 to AQ.7: 4 in the queue, and three connects at once. */
const BURST: QueueSettings = { ...QUEUE_DEFAULTS, rtt: RTT, hz: HZ };

describe("the lenses of the accept queue and the cells", () => {
  const counts = [...ACCEPT_QUEUE_SPECS.filter((s) => ["AQ.1", "AQ.2", "AQ.3"].includes(s.plan)), ...SERVICE_QUEUE_SPECS].map((s) => [s.plan, s] as const);

  it.each(counts)("%s: the count of the page is the count of the cell", (_, cell) => {
    const settings: QueueSettings = {
      ...QUEUE_DEFAULTS,
      listener: SERVICE_QUEUE_SPECS.includes(cell) ? "node" : "native",
      backlog: cell.backlog,
      somaxconn: cell.somaxconn,
      queued: 0,
      connections: flag(cell, "--fill"),
      arrival: "turn",
      rtt: ms(1),
      hz: HZ,
    };
    const model = queueModel(settings);
    expect(model.limit).toBe(cell.queue.max);
    expect(model.held).toBe(cell.queue.held);
    expect(model.admitted).toBe(cell.queue.connected);
    expect(model.synDrops + model.ackDrops).toBe(cell.queue.overflows.low);
    expect(cell.queue.overflows.high).toBe(cell.queue.overflows.low);
  });

  it("AQ.10: Node gives listen(2) 511 for a backlog of 0, and a native program gives 0", () => {
    expect(listenBacklog({ ...QUEUE_DEFAULTS, listener: "node", backlog: 0 })).toBe(511);
    expect(listenBacklog({ ...QUEUE_DEFAULTS, listener: "native", backlog: 0 })).toBe(0);
    expect(queueModel({ ...QUEUE_DEFAULTS, listener: "node", backlog: 0, queued: 0, connections: 514, arrival: "turn" }).held).toBe(512);
  });

  it("AQ.4: a SYN at a full queue meets the SYN ladder of the client, and ETIMEDOUT", () => {
    const cell = spec("AQ.4");
    const model = queueModel({ ...QUEUE_DEFAULTS, backlog: cell.backlog, queued: flag(cell, "--fill"), connections: 1, rtt: ms(1), hz: HZ });
    expect(model.held).toBe(cell.queue.held);
    expect(model.start).toBe(cell.queue.connected);
    const story = model.syn;
    if (story === null) throw new Error("no SYN drops");
    const blocked = connection(cell, "blocked");
    const syns = blocked.syns ?? [];
    expect(story.syns).toHaveLength(syns.length);
    // each SYN of the client is one overflow
    expect(story.syns.length + 1).toBe(cell.queue.overflows.low);
    story.syns.forEach((firing, k) => inside(firing.at - (story.syns[k - 1]?.at ?? story.dial), syns[k] ?? synWait(k), `the wait ${k} of the SYN`));
    expect(story.end.kind).toBe("timeout");
    inside(story.end.at - story.dial, blocked.ends?.within ?? synGiveup(), "the end of the connect");
  });

  it("AQ.5: the client connects, five SYN-ACKs come again, and the target forgets the request at 63 s", () => {
    const cell = spec("AQ.5");
    const model = queueModel(BURST);
    expect(model.held).toBe(cell.queue.held);
    expect(model.start + model.admitted + model.ackDrops).toBe(cell.queue.connected);
    expect(model.synDrops + model.ackDrops).toBeGreaterThanOrEqual(cell.queue.overflows.low);
    const story = model.ack;
    if (story === null || story.expiry === null) throw new Error("no final ACK overflows");
    const waits = connection(cell, "busy").synAcks ?? [];
    expect(story.synAcks).toHaveLength(waits.length);
    // the client gets each SYN-ACK one half of the round trip after the firing
    story.synAcks.forEach((firing, k) => inside(firing.at + HALF - ((story.synAcks[k - 1]?.at ?? story.dial - HALF) + HALF), waits[k] ?? synAckWait(k), `the wait ${k} of the SYN-ACK`));
    inside(story.expiry.at - (story.dial + HALF), cell.queue.expiry?.within ?? synAckExpiry(), "the expiry of the request");
    expect(story.end.kind).toBe("blind");
  });

  it("AQ.5 busy: the retransmissions of the client meet the reset after the expiry", () => {
    const cell = spec("AQ.5");
    const story = queueModel({ ...BURST, send: "connected" }).ack;
    if (story === null) throw new Error("no final ACK overflows");
    const ends = connection(cell, "busy").ends;
    if (ends === null) throw new Error("the busy connection has no end");
    expect(story.end.kind).toBe("reset");
    expect(story.end.by).toBe("expiry");
    inside((story.end.at ?? 0) - story.dial, ends.within, "the reset of the busy connection");
  });

  it("AQ.5 quiet: a send after the expiry meets a reset one round trip later", () => {
    const cell = spec("AQ.5");
    const story = queueModel({ ...BURST, send: "later", sendAt: s(70) }).ack;
    if (story === null || story.send === null) throw new Error("no send");
    const ends = connection(cell, "quiet").ends;
    if (ends === null) throw new Error("the quiet connection has no end");
    expect(story.end.kind).toBe("reset");
    inside((story.end.at ?? 0) - story.send, ends.within, "the reset of the quiet connection");
  });

  it("AQ.6: tcp_abort_on_overflow 1 resets the client one round trip after it connects", () => {
    const cell = spec("AQ.6");
    const model = queueModel({ ...BURST, abort: true });
    const story = model.ack;
    if (story === null) throw new Error("no final ACK overflows");
    expect(model.ackDrops).toBe(cell.queue.resets);
    expect(story.end.kind).toBe("reset");
    expect(story.end.by).toBe("abort");
    const ends = connection(cell, "busy").ends;
    if (ends === null) throw new Error("the busy connection has no end");
    inside((story.end.at ?? 0) - story.connected, ends.within, "the reset after the connect");
  });

  it("AQ.7: after the accept, the next SYN-ACK brings a challenge ACK that finds a place", () => {
    const cell = spec("AQ.7");
    const accept = { ...BURST, accept: true, acceptAt: s(flag(cell, "--accept-at-ms") / 1000) };
    const story = queueModel(accept).ack;
    if (story === null) throw new Error("no final ACK overflows");
    expect(story.end.kind).toBe("connected");
    expect(story.end.by).toBe("synack");
    expect(story.synAcks).toHaveLength((connection(cell, "busy").synAcks ?? []).length);
    inside((story.end.at ?? 0) - story.dial, cell.queue.rise?.within ?? synAckFiring(2, 0.02), "the challenge ACK");
    // a busy client that sends at once also finds its place with the SYN-ACK
    expect(queueModel({ ...accept, send: "connected" }).ack?.end.by).toBe("synack");
  });

  it("AQ.7 blocked: a SYN after the accept finds a place at its next firing", () => {
    const cell = spec("AQ.7");
    const story = queueModel({ ...BURST, queued: 5, connections: 1, accept: true, acceptAt: s(flag(cell, "--accept-at-ms") / 1000) }).syn;
    if (story === null) throw new Error("no SYN drops");
    const syns = connection(cell, "blocked").syns ?? [];
    expect(story.end.kind).toBe("connected");
    expect(story.syns).toHaveLength(syns.length);
    story.syns.forEach((firing, k) => inside(firing.at - (story.syns[k - 1]?.at ?? story.dial), syns[k] ?? synWait(k), `the wait ${k} of the blocked SYN`));
  });
});

describe("the lenses of the accept queue", () => {
  const lenses = queueLenses();
  const all = [lenses.queue, lenses.syn, lenses.ack] as ReadonlyArray<Lens<QueueSettings>>;

  it("each knob of the settings has one control on the page", () => {
    const shown = [...controlsOf(all).values()].flat();
    expect(new Set(shown).size).toBe(shown.length);
    expect(new Set(shown)).toEqual(new Set(Object.keys(QUEUE_DEFAULTS)));
  });

  it("the defaults give a lane that detects the overflow, a silent SYN lane and a blind final ACK", () => {
    const lanes = lanesOf(all, QUEUE_DEFAULTS);
    expect(lanes.map((lane) => [lane.id, lane.verdict])).toEqual([
      ["queue", "detects"],
      ["syn", "silent"],
      ["ack", "blind"],
    ]);
  });

  it("a queue with room is silent in each lane", () => {
    const lanes = lanesOf(all, { ...QUEUE_DEFAULTS, queued: 0 });
    expect(lanes.map((lane) => lane.verdict)).toEqual(["silent", "silent", "silent"]);
  });

  it("a cookie SYN warns, and the count holds", () => {
    const settings = { ...QUEUE_DEFAULTS, queued: 0, backlog: 1, connections: 3 };
    const model = queueModel(settings);
    expect(model.cookies).toBe(2);
    expect(model.admitted).toBe(2);
    expect(lanesOf(all, settings)[0]?.warning).toContain("SYN cookie");
  });

  it("the model is pure: the same settings give the same lanes", () => {
    const settings = { ...QUEUE_DEFAULTS, send: "connected" as const };
    expect(JSON.stringify(lanesOf(all, settings))).toBe(JSON.stringify(lanesOf(all, { ...settings })));
  });
});
