import { fileURLToPath } from "node:url";
import type { Cell, ClientImage, EtcdCluster, GroupPlace, Prediction, Target } from "@mark1russell7/harness";
import { ms, s } from "./catalog.ts";

/**
 * This module holds the read cells of etcd (SYS-75): does a read of a member cut from the other
 * members give a stale value? The subject is a cluster of three members of etcd v3.6.15, with Raft
 * v3.6.0, the version in its go.mod. The client is `etcd-kv` on clientv3. Its workers put unique
 * values and get keys through each member. The checker of linearizability judges the history of
 * each run.
 *
 * The law comes from the source at those tags. Each term cites its file and line:
 * - A Range that is not serializable waits for `linearizableReadNotify`
 *   (server/etcdserver/v3_server.go:124-125). A serializable Range reads the local store and skips it.
 * - etcd sets CheckQuorum and Pre-Vote (server/etcdserver/bootstrap.go:532-533, and the default
 *   `PreVote: true` of server/embed/config.go:695). It does not set `ReadOnlyOption`, thus the
 *   option is ReadOnlySafe, the zero value (raft.go:61).
 * - Under ReadOnlySafe, a leader answers a ReadIndex only after a quorum acknowledges a heartbeat
 *   with its context (raft.go:2148-2151).
 * - A leader with no active quorum steps down at its check (raft.go:1273-1275).
 * - A pre-candidate has no leader (raft.go:928). A follower with no leader drops a ReadIndex
 *   (raft.go:1759-1761). A follower with a leader sends the ReadIndex to it.
 *
 * Thus a linearizable get through the cut member cannot end with a value: its ReadIndex needs the
 * quorum, and the cut takes the quorum away. The get fails at its deadline, and the checker drops
 * it. The other members elect a leader and accept puts. A serializable get through the cut member
 * reads its local store, which does not have those puts. Thus a get after the reply of a put reads
 * the old value, and no linearization of that key exists.
 *
 * The cut is a partition of the group (`cuts: "group"`). The member loses the other members, and
 * its clients stay connected to it. The cut of the leader and the cut of a follower give the same
 * law. The leader steps down at its check, and the follower loses its leader at its election timeout.
 */

/** This folder is the build context of the client: the cells package, with the client and the checker. */
const CLIENT_CONTEXT = fileURLToPath(new URL("../", import.meta.url));

/** These are the files that the Dockerfile of the client reads, in its context. */
const CLIENT_FILES = [
  "clients/etcd-kv/Dockerfile",
  "clients/etcd-kv/go.mod",
  "clients/etcd-kv/go.sum",
  "clients/etcd-kv/main.go",
  "checkers/linearizability/go.mod",
  "checkers/linearizability/go.sum",
  "checkers/linearizability/history.go",
  "checkers/linearizability/main.go",
];

/** This port is the client port of each member. */
const PORT = 2379;

/** This cluster is three members of etcd v3.6.15 at the defaults of etcd, each one the etcd image of the harness (`image/etcd`). */
export const ETCD_CLUSTER: EtcdCluster = {
  image: { kind: "shipped", name: "etcd" },
  members: ["e1", "e2", "e3"],
  port: PORT,
  peerPort: 2380,
  programs: { server: "etcd" },
};

/** This image is the commander of the cluster: the client etcd-kv, the checker of linearizability and etcdctl. */
export const ETCD_KV: ClientImage = {
  image: { kind: "build", name: "etcd-kv", context: CLIENT_CONTEXT, dockerfile: "clients/etcd-kv/Dockerfile", files: CLIENT_FILES },
  command: ["etcd-kv"],
};

/** This target is the image of each member, for the record. The cluster replaces it, and it does not read it. */
const ETCD_TARGET: Target = {
  image: "quay.io/coreos/etcd:v3.6.15@sha256:7cf6622cb09b111289eed8a0cce3478e4f01d5048b0e0a1ed208299f3419334d",
  subject: ETCD_CLUSTER.image,
  port: PORT,
  ready: "ready to serve client requests",
};

/** This count is the runs of a read cell in each environment, as for the other count cells. */
const READ_RUNS = 4;

/** This time is the length of the cut, in seconds: 10 election timeouts of etcd at its defaults (1000 ms, server/embed/config.go:672). */
const HOLD = 10;

/** This time is the watch after the lift, in seconds: the cut member catches up, and the gets through it read the puts again. */
const WATCH = 5;

/** A read spec is one read cell: its plan, the kind of each get, the member that the partition cuts, and what it shows. */
export interface ReadSpec {
  readonly plan: string;
  readonly reads: "linearizable" | "serializable";
  readonly role: "primary" | "replica";
  readonly name: string;
}

/** These are the specs of SYS-75. */
export const READ_SPECS: readonly ReadSpec[] = [
  { plan: "LR.1", reads: "linearizable", role: "replica", name: "linearizable reads, a follower cut from the other members: each get through it fails, thus the history is linearizable" },
  { plan: "LR.2", reads: "linearizable", role: "primary", name: "linearizable reads, the leader cut from the other members: each get through it fails, thus the history is linearizable" },
  { plan: "LR.3", reads: "serializable", role: "replica", name: "serializable reads, a follower cut from the other members: its gets read its old store, thus a stale read" },
  { plan: "LR.4", reads: "serializable", role: "primary", name: "serializable reads, the leader cut from the other members: its gets read its old store, thus a stale read" },
];

/** This function gives the verdict of the checker that the law gives to a spec. */
export const historyOf = (spec: ReadSpec): "Ok" | "Illegal" => (spec.reads === "linearizable" ? "Ok" : "Illegal");

/** This function says the law of a spec in words, for the prediction. */
const wordsOf = (spec: ReadSpec): string =>
  spec.reads === "linearizable"
    ? "a linearizable get needs a quorum of heartbeat acks (ReadOnlySafe, raft.go:2148-2151), thus each get through the cut member fails and the checker finds a linearization. The verdict reads no timer, thus it has no band"
    : "a serializable get skips the ReadIndex (v3_server.go:124), thus the cut member reads its local store while the other members accept puts, and the checker finds no linearization. The verdict reads no timer, thus it has no band";

/** This function gives the prediction of a spec: the verdict of the checker on the history of each run. */
export const readPrediction = (spec: ReadSpec): Prediction => ({
  detects: null,
  window: s(HOLD + WATCH + 15),
  why: wordsOf(spec),
  history: historyOf(spec),
});

/** This function gives the cell of a spec. */
export const readCell = (spec: ReadSpec): Cell => ({
  name: `${spec.plan} etcd-3.6 cluster, ${spec.name}`,
  target: ETCD_TARGET,
  sysctls: {},
  client: ETCD_KV,
  probe: { mode: "stream", keepalive: false, interval: ms(20), kv: { reads: spec.reads, workers: 6, keys: 8, timeout: s(1) } },
  fault: "partition",
  faultAt: { role: spec.role, cuts: "group" } satisfies GroupPlace,
  etcd: ETCD_CLUSTER,
  hold: s(HOLD),
  watch: s(WATCH),
  prediction: readPrediction(spec),
  runs: READ_RUNS,
  environments: 2,
  // a cluster has five containers: three members, the holder and the commander. One cell at a time
  concurrency: 1,
});

/** These are the cells of SYS-75. */
export const READ_CELLS: readonly Cell[] = READ_SPECS.map(readCell);
