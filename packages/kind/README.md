# @mark1russell7/kind

Kubernetes in Docker (kind) as a lab for connection timers. A scenario gives the cluster, and the lab puts the faults of the harness in the namespaces of its pods. Each observation is on the one monotonic clock of the VM, and the ordering law gives the predictions. The package also reads the raw record of a cell and judges it again, without Docker.

```sh
npm install @mark1russell7/kind zod
```

## The two entries

| Entry | What it holds | What it loads |
| --- | --- | --- |
| `@mark1russell7/kind` | Each part: the cluster, the lab, the image, the faults, the predictions, the runner, and all of `./judge` | Testcontainers, Docker, `kind` and `kubectl` when a lab opens |
| `@mark1russell7/kind/judge` | The types and the zod schemas of a record, `upgrade`, `judge`, the verdict, the readers of the lines and the report | `@mark1russell7/quantity` and zod only |

The entry `./judge` loads no Docker, no Testcontainers, no child process and no `node:` module. Thus a program that only reads records can use it, in a browser too. Two tests hold it to that. One follows the imports of its source, and one imports it in a new Node process. The smoke test of a release does the same on the built tarball.

```ts
import { judge, readRecord } from "@mark1russell7/kind/judge";

const record = readRecord(JSON.parse(text)); // a record of /1 or /2, as /2
const verdict = judge(record); // the verdict of this version, from the cell and the runs
```

- `readRecord(data)` examines a record of either format with its zod schema, and gives it in the format `/2`.
- `upgrade(record)` gives a record of `/1` in the format `/2`. It does not examine the record, and it changes nothing in it.
- `judge(record)` judges a record of either format again, from its cell and its runs. For each of the 31 records of the kind workflow of 2026-10-16, it gives the verdict of the record.
- `kindCellRecordSchema` and `kindCellRecordV1Schema` are the zod schemas of the two formats.
- `judgeKind`, `checkRun`, `factsOf` and `unitOf` are the verdict. `cellsTable`, `predictionText`, `medianText`, `calibrationOf` and `timeSpread` are the report.

The judge does not load the harness, because the harness loads its Docker lab. It has its own copy of the median interval, the quantile and δ_rel of the harness, and a test holds the copy to the harness.

## The record formats

The lab writes the raw record of each cell as JSON: `{ format, cell, runs, manifests, loads, verdict, at }`. A cell is all that the measurement needs, as data. A run keeps each line that its sources wrote, thus a holder of the record can judge it again.

- **`systems.kind-cell-record/2`** is the format that the lab writes. Each amount in it is a quantity, `{ "value": 34.244, "unit": "s" }`, from `@mark1russell7/quantity`.
- **`systems.kind-cell-record/1`** is the first format. Its bands, its medians and the times of its facts are numbers. The lab does not write it again, and a reader reads it through `upgrade`.

These are the changes from `/1` to `/2`. Each value stays the same. Only its form changes.

| Field | `/1` | `/2` |
| --- | --- | --- |
| `cell.prediction` bands (`band`, `start.band`, `end.band`) | `{ "lo": 28, "hi": 49 }`, in seconds | `{ "lo": { "value": 28, "unit": "s" }, "hi": { "value": 49, "unit": "s" } }` |
| `cell.trigger.cpuMax` | `{ "quota": 1000, "period": 1000000 }`, in microseconds | Each part a quantity in `us` |
| `verdict.median` and `verdict.checks[].value` | A number: seconds or a count, by the prediction | A quantity in the unit of the prediction (`unitOf`) |
| The times of `verdict.checks[].facts` | Numbers of seconds | Quantities in `s` |

The unit of the main value of a run comes from the prediction of its cell:

- `s` for a time: `removal`, `leaves`, `stalls`, and `restarts` with a band.
- `{request}` for the failed requests: `none`, `window`, `stays` and `measured`.
- `{replica}` for the replicas that received SIGTERM: `restarts` without a band.

These values stay numbers in the two formats:

- **A stamp** is a reading of CLOCK_MONOTONIC in milliseconds, a point on a clock, not an amount. The stamps are `start`, `end` and `acts` of a run, `t` of each line, and `first`, `last` and `deletion` of the facts.
- **A line** stays as its source wrote it. The image writes it, and the record keeps it.
- **A count** or **a share**: the replicas, the thresholds, the runs and the counts of a verdict. The jitter of a poll and the idle share of a load sample are shares.

The tests read three real records of `/1` (`test/records/`): a cell that holds, a cell that fails and a calibration. Each fixture is a whole record, without its load samples and without the kernel release of the runner. `KIND_RECORDS=<folder> pnpm test` judges each record under a folder again, and holds each verdict to the verdict of its record.

## The cluster

- **The scenario** (`scenario.ts`) is the cluster as data: its nodes, its version, the mode and the sync periods of kube-proxy, its CNI and its subnets. `kindConfig(scenario)` generates the configuration of kind from it.
- **The node image** is `kindest/node:v1.37.0`, pinned by digest, the default of kind v0.33.0. The research names v1.37.1 for some defaults. The patch release is the mismatch.
- **The tools** (`tools.ts`) are kind v0.33.0 and kubectl v1.37.0. The lab downloads each one into `.cache/` in this package, and it compares the sha256 with the pinned value at each use. `KIND_CACHE` names another folder. The lab installs nothing on the system, and the same code works on Linux, macOS and Windows.
- **The isolation.** Each cluster gets its own Docker network, its own kubeconfig and its own cache for kubectl, in its run folder. The lab refuses a pod or service subnet that overlaps a Docker network.

## The lab

`openKindLab(cluster, image)` (`lab.ts`) starts the instruments of a cluster:

- **The agent of each node** is a privileged container in the PID namespace of the node container. It signals a process of a pod by its PID on the node. It writes `cpu.max` in the cgroup of a container, and a flag file in the root of a container.
- **The rules of each node.** The agent reads the rules of kube-proxy in the namespaces of the node each 50 ms: `iptables-save`, `nft list table ip kube-proxy`, or `/proc/net/ip_vs`. It writes a line when the backends of the Service change (`backends.ts`). A backend of IPVS with the weight zero takes no new connection, thus it is not a backend.
- **The injector of each node** is the image of the harness, in the PID namespace of the node. `crictl` on the node gives the PID of a container, and `nsenter -n` enters the network namespace of its pod. The injector of the harness then applies its rules there.
- **The watcher** is a container on the network of the cluster. It watches the pods, the EndpointSlices and the events through the API, and it follows the log of each pod of the cell.
- **The prober** of the harness watches the network namespace of each pod, by its inode. The lab keeps its resets, errors and retransmissions, and it counts the other records.

Each pod of a cluster shares the kernel of the Docker VM. Thus each stamp of the agent, the injector, the watcher, the clients, the service and the prober is on the same CLOCK_MONOTONIC.

## The image

The lab image (`image/`) holds the service of a cell on `@mark1russell7/service`, its clients, the agent and the watcher, on Node 24.21.0. Its base is pinned by digest, and `npm-lock.json` pins the packages from npm. `stageLabImage()` stages its context, and `labImage()` tags the image by its content.

- **In the workspace** of this repository, the stage builds `@mark1russell7/quantity`, `@mark1russell7/algebra` and `@mark1russell7/service`, and packs each one as npm gets it.
- **From npm**, the stage packs the installed versions of the same packages. The package holds the files of the image, and `src/compose.ts` and `src/backends.ts`, for that.
- **The service** (`app.mjs`) is a Node HTTP server. Its one controller needs Redis when the cell has Redis. Its health server gives the probes, and it declares each stage of the shutdown. `compose.ts` composes the service from the declaration of the cell, and `lint()` reads the same composition.
- **The seams** of the service are a flag file that fails its liveness check, and SIGUSR2. SIGUSR2 blocks its event loop for the time in a file.
- **The clients** (`client.mjs`) send requests on new connections to the ClusterIP. Each request gives one line with its outcome: ok, 503, refused, reset, timeout or unreachable.

## The triggers

`planOf(cell)` (`faults.ts`) maps each trigger to the acts of the lab:

| Trigger | Acts |
| --- | --- |
| `pod-deletion` | `kubectl delete pod` of the first replica |
| `rolling-update` | a new value of an environment variable of the Deployment |
| `node-drain` | `kubectl drain` of the node of the first replica, then `uncordon` |
| `scale-in` | one replica less, then back |
| `crash` | SIGKILL of the process of the service, from the node |
| `liveness-restart` | the flag file that fails the liveness check of the first replica |
| `freeze-process` | SIGSTOP and SIGCONT: of kube-proxy on one node across a deletion (T07), or of Redis (T18) |
| `rst`, `blackhole` | the injector of the harness in the namespace of Redis, with each replica as a peer |
| `peer-gone-without-close` | a black hole on Redis, then no Redis pod: its namespace goes away with its rules |
| `app-stall` | the event loop of the first replica blocked |
| `rollout` | no Redis pod, then a rolling update |
| `cpu-throttle` | `cpu.max` in the cgroup of the container of the first replica |

A cgroup path that is not the scope of one container is refused. A write to the root of the node throttles or freezes each pod of the node.

The plan's `event:clock-jump` has no trigger. A step of CLOCK_REALTIME in the VM steps the clock of each container: the kubelet, the API server and the cells of other agents. A time namespace offsets only the monotonic clocks, and the runtime of the service reads only the monotonic clock.

## The predictions

`predict.ts` gives each band from the declaration, the pod settings and the calibration of the propagation:

- **A deletion.** The listener of a leaving pod stays open for its preStop sleep and the hold of `fail readiness`. A connection fails when the rules of its node select the pod after that. `rules.ts` gives O04 with the hold as data, and `lint()` decides it.
- **A pause of kube-proxy** keeps the rules of one node for its hold. The window on that node ends one propagation after the pause.
- **A fault of a shared dependency** trips the readiness latch of each replica (`failSpan`). Then the kubelet needs its threshold of probes, and the rules need one propagation.
- **A restart through a coupling** adds the liveness probes of the kubelet and the preStop sleep to the latch.

`verdict.ts` judges each run, and each cell on its counted runs. Each time lands in its band ± 100 ms: the poll of the rules and the delay of the watcher. A median in a band gets the test of the harness: its order-statistic interval in the band, made 5 % wider.

## Tests

`pnpm --filter @mark1russell7/kind test` starts the tests of the configuration, the tools, the parser of the rules and the fault mapping. It also starts the tests of the predictions, the verdict and the judge of the real records. They do not need Docker.

The catalogs are in `@systems/cells` (`t07.ts`, `t18.ts`). `KIND_LAB=1` starts them in kind.

## CI

The cells operate on the runners of GitHub, and not on a machine that does other work (`.github/workflows/kind.yml`). Each shard gets a runner, and each job makes its own clusters and deletes them.

- **The modes of the kernel.** kube-proxy in a node container uses the modules of the host kernel. Thus the job loads `ip_vs` and `nf_tables` first. A cell of a mode that the kernel cannot do waits, and `summary.ndjson` tells why.
- **The shards.** `shardOf` gives each shard an equal share of the estimated time, and the cells of one mode stay together. Thus a shard makes few clusters.
- **The output.** Each job uploads its raw records, `summary.ndjson`, and what the runner is. The run folder of each cluster stays out of the output, because a kubeconfig holds credentials.
- **A pull request** that changes the workflow starts a smoke run: the calibration of each mode, with 2 runs on one cluster.

## Releases

CI publishes each new version of this package (`.github/workflows/release.yml`). npm trusts the workflow only for a package that exists. Thus the first version of a new package goes out by hand, and then the workflow becomes its trusted publisher. For a package that npm does not have, the workflow gives a warning and publishes nothing.
