import { describe, expect, it } from "vitest";
import type { Cell, EtcdCluster } from "./cell.ts";
import { clusterCutOf } from "./cluster.ts";
import { etcdArgs, etcdCommand, etcdLineOf, etcdOnMonotonic, etcdViewOf, observeMsOf, quoteLongIntegers, realOf } from "./etcd.ts";
import type { StatusRow } from "./etcd.ts";

const ETCD: EtcdCluster = {
  image: { kind: "build", name: "etcd-member", context: "targets/etcd-member" },
  members: ["e1", "e2", "e3"],
  port: 2379,
  peerPort: 2380,
  programs: { server: "etcd" },
};
const MEMBERS = { e1: { ip: "10.0.0.2", netns: 1 }, e2: { ip: "10.0.0.3", netns: 2 }, e3: { ip: "10.0.0.4", netns: 3 } };
const ENDPOINTS = { e1: "http://10.0.0.2:2379", e2: "http://10.0.0.3:2379", e3: "http://10.0.0.4:2379" };

/** This function gives a status row of `etcdctl endpoint status`, with its IDs as texts. */
const row = (endpoint: string, member: string, leader: string, term = 2, applied = 9): StatusRow => ({
  Endpoint: endpoint,
  Status: { header: { member_id: member }, leader, raftTerm: term, raftAppliedIndex: applied },
});

describe("a cluster of etcd as data", () => {
  it("forms the cluster from the name of each member, with the server as the child of a shell", () => {
    const command = etcdCommand({ ...ETCD, args: ["--heartbeat-interval 100"] }, "e2");
    expect(command).toContain("--name e2 ");
    expect(command).toContain("--advertise-client-urls http://e2:2379 ");
    expect(command).toContain("--initial-advertise-peer-urls http://e2:2380 ");
    expect(command).toContain("--initial-cluster e1=http://e1:2380,e2=http://e2:2380,e3=http://e3:2380 ");
    expect(command).toContain("--initial-cluster-state new --heartbeat-interval 100 & while :; do sleep 3600; done");
  });

  it("keeps the IDs of 64 bits exact, and only the long integers become texts", () => {
    const text = '[{"Endpoint":"http://10.0.0.2:2379","Status":{"header":{"cluster_id":14841639068965178418,"member_id":10276657743932975437,"revision":12},"leader":10276657743932975437,"raftTerm":2}}]';
    const read = JSON.parse(quoteLongIntegers(text)) as Array<{ Status: { header: { member_id: string; revision: number }; leader: string; raftTerm: number } }>;
    expect(read[0]!.Status.header.member_id).toBe("10276657743932975437");
    expect(read[0]!.Status.leader).toBe("10276657743932975437");
    expect(read[0]!.Status.header.revision).toBe(12);
    expect(read[0]!.Status.raftTerm).toBe(2);
  });

  it("finds one leader that each member names, in one term and at one applied index", () => {
    const whole = [row(ENDPOINTS.e1, "11", "22"), row(ENDPOINTS.e2, "22", "22"), row(ENDPOINTS.e3, "33", "22")];
    expect(etcdViewOf(ENDPOINTS, whole)).toEqual({ primary: "e2", healthy: true, why: "healthy" });
    // a member that did not answer: the leader is known, and the cluster is not whole
    expect(etcdViewOf(ENDPOINTS, whole.slice(0, 2))).toMatchObject({ primary: "e2", healthy: false, why: "2 of 3 members answered" });
    // a cut member names its old leader
    expect(etcdViewOf(ENDPOINTS, [row(ENDPOINTS.e1, "11", "11", 3), whole[1]!, whole[2]!])).toMatchObject({ primary: null, healthy: false });
    expect(etcdViewOf(ENDPOINTS, [whole[0]!, whole[1]!, row(ENDPOINTS.e3, "33", "22", 3)])).toMatchObject({ healthy: false, why: "e3 is in term 3" });
    expect(etcdViewOf(ENDPOINTS, [whole[0]!, whole[1]!, row(ENDPOINTS.e3, "33", "22", 2, 8)])).toMatchObject({ healthy: false, why: "e3 is at another applied index" });
    // a leader that no member that answered has: the leader is not known
    expect(etcdViewOf(ENDPOINTS, [row(ENDPOINTS.e1, "11", "99"), row(ENDPOINTS.e3, "33", "99")])).toMatchObject({ primary: null, healthy: false });
  });

  it("cuts a member from the other members and not from its clients, by the cut of a cluster", () => {
    expect(clusterCutOf(ETCD, MEMBERS, "10.0.0.9", "e1", "group")).toEqual({ peers: ["10.0.0.3", "10.0.0.4"] });
    expect(clusterCutOf(ETCD, MEMBERS, "10.0.0.9", "e1", "all")).toEqual({ peers: ["10.0.0.3", "10.0.0.4", "10.0.0.9"] });
  });
});

describe("the log lines of etcd", () => {
  it("reads the time of zap in microseconds, in milliseconds, with an offset, and as seconds", () => {
    expect(realOf("2026-11-06T12:00:00.123456Z")).toBeCloseTo(Date.parse("2026-11-06T12:00:00.123Z") + 0.456, 6);
    expect(realOf("2026-11-06T12:00:00.5Z")).toBe(Date.parse("2026-11-06T12:00:00.500Z"));
    expect(realOf("2026-11-06T07:00:00.000-0500")).toBe(Date.parse("2026-11-06T12:00:00.000Z"));
    expect(realOf(1_700_000_000.25)).toBe(1_700_000_000_250);
    expect(realOf("yesterday")).toBeNull();
  });

  it("keeps the lines of Raft on the leader and the elections, each warning and each error", () => {
    const at = "2026-11-06T12:00:00.000000Z";
    const line = (level: string, msg: string) => JSON.stringify({ level, ts: at, logger: "raft", caller: "v3@v3.6.0/raft.go:1", msg });
    expect(etcdLineOf("e1", line("info", "e1 became leader at term 2"))).toMatchObject({ ev: "etcd", member: "e1", level: "info", msg: "e1 became leader at term 2" });
    expect(etcdLineOf("e2", line("info", "raft.node: e2 elected leader e1 at term 2"))).not.toBeNull();
    expect(etcdLineOf("e2", line("warn", "prober detected unhealthy status"))).not.toBeNull();
    expect(etcdLineOf("e2", line("info", "serving client traffic insecurely"))).toBeNull();
    expect(etcdLineOf("e2", "not json")).toBeNull();
  });

  it("puts the lines on the monotonic clock with the offset of a client", () => {
    const [line] = etcdOnMonotonic([{ ev: "etcd", t: 0, member: "e1", real: 2_000, level: "info", msg: "x" }], 1_000 * 1e6);
    expect(line!.t).toBe(1_000 * 1e6);
  });
});

describe("the runs of an etcd cell", () => {
  const cell = {
    name: "RD.serializable.follower",
    etcd: ETCD,
    probe: { mode: "stream", keepalive: false, interval: { value: 20, unit: "ms" }, kv: { reads: "serializable", workers: 6, keys: 8, timeout: { value: 1, unit: "s" } } },
    fault: "partition",
    hold: { value: 10, unit: "s" },
    watch: { value: 5, unit: "s" },
    prediction: { detects: null, window: { value: 30, unit: "s" }, why: "", history: "Illegal" },
  } as unknown as Cell;

  it("observes the hold and the watch after it, or the window without a hold", () => {
    expect(observeMsOf(cell)).toBe(15_000);
    expect(observeMsOf({ ...cell, hold: undefined } as unknown as Cell)).toBe(30_000);
  });

  it("gives each run keys of its own, and the workload of the cell", () => {
    expect(etcdArgs(cell, 2, 3)).toEqual([
      "--prefix",
      "r2-3-",
      "--clients",
      "6",
      "--keys",
      "8",
      "--interval-ms",
      "20",
      "--max-s",
      "135",
      "--reads",
      "serializable",
      "--timeout-ms",
      "1000",
      "--seed",
      "2005",
    ]);
    expect(() => etcdArgs({ ...cell, probe: { mode: "stream" } } as unknown as Cell, 0, 0)).toThrow(/probe.kv/);
  });
});
