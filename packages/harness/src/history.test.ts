import { describe, expect, it } from "vitest";
import type { Cell, HistoryVerdict, ProbeEvent, Run } from "./cell.ts";
import { historyOf, historyText, measureEtcd, verdictOfText } from "./history.ts";

const s = (seconds: number) => Math.round(seconds * 1e9);

describe("the history of a client of etcd", () => {
  it("keeps each whole operation in the form of the checker, and no other field", () => {
    const events: ProbeEvent[] = [
      { ev: "start", t: 1 },
      { ev: "op", t: 5, worker: 0, at: "http://10.0.0.2:2379", client: 0, op: "put", key: "k1", value: "0-0", call: 2, return: 4, result: "ok" },
      { ev: "op", t: 9, worker: 1, at: "http://10.0.0.3:2379", client: 1, op: "get", key: "k1", value: null, call: 6, return: 8, result: "ok" },
      { ev: "op", t: 12, worker: 2, client: 2, op: "put", key: "k2", value: "2-0", call: 10, result: "unknown", error: "context deadline exceeded" },
      { ev: "op", t: 14, worker: 0, client: 0, op: "get", key: "k2", call: 11, return: 13, result: "fail", error: "context deadline exceeded" },
      // not a whole operation: no key, and a result that the checker does not know
      { ev: "op", t: 15, client: 0, op: "get", call: 1, result: "ok" },
      { ev: "op", t: 16, client: 0, op: "get", key: "k3", call: 1, result: "maybe" },
    ];
    const history = historyOf(events);
    expect(history).toEqual([
      { client: 0, op: "put", key: "k1", value: "0-0", call: 2, return: 4, result: "ok" },
      { client: 1, op: "get", key: "k1", value: null, call: 6, return: 8, result: "ok" },
      { client: 2, op: "put", key: "k2", value: "2-0", call: 10, result: "unknown" },
      { client: 0, op: "get", key: "k2", call: 11, return: 13, result: "fail" },
    ]);
    expect(historyText(history).split("\n")).toHaveLength(5);
    expect(JSON.parse(historyText(history).split("\n")[1]!)).toEqual(history[1]);
  });

  it("reads the last verdict line of the checker, and gives null without one", () => {
    const text = [
      "a line of Go",
      '{"ev":"checked","result":"Illegal","operations":40,"keys":2,"illegal":["k1"],"undecided":[],"dropped":3,"unknown":1}',
      "",
    ].join("\n");
    expect(verdictOfText(text)).toEqual({ result: "Illegal", operations: 40, keys: 2, illegal: ["k1"], undecided: [], dropped: 3, unknown: 1 });
    expect(verdictOfText('{"ev":"checked","result":"Maybe"}')).toBeNull();
    expect(verdictOfText("nothing")).toBeNull();
  });
});

describe("a run of an etcd cell, measured", () => {
  const cell = {
    name: "RD.linearizable.follower",
    etcd: { image: { kind: "pinned", image: "x@sha256:0" }, members: ["e1", "e2", "e3"], port: 2379, peerPort: 2380, programs: { server: "etcd" } },
    prediction: { detects: null, window: { value: 30, unit: "s" }, why: "", history: "Ok" },
  } as unknown as Cell;
  const OK: HistoryVerdict = { result: "Ok", operations: 4, keys: 1, illegal: [], undecided: [], dropped: 1, unknown: 1 };
  const op = (t: number, at: string, kind: "put" | "get", result: string) => ({ ev: "op", t: s(t), at, op: kind, key: "k1", client: 0, call: s(t), result });
  const run: Run = {
    environment: 0,
    index: 0,
    events: [
      { ev: "ready", t: s(0.1) },
      op(1, "http://10.0.0.2:2379", "put", "ok"),
      // the cut member, e1, in the hold: its put is unknown, and its get fails
      op(11, "http://10.0.0.2:2379", "put", "unknown"),
      op(12, "http://10.0.0.2:2379", "get", "fail"),
      op(12, "http://10.0.0.3:2379", "get", "ok"),
      { ev: "done", t: s(30) },
    ],
    fault: { t0: s(10), t1: s(10.001) },
    heal: { t0: s(20), t1: s(20.001) },
    kernel: [],
    netns: 7,
    targetNetns: 1,
    lost: null,
    history: OK,
    group: {
      members: { e1: { ip: "10.0.0.2", netns: 1 }, e2: { ip: "10.0.0.3", netns: 2 }, e3: { ip: "10.0.0.4", netns: 3 } },
      sentinels: {},
      primary: "e2",
      at: "e1",
      timeline: [],
      after: "e2",
      holds: null,
    },
  };

  it("counts the operations of the cut member in the hold by kind, and holds with the verdict of the prediction", () => {
    const read = measureEtcd(cell, run);
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.history.ops).toEqual({ ok: 2, fail: 1, unknown: 1 });
    expect(read.history.cut).toEqual({ put: { ok: 0, fail: 0, unknown: 1 }, get: { ok: 0, fail: 1, unknown: 0 } });
  });

  it("gives a finding for another verdict, and names each key with no linearization", () => {
    const read = measureEtcd(cell, { ...run, history: { ...OK, result: "Illegal", illegal: ["k1"] } });
    expect(read.finding).toBe("the history is Illegal, not Ok: no linearization of k1");
  });

  it("is void with no done line, no verdict, a timeout of the check, or no operation of the cut member in the hold", () => {
    expect(measureEtcd(cell, { ...run, events: run.events.filter((event) => event.ev !== "done") }).void).toMatch(/no done line/);
    expect(measureEtcd(cell, { ...run, history: null }).void).toBe("the checker gave no verdict");
    expect(measureEtcd(cell, { ...run, history: { ...OK, result: "Unknown", undecided: ["k1"] } }).void).toBe("the check reached its timeout on k1");
    expect(measureEtcd(cell, { ...run, group: { ...run.group!, at: "e3" } }).void).toMatch(/no operation at the cut member e3/);
  });
});
