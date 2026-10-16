import { describe, expect, it } from "vitest";
import type { Cell, Group, Run, SentinelEvent } from "./cell.ts";
import { deadlineOf, fieldsOf, infoOf, memberConfig, peersOf, sentinelConfig, subscriptionsOf, viewOf } from "./group.ts";
import { measure } from "./observe.ts";
import { judge } from "./run.ts";
import { errorsOf, lagsOf, writesOf } from "./timeline.ts";
import { verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const GROUP: Group = {
  name: "mymaster",
  image: "valkey/valkey:9.1",
  programs: { server: "valkey-server", sentinel: "valkey-sentinel", cli: "valkey-cli" },
  port: 6379,
  sentinelPort: 26379,
  members: ["m1", "m2", "m3"],
  sentinels: ["s1", "s2", "s3"],
  quorum: 2,
  memberSettings: { "protected-mode": "no", save: '""' },
  sentinelSettings: { "down-after-milliseconds": "30000", "failover-timeout": "180000", "parallel-syncs": "1" },
  ready: { member: "Ready to accept connections", sentinel: "+monitor master" },
};
const parts = {
  members: { m1: { ip: "10.0.0.2", netns: 1 }, m2: { ip: "10.0.0.3", netns: 2 }, m3: { ip: "10.0.0.4", netns: 3 } },
  sentinels: { s1: { ip: "10.0.0.5", netns: 4 }, s2: { ip: "10.0.0.6", netns: 5 }, s3: { ip: "10.0.0.7", netns: 6 } },
};
const CLIENT = "10.0.0.8";

describe("a group as data", () => {
  it("writes the configuration of each member and each Sentinel from the group", () => {
    expect(memberConfig(GROUP, null)).toBe('port 6379\nprotected-mode no\nsave ""\n');
    expect(memberConfig(GROUP, "10.0.0.2")).toContain("replicaof 10.0.0.2 6379\n");
    expect(sentinelConfig(GROUP, "10.0.0.2")).toBe(
      [
        "port 26379",
        "sentinel monitor mymaster 10.0.0.2 6379 2",
        "sentinel down-after-milliseconds mymaster 30000",
        "sentinel failover-timeout mymaster 180000",
        "sentinel parallel-syncs mymaster 1",
        "",
      ].join("\n"),
    );
  });

  it("cuts a part from all of its peers, from the group only, or from the clients only, and never from the observer", () => {
    expect(peersOf(parts, CLIENT, "m1", "all")).toEqual(["10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6", "10.0.0.7", CLIENT]);
    expect(peersOf(parts, CLIENT, "m1", "group")).toEqual(["10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6", "10.0.0.7"]);
    expect(peersOf(parts, CLIENT, "m1", "clients")).toEqual([CLIENT]);
    expect(peersOf(parts, CLIENT, "s2", "all")).toEqual(["10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.7", CLIENT]);
  });

  it("reads the replies of the command line client and of INFO", () => {
    expect(fieldsOf("name\nmymaster\nip\n10.0.0.2\nflags\nmaster\n")).toEqual([{ name: "mymaster", ip: "10.0.0.2", flags: "master" }]);
    expect(fieldsOf("name\n10.0.0.3:6379\nflags\nslave\nname\n10.0.0.4:6379\nflags\ns_down,slave\n")).toEqual([
      { name: "10.0.0.3:6379", flags: "slave" },
      { name: "10.0.0.4:6379", flags: "s_down,slave" },
    ]);
    expect(infoOf("# Replication\r\nrole:master\r\nconnected_slaves:2\r\n")).toEqual({ role: "master", connected_slaves: "2" });
  });

  it("calls a group healthy only when each Sentinel and each member agrees on one primary", () => {
    const replica = (ip: string) => ({ name: `${ip}:6379`, flags: "slave", "master-link-status": "ok", "master-host": "10.0.0.2" });
    const sentinel = { master: { ip: "10.0.0.2", flags: "master", "num-other-sentinels": "2" }, replicas: [replica("10.0.0.3"), replica("10.0.0.4")] };
    const members = {
      m1: { role: "master", master_failover_state: "no-failover", slave0: "ip=10.0.0.3,port=6379,state=online", slave1: "ip=10.0.0.4,port=6379,state=online" },
      m2: { role: "slave", master_host: "10.0.0.2", master_link_status: "up" },
      m3: { role: "slave", master_host: "10.0.0.2", master_link_status: "up" },
    };
    const ips = { m1: "10.0.0.2", m2: "10.0.0.3", m3: "10.0.0.4" };
    expect(viewOf(GROUP, ips, [sentinel, sentinel, sentinel], members)).toEqual({ primary: "m1", healthy: true, why: "healthy" });
    // a Sentinel that still flags the primary down, or a replica that converts
    const down = { ...sentinel, master: { ...sentinel.master, flags: "s_down,master" } };
    expect(viewOf(GROUP, ips, [sentinel, down, sentinel], members).healthy).toBe(false);
    const syncing = { ...members, m3: { role: "slave", master_host: "10.0.0.2", master_link_status: "down" } };
    expect(viewOf(GROUP, ips, [sentinel, sentinel, sentinel], syncing).why).toBe("m3 is not a replica of m1 with its link up");
    // two views of the primary: a switch in the middle of its hello
    const moved = { ...sentinel, master: { ...sentinel.master, ip: "10.0.0.3" } };
    expect(viewOf(GROUP, ips, [sentinel, moved, sentinel], members).why).toBe("the Sentinels name 2 primaries");
  });
});

// ---- a run of a group cell, measured from the lines of the client, the observer and the prober
const T = 50_000_000_000_000;
const ms = (value: number) => T + Math.round(value * 1e6);
const CELL: Cell = {
  name: "T12.defaults.8 fin at the primary",
  target: { image: "valkey/valkey:9.1", port: 6379, ready: "Ready to accept connections" },
  sysctls: {},
  probe: { mode: "stream", keepalive: false, interval: { value: 50, unit: "ms" } },
  fault: "fin",
  faultAt: { role: "primary" },
  group: GROUP,
  prediction: {
    detects: true,
    timer: "Sentinel failover, then the reconnect of ioredis",
    errno: "OK",
    from: "fault",
    low: s(31.35),
    high: s(39),
    group: {
      lands: "new",
      failover: true,
      stamps: { value: 2, unit: "ms" },
      stages: [
        { stage: "+sdown", low: s(30.001), high: s(30.201) },
        { stage: "+switch-master", low: s(30.158), high: s(31.805) },
      ],
    },
  },
  runs: 11,
  environments: 2,
};
const sentinelLine = (at: number, event: string, detail: string, sentinel = "10.0.0.5:26379"): SentinelEvent => ({
  ev: "sentinel",
  t: ms(at),
  sentinel,
  event,
  detail,
});
const groupRun = (more: Partial<Run> = {}, holds: number[] | null = [1, 2, 3, 4, 5, 7, 8]): Run => ({
  environment: 0,
  index: 0,
  events: [
    { ev: "ready", t: ms(-2000), at: "10.0.0.2:6379" },
    { ev: "sent", t: ms(-100), n: 1 },
    { ev: "ack", t: ms(-99), n: 1, at: "10.0.0.2:6379" },
    { ev: "sent", t: ms(-50), n: 2 },
    { ev: "ack", t: ms(-49), n: 2, at: "10.0.0.2:6379" },
    { ev: "sent", t: ms(-1), n: 3 },
    { ev: "ack", t: ms(-0.5), n: 3, at: "10.0.0.2:6379" },
    { ev: "sent", t: ms(30), n: 4 },
    { ev: "error", t: ms(31), errno: "ECONNRESET", name: "Error" },
    { ev: "error", t: ms(90), errno: "ECONNREFUSED", name: "Error" },
    { ev: "error", t: ms(250), errno: "ECONNREFUSED", name: "Error" },
    { ev: "ack", t: ms(32_400), n: 4, at: "10.0.0.3:6379" },
    { ev: "sent", t: ms(32_451), n: 5 },
    { ev: "ack", t: ms(32_452), n: 5, at: "10.0.0.3:6379" },
    { ev: "sent", t: ms(32_503), n: 6 },
    { ev: "fail", t: ms(32_504), n: 6, name: "Error", message: "boom" },
    { ev: "done", t: ms(35_000) },
    { ev: "sent", t: ms(35_001), n: 9 },
  ],
  fault: { t0: ms(0), t1: ms(0.2) },
  kernel: [
    { ev: "rx", mono: ms(32_399.6), netns: 77, cookie: 3, src: "10.0.0.8:40000", dst: "10.0.0.3:6379", seg: { seq: 1, len: { value: 5, unit: "B" } } },
    { ev: "clock", mono: ms(36_000), lost: 0 },
  ],
  netns: 77,
  targetNetns: 1,
  lost: 0,
  group: {
    members: parts.members,
    sentinels: parts.sentinels,
    primary: "m1",
    at: "m1",
    timeline: [
      sentinelLine(30_050, "+sdown", "master mymaster 10.0.0.2 6379"),
      sentinelLine(30_060, "+sdown", "slave 10.0.0.9:6379 10.0.0.9 6379 @ mymaster 10.0.0.2 6379"),
      sentinelLine(30_120, "+odown", "master mymaster 10.0.0.2 6379 #quorum 2/2"),
      sentinelLine(30_121, "+try-failover", "master mymaster 10.0.0.2 6379"),
      sentinelLine(30_200, "+elected-leader", "master mymaster 10.0.0.2 6379"),
      sentinelLine(31_300, "+promoted-slave", "slave 10.0.0.3:6379 10.0.0.3 6379 @ mymaster 10.0.0.2 6379"),
      sentinelLine(31_350, "+switch-master", "mymaster 10.0.0.2 6379 10.0.0.3 6379", "10.0.0.6:26379"),
    ],
    after: "m2",
    holds,
  },
  ...more,
});

describe("a run of a group cell, measured", () => {
  it("times the first write that the new primary accepted, from the fault, by the kernel's segment", () => {
    const read = measure(CELL, groupRun());
    expect(read).toMatchObject({ outcome: { kind: "answered" }, elapsed: s(32.3996), socket: s(32.4), noticed: s(0.0004), void: null, finding: null });
    expect(read.group).toMatchObject({ from: "m1", to: "m2" });
    // the down states of a replica do not count: the first +sdown is the primary's
    expect(read.group?.stages).toMatchObject({ "+sdown": s(30.05), "+odown": s(30.12), "+switch-master": s(31.35) });
  });

  it("tells what became of each write: kept, lost, and unknown", () => {
    // 6 failed and 9 went after the stop. The group keeps 1–5, 7 and 8, and loses none of its acknowledged writes
    expect(writesOf(groupRun(), ms(0), "m1")).toEqual({ sent: 7, acked: 5, old: 0, lost: [], unknown: [{ n: 6, held: false }] });
    // a group that kept only the writes before the fault lost 4 and 5
    expect(writesOf(groupRun({}, [1, 2, 3]), ms(0), "m1").lost).toEqual([4, 5]);
    expect(writesOf(groupRun({}, null), ms(0), "m1").lost).toBeNull();
    expect(errorsOf(groupRun().events, ms(0))).toEqual([
      { name: "ECONNRESET", first: s(0.031), count: 1 },
      { name: "ECONNREFUSED", first: s(0.09), count: 2 },
      { name: "Error", first: s(32.504), count: 1 },
    ]);
  });

  it("voids a run with a TILT or a split vote, and finds a failover where none should be", () => {
    const tilt = groupRun();
    const tilted = { ...tilt, group: { ...tilt.group!, timeline: [...tilt.group!.timeline, sentinelLine(10_000, "+tilt", "#tilt mode entered")] } };
    expect(measure(CELL, tilted).void).toBe("a Sentinel entered TILT 10 s after the fault: the host delayed it, not its timers");
    const split = {
      ...tilt,
      group: {
        ...tilt.group!,
        timeline: [
          sentinelLine(30_121, "+try-failover", "master mymaster 10.0.0.2 6379"),
          sentinelLine(40_200, "-failover-abort-not-elected", "master mymaster 10.0.0.2 6379"),
        ],
      },
    };
    expect(measure(CELL, split).void).toMatch(/^the election split its votes/);
    // an +odown with no +try-failover: each Sentinel was in the hold-off of an earlier attempt
    const off = {
      ...tilt,
      group: { ...tilt.group!, timeline: tilt.group!.timeline.filter((line) => line.event === "+sdown" || line.event === "+odown") },
    };
    expect(measure(CELL, off).void).toBe(
      "no Sentinel started a failover after +odown: each was in the hold-off of 2 × failover-timeout after an earlier attempt",
    );
    // a hold that lifted later than δ_abs: the injector was late, and each stage after the lift moved
    const held: Cell = { ...CELL, fault: "freeze-process", hold: s(40) };
    expect(measure(held, groupRun({ heal: { t0: ms(40_020), t1: ms(40_020.1) } })).void).toBe(
      "the lift came 20 ms after its hold: the injector was late, not the group",
    );
    expect(measure(held, groupRun({ heal: { t0: ms(40_001), t1: ms(40_001.1) } })).void).toBeNull();
    const stays: Cell = { ...CELL, prediction: { ...CELL.prediction, group: { lands: "new", failover: false, stages: [] } } as Cell["prediction"] };
    expect(measure(stays, groupRun()).finding).toBe("the group failed over 31.35 s after the fault, where it should not");
  });

  it("judges the band of the write and each stage band with the error of the stamps", () => {
    const runs = Array.from({ length: 11 }, (_, index) => groupRun({ index }));
    const { verdict } = judge(CELL, runs);
    expect(verdict.decision).toBe("holds");
    expect(verdict.group?.stages.map((each) => [each.stage, each.decision, each.band.high.value])).toEqual([
      ["+sdown", "holds", 30.207],
      ["+switch-master", "holds", 31.811],
    ]);
    expect(verdict.group?.medians["+promoted-slave"]).toEqual(s(31.3));
    expect(verdict.group?.lost).toEqual({ runs: 11, total: 0, median: 0, max: 0 });
    // a stage out of its band fails that stage, and the band of the write does not move
    const late = groupRun({ index: 11 });
    const moved = { ...late, group: { ...late.group!, timeline: late.group!.timeline.map((line) => (line.event === "+sdown" ? { ...line, t: ms(31_000) } : line)) } };
    const again = verdictOf(CELL.prediction, [...runs.slice(1), moved].map((run) => measure(CELL, run)));
    expect(again.decision).toBe("holds");
    expect(again.group?.stages[0]?.decision).toBe("fails");
  });

  it("waits for the outcome of a group cell up to its band, or its window, and 10 s more", () => {
    expect(deadlineOf(CELL)).toBe(49_000);
    expect(deadlineOf({ ...CELL, prediction: { detects: null, window: s(90), why: "measured", from: "fault" } })).toBe(100_000);
  });

  it("calibrates each stamp of the observer against the write of its Sentinel, from the subscription before the run", () => {
    // the observer subscribed when the environment opened, and once more after a lost connection
    const before: SentinelEvent[] = [
      { ev: "subscribed", t: ms(-90_000), sentinel: "10.0.0.5:26379", local: "10.0.0.9:40000" },
      { ev: "subscribed", t: ms(-60_000), sentinel: "10.0.0.5:26379", local: "10.0.0.9:40002" },
      { ev: "sentinel", t: ms(-50_000), sentinel: "10.0.0.5:26379", event: "+sdown", detail: "slave" },
    ];
    const subscribed = subscriptionsOf(before);
    expect(subscribed.map((line) => line["local"])).toEqual(["10.0.0.9:40002"]);
    const run = groupRun();
    const timeline = [...subscribed, sentinelLine(1_000, "+try-failover", "master mymaster 10.0.0.2 6379")];
    const tx = (at: number, dst: string) => ({ ev: "tx", mono: ms(at), netns: 4, cookie: 9, src: "10.0.0.5:26379", dst });
    const kernel = [tx(999.5, "10.0.0.9:40002"), tx(999.9, "10.0.0.8:50000"), tx(1_000.4, "10.0.0.9:40002")];
    // the write before the stamp, on the socket toward the observer: 0.5 ms
    expect(lagsOf({ ...run, group: { ...run.group!, timeline } }, kernel)).toEqual([s(0.0005)]);
  });
});
