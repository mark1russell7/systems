import { describe, expect, it } from "vitest";
import type { Cell, Cluster, ProbeEvent, Run } from "./cell.ts";
import {
  clusterArgs,
  clusterConf,
  clusterCutOf,
  clusterHostsOf,
  clusterViewOf,
  logNameOf,
  monotonicOf,
  nodeCommand,
  nodeLineOf,
  nodesOnMonotonic,
  restamped,
  toolJsonOf,
} from "./cluster.ts";
import { measureGroup } from "./timeline.ts";

const CLUSTER: Cluster = {
  image: "rabbitmq:4.3.6@sha256:3e5cc23235b0eb850f604e8ace10d9a9b6d05be3e36730e53522ee9ead707a9e",
  members: ["r1", "r2", "r3"],
  port: 5672,
  cookie: "harness-cookie",
  conf: ["raft.adaptive_failure_detector.poll_interval = 1000"],
  queue: "cells",
  ready: "Server startup complete",
  programs: { server: "beam.smp", start: "docker-entrypoint.sh rabbitmq-server" },
};
const MEMBERS = { r1: { ip: "10.0.0.2", netns: 1 }, r2: { ip: "10.0.0.3", netns: 2 }, r3: { ip: "10.0.0.4", netns: 3 } };

describe("a cluster of RabbitMQ as data", () => {
  it("forms the cluster from the name of each node, and lets the user guest connect from each address", () => {
    expect(clusterConf(CLUSTER).split("\n")).toEqual([
      "cluster_formation.peer_discovery_backend = classic_config",
      "cluster_formation.classic_config.nodes.1 = rabbit@r1",
      "cluster_formation.classic_config.nodes.2 = rabbit@r2",
      "cluster_formation.classic_config.nodes.3 = rabbit@r3",
      "loopback_users.guest = false",
      "raft.adaptive_failure_detector.poll_interval = 1000",
      "",
    ]);
    // the cookie of the server and of the tools, then the server as the child of a shell
    expect(nodeCommand(CLUSTER)).toMatch(/^for f in \/var\/lib\/rabbitmq\/\.erlang\.cookie \/root\/\.erlang\.cookie; do cp \/tmp\/cookie \$f; chmod 400 \$f; done/);
    expect(nodeCommand(CLUSTER)).toMatch(/; docker-entrypoint\.sh rabbitmq-server & while :; do sleep 3600; done$/);
    expect(nodeCommand(CLUSTER)).not.toContain("&;");
  });

  it("cuts a node from each peer, from the nodes only, from the client only, or from one node in one or two directions", () => {
    expect(clusterCutOf(CLUSTER, MEMBERS, "10.0.0.9", "r2", "all")).toEqual({ peers: ["10.0.0.2", "10.0.0.4", "10.0.0.9"] });
    expect(clusterCutOf(CLUSTER, MEMBERS, "10.0.0.9", "r2", "group")).toEqual({ peers: ["10.0.0.2", "10.0.0.4"] });
    expect(clusterCutOf(CLUSTER, MEMBERS, "10.0.0.9", "r2", "clients")).toEqual({ peers: ["10.0.0.9"] });
    expect(clusterCutOf(CLUSTER, MEMBERS, "10.0.0.9", "r2", "one-way")).toEqual({ peers: ["10.0.0.2"], direction: "out" });
  });

  it("calls the queue healthy only with one leader and a follower on each other node, in one term at one commit index", () => {
    const row = (node: string, state: string, term = 2, commit = 40) => ({ "Node Name": `rabbit@${node}`, "Raft State": state, Term: term, "Commit Index": commit });
    expect(clusterViewOf(CLUSTER, [row("r1", "follower"), row("r2", "leader"), row("r3", "follower")])).toEqual({ primary: "r2", healthy: true, why: "healthy" });
    expect(clusterViewOf(CLUSTER, [row("r1", "follower"), row("r2", "leader"), row("r3", "follower", 2, 39)])).toMatchObject({ primary: "r2", healthy: false });
    expect(clusterViewOf(CLUSTER, [row("r1", "candidate"), row("r2", "leader"), row("r3", "follower")])).toMatchObject({ healthy: false, why: "rabbit@r1 is candidate" });
    expect(clusterViewOf(CLUSTER, [row("r1", "follower"), row("r2", "follower"), row("r3", "follower")])).toMatchObject({ primary: null, why: "the queue has 0 leaders" });
    expect(clusterViewOf(CLUSTER, [row("r1", "leader"), row("r2", "noproc"), row("r3", "follower")])).toMatchObject({ primary: "r1", healthy: false });
  });

  it("reads the JSON of a tool of RabbitMQ over one line or over more than one", () => {
    expect(toolJsonOf('[\n{"Node Name":"rabbit@r1"},\n{"Node Name":"rabbit@r2"}\n]\n')).toHaveLength(2);
    expect(toolJsonOf('{"running_nodes":["rabbit@r1"]}')).toEqual({ running_nodes: ["rabbit@r1"] });
    expect(() => toolJsonOf("Error: the node is not running")).toThrow("no JSON in the output");
  });

  it("reads the console log of RabbitMQ, and keeps the lines of the queue, the warnings and the maintenance mode", () => {
    const leader = nodeLineOf("r2", `2026-10-19 06:10:00.123456+00:00 [notice] <0.718.0> ${logNameOf("cells")}: candidate -> leader in term: 3 machine version: 7, last applied 120`, "cells");
    expect(leader).toMatchObject({ ev: "rabbit", member: "r2", level: "notice" });
    expect(leader?.real).toBeCloseTo(Date.parse("2026-10-19T06:10:00.123Z") + 0.456, 6);
    expect(nodeLineOf("r1", "2026-10-19 06:10:00.000001+00:00 [info] <0.1.0> Server startup complete; 0 plugins started.", "cells")).toBeNull();
    expect(nodeLineOf("r1", "2026-10-19 06:10:00.000001+00:00 [warning] <0.1.0> This node is being put into maintenance (drain) mode", "cells")).not.toBeNull();
    expect(nodeLineOf("r1", "not a line of the log", "cells")).toBeNull();
    // the console colors each line by its level: a NOTICE starts with an escape of ANSI, and each line ends with one
    const escape = String.fromCharCode(27);
    const colored = nodeLineOf("r1", `${escape}[38;5;87m2026-10-19 07:21:54.986692+00:00 [notice] <0.1192.0> ${logNameOf("cells")}: leader -> await_condition in term: 1 machine version: 8, last applied 35${escape}[0m`, "cells");
    expect(colored).toMatchObject({ level: "notice", msg: `${logNameOf("cells")}: leader -> await_condition in term: 1 machine version: 8, last applied 35` });
    // the wall clock of a line goes onto the monotonic clock by the offset of the client
    expect(nodesOnMonotonic([leader!], 1e15)[0]!.t).toBe(Math.round(leader!.real * 1e6 - 1e15));
  });

  it("puts the wall stamps of a command onto the monotonic clock with the clock lines of the client", () => {
    const events: ProbeEvent[] = [{ ev: "clocks", t: 5_000_000_000, real: 1_000_000 }];
    expect(monotonicOf({ wall0: 1_001_000_000_000, wall1: 1_001_500_000_000 }, events)).toEqual({ t0: 6_000_000_000, t1: 6_500_000_000 });
    expect(monotonicOf({ wall0: 1, wall1: 2 }, [])).toBeNull();
  });

  it("puts the stamp from a line of the log at that line, with the offset of all the clock lines of the client", () => {
    const line = { ev: "rabbit" as const, t: 0, member: "r1", real: 1_000_100.25, level: "notice", msg: "leader -> await_condition in term: 1" };
    // a later clock line gives a larger offset: the pair that truncates less
    const early: ProbeEvent[] = [{ ev: "clocks", t: 5_000_000_000, real: 1_000_000 }];
    const all: ProbeEvent[] = [...early, { ev: "clocks", t: 5_999_400_000, real: 1_001_000 }];
    const stamp = restamped(line, all);
    expect(stamp).toEqual({ t0: nodesOnMonotonic([line], 995_000_600_000)[0]!.t, t1: nodesOnMonotonic([line], 995_000_600_000)[0]!.t });
    // the stamp of the early offset is 0.6 ms later: the line of the timeline is before it
    expect(restamped(line, early)!.t0 - stamp!.t0).toBe(600_000);
  });

  it("gives the client its node first: the last follower at the defaults, or the leader", () => {
    const cell = { cluster: CLUSTER, probe: { mode: "stream", keepalive: false }, prediction: { detects: false, window: { value: 30, unit: "s" } } } as unknown as Cell;
    // a fault on one member cuts the first follower, r1, and not the node of the client, r3
    expect(clusterHostsOf(cell, MEMBERS, "r2")).toEqual(["10.0.0.4:5672", "10.0.0.2:5672", "10.0.0.3:5672"]);
    expect(clusterCutOf(CLUSTER, MEMBERS, "10.0.0.9", "r2", "one")).toEqual({ peers: ["10.0.0.2"] });
    expect(clusterHostsOf({ ...cell, clientAt: "leader" }, MEMBERS, "r2")).toEqual(["10.0.0.3:5672", "10.0.0.2:5672", "10.0.0.4:5672"]);
    expect(clusterArgs(cell, MEMBERS, "r2").slice(0, 5)).toEqual(["10.0.0.4:5672,10.0.0.2:5672,10.0.0.3:5672", "--queue", "cells", "--interval-ms", "50"]);
  });
});

describe("a run of a cluster cell, measured", () => {
  const s = (seconds: number) => Math.round(seconds * 1e9);
  const line = (t: number, member: string, msg: string) => ({ ev: "rabbit", t: s(t), member, real: 0, level: "notice", msg: `${logNameOf("cells")}: ${msg}` });
  const run: Run = {
    environment: 0,
    index: 0,
    events: [
      { ev: "ready", t: s(0.1), at: "10.0.0.3:5672" },
      { ev: "connected", t: s(0.1), at: "10.0.0.3:5672", local: "10.0.0.9:40000" },
      { ev: "sent", t: s(9.9), n: 30, at: "10.0.0.3:5672" },
      { ev: "ack", t: s(9.95), n: 30, at: "10.0.0.3:5672" },
      { ev: "sent", t: s(10.01), n: 31, at: "10.0.0.3:5672" },
      { ev: "ack", t: s(12.3), n: 31, at: "10.0.0.3:5672" },
    ],
    fault: { t0: s(10), t1: s(10.001) },
    kernel: [{ ev: "clock", mono: s(13), lost: 0 }],
    netns: 7,
    lost: 0,
    group: {
      members: { r1: { ip: "10.0.0.2", netns: 1 }, r2: { ip: "10.0.0.3", netns: 2 }, r3: { ip: "10.0.0.4", netns: 3 } },
      sentinels: {},
      primary: "r1",
      at: "r1",
      timeline: [line(12.1, "r3", "candidate -> leader in term: 3"), line(12.15, "r2", "detected a new leader {'%2F_cells',rabbit@r3} in term 3"), line(15, "r1", "leader -> follower in term: 3")],
      after: "r3",
      holds: [30, 31],
    },
  } as unknown as Run;
  const cell = {
    name: "lab cluster",
    cluster: CLUSTER,
    probe: { mode: "stream", keepalive: false },
    fault: "blackhole",
    sysctls: {},
    prediction: { detects: false, window: { value: 30, unit: "s" }, why: "", from: "fault", group: { lands: "new", failover: true, stages: [] } },
    runs: 1,
    environments: 1,
  } as unknown as Cell;

  it("marks the new leader, its follower and the old leader from the logs, and the first confirm through any node", () => {
    const read = measureGroup(cell, run);
    expect(read.outcome).toEqual({ kind: "answered" });
    expect(read.group.stages["elected"]?.value).toBeCloseTo(2.1, 6);
    expect(read.group.stages["followed"]?.value).toBeCloseTo(2.15, 6);
    expect(read.group.stages["old-leader-steps-down"]?.value).toBeCloseTo(5, 6);
    expect(read.group.stages["first-write"]?.value).toBeCloseTo(2.3, 6);
    // the confirm comes through the node of the client, not the node of the leader
    expect(read.group.to).toBe("r2");
    expect(read.finding).toBeNull();
    expect(read.group.writes).toMatchObject({ acked: 2, old: 0, lost: [] });
  });
});
