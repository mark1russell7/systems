import { describe, expect, it } from "vitest";
import type { KindRun } from "./cell.ts";
import { DESIGN, cellOf } from "./cells.fixture.ts";
import { placementOf, planOf } from "./faults.ts";
import type { Line } from "./lab.ts";
import { sessionsAt } from "./observe.ts";
import { placeSlot, placementFrom } from "./place.ts";
import { FORMAT } from "./record.ts";
import { kindCellRecordSchema } from "./schema.ts";
import { factsOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const TARGET = { pod: "lab-a", node: "w1", ip: "10.244.1.3", version: "h1" };
const OTHER = { pod: "lab-b", node: "w2", ip: "10.244.2.4", version: "h1" };

/** a request of a client on its local port, answered by a pod or failed */
const request = (t: number, p: string, lp: number, b: string | null): Line => ({ ev: "req", t, d: 1, o: b === null ? "timeout" : "ok", p, n: "w1", lp, ...(b === null ? {} : { b }) });

const runWith = (lines: Line[], fault: number | null = 1000): KindRun => ({
  env: 0,
  index: 0,
  warmup: false,
  start: 0,
  end: 60_000,
  acts: { fault, heal: null, resume: null },
  target: TARGET,
  paused: null,
  replicas: [TARGET, OTHER],
  void: null,
  dropped: {},
  lines,
});

describe("the placement of the sessions of the clients", () => {
  it("gives the sessions on the target to each client in turn, and the others to the other replicas", () => {
    const clients = ["client-c", "client-a", "client-b"];
    const at = (onTarget: number) => Object.fromEntries(placementOf(clients, 2, onTarget, "lab-a", ["lab-b"]));
    expect(at(1)).toEqual({ "client-a": ["lab-a", "lab-b"], "client-b": ["lab-b", "lab-b"], "client-c": ["lab-b", "lab-b"] });
    expect(at(2)).toEqual({ "client-a": ["lab-a", "lab-b"], "client-b": ["lab-a", "lab-b"], "client-c": ["lab-b", "lab-b"] });
    expect(at(3)).toEqual({ "client-a": ["lab-a", "lab-b"], "client-b": ["lab-a", "lab-b"], "client-c": ["lab-a", "lab-b"] });
    expect(at(4)).toEqual({ "client-a": ["lab-a", "lab-a"], "client-b": ["lab-a", "lab-b"], "client-c": ["lab-a", "lab-b"] });
    expect(at(6)).toEqual({ "client-a": ["lab-a", "lab-a"], "client-b": ["lab-a", "lab-a"], "client-c": ["lab-a", "lab-a"] });
    // the other slots go to each other replica in turn
    expect(Object.fromEntries(placementOf(["client-a"], 3, 0, "lab-a", ["lab-b", "lab-c"]))).toEqual({ "client-a": ["lab-b", "lab-c", "lab-b"] });
  });

  it("refuses a count that the sessions of the clients cannot hold", () => {
    expect(() => placementOf(["client-a"], 2, 3, "lab-a", ["lab-b"])).toThrow(RangeError);
    expect(() => placementOf(["client-a"], 2, -1, "lab-a", ["lab-b"])).toThrow(RangeError);
    expect(() => placementOf(["client-a"], 0, 0, "lab-a", ["lab-b"])).toThrow(RangeError);
    expect(() => placementOf(["client-a"], 2, 1, "lab-a", [])).toThrow(RangeError);
    expect(placementOf(["client-a"], 2, 2, "lab-a", []).get("client-a")).toEqual(["lab-a", "lab-a"]);
  });

  it("writes the placement before the SIGHUP of the clients of a stall, and only for a workload with a placement", () => {
    const stall = cellOf("app-stall");
    expect(planOf(stall).prepare).toEqual([{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: s(3) }]);
    const placed = { ...stall, workload: { ...stall.workload, connections: 2, onTarget: 3 } };
    expect(planOf(placed).prepare).toEqual([{ do: "place", onTarget: 3 }, { do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: s(3) }]);
    // a placement needs the sessions of each client, and a SIGHUP of the clients before the fault
    expect(() => planOf({ ...stall, workload: { ...stall.workload, onTarget: 1 } })).toThrow(/connections/);
    const t18 = cellOf("app-stall", DESIGN, "T18");
    expect(() => planOf({ ...t18, workload: { ...t18.workload, connections: 2, onTarget: 1 } })).toThrow(/SIGHUP/);
  });

  it("opens a slot again until its first answer comes from the wanted backend, and keeps the last session after the last try", async () => {
    const answers = ["lab-b", null, "lab-b", "lab-a"];
    const closed: number[] = [];
    let opened = 0;
    const open = () => (opened += 1);
    const probe = async (held: number) => answers[held - 1] ?? null;
    expect(await placeSlot(open, probe, (held) => closed.push(held), "lab-a", 8)).toEqual({ held: 4, b: "lab-a", tries: 4, ok: true });
    expect(closed).toEqual([1, 2, 3]);
    opened = 0;
    expect(await placeSlot(open, probe, (held) => closed.push(held), "lab-a", 2)).toEqual({ held: 2, b: null, tries: 2, ok: false });
    await expect(placeSlot(open, probe, () => undefined, "lab-a", 0)).rejects.toThrow(RangeError);
  });

  it("reads a placement only as a list of one backend for each slot", () => {
    expect(placementFrom('["lab-a","lab-b"]', 2)).toEqual(["lab-a", "lab-b"]);
    expect(placementFrom('["lab-a"]', 2)).toBeNull();
    expect(placementFrom('["lab-a",""]', 2)).toBeNull();
    expect(placementFrom('{"slots":["lab-a","lab-b"]}', 2)).toBeNull();
    expect(placementFrom("not json", 2)).toBeNull();
  });
});

describe("the sessions on the target at the fault", () => {
  it("names the sessions of each client by the ports of its last requests, and their backends by their last answers", () => {
    const lines: Line[] = [
      // client-a: an old session on port 1 before the SIGHUP, then the ports 3 (target) and 4 (other)
      request(100, "client-a", 1, "lab-a"),
      request(400, "client-a", 3, "lab-a"),
      request(410, "client-a", 4, "lab-b"),
      request(900, "client-a", 3, null),
      request(910, "client-a", 4, "lab-b"),
      // client-b: both sessions on the target
      request(400, "client-b", 5, "lab-a"),
      request(410, "client-b", 6, "lab-a"),
      // client-c: a session with no answer yet is not on the target
      request(400, "client-c", 7, "lab-b"),
      request(410, "client-c", 8, null),
      // a request after the fault names no session at the fault
      request(1200, "client-c", 9, "lab-a"),
    ];
    expect(sessionsAt(lines, 1000, "lab-a", 2)).toEqual({ onTarget: 3, of: 6, byClient: { "client-a": 1, "client-b": 2, "client-c": 0 } });
    expect(sessionsAt(lines, 1000, "lab-a", 1)).toEqual({ onTarget: 1, of: 3, byClient: { "client-a": 0, "client-b": 1, "client-c": 0 } });
    expect(sessionsAt([], 1000, "lab-a", 2)).toEqual({ onTarget: 0, of: 0, byClient: {} });
  });

  it("are a fact of a run with kept connections and a target, and a stall gives its start after the fault and its hold", () => {
    const stall = { ...cellOf("app-stall"), workload: { every: { value: 10, unit: "ms" }, timeout: s(2), connections: 2 } };
    const lines: Line[] = [
      request(400, "client-a", 3, "lab-a"),
      request(410, "client-a", 4, "lab-b"),
      { ev: "stall", t: 1004.4, p: "lab-a", phase: "start", ms: 5000 },
      { ev: "stall", t: 6004.6, p: "lab-a", phase: "end", ms: 5000, held: 5000.2 },
    ];
    const facts = factsOf(stall, runWith(lines));
    expect(facts.sessions).toEqual({ onTarget: 1, of: 2, byClient: { "client-a": 1 } });
    expect(facts.stall).toEqual({ start: s(0.004), held: s(5) });
    // a run with no stall line gives null times, and a run with no fault gives no sessions
    expect(factsOf(stall, runWith([])).stall).toEqual({ start: null, held: null });
    expect(factsOf(stall, runWith(lines, null)).sessions).toBeUndefined();
    // a workload with a new connection for each request has no sessions, and a trigger with no stall has no stall
    expect(factsOf(cellOf("app-stall"), runWith(lines)).sessions).toBeUndefined();
    expect(factsOf({ ...cellOf("pod-deletion"), workload: stall.workload }, runWith(lines)).stall).toBeUndefined();
  });

  it("are in the schema of a record, with the placement of the workload", () => {
    const stall = { ...cellOf("app-stall"), workload: { every: { value: 10, unit: "ms" }, timeout: s(2), connections: 2, onTarget: 1 } };
    const facts = factsOf(stall, runWith([request(400, "client-a", 3, "lab-a"), { ev: "stall", t: 1004.4, p: "lab-a", phase: "start", ms: 5000 }]));
    const record = {
      format: FORMAT,
      cell: stall,
      runs: [],
      manifests: [],
      loads: [],
      at: "2026-10-27T00:00:00.000Z",
      verdict: { decision: "holds", counted: 1, voided: 0, failed: 0, median: null, why: "a test", checks: [{ ok: true, why: "a test", value: null, facts }] },
    };
    const parsed = kindCellRecordSchema.safeParse(record);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cell.workload.onTarget).toBe(1);
      expect(parsed.data.verdict.checks[0]!.facts.sessions).toEqual({ onTarget: 1, of: 1, byClient: { "client-a": 1 } });
      expect(parsed.data.verdict.checks[0]!.facts.stall).toEqual({ start: s(0.004), held: null });
    }
  });
});
