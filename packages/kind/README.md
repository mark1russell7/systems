# @systems/kind

Kubernetes in Docker (kind) as an environment of the systems program. A scenario gives the cluster, and the lab puts the faults of the harness in the namespaces of its pods. Each observation is on the one monotonic clock of the VM. This package is private, and it does not go to npm.

## Why it is private

The package is the first environment of its kind, and only T07 and T18 use it. Its image holds the packages of this workspace as tarballs. Thus it builds from the workspace, not from npm. CI does not start a cluster, thus no test in CI examines its lab parts. When a second template uses it, its shape is known, and it can go to npm as `@mark1russell7/kind`.

## The cluster

- **The scenario** (`scenario.ts`) is the cluster as data: its nodes, its version, the mode and the sync periods of kube-proxy, its CNI and its subnets. `kindConfig(scenario)` generates the configuration of kind from it.
- **The node image** is `kindest/node:v1.37.0`, pinned by digest, the default of kind v0.33.0. The research names v1.37.1 for some defaults. The patch release is the mismatch.
- **The tools** (`tools.ts`) are kind v0.33.0 and kubectl v1.37.0. The lab downloads each one into `.cache/` in this package, and it compares the sha256 with the pinned value at each use. It installs nothing on the system. The same code works on Linux, macOS and Windows.
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

The lab image (`image/`) holds the service of a cell on `@mark1russell7/service`, its clients, the agent and the watcher, on Node 24.21.0. Its base is pinned by digest, and `npm-lock.json` pins the packages from npm. `image.ts` builds the packages of the workspace, packs them as npm gets them, and tags the image by its content.

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

`pnpm --filter @systems/kind test` starts the tests of the configuration, the tools, the parser of the rules, the fault mapping, the arithmetic of the predictions and the verdict. They do not need Docker.

The catalogs are in `@systems/cells` (`t07.ts`, `t18.ts`). `KIND_LAB=1` starts them in kind.
