import { describe, expect, it } from "vitest";
import type { Cell, ReplicaSet, Run } from "./cell.ts";
import { measure } from "./observe.ts";
import {
  clockOffsetOf,
  cutOf,
  initiateScript,
  memberCommand,
  memberLineOf,
  onMonotonic,
  replicaSetArgs,
  statusViewOf,
} from "./replset.ts";
import type { MemberLine, Status } from "./replset.ts";
import { replicaSetStagesOf } from "./timeline.ts";
import { verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const SET: ReplicaSet = {
  name: "rs0",
  image: "mongo:9.0.4",
  programs: { server: "mongod", shell: "mongosh" },
  args: ["--wiredTigerCacheSizeGB", "0.25"],
  port: 27017,
  members: ["m1", "m2", "m3"],
  settings: { electionTimeoutMillis: 10000, heartbeatIntervalMillis: 2000 },
  ready: "Waiting for connections",
};
const MEMBERS = { m1: { ip: "10.0.0.2", netns: 1 }, m2: { ip: "10.0.0.3", netns: 2 }, m3: { ip: "10.0.0.4", netns: 3 } };
const IPS = { m1: "10.0.0.2", m2: "10.0.0.3", m3: "10.0.0.4" };
const CLIENT = "10.0.0.8";

describe("a replica set as data", () => {
  it("starts each member with the name of the set, and the set with the address of each member", () => {
    expect(memberCommand(SET)).toBe("mongod --replSet rs0 --bind_ip_all --port 27017 --wiredTigerCacheSizeGB 0.25");
    const script = initiateScript(SET, IPS);
    expect(script).toContain('"members":[{"_id":0,"host":"10.0.0.2:27017"},{"_id":1,"host":"10.0.0.3:27017"},{"_id":2,"host":"10.0.0.4:27017"}]');
    expect(script).toContain('"settings":{"electionTimeoutMillis":10000,"heartbeatIntervalMillis":2000}');
  });

  it("cuts a member from each peer, from the members only, from the client only, or from one member in one or two directions", () => {
    expect(cutOf(SET, MEMBERS, CLIENT, "m1", "all")).toEqual({ peers: ["10.0.0.3", "10.0.0.4", CLIENT] });
    expect(cutOf(SET, MEMBERS, CLIENT, "m1", "group")).toEqual({ peers: ["10.0.0.3", "10.0.0.4"] });
    expect(cutOf(SET, MEMBERS, CLIENT, "m2", "clients")).toEqual({ peers: [CLIENT] });
    expect(cutOf(SET, MEMBERS, CLIENT, "m2", "one")).toEqual({ peers: ["10.0.0.2"] });
    expect(cutOf(SET, MEMBERS, CLIENT, "m1", "one-way")).toEqual({ peers: ["10.0.0.3"], direction: "out" });
  });

  it("calls the set healthy only when the member that answers is the one primary, accepts writes, and each secondary is at its optime", () => {
    const status: Status = {
      me: "10.0.0.3:27017",
      writable: true,
      members: [
        { name: "10.0.0.2:27017", state: "SECONDARY", health: 1, optime: 5 },
        { name: "10.0.0.3:27017", state: "PRIMARY", health: 1, optime: 5 },
        { name: "10.0.0.4:27017", state: "SECONDARY", health: 1, optime: 5 },
      ],
    };
    expect(statusViewOf(SET, IPS, status)).toEqual({ primary: "m2", healthy: true, why: "healthy" });
    expect(statusViewOf(SET, IPS, { ...status, writable: false }).why).toBe("m2 does not accept writes yet");
    const behind = { ...status, members: status.members.map((member, at) => (at === 2 ? { ...member, optime: 4 } : member)) };
    expect(statusViewOf(SET, IPS, behind).why).toBe("10.0.0.4:27017 is behind the primary");
    const recovering = { ...status, members: status.members.map((member, at) => (at === 0 ? { ...member, state: "ROLLBACK" } : member)) };
    expect(statusViewOf(SET, IPS, recovering).why).toBe("10.0.0.2:27017 is ROLLBACK");
    const two = { ...status, members: status.members.map((member) => ({ ...member, state: "PRIMARY" })) };
    expect(statusViewOf(SET, IPS, two).why).toBe("the set has 3 primaries");
  });

  it("reads the JSON log of mongod, and keeps the lines of replication only", () => {
    const line = memberLineOf(
      "m2",
      '{"t":{"$date":"2026-10-16T12:00:10.123+00:00"},"s":"I","c":"REPL","id":21331,"ctx":"OplogApplier-0","msg":"Transition to primary complete; database writes are now permitted","attr":{"term":2}}',
    );
    expect(line).toMatchObject({ ev: "mongod", member: "m2", real: Date.parse("2026-10-16T12:00:10.123Z"), id: 21331, c: "REPL", attr: { term: 2 } });
    expect(memberLineOf("m2", '{"t":{"$date":"2026-10-16T12:00:10.123+00:00"},"c":"NETWORK","id":22943,"msg":"Connection accepted"}')).toBeNull();
    expect(memberLineOf("m2", "not json")).toBeNull();
  });

  it("puts a line of the wall clock onto the monotonic clock, by the nearest pair of the client's clock lines", () => {
    // each pair truncates the wall clock to the ms: the largest offset is the nearest
    const events = [
      { ev: "clocks", t: 1_000_000_000, real: 1_000_000 },
      { ev: "clocks", t: 2_000_400_000, real: 1_001_000 },
    ];
    const offset = clockOffsetOf(events);
    expect(offset).toBe(1_000_000 * 1e6 - 1_000_000_000);
    const log = [{ ev: "mongod", t: 0, member: "m1", real: 1_000_500, id: 1, c: "REPL", msg: "", attr: {} } as MemberLine];
    expect(onMonotonic(log, offset)[0]!.t).toBe(1_500_000_000);
    expect(clockOffsetOf([])).toBeNull();
  });
});

// ---- a run of a replica set cell: the lines of the client, the logs of the members, and the prober
const T = 50_000_000_000_000;
const at = (seconds: number) => T + Math.round(seconds * 1e9);
const CELL: Cell = {
  name: "T11.defaults.9 blackhole at the primary",
  target: { image: "mongo:9.0.4", port: 27017, ready: "Waiting for connections" },
  sysctls: {},
  probe: { mode: "stream", keepalive: false, interval: { value: 50, unit: "ms" } },
  fault: "blackhole",
  faultAt: { role: "primary", cuts: "all" },
  replicaSet: SET,
  hold: s(60),
  prediction: {
    detects: true,
    timer: "the election, then the write-off of the old primary",
    errno: "OK",
    from: "fault",
    low: s(29.999),
    high: s(40.149),
    group: {
      lands: "new",
      failover: true,
      stamps: { value: 2, unit: "ms" },
      stages: [
        { stage: "member-down", low: s(10), high: s(12.02) },
        { stage: "elected", low: s(9.84), high: s(11.636) },
        { stage: "written-off", low: s(29.999), high: s(40.011) },
      ],
    },
  },
  runs: 11,
  environments: 2,
};
const member = (seconds: number, name: string, id: number, msg: string, attr: Record<string, unknown> = {}) => ({
  ev: "mongod",
  t: at(seconds),
  member: name,
  real: 0,
  id,
  c: "REPL",
  msg,
  attr,
});
const setRun = (more: Partial<Run> = {}): Run => ({
  environment: 0,
  index: 0,
  events: [
    { ev: "ready", t: at(-5), at: "10.0.0.2:27017" },
    { ev: "socket", t: at(-5), role: "monitor", server: "10.0.0.3:27017", local: "10.0.0.8:41000" },
    { ev: "socket", t: at(-5), role: "pool", server: "10.0.0.3:27017", local: "10.0.0.8:41001" },
    { ev: "sent", t: at(-0.05), n: 1 },
    { ev: "ack", t: at(-0.049), n: 1, at: "10.0.0.2:27017" },
    { ev: "sent", t: at(-0.0001), n: 2 },
    // its write went out before the fault: its late ack does not count
    { ev: "ack", t: at(0.001), n: 2, at: "10.0.0.2:27017" },
    { ev: "sent", t: at(0.05), n: 3 },
    { ev: "sdam", t: at(11.7), event: "server-changed", address: "10.0.0.3:27017", next: { type: "RSPrimary" } },
    { ev: "sdam", t: at(35.2), event: "heartbeat-failed", address: "10.0.0.2:27017" },
    { ev: "fail", t: at(35.21), n: 3, name: "PoolClearedOnNetworkError" },
    { ev: "sent", t: at(35.3), n: 4 },
    { ev: "ack", t: at(35.31), n: 4, at: "10.0.0.3:27017" },
    { ev: "done", t: at(70) },
  ],
  fault: { t0: at(0), t1: at(0.0002) },
  heal: { t0: at(60.0005), t1: at(60.001) },
  kernel: [
    // the monitor's segment from the new primary is later, but it is not the pool's
    { ev: "rx", mono: at(35.3092), netns: 77, cookie: 4, src: "10.0.0.8:41001", dst: "10.0.0.3:27017", seg: { seq: 1, len: { value: 60, unit: "B" } } },
    { ev: "rx", mono: at(35.3095), netns: 77, cookie: 5, src: "10.0.0.8:41000", dst: "10.0.0.3:27017", seg: { seq: 1, len: { value: 400, unit: "B" } } },
    { ev: "clock", mono: at(71), lost: 0 },
  ],
  netns: 77,
  targetNetns: 1,
  lost: 0,
  group: {
    members: MEMBERS,
    sentinels: {},
    primary: "m1",
    at: "m1",
    timeline: [
      member(-1, "m2", 21358, "Replica set state transition", { newState: "SECONDARY", oldState: "STARTUP2" }),
      member(10.5, "m3", 21216, "Member is now in state DOWN", { hostAndPort: "10.0.0.2:27017" }),
      member(10.4, "m2", 4615652, "Starting an election, since we've seen no PRIMARY in election timeout period"),
      member(10.9, "m2", 21450, "Election succeeded, assuming primary role"),
      member(11.2, "m2", 21363, "Exited primary catch-up mode"),
      member(11.3, "m2", 21331, "Transition to primary complete; database writes are now permitted"),
      member(9.9, "m1", 21809, "Can't see a majority of the set, relinquishing primary"),
    ],
    after: "m2",
    holds: [1, 2, 4],
  },
  ...more,
});

describe("a run of a replica set cell, measured", () => {
  it("marks each stage from the logs of the members and from the lines of the client", () => {
    const run = setRun();
    expect(replicaSetStagesOf(run, at(0), at(0.0002), "new")).toEqual({
      "member-down": s(10.5),
      "election-start": s(10.4),
      elected: s(10.9),
      "caught-up": s(11.2),
      writable: s(11.3),
      "old-primary-steps-down": s(9.9),
      discovered: s(11.7),
      "written-off": s(35.2),
      "first-write": s(35.31),
    });
  });

  it("times the first write on the new primary of a write sent after the fault, by the segment of the pool", () => {
    const read = measure(CELL, setRun());
    expect(read).toMatchObject({ outcome: { kind: "answered" }, elapsed: s(35.3092), void: null, finding: null });
    expect(read.group).toMatchObject({ from: "m1", to: "m2", writes: { sent: 4, acked: 3, lost: [], unknown: [{ n: 3, held: false }] } });
    const verdict = verdictOf(CELL.prediction, [read]);
    expect(verdict.group?.stages.map((stage) => stage.decision)).toEqual(["holds", "holds", "holds"]);
  });

  it("finds a failover where none should be, and a stage that should not come", () => {
    const quiet: Cell = {
      ...CELL,
      prediction: {
        ...CELL.prediction,
        low: s(0),
        high: s(0.2),
        group: { lands: "same", failover: false, stages: [], quiet: ["written-off"] },
      } as Cell["prediction"],
    };
    const read = measure(quiet, setRun());
    expect(read.finding).toBe("the group failed over 10.9 s after the fault, where it should not");
    expect(measure({ ...quiet, prediction: { ...quiet.prediction, group: { lands: "same", failover: true, stages: [], quiet: ["written-off"] } } as Cell["prediction"] }, setRun()).finding).toBe(
      "written-off came 35.2 s after the fault, where it should not",
    );
    // the same primary: the first write sent after the fault, not the late ack of the write before it
    expect(read.group?.stages["first-write"]).toEqual(s(35.31));
  });

  it("gives the client the address of each member and the write concern of the cell", () => {
    const args = replicaSetArgs({ ...CELL, writeConcern: 1, driverOptions: { heartbeatFrequencyMS: 2000 } }, MEMBERS);
    expect(args.slice(0, 8)).toEqual(["10.0.0.2", "27017", "--mode", "stream", "--hosts", "10.0.0.2:27017,10.0.0.3:27017,10.0.0.4:27017", "--set", "rs0"]);
    expect(args).toContain("--w");
    expect(args[args.indexOf("--w") + 1]).toBe("1");
    expect(args.at(-1)).toBe('{"heartbeatFrequencyMS":2000}');
  });
});
