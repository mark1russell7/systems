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

- **A stamp** is a reading of CLOCK_MONOTONIC in milliseconds, a point on a clock, not an amount. The stamps are `start`, `end` and `acts` of a run, `t` of each line, and `first`, `last`, `deletion` and `deletions` of the facts.
- **A line** stays as its source wrote it. The image writes it, and the record keeps it.
- **A count** or **a share**: the replicas, the thresholds, the runs and the counts of a verdict. The jitter of a poll and the idle share of a load sample are shares.

The tests read three real records of `/1` (`test/records/`): a cell that holds, a cell that fails and a calibration. Each fixture is a whole record, without its load samples and without the kernel release of the runner. `KIND_RECORDS=<folder> pnpm test` judges each record under a folder again, and holds each verdict to the verdict of its record.

## The cluster

- **The scenario** (`scenario.ts`) is the cluster as data: its nodes, its version, its dataplane, the sync periods of kube-proxy, its CNI and its subnets. `kindConfig(scenario)` generates the configuration of kind from it.
- **The dataplane** (`Dataplane`) is the path of a Service on each node, and the mode of a cell. From 0.12.0, it is a mode of kube-proxy (`iptables`, `ipvs`, `nftables`), or `cilium`. A scenario of `cilium` has no kube-proxy and no kindnet (`kubeProxy: null`, `cni: "cilium"`).
- **The node image** is `kindest/node:v1.37.0`, pinned by digest, the default of kind v0.33.0. The research names v1.37.1 for some defaults. The patch release is the mismatch.
- **The tools** (`tools.ts`) are kind v0.33.0 and kubectl v1.37.0. The lab downloads each one into `.cache/` in this package, and it compares the sha256 with the pinned value at each use. `KIND_CACHE` names another folder. The lab installs nothing on the system, and the same code works on Linux, macOS and Windows.
- **istioctl 1.31.3** (`ISTIOCTL`) comes in a gzipped tar file. The pinned sha256 is that of the tar file. The cache keeps the tar file, and each use examines it and takes the tool from it again (`tarEntry`). The release has a zip file for Windows, thus Windows has no asset of istioctl.
- **Helm v3.22.1** (`HELM`) installs Cilium. It also comes in a gzipped tar file. Its tar file for Windows has `helm.exe`, thus Windows has no asset of Helm.
- **The isolation.** Each cluster gets its own Docker network, its own kubeconfig and its own cache for kubectl, in its run folder. The lab refuses a pod or service subnet that overlaps a Docker network.

## The lab

`openKindLab(cluster, image)` (`lab.ts`) starts the instruments of a cluster:

- **The agent of each node** is a privileged container in the PID namespace of the node container. It signals a process of a pod by its PID on the node. It writes `cpu.max` in the cgroup of a container, and a flag file in the root of a container.
  - From 0.1.4, it also reads the conntrack table of the node each second. It writes a `stale` line for each entry to the ClusterIP that keeps its NAT to a pod that the rules dropped.
  - It reads `/proc/net/nf_conntrack`, or else it asks netlink with the `conntrack` tool of the node. The kernel of a GitHub runner has no `/proc/net/nf_conntrack`. A dump through netlink walks each bucket of the table of the kernel with the softirqs off. A segment that comes in that walk waits. Thus each read is one dump, and `kind.yml` gives the table 16384 buckets, not 262144.
  - A SYN on the port of such an entry goes to that pod, whatever the rules say. An entry in TIME_WAIT is not stale, because a SYN reopens it with a new lookup.
  - It writes a `stalled` line for each handshake that stopped for one second or more: a SYN with no reply, or a SYN-ACK with no ACK. On the node of the client, the line gives the backend of the DNAT. On the node of that backend, the line tells which half of the handshake did not arrive.
  - Each `rules-alive` line gives the source of the table (`ct`). It counts the reads since the last line, and the entries of the ClusterIP in each state. A read that fails stops the reads, and `ct.error` tells why. The lab drops the lines from before the first measurement, thus an early failure shows only in `ct.error`.
  - `ct.syn` gives up to three entries in SYN_SENT, with the backend of their NAT and their life. A new SYN has the life 120 s, and an older one less.
  - Each second, the agent reads the counters of dropped packets (`drops.ts`), and it writes a `drops` line with each counter that grew. For the node, these are the drops of the backlogs, the squeezes of the softirqs, and the drops of each veth.
  - For each client pod, the agent reads `/proc/<pid>/net`. These counters are the IP discards, the sends with no route, the failed connects, the drops of its interfaces, and its neighbors with no address. From 0.1.5, they also count the ICMP errors of an unreachable destination. A refusal by a reject rule is such an error, not a reset. A SYN that does not get to the conntrack of the node leaves its trace in one of them.
- **The rules of each node.** The agent reads the rules of kube-proxy in the namespaces of the node each 50 ms: `iptables-save`, `nft list table ip kube-proxy`, or `/proc/net/ip_vs`. It writes a line when the backends of the Service change (`backends.ts`). A backend of IPVS with the weight zero takes no new connection, thus it is not a backend.
  - From 0.12.0, in the dataplane `cilium`, the agent asks the agent of Cilium on its socket in the node: `GET /v1/service`. The backends are those in the state `active`, or the `terminating` ones when no backend is active (`ciliumBackendsOf`). A reply that does not parse gives a `rules-fail` line.
- **The endpoints of each client sidecar.** From 0.3.0, in a sidecar mesh, the agent also polls the Envoy of the client sidecar on its node each 50 ms (`eds`). The client sidecar picks the backend of each call, thus these endpoints and not the rules are the propagation of the cell (`propagationSource`).
  - A poller enters the network namespace of the client pod (`nsenter -n`). It reads `/clusters` on `127.0.0.1:15000` with a filter that selects the server cluster (`eds.ts`).
  - Each change of the healthy hosts gives an `eds` line with the start of the poll before it. That line has the form of a rules line. Each second, an `eds-alive` line counts the polls and gives their mean time.
- **The listeners of each server sidecar.** From 0.4.0, the agent also polls the Envoy of each server sidecar on its node each 50 ms (`lds`). It does this for a policy in a sidecar mesh (`pollsListeners`).
  - A poller enters the network namespace of the server pod through the PID of its app. It reads `/stats` on `127.0.0.1:15000` with a filter that selects two counters of the listener manager (`lds.ts`).
  - `listener_modified` counts each update of a listener, and `listener_in_place_updated` counts each update of its filter chains only.
  - Each change of the counters gives an `lds` line with the start of the poll before it. The first line of a poller has no poll before it, thus it is no update (`updatesOf`).
- **The injector of each node** is the image of the harness, in the PID namespace of the node. `crictl` on the node gives the PID of a container, and `nsenter -n` enters the network namespace of its pod. The injector of the harness then applies its rules there.
  - From 0.5.0, the target `servers` puts a rule in the namespace of each replica, with each client pod as a peer. A REJECT resets only the sender of the segment that it matches, thus the rule goes where the segments of the clients arrive.
  - The rules of all replicas commit at one instant on CLOCK_MONOTONIC (`--at`, 700 ms after the start). Thus no client meets one replica with the rule and another without it. The clear uses the PIDs of the fault again, thus the heal comes soon after its hold.
  - The lab reads the tables of each replica with their counters (`tables`): the nat table after the fault, and the filter table before the clear. A `tables` line in the record shows if the rule matched the clients beside the rules of istio-cni.
- **The watcher** is a container on the network of the cluster. It watches the pods, the EndpointSlices and the events through the API, and it follows the log of each pod of the cell.
  - From 0.3.0, it also follows the sidecar of Istio (`istio-proxy`), and a pod line gives the state of the sidecar (`sc`). Each line of the sidecar becomes a `proxy` line, stamped at its arrival. Its own stamps are of the wall clock, thus no band reads them.
  - The access line of a call that succeeded at its first try is only counted, in a `proxy-ok` line each second. The record keeps each failure, each retry and each local reply, with its response flags and its upstream host.
- **The prober** of the harness watches the network namespace of each pod, by its inode. The lab keeps its resets, errors and retransmissions, and it counts the other records.

Each pod of a cluster shares the kernel of the Docker VM. Thus each stamp of the agent, the injector, the watcher, the clients, the service and the prober is on the same CLOCK_MONOTONIC.

Before each run, the lab deletes the conntrack entries in SYN_SENT to the ClusterIP on each node (`forgetHandshakes`). A note of the run gives each count. Such an entry is a SYN with no answer, and it keeps its NAT for 120 s. A new SYN from the same port goes where the first one went, and it gets no answer either. The clients send requests between the runs too. Thus the restore of one run left such entries, and a client that took the port again in the next run timed out (T07, 2026-10-17).

## The stacks

From 0.2.0, a cell names its stack (`stack`): its server and its clients. A cell without a stack has the service.

- **`service`** is the service of this repository with its declaration, and the HTTP clients. Each request opens a new connection, thus kube-proxy picks a backend for each request.
- **`grpc`** is the server of grpc-go v1.84.0 from the image of the harness, and the gRPC clients of the lab image. A client holds one channel. Thus kube-proxy picks a backend only when grpc-js connects again: after a GOAWAY of the server, or after the end of the socket.
  - The probes are the gRPC probes of the kubelet on the port of the server.
  - The lines of grpc-go name their pod and stamp in milliseconds (`--name`, `--clock ms`). Its line `stopping` gives the intake and the SIGTERM of a pod (`stoppingOf`): then GracefulStop closes the listener and sends GOAWAY.
  - The clients start after the server is ready. Each failed connect of a channel makes the backoff of grpc-js longer, up to 120 s.
  - The target of a run is the replica that answers the most clients. A channel stays on its replica, and the channels go to the replica that stays after a run. Thus a target by name has no client in most runs.
  - The cell has no declaration (`declaration` is null), thus `describeCell` refuses it.
  - From 0.2.2, the trigger `liveness-restart` has a seam in grpc-go. The server gets `--fail-file /tmp/lab-fail`, and the liveness probe is the gRPC probe of the service `liveness` (`probeOf` with a `service`). While the flag file exists, that check answers NOT_SERVING. The readiness probe stays the check of `""`, thus the endpoint stays ready until the kubelet stops the container.

A declaration that can be null changes the type `KindCell`. That is a breaking change before 1.0.0, thus the version is 0.2.0.

## The mesh

From 0.3.0, a cell can name a mesh (`mesh`): Istio 1.31.3 in its cluster. This is the template `T15`, the lifecycle of T07 through two mesh hops.

- **The field.** `mesh.flavor` is the install: `sidecar` is istiod only, and `ambient` is istiod, istio-cni and ztunnel. `mesh.mode` is the data plane of the pods of the cell.
- **The cluster.** The cells of one kube-proxy mode, one node count and one mesh flavor share a cluster. `shardOf` keeps them together, and in each mode the cells with no mesh come first.
- **The install.** `installMesh` writes the IstioOperator of the flavor (`istioOperator`), and `istioctl install` applies it with the kubeconfig of the cluster. Then the lab waits for each workload of the flavor (`MESH_WORKLOADS`). A failed install gives the pods of istio-system and the log of istio-cni in its error.
- **The values.** The profile is `minimal`, because the profile `default` also has an ingress gateway. The pod of istiod requests 256 MiB, with one replica and no autoscaler. The access log of each sidecar goes to its output as JSON (`ACCESS_LOG_FORMAT`).
- **The images.** `ISTIO_IMAGES` pins istiod and the proxy by the digest of their index on Docker Hub. The lab pulls each one by its digest and tags it with that digest (`localPin`). Then `kind load` puts it on each node.
- **No pull.** Each image is a full reference, thus the charts use it as it is. The init container of the injector gets the image of the proxy too. `imagePullPolicy` is `Never`, thus an image that the lab did not load fails the install.
- **The namespace.** In the sidecar mode, the namespace of the cell has the label `istio-injection=enabled` (`namespaceObject`). The injector then puts a native sidecar in each pod: an init container that runs beside the app, because each kubelet is at least 1.33.
- **The probes.** The injector changes the gRPC probe of grpc-go into an HTTP probe of pilot-agent. Then pilot-agent sends the gRPC check to the app, with the service of the probe.

From 0.5.0, the lab installs the flavor `ambient` too:

- **The values.** The profile is `ambient`: istiod, istio-cni and ztunnel on each node, and no gateway. `ISTIO_IMAGES` also pins istio-cni and ztunnel, and `MESH_IMAGES` gives the images of each flavor. The chart of ztunnel reads only its own `imagePullPolicy`, thus the operator sets it to `Never` there too.
- **The namespace.** In the ambient mode, the namespace of the cell has the label `istio.io/dataplane-mode=ambient`. Then istio-cni redirects the traffic of each pod to ztunnel in the network namespace of the pod. A pod has no sidecar.
- **The kernel.** istio-cni writes iptables rules in each pod and on each node. Thus `kind.yml` loads their modules first, and an ambient cell waits when one does not load.
- **The log of ztunnel.** For a cell in the ambient mode, the watcher follows each ztunnel pod in istio-system (`followsZtunnel`). Each line of its log becomes a `ztunnel` line, stamped at its arrival, and each ztunnel pod is a `ztunnel-pod` line. No band reads them.

From 0.7.0, a cell can restart ztunnel, and it can set the environment of ztunnel:

- **The watcher.** It follows the ztunnel pods for each cell in the flavor `ambient`, also for a cell of sidecar pods there. The lines of the ztunnel pods are the evidence of a restart that no pod of the cell sees.
- **The environment.** `mesh.ztunnel` gives variables of the DaemonSet of ztunnel for one cell, for example `CONNECTION_TERMINATION_DEADLINE`. Before the cell, `setZtunnelEnv` sets them with `kubectl set env` (`ztunnelEnvArgs`). Then it waits for the rollout, and until no old ztunnel pod is left. After the cell, it removes them in the same way.
- **The reference `restart`.** It is the first deletion timestamp of a ztunnel pod in the run, as the watcher receives it (`restartOf`). A run of the trigger `ztunnel-restart` ends when each deleted ztunnel pod is gone, and each node has a ready new one (`ztunnelReplaced`).
- **The DaemonSet.** The chart of ztunnel sets `maxSurge` 1. Then the controller of the DaemonSet of Kubernetes v1.37.0 skips a pod with a deletion timestamp. It makes a new pod on that node at once (`daemon_controller.go`, lines 863–924). Thus the new ztunnel runs beside the old one while the old one drains.

A new member of the union `Template` breaks a reader that switches on it. That is a breaking change before 1.0.0, thus the version is 0.3.0. The record format stays `/2`, with the optional field `mesh`. A judge before 0.3.0 cannot read a record of T15.

## The image

The lab image (`image/`) holds the service of a cell on `@mark1russell7/service`, its clients, the agent and the watcher, on Node 24.21.0. Its base is pinned by digest, and `npm-lock.json` pins the packages from npm. `stageLabImage()` stages its context, and `labImage()` gives the tag of the image.

- **The keep-alive clients.** A workload with `connections` gives each HTTP client that count of keep-alive connections. Each request goes on the next connection in turn. kube-proxy selects a backend only for a new connection. SIGHUP gives the client new connections, and its old connections close after the timeout. With no `connections`, each request has a new connection, as before.
- **The lame duck.** The declaration has the optional field `lameDuck`. With true or no value, the edge sends `Connection: close` while the service is not ready (`httpTransport` as it is). With false, the app gives the transport `keepAlive: () => true`, thus each connection stays open and a caller learns only from the endpoints.
- **The shared gate.** The declaration has the optional field `sharedGate`, a candidate of S6 that is off by default. With true, the app gives its health server `sharedGate()` of this package. The readiness probe that the kubelet reads then leaves out each check of the Redis of the declaration, which must have Redis. The controller still reads those checks, thus the service refuses each request with a 503. A check of no dependency, a drain or a failed liveness still fails the probe.
- **HTTP/2.** The declaration has the optional field `protocol` (`EdgeProtocol`). With `h2c`, the app listens with `node:http2` through the same `httpTransport`, and the lame duck is a GOAWAY on each session. The manifests give each client `PROTOCOL=h2c`. The client then keeps `connections` sessions, and sends each request as a stream on the next session in turn.
  - A GOAWAY, a close or an error of a session makes its slot open a new session at the next stream. Then kube-proxy selects a backend for that new connection.
  - The client sends a stream that the server did not take again, once, on a new session (RFC 9113, section 8.7). Its line has `r: 1`.
  - Each stream writes the same `req` line as a request of HTTP/1.1, with the local port of the socket of its session.

- **The resolver.** From 0.10.1, the lab image is a `build` source of the harness (`labSource()`). The resolver of the harness plans it and builds it, as it does each other image (`planOf`, `imageOf`). Thus its tag comes from its content, and each `FROM` has a digest. Each manifest of packages has a lockfile, and a failed build tries again after each wait. The build goes through the CLI of Docker, not through Testcontainers.

- **In the workspace** of this repository, the stage builds `@mark1russell7/quantity`, `@mark1russell7/algebra` and `@mark1russell7/service`, and packs each one as npm gets it.
- **From npm**, the stage packs the installed versions of the same packages. The package holds the files of the image, and `src/compose.ts` and `src/backends.ts`, for that.
- **The service** (`app.mjs`) is a Node HTTP server. Its one controller needs Redis when the cell has Redis. Its health server gives the probes, and it declares each stage of the shutdown. `compose.ts` composes the service from the declaration of the cell, and `lint()` reads the same composition.
- **The HTTP edge of the service.** From 0.1.7, the service has no transport of its own. Its listener is `httpTransport` of `@mark1russell7/service/http`, and its probes are `probeServer` on the health port. Its one route is `handle()` over `life.request`.
- **The answers of the route.** A value gets 200, and a refusal or a cut of the shutdown gets 503. A failure of the route also gets 503, through the hook `failed`, as in 0.1.6. Thus the T07 and T18 cells count the same outcomes. Each 503 gets `Retry-After` of 1 s.
- **The knobs of the listener.** `server_idle_close` is 6 s, the real idle close of Node 24.21: `keepAliveTimeout` of 5 s and its buffer of 1 s. The sweep of idle connections comes each second after the stop of the intake.
- **The seams** of the service are a flag file that fails its liveness check, and SIGUSR2. SIGUSR2 blocks its event loop for the time in a file.
- **The clients** (`client.mjs`) send requests on new connections to the ClusterIP. Each request gives one line with its outcome: ok, 503, refused, reset, timeout or unreachable. From 0.1.3, each line also gives the local port of its connection (`lp`), a refused one's too. A conntrack entry is per port. Thus the requests on the port of a failure show the connection before it, and the pod that it went to.
- **The gRPC clients** (`client-grpc.mjs`) hold one channel of grpc-js 1.14.6 to the ClusterIP, and send a call of `grpc.health.v1.Health/Check` each interval on it. Each call gives the line of a request of `client.mjs`, with the pod that answered (the header `x-pod`). A call that fails at once names the errno of the last connect: refused, reset or unreachable. A call of grpc-js has no deadline at its defaults. Thus a call with no answer in the timeout is a timeout, and the client cancels it.
  - From 0.6.0, each socket of the channel also gives a `sock` line at its connect and at its close (`client-lines.ts`). Each line gives the local port of the socket (`lp`). The close line keeps the port of the connect, and it gives the code of the error of the socket (`err`), or null.
  - From 0.6.0, SIGUSR1 stops the calls of the client, and SIGUSR2 starts them again. Each signal gives a `gap` line. The channel and its socket stay open in the gap. A listener of SIGUSR1 replaces the start of the inspector of Node at that signal.
  - From 0.8.0, SIGHUP stops the calls and closes the channel. Then the next SIGUSR2 opens a new channel before it starts the calls, and its `gap` line has `open: true`. The connect line of a socket also gives its local address (`la`): the address of the pod.

## The triggers

`planOf(cell)` (`faults.ts`) maps each trigger to the acts of the lab:

| Trigger | Acts |
| --- | --- |
| `pod-deletion` | `kubectl delete pod` of the first replica |
| `rolling-update` | a new value of an environment variable of the Deployment |
| `node-drain` | `kubectl drain` of the node of the first replica, then `uncordon` |
| `scale-in` | one replica less, then back. For the stack `grpc`, the first replica first gets a deletion cost of -1, thus its ReplicaSet removes it |
| `crash` | SIGKILL of the process of the service, from the node |
| `liveness-restart` | the flag file that fails the liveness check of the first replica |
| `freeze-process` | SIGSTOP and SIGCONT: of kube-proxy on one node across a deletion (T07), or of Redis (T18) |
| `rst`, `blackhole` | the injector of the harness in the namespace of Redis, with each replica as a peer. In T15, the injector in the namespace of each replica, with each client pod as a peer (the target `servers`) |
| `peer-gone-without-close` | a black hole on Redis, then no Redis pod: its namespace goes away with its rules |
| `app-stall` | the event loop of the first replica blocked |
| `rollout` | no Redis pod, then a rolling update |
| `cpu-throttle` | `cpu.max` in the cgroup of the container of the first replica |
| `authorization-policy` | `kubectl apply` of a DENY AuthorizationPolicy on the server pods for the principal of an account (`account`, the account `default` of the clients when not given), then `kubectl delete` after the hold |
| `idle` | SIGUSR1 to the gRPC client of each client pod, and SIGUSR2 after the hold: a gap of the calls (the target `clients`). The restore sends SIGUSR2 again. With `middlebox`, a stateful middlebox in each replica from before the gap to the restore. With `close`, a new channel at the fault for 5 s: SIGHUP before the fault, then SIGUSR2, a wait and SIGHUP |
| `ztunnel-restart` | `kubectl delete pod` of the ztunnel pod of each node, with its grace (`ZTUNNEL_PODS`). The flow of each client crosses the ztunnel of its own node. The restore waits for the rollout of the DaemonSet |
| `cannot-serve` | SIGHUP to each client before the fault, thus the keep-alive connections spread over the replicas again in each run (`SPREAD_LEAD`, 3 s). Then the flag file of the first replica for the hold. While the flag is there, the route of the replica fails with 503, and the flag check of the declaration fails. The heal and the restore remove the flag |
| `certificate-expiry` | No act on a connection: the calls of each client go on for the hold. At the fault and at the heal, istioctl reads the leaf certificates of the ztunnel pod of each node (`ztunnelCertificates`). A line `certificates` keeps their validity, the evidence of their lifetime |

A cgroup path that is not the scope of one container is refused. A write to the root of the node throttles or freezes each pod of the node.

From 0.8.0, a plan can have steps before the fault (`prepare`). No reference comes from them, and a failed one makes the run void after the restore. The steps of the borders of T15:

- **A sysctl of a namespace** (`sysctl`): the injector of the harness enters the network namespace of each client pod or each replica. There it sets one sysctl (`sysctlCommand`). Only a sysctl of the namespace (`net.`) and a whole number reach it. A black hole of T15 with `retries` sets `net.ipv4.tcp_retries2` of each client pod. The restore sets the default of a new namespace, 15 (`NETNS_DEFAULTS`).
- **A stateful middlebox** (`middlebox`): two chains of its own (`MIDDLEBOX`) in each replica take the segments of each client pod on the HBONE port. A table of the match recent keeps the time of the last segment of each client pod. After the idle timeout with no segment, the chains drop each later segment of the flow: the silent-drop form (`middleboxCommands`). A SYN is a new flow. Conntrack stays as it is: istio-cni sends each answer of the app back to ztunnel through the connmark of its conntrack entry. The lab reads the filter table after the set and before the removal.
- **A quiet black hole** (`quiet`): SIGUSR1 to each client 1 s before the fault, and SIGUSR2 after the clear. Thus the PING of ztunnel is the only data that gets no answer.
- `KindLab` has the method `netns`: the commands of the injector in the namespace of a PID, in sequence, each word plain. Each one gives an `act` line with its output.

The plan's `event:clock-jump` has no trigger. A step of CLOCK_REALTIME in the VM steps the clock of each container: the kubelet, the API server and the cells of other agents. A time namespace offsets only the monotonic clocks, and the runtime of the service reads only the monotonic clock.

## The predictions

`predict.ts` gives each band from the declaration, the pod settings and the calibration of the propagation:

- **A deletion.** The listener of a leaving pod stays open for its preStop sleep and the hold of `fail readiness`. A connection fails when the rules of its node select the pod after that. The entry `@mark1russell7/service/rules` gives O04 with the hold as data, and `lint()` decides it. Kind gives the drain rules of that entry again (`DRAIN_RULES`, `O04`, `O09`, `O10`, `O16`).
- **The way that a plan stops a pod.** `stopOf(cell)` reads it from the trigger: a deletion, a liveness restart, a crash, or null when the plan stops no pod. `lintCell()` gives each cell only the drain rules that guard its way (`lintStop()` of the service). A plan that stops no pod gets each drain rule. A crash gets no drain rule, and its finding of `stop` depends.
- **A pause of kube-proxy** keeps the rules of one node for its hold. The window on that node ends one propagation after the pause. A SYN_SENT entry of an earlier run lives up to 122 s, thus the window also opens up to 122 s before the intake. `predictionText` writes each end of a window with its band, for example `the intake + [-122, 4.605] s`.
- **A reset from a leaving pod** leaves the conntrack entry of its flow in CLOSE for 10 s, with the NAT to that pod. From 0.1.6, a window can give that life (`afterReset`). Then a request outside the window can fail with the outcome of the rule (`reusesReset`). The condition is a reset of the same client on the same port, up to that life before the request. The catalog gives it to a deletion without a hold, in the modes with the NAT in conntrack.
- **A fault of a shared dependency** trips the readiness latch of each replica (`failSpan`). Then the kubelet needs its threshold of probes, and the rules need one propagation.
- **A restart through a coupling** adds the liveness probes of the kubelet and the preStop sleep to the latch.
- **A replica that cannot serve** (`learnWindow`) fails each request on a connection to it from the fault. A turn is the time between two requests on one connection. With the lame duck, the latch closes each connection (`Connection: close`, or GOAWAY on HTTP/2), and the rules select the replica until its removal. Thus the window ends from the fault, in the latch to the removal and one turn. Without the lame duck, no connection opens again, thus the removal changes nothing. The window ends from the heal, in the recovery of the readiness and one turn.

`verdict.ts` judges each run, and each cell on its counted runs. Each time lands in its band ± 100 ms: the poll of the rules and the delay of the watcher. A median in a band gets the test of the harness: its order-statistic interval in the band, made 5 % wider.

From 0.1.8, a run can agree with the law but be past its calibrated band (D-EXTEND). A request failed after the window, but before the rules of its node dropped the target. The check of that run tells it (`tail`), and its cell is `extend`. Such a cell does not hold. A request after the drop is still late, thus its run fails the cell.

From 0.2.1, a window can be one window for each deleted replica (`each`). A rolling update deletes each old replica in turn, and a client of gRPC can see each of these deletions.

- The judge makes one window for each replica of the run (`replicas`) with a deletion after the start of the run. Each window counts from the intake and the deletion of its own replica.
- A request is late only when it is outside each of these windows. A request after a window and before the rules of its node dropped the replica of that window is a `tail`.
- The facts of each run give these replicas, with the stamps of their intake and their deletion (`deletions`).
- `predictionText` adds `of each deleted replica`. A window without `each` stays the window of the target.

From 0.2.3, a run observes until each predicted window can close, and until each request that started in it ended (`observationEnd`).

- The judge closes a window `end.band.hi` + δ after its end reference. A request that starts by then ends at most one timeout of the workload later.
- Thus a run observes to its latest end reference, plus that band, the timeout and δ (`observationAfter`). With `each`, the end reference of each deleted replica counts.
- A prediction that is not a window, or a window with no end, keeps the observation of 0.2.2. Such a run observes until the trigger is done and the cell is at rest again.
- In kind run 40128267098, 10 of 11 runs of a rolling update over gRPC ended too early. The calls in the queue of a channel had not timed out yet, thus only 1 run recorded its failures.
- The estimate of a cell for the shards adds this observation. The window of a pause of kube-proxy ends up to 122 s after the resume, because of a stale SYN_SENT entry. Thus each run of such a cell observes approximately 2 min more.

From 0.2.3, a window can also give the propagation that it assumes (`propagation`). The judge holds the drop of the replica of each window from the rules of each node to the end of that band ± δ.

- A later drop agrees with the law, but the band is short. The check of the run tells it (`tail`), and the cell is `extend` (D-EXTEND). A node that keeps the replica past the band to the end of the run is such a drop too.
- An earlier drop only closes the window earlier, thus the judge does not test the start of the band.
- `predictionText` adds `the rules drop the replica in` and the band.

From 0.4.0, a window can count from the heal (`heal`), the first act that ends the fault. A window can also name its outcomes (`outcomes`). A failure in the window with another outcome then fails the run.

- The client of gRPC gives the outcome `denied` to PERMISSION_DENIED: the local reply 403 of an RBAC deny of a sidecar.
- For a policy, the propagation of a window is the LDS update of each server sidecar, after the apply and after the delete (`updatesOf`). An update after the band agrees with the law, and the cell is `extend`.
- A denial after the window, before the last update after the delete and one more call, is a `tail`. A denied call has no pod, because the sidecar answers it. Thus the judge reads the last update of each server sidecar.
- `calibrationOf` gives the updates after the apply by node, and the updates after the delete (`heal`).

From 0.6.0, the prediction `ends` is the end of the socket of each client, from the `sock` lines. A client of the run is a client with an answer before the reference.

- With a band, the first close of a socket of each client after the reference must be in the band ± δ. It must be the socket of its last answer. The main value is the middle of these times, in `s`.
- With no band, no socket of a client can close after the reference. The first request of each client after the heal must be `ok` on the socket of its last answer. The main value is the count of the closes, in `{socket}`.
- With a window (`window`), the failed requests must also agree with that window. The observation lasts until each socket can end, and until each request of the window ended.
- The facts of a run give the first close of each client after the reference (`closes`).

From 0.8.0, a prediction `ends` can be the end of the tunnel of each client (`of: "tunnel"`). The tunnel is the HBONE connection of its ztunnel to the replica of its last answer before the heal.

- The prober gives each change of the state of a socket of the HBONE port, 15008. The lab keeps these records (`keptKernel`) as `kernel.state` lines (`tunnelsOf`). It drops the other changes of state, as before.
- The tunnel of a client goes from the address of its pod (`la` of a `sock` line) to that replica at port 15008. Its first change out of ESTABLISHED after the reference must be in the band ± δ. It must be to FIN_WAIT1: the side of the client closes it, and the peer does not close first.
- The first request of each client after the heal must be `ok`, on a new tunnel. The main value is the middle of the ends, in `s`.
- From 0.8.1, `ends` has the optional band `answer`. A change to CLOSE_WAIT in that band ± δ also agrees: the peer answers the close of the client, and its FIN comes first. Before the band, the peer closed first.

In 0.12.4, a fix: the quiet wait before a run stops after 5 min, and the run is void with its reason. Before, the wait had no limit, and a cluster that did not become quiet held the job until its timeout. The optional field `drains` of a backlog term and the function `drainBand` are new features. They keep the old behavior, thus the version is a patch. The record format stays `/2`.

In 0.12.0, `kubeProxy` of a scenario can be null, `cni` can be `cilium`, and the mode of a cell can be `cilium`. A reader of `kubeProxy.mode` breaks, thus this is a breaking change before 1.0.0. To migrate, examine `kubeProxy` for null, and read the mode from `dataplane`. The record format stays `/2`.

The optional field `protocol` of a declaration, the type `EdgeProtocol` and the mode h2c of the lab image are new features. The optional field `sharedGate` of a declaration and the function `sharedGate` are new features. They keep the old behavior, thus their release is a patch. The record format stays `/2`.

They keep the old behavior. Before `1.0.0`, a feature is a patch, thus the next version is `0.11.1`. The record format stays `/2`.

A new member of the union `TriggerKind`, `cannot-serve`, breaks a reader that switches on it. That is a breaking change before 1.0.0, thus the next version is 0.11.0. The record format stays `/2`, with the optional fields `connections` of a workload and `lameDuck` of a declaration. The line `client` of the reconnect is a new line of a run.

A new member of the union `TriggerKind`, `certificate-expiry`, and a new member of the union `Step`, `certificates`, break a reader that switches on them. `KindLab` also has a new method, `record`. Each is a breaking change before 1.0.0, thus the version is 0.9.0. The record format stays `/2`: the lines `certificates` are new lines of a run.

In 0.8.1, the middlebox uses the match recent, not the sysctls of conntrack, and `ends` has the optional field `answer`. `SYSCTL` and `NETNS_DEFAULTS` keep only `tcp_retries2`. These fields came in 0.8.0, which was not published. The fix and the optional field are a patch, thus the version is 0.8.1.

New members of the union `Step` (`sysctl` and `middlebox`) and of the signals of a step (`SIGHUP`) break a reader that switches on them. `KindLab` also has a new method, `netns`. Each is a breaking change before 1.0.0, thus the version is 0.8.0. The record format stays `/2`. A trigger has the optional fields `middlebox`, `retries`, `quiet` and `close`, and `ends` has the optional field `of`. The lines `kernel.state` are new lines of a run.

A new member of the union `TriggerKind`, `ztunnel-restart`, and a new member of the union `Reference`, `restart`, break a reader that switches on them. Each is a breaking change before 1.0.0, thus the version is 0.7.0. The record format stays `/2`, with the optional field `mesh.ztunnel`.

A new member of the union `Prediction`, `ends`, and a new member of the union `TriggerKind`, `idle`, break a reader that switches on them. The union `Target` has the new member `clients` too. Each is a breaking change before 1.0.0, thus the version is 0.6.0. The record format stays `/2`, with the optional field `closes`: the lines `sock` and `gap` are new lines of a run.

A new member of the union `Target`, `servers`, breaks a reader that switches on it. `KindLab` also has a new method, `tables`, which each implementation must have. Each is a breaking change before 1.0.0, thus the version is 0.5.0. The record format stays `/2`: the lines `tables`, `ztunnel` and `ztunnel-pod` are new lines of a run.

A new member of the union `TriggerKind` breaks a reader that switches on it. That is a breaking change before 1.0.0, thus the version is 0.4.0. The record format stays `/2`, with the optional fields `account`, `outcomes`, `updates` and `healUpdates`, and the reference `heal`.

A preStop sleep that is longer than the grace is a command in the container (`sh -c "sleep 60"`). The API server refuses a sleep action that is longer than the grace.

## Tests

`pnpm --filter @mark1russell7/kind test` starts the tests of the configuration, the tools, the parser of the rules and the fault mapping. It also starts the tests of the predictions, the verdict and the judge of the real records. They do not need Docker.

The catalogs are in `@systems/cells` (`t07.ts`, `t18.ts`, `grpc/t07.ts` and `grpc/t15.ts`). `KIND_LAB=1` starts them in kind.

## Cilium

From 0.12.0, a cell can have the dataplane `cilium`: Cilium 1.20.4 is the CNI, and it replaces kube-proxy (`cilium.ts`).

- **The cluster.** kind makes the cluster with no kube-proxy and no CNI, thus it does not wait for ready nodes. Then the lab loads the images of Cilium and installs it, before each other image.
- **The install.** `installCilium` installs the chart of 1.20.4, pinned by sha256 (`CILIUM_CHART`), with Helm. Then it waits for the agent, the operator, Envoy, each node and CoreDNS. A failed install gives the pods of kube-system and the log of the agent in its error.
- **The values** (`ciliumValues`). `kubeProxyReplacement` is true, and the agent reaches the API server on the control plane. The IPAM is `kubernetes`, as the kind guide of Cilium tells. The operator has one replica. Each other value is the default of the chart.
- **Socket LB** stays at its default: on, because the replacement of kube-proxy sets it. It selects a backend at each `connect()`, thus an established connection keeps its backend, as with kube-proxy.
- **The images.** `CILIUM_IMAGES` pins the agent, the operator and Envoy by the digests of the chart. `pullPolicy` is `Never`.
- **The mode** of the cluster manifest gives the version of Cilium and the keys of `cilium-config` that a cell depends on (`ciliumMode`).
- **The target `kube-proxy`** of a freeze needs kube-proxy. A cell of `cilium` with that target fails with a clear error.

## CI

The cells operate on the runners of GitHub, and not on a machine that does other work (`.github/workflows/kind.yml`). Each shard gets a runner, and each job makes its own clusters and deletes them.

- **The modes of the kernel.** kube-proxy in a node container uses the modules of the host kernel. Thus the job loads `ip_vs` and `nf_tables` first. A cell of a mode that the kernel cannot do waits, and `summary.ndjson` tells why.
- **The dataplane `cilium`** needs cgroup v2 on the runner. The job examines it, and a cell of `cilium` waits on a runner without it.
- **The capture.** The job `capture` makes a cluster of `cilium` and dumps the services of the agent of each node in three states of the backends (`src/cilium.capture.test.ts`). It uploads the artifact `cilium-capture`. The unit tests of `ciliumBackendsOf` read a part of a real dump (`test/cilium/`).
- **The inotify limits.** The pods of each node share the inotify limits of the kernel of the runner. Thus the job raises them to 512 instances and 524288 watches, the values of the known issues of kind.
- **The shards.** `shardOf` gives each shard an equal share of the estimated time, and the cells of one mode stay together. Thus a shard makes few clusters.
- **The output.** Each job uploads its raw records, `summary.ndjson`, and what the runner is. The run folder of each cluster stays out of the output, because a kubeconfig holds credentials.
- **A pull request** that changes the workflow starts a smoke run: the calibration of each mode, with 2 runs on one cluster.

## Releases

CI publishes each new version of this package (`.github/workflows/release.yml`). npm trusts the workflow only for a package that exists. Thus the first version of a new package goes out by hand, and then the workflow becomes its trusted publisher. For a package that npm does not have, the workflow gives a warning and publishes nothing.
