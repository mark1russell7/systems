import { describe, expect, it } from "vitest";
import type { Cell, Kafka, Run, RunPart } from "./cell.ts";
import { bootstrapOf, brokerEnv, controllerEnv, envOf, kafkaArgs, kafkaCutOf, kafkaViewOf, nodeIdOf, topicOf } from "./kafka.ts";
import { measureGroup } from "./timeline.ts";

const KAFKA: Kafka = {
  image: "apache/kafka@sha256:0",
  brokers: ["k1", "k2", "k3"],
  controller: "c1",
  port: 9092,
  controllerPort: 9093,
  clusterId: "Y2VsbHMtb2Yta2Fma2EtMQ",
  heap: "-Xmx512m",
  settings: { "socket.connection.setup.timeout.ms": "1000", "auto.leader.rebalance.enable": "false" },
  ready: "Kafka Server started",
  minInsync: 2,
  writers: 4,
};

const part = (ip: string): RunPart => ({ ip, netns: 1 });

describe("the nodes of a Kafka lab", () => {
  it("gives each broker its place from 1, and the controller the id after them", () => {
    expect(nodeIdOf(KAFKA, "k1")).toBe(1);
    expect(nodeIdOf(KAFKA, "k3")).toBe(3);
    expect(nodeIdOf(KAFKA, "c1")).toBe(4);
    expect(() => nodeIdOf(KAFKA, "k9")).toThrow(/no node k9/);
  });

  it("writes a property as the variable that the wrapper of the image reverses", () => {
    expect(envOf("broker.session.timeout.ms")).toBe("KAFKA_BROKER_SESSION_TIMEOUT_MS");
    expect(envOf("a-b_c.d")).toBe("KAFKA_A___B__C_D");
  });

  it("gives a broker its listener, its advertised listener and the settings of the group", () => {
    const env = brokerEnv(KAFKA, "k2");
    expect(env).toMatchObject({
      CLUSTER_ID: KAFKA.clusterId,
      KAFKA_HEAP_OPTS: "-Xmx512m",
      KAFKA_PROCESS_ROLES: "broker",
      KAFKA_NODE_ID: "2",
      KAFKA_ADVERTISED_LISTENERS: "PLAINTEXT://k2:9092",
      KAFKA_CONTROLLER_QUORUM_VOTERS: "4@c1:9093",
      KAFKA_SOCKET_CONNECTION_SETUP_TIMEOUT_MS: "1000",
      KAFKA_AUTO_LEADER_REBALANCE_ENABLE: "false",
    });
  });

  it("gives the controller no advertised listener: the start script stops on one", () => {
    const env = controllerEnv(KAFKA);
    expect(env).toMatchObject({ KAFKA_PROCESS_ROLES: "controller", KAFKA_NODE_ID: "4", KAFKA_LISTENERS: "CONTROLLER://0.0.0.0:9093" });
    expect(env["KAFKA_ADVERTISED_LISTENERS"]).toBeUndefined();
  });

  it("bootstraps from each broker, and gives each run its own topic", () => {
    expect(bootstrapOf(KAFKA)).toBe("k1:9092,k2:9092,k3:9092");
    expect(topicOf(1, 0)).toBe("cells-e1-r1");
    expect(topicOf(2, -1)).toBe("cells-e2-r0");
  });
});

describe("the view of a partition", () => {
  const whole = { brokers: [1, 2, 3], leader: 2, isr: [1, 2, 3], replicas: [1, 2, 3] };

  it("gives the leader by its name, and healthy for a whole partition", () => {
    expect(kafkaViewOf(KAFKA, whole)).toEqual({ primary: "k2", healthy: true, why: "healthy" });
  });

  it("tells each reason that a partition is not whole", () => {
    expect(kafkaViewOf(KAFKA, { ...whole, brokers: [1, 2] })).toMatchObject({ primary: "k2", healthy: false, why: "2 brokers are not fenced" });
    expect(kafkaViewOf(KAFKA, { ...whole, leader: null })).toMatchObject({ primary: null, healthy: false, why: "the partition has no leader" });
    expect(kafkaViewOf(KAFKA, { ...whole, isr: [2, 3] })).toMatchObject({ healthy: false, why: "the partition has 2 in-sync replicas" });
    expect(kafkaViewOf(KAFKA, { brokers: [1, 2, 3] })).toMatchObject({ primary: null, healthy: false });
  });
});

describe("the cut of a Kafka cell", () => {
  const members = { k1: part("10.0.0.1"), k2: part("10.0.0.2"), k3: part("10.0.0.3") };

  it("cuts a broker from the other brokers and the controller, thus the route of the client stays", () => {
    expect(kafkaCutOf(KAFKA, members, part("10.0.0.4"), "k1", "group")).toEqual({ peers: ["10.0.0.2", "10.0.0.3", "10.0.0.4"] });
  });

  it("refuses a cut with no law", () => {
    expect(() => kafkaCutOf(KAFKA, members, part("10.0.0.4"), "k1", "client")).toThrow(/no cut client/);
  });
});

describe("the client of a Kafka cell", () => {
  it("gives the topic, the writers, the interval and each option as a setting", () => {
    const cell = {
      kafka: KAFKA,
      probe: { mode: "stream", keepalive: false, interval: { value: 50, unit: "ms" } },
      hold: { value: 20, unit: "s" },
      driverOptions: { acks: "all", "linger.ms": 0 },
      prediction: { detects: null, window: { value: 60, unit: "s" }, why: "", from: "fault" },
    } as unknown as Cell;
    const args = kafkaArgs(cell, "t");
    expect(args.slice(0, 6)).toEqual(["--topic", "t", "--writers", "4", "--interval-ms", "50"]);
    expect(args.slice(-4)).toEqual(["--set", "acks=all", "--set", "linger.ms=0"]);
    expect(Number(args[7])).toBeGreaterThan(80);
  });
});

describe("a run of a Kafka cell, measured", () => {
  const s = (seconds: number) => Math.round(seconds * 1e9);
  const writes = (n: number, t: number) => [
    { ev: "sent", t: s(t), n },
    { ev: "ack", t: s(t + 0.01), n, offset: n - 1, at: "10.0.0.2:9092" },
  ];
  const runOf = (after: string, holds: readonly number[]) =>
    ({
      environment: 0,
      index: 0,
      events: [{ ev: "ready", t: s(1), at: "10.0.0.2:9092" }, ...writes(1, 9),...writes(2, 11), ...writes(3, 13), ...writes(4, 40)],
      fault: { t0: s(10), t1: s(10.001) },
      heal: { t0: s(30), t1: s(30.001) },
      kernel: [{ ev: "clock", mono: s(41), lost: 0 }],
      netns: 7,
      lost: 0,
      group: { members: { k1: { ip: "10.0.0.2", netns: 1 } }, sentinels: {}, primary: "k1", at: "k1", timeline: [], after, holds },
    }) as unknown as Run;
  const cellOf = (group: Record<string, unknown>) =>
    ({
      name: "lab kafka",
      kafka: KAFKA,
      probe: { mode: "stream", keepalive: false },
      fault: "partition",
      hold: { value: 20, unit: "s" },
      sysctls: {},
      prediction: { detects: null, window: { value: 60, unit: "s" }, why: "", from: "fault", group: { lands: "same", stages: [], ...group } },
      runs: 1,
      environments: 1,
    }) as unknown as Cell;

  it("counts the acknowledged writes that the partition lacks, with no finding in the band", () => {
    const read = measureGroup(cellOf({ failover: true, lost: { low: 2, high: 2 } }), runOf("k2", [1, 4]));
    expect(read.group.writes.lost).toEqual([2, 3]);
    expect(read.finding).toBeNull();
    expect(read.void).toBeNull();
  });

  it("finds a count outside its band", () => {
    expect(measureGroup(cellOf({ failover: true, lost: { low: 0, high: 0 } }), runOf("k2", [1, 4])).finding).toBe("the group lost 2 accepted writes, outside [0, 0]");
  });

  it("finds a copy that the band of an idempotent producer does not allow", () => {
    expect(measureGroup(cellOf({ failover: true, duplicates: { low: 0, high: 0 } }), runOf("k2", [1, 2, 2, 3, 4])).finding).toBe("the group holds 1 extra copies, outside [0, 0]");
  });

  it("reads the leader after the run, in both directions of the prediction", () => {
    expect(measureGroup(cellOf({ failover: true }), runOf("k1", [1, 2, 3, 4])).finding).toBe("the leader stayed on k1, where it should change");
    expect(measureGroup(cellOf({ failover: false }), runOf("k2", [1, 2, 3, 4])).finding).toBe("the leader moved to k2, where it should stay on k1");
  });

  it("voids a run whose lift came late: the law reads the hold", () => {
    const late = { ...runOf("k2", [1, 2, 3, 4]), heal: { t0: s(31), t1: s(31.001) } };
    expect(measureGroup(cellOf({ failover: true }), late).void).toMatch(/after its hold/);
  });
});
