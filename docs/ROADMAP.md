# The roadmap of the systems program

This file is the source of truth for the work of the program. A live tracker shows the same items, with their dependencies and status. Each change to this file changes the tracker too.

Each item has an id, a status, an area, the items that it needs, its dates and its links. The statuses are `done`, `in progress`, `blocked`, `waiting on Mark` and `later`. An item that waits on Mark says what Mark does.

## The slices of the program

### R · The research rounds R1 to R5

- **Status:** done
- **Area:** program
- **Depends on:**
- **Started:** 2026-10-03
- **Shipped:** 2026-10-05
- **Links:**

Five research rounds give the facts, the systems to test, the queue of cells and the models of the network. The design takes the answer of each round.

### S0 · The groundwork

- **Status:** done
- **Area:** program
- **Depends on:** R
- **Started:** 2026-10-05
- **Shipped:** 2026-10-08
- **Links:**

The ontology, the quantity package, the register of sources and the corpus. A query gives the default of `tcp_retries2` on Linux 6.6 from graded claims.

### S1 · Detection and divergence in Docker

- **Status:** in progress
- **Area:** program
- **Depends on:** S0
- **Started:** 2026-10-08
- **Shipped:**
- **Links:** [The results](https://mark1russell7.github.io/systems/results/cells/)

Each system of the S1 set gets a matrix of cells, and the algebra predicts each cell. A prediction must match the harness in its tolerance.

### S2 · Intermediaries and Kubernetes

- **Status:** in progress
- **Area:** program
- **Depends on:** S1
- **Started:** 2026-10-15
- **Shipped:**
- **Links:** [The kind results](https://mark1russell7.github.io/systems/results/kind/)

kube-proxy in each mode, Cilium, Istio, kube-vip, CoreDNS, MetalLB and Pulsar, with drains and the lifecycle of a pod. kind checks each one.

### S3 · Outcomes under failure and load

- **Status:** later
- **Area:** program
- **Depends on:** S1
- **Started:**
- **Shipped:**
- **Links:**

Histories of operations and their checkers, load, exhaustion, retry storms and metastability. Kafka and etcd join the set.

### S4 · The host, the NIC and the cloud

- **Status:** waiting on Mark
- **Area:** program
- **Depends on:** S1
- **Started:**
- **Shipped:**
- **Links:**
- **Waiting on Mark:** Set up one Linux box as the VM tier, with KVM and QEMU. Check the box for an SR-IOV NIC. If it has none, order a used one. Tell if the box can stay on.

VMs with a kernel for each node, the failover of a host, block storage and shared fate. The cloud adds managed load balancers and real zones.

### S5 · Silicon

- **Status:** later
- **Area:** program
- **Depends on:**
- **Started:**
- **Shipped:**
- **Links:**

From the layout of a CMOS cell to the routing fabric of an FPGA, with the real geometry of SKY130. This slice can start at any time.

### S6 · The service abstraction

- **Status:** in progress
- **Area:** program
- **Depends on:** S1
- **Started:** 2026-10-08
- **Shipped:**
- **Links:** [@mark1russell7/service](https://www.npmjs.com/package/@mark1russell7/service), [The requirements](S6.md), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A service declares its clients, timeouts, retries, checks and state machines as data that the algebra reads. `@mark1russell7/service` has the declaration, the law, the health runtime, the lifecycle and the Redis client. Version 0.5.0 adds the HTTP edge (`./http`), the runner options and the requests as streams.

On 2026-10-17, Mark decided the design of the server stack (D1 to D18). These decisions replace the co-design gate for the runner, its HTTP entry, the composition, the requests, the signals and the profiles. Two parts of S6 still wait on S1. The first is the wrappers of the S1 clients after Redis, which Mark designs with S1. The second is the design of health and routing in the draft, whose candidates the harness of S1 and S2 tests.

## The server stack in S6

These items are the part of the server stack in this repository. The server stack is a plan across repositories: one service runner here, and one procedures server in the client. [Its tracker](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb) has the whole plan, with the same ids.

On 2026-10-17, Mark decided these questions for this repository:

- **D1.** The generic listener of `node:http` is a new entry, `@mark1russell7/service/http`. It has no framework.
- **D2.** A procedures host is a component. It gives its parts to the one service of the process, and only the entry of the process uses `run()`.
- **D3.** A controller can match a path pattern, and a function gives the idempotency of each request.
- **D4.** Each request is a stream, and a unary call is a stream of one item.
- **D5.** The probes answer on a port of their own or on the app port, as each process chooses.
- **D6.** A declared option tells what a second signal does: `ignore` or `exit`.
- **D7.** The profiles, for example local development and Kubernetes, are exported data that a caller spreads.
- **D16.** The harness takes its test subjects as data, and the client owns the image of its procedures subject. Thus this repository pins no `@procedures` package. Today harness 0.11.1 holds `@procedures/client` 0.7.0 in its procedures image ([#44](https://github.com/mark1russell7/systems/pull/44)).
- **D17.** A process for one command also operates under `run()`, with a minimal profile.

### DOC-5 · The requirements of S6 in this repository

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The requirements](S6.md), [#46](https://github.com/mark1russell7/systems/pull/46), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The groups A, B and E of the S6 draft move from jarvis into this repository, in STE. Each requirement tells which part of the service meets it.

### SYS-13 · The roadmap and the README tell the truth about S6

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#49](https://github.com/mark1russell7/systems/pull/49), [#46](https://github.com/mark1russell7/systems/pull/46), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

S6 is in progress, and the items of the server stack are on this roadmap. The README of the service named the `./http` exports before they existed. Then #49 gave those exports and corrected the example. Thus the README and the code agree.

### SYS-8 · The composition of components in one service

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [The README](https://github.com/mark1russell7/systems/tree/main/packages/service#composition), [#46](https://github.com/mark1russell7/systems/pull/46), [#48](https://github.com/mark1russell7/systems/pull/48), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A component gives its transports, dependencies and checks to the one service of the process. Only the entry uses `run()`. The README has the pattern. A test composes two sets of parts under one `run()`: the parts start and stop in their sequence, and the process exits one time.

### SYS-4 · A conformance kit for transports

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#49](https://github.com/mark1russell7/systems/pull/49), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

`@mark1russell7/service/testing` gets `transportConformance`, 12 cases for each `TransportImpl`. The intake stops, the drain keeps its deadline and its signal, the count is true, and a close has a bound. A reference transport passes, and each of nine mutations of it fails its case. #49 has the kit.

### CI-1 · Real sockets and drain times in CI

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-4
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#49](https://github.com/mark1russell7/systems/pull/49), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

`http.yml` starts the conformance kit on real sockets, with the keep-alive and drain times of `./http`, on Node 22.19, 24 and 26. Each job keeps its raw records as an artifact. These timed tests are only for CI. #49 has the workflow.

### SYS-1 · The HTTP listener as a transport

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-4, CI-1, DOC-5
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#49](https://github.com/mark1russell7/systems/pull/49), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A new entry, `@mark1russell7/service/http`, makes a `node:http` server a transport, as A8 of S6 tells. A small list of request and upgrade handlers lets several hosts use one port. The transport gets the lifecycle at its start, and its keep-alive reads `life.keepAlive()`. `httpTransport` passes the conformance kit on a fake server, and CI starts it on real sockets. #49 has the entry.

### SYS-2 · Probes on their own port or on the app port

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-1
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#49](https://github.com/mark1russell7/systems/pull/49), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

`probeServer` answers on its own port, and it closes last. `probeHandler` answers on an app port until `close transports`, thus its mount keeps the listener open through the drain. Both answer from the cache of the health runtime, and each 503 of a probe gets `Retry-After`. #49 has them.

### SYS-3 · An HTTP answer from each request outcome

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-1, SYS-15, SYS-6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#49](https://github.com/mark1russell7/systems/pull/49), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

`handle()` binds a request of `node:http` to `life.request`, and `writeOutcome` writes the stream of the request. A unary request gets one status and its value. A stream gets each item as it comes, and an end after the first item goes in the body. Each 503 gets `Retry-After`, and a 500 gets none. #49 has them. They use the lifecycle that each transport gets at its start (#48), and the streams of #50.

### SYS-15 · Request tracking from the start of each transport

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#48](https://github.com/mark1russell7/systems/pull/48), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The transports start before the startup ends, but `run()` gives `life.request` only at that end. The kind lab uses a global and a 503 to go around it. After this item, a transport tracks its requests from its start.

### SYS-5 · Dynamic routes

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [#50](https://github.com/mark1russell7/systems/pull/50), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A controller can declare a path pattern, and a function gives the idempotency of each request. Thus the service tracks a registry of procedures that changes while it operates.

### SYS-6 · Each request is a stream

- **Status:** in progress
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:**
- **Links:** [#50](https://github.com/mark1russell7/systems/pull/50), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A request stays in flight until its stream ends. A failure after the first item ends the stream with an error line, not a 503. The cooperative abort ends the stream. This change breaks the API, thus it comes in service 0.5.0. #50 gives the server side. On it, 25 of the 31 cells in kind hold, and the one failure is a finding of conntrack (KIND-LONE). The client streams and the conformance kit of SYS-4 complete the item.

### SYS-7 · A stop when stdin closes, and a minimal profile

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#48](https://github.com/mark1russell7/systems/pull/48), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A stdio process, for example an MCP host, stops through the staged shutdown when its parent closes stdin. A small declaration without probes passes `describe()` and `lint()`.

### SYS-9 · A declared policy for a second signal

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#48](https://github.com/mark1russell7/systems/pull/48), [#50](https://github.com/mark1russell7/systems/pull/50), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

Each declaration tells what a second signal does: `ignore`, as in 0.4, or `exit`. In 0.5.0 `describe()` refuses a declaration without it, and `lint()` names a description without it. The profiles for a terminal use `exit`, and the profiles for a supervised host use `ignore`. jarvisService declares it at JAR-4.

### SYS-10 · Profiles as data

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#48](https://github.com/mark1russell7/systems/pull/48), [#50](https://github.com/mark1russell7/systems/pull/50), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

Exported profiles fill the phases, the cooperative window and the policies. A caller spreads them. The Kubernetes profile gets the caps from the grace period and the preStop delay. The profile `daemon` is for a background host, with the caps of local development.

### SYS-12 · An optional zod

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#48](https://github.com/mark1russell7/systems/pull/48), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The root of the service does not use zod at run time. Thus zod becomes an optional peer dependency. The algebra keeps zod as a necessary peer, because its root uses zod. SYS-19 changes that.

### SYS-19 · The zod schemas of the algebra in an entry of their own

- **Status:** later
- **Area:** server stack
- **Depends on:** SYS-12
- **Started:**
- **Shipped:**
- **Links:** [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The zod schemas of `@mark1russell7/algebra` move into a new entry, `./schema`, as in `quantity`. Then zod becomes an optional peer of the algebra too. The root of the algebra no longer gives the schemas, thus the change breaks its API and comes in algebra 0.8.0.

### SYS-20 · The OpenTelemetry preload of an ESM service

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-1
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [#57](https://github.com/mark1russell7/systems/pull/57), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

An ESM service loses its express spans when its preload does not register `@opentelemetry/instrumentation/hook.mjs` before the app loads. The telemetry check of Graph found it when `@graph/server` moved to ESM. The README of the service tells it, beside an HTTP service under `run()`, with the preload of the hook.

### SYS-16 · run() for a process that runs one command

- **Status:** done
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#48](https://github.com/mark1russell7/systems/pull/48), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The process exits with the code of its work. A first Ctrl-C can abort at once, and the exit waits for stdout and stderr.

### SYS-14 · A worker loop and a queue drain

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-4
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [#66](https://github.com/mark1russell7/systems/pull/66), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

`workerLoop` (A10 of S6) and `queueDrain` (A11) are `TransportImpl` factories in the root of the service. Each lane of a loop does one iteration at a time, and its sleeps and backoffs are on the clock. The drain takes jobs under a concurrency, applies the declared redelivery policy, and gives back each job that it did not start. Each unit can go through `life.request`. `lint()` applies O20 to each consumer and worker. Both pass the conformance kit of SYS-4.

The lifecycle holds its process from its start to its exit, thus a process with only workers does not end while it waits. The helpers come to npm in the next PATCH of the service. They are for the heartbeat of jarvis (JAR-4), the workers of Graph (GRAPH-6, GRAPH-10) and the job queues of OTH-4.

### SYS-21 · A stop from a message of the IPC channel

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-7
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [#66](https://github.com/mark1russell7/systems/pull/66), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

Windows cannot give a child a SIGTERM that the child can catch, thus the entry of Graph also stops at the IPC message `shutdown` (CI-4 of Graph). `svc.trigger("ipc-message", { match, as })` declares the message as data, and it starts the staged shutdown of SIGTERM with its exit code. `process.yml` tests a real child on Linux and on Windows.

### SYS-11 · The kind lab on ./http

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-1, SYS-2, SYS-3
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [#58](https://github.com/mark1russell7/systems/pull/58), [The kind run](https://github.com/mark1russell7/systems/actions/runs/39092100083), [#49](https://github.com/mark1russell7/systems/pull/49), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The image of the kind lab replaces its own transport, probe server and outcome map with `./http`: `httpTransport`, `probeServer` and `handle()`. A failure of the route keeps its 503 through the hook `failed`, thus the T07 and T18 cells count the same outcomes. The kind cells run only in CI.

### REL-1 · Service 0.5.0 with ./http and the runner options

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-1, SYS-2, SYS-3, SYS-15, SYS-11
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A change of the version on main makes `release.yml` publish it. It is a MINOR, because SYS-6 changes `RequestFn` and the outcome type before 1.0. The client, jarvis and Graph then use it from npm.

### REL-4 · Service 0.5.1 with the worker loop, the queue drain and the IPC trigger

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-14, SYS-21
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [#69](https://github.com/mark1russell7/systems/pull/69), [npm](https://www.npmjs.com/package/@mark1russell7/service/v/0.5.1), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

This release publishes `workerLoop`, `queueDrain`, `redeliverOnce`, the trigger `ipc-message` and the hold of the process (#66). It is a PATCH, because each change adds an export or an option before 1.0, and nothing is removed. Graph (GRAPH-6) and jarvis (JAR-4) then use the helpers from npm.

### SYS-17 · The harness takes its test subjects as data

- **Status:** in progress
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-18
- **Shipped:**
- **Links:** [#65](https://github.com/mark1russell7/systems/pull/65), [The WS, WST and PG run](https://github.com/mark1russell7/systems/actions/runs/39101123561), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

`@mark1russell7/harness` accepts the image of a subject as data (D16). Thus another repository can give its own subject, with its own release in it.

The source of an image is an image pinned by digest, a build context, or an image that the harness ships. Each build has a digest on each `FROM` and a lockfile for each manifest. The procedures image is the shipped subject `SUBJECTS.procedures`. The WS and WST catalogs take a subject, and `cells.yml` takes one as JSON (`subject`). #65 has the change, and `image/procedures` stays until SYS-18.

### SYS-18 · The procedures image leaves the harness

- **Status:** blocked
- **Area:** server stack
- **Depends on:** SYS-17
- **Started:**
- **Shipped:**
- **Links:** [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

After CLI-33, the client owns the image of its procedures subject. Then the harness removes `image/procedures`, and the README of the harness no longer describes that image.

### SYS-24 · The progress check names the loops that mark it

- **Status:** later
- **Area:** server stack
- **Depends on:** SYS-14
- **Started:**
- **Shipped:**
- **Links:** [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A check of the kind `progress` fires when no loop marks progress in its stall time. Today each app gives that time by hand: jarvis gives 370 s for its weather poll (JAR-4). With a field `marks`, the check names its loops. Then `lint()` finds a stall time that is shorter than the interval of the slowest loop, with its jitter and its timeout. It is a PATCH: an optional field and a new finding.

### SYS-25 · The pairing window from the jitter of the runner

- **Status:** later
- **Area:** engines
- **Depends on:**
- **Started:**
- **Shipped:**
- **Links:**

A run pairs each event of a program with its record of the kernel in δ_abs, 1 ms. On a runner of GitHub the jitter of a program is 1.06 to 1.74 ms, thus a single run can fail on it. The harness measures that jitter in each run and records it, and δ_abs is the larger of 1 ms and the measured bound. A verdict that fails a cell only when its miss repeats changes how a verdict counts. Mark ruled the void threshold on 2026-10-16, thus that part is the decision D19 of the server stack, for Mark.

### SYS-26 · The image of the kind lab goes through the resolver of images

- **Status:** later
- **Area:** engines
- **Depends on:** SYS-17
- **Started:**
- **Shipped:**
- **Links:**

The kind lab builds its image with its own code. As a `build` source of SYS-17, it goes through `planOf` and `imageOf`. Then their rules apply: each FROM has a digest, and each manifest of packages has a lockfile.

### SYS-27 · A process port for a service in a process that another part owns

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-21
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [#72](https://github.com/mark1russell7/systems/pull/72), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

Some entries start a service in a process that they do not own. Examples are a script, a test of an application, and `createPeer` of the client (CLI-7). Before, such an entry wrote its own small runner, or it gave the port of the process of Node. The new port `embeddedProcess()` adds no signal handler, it does not hold the process, and its `exit` only records the code. Thus the full lifecycle runs, and only the owner of the process handles its signals. It comes in service 0.5.2, a PATCH: one new export.

## The systems of S1

### REDIS · Redis and R3's compiled queue

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-08
- **Shipped:** 2026-10-17
- **Links:** [R3's queue](https://mark1russell7.github.io/systems/results/r3/), [#36](https://github.com/mark1russell7/systems/pull/36)

Of the 115 cells that jarvis compiles from its corpus, 114 hold and 1 is a measurement only. Two gaps of the corpus failed 9 cells first, and each one held after the fix.

### SENTINEL · Valkey under Sentinel

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-14
- **Shipped:** 2026-10-16
- **Links:** [The results](https://mark1russell7.github.io/systems/results/sentinel/)

T12 puts a Valkey primary and its replicas under three Sentinels, and ioredis in Sentinel mode follows each failover.

### HTTP · The keep-alive of HTTP clients

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-15
- **Shipped:** 2026-10-16
- **Links:** [The results](https://mark1russell7.github.io/systems/results/http/)

The agent of Node, undici and the transport of Go race the keep-alive timer of a Node server. Calibration cells bound the handling time of each client.

### MONGODB · The MongoDB driver and a replica set

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-15
- **Shipped:** 2026-10-17
- **Links:** [The results](https://mark1russell7.github.io/systems/results/mongodb/), [#30](https://github.com/mark1russell7/systems/pull/30)

T01, T03 and T11 put the Node driver against a replica set of three. The documents of the driver and of mongod come from their source.

### WS · The heartbeat of a WebSocket client

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-16
- **Shipped:** 2026-10-17
- **Links:** [#29](https://github.com/mark1russell7/systems/pull/29)

The client of `@procedures/client` drops a silent connection on its own heartbeat. The harness times the drop and the reconnect, behind routers and HAProxy too.

### WS-070 · The WebSocket cells on @procedures/client 0.7.0

- **Status:** done
- **Area:** catalogs
- **Depends on:** WS
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39073727730), [#44](https://github.com/mark1russell7/systems/pull/44)

The image of the WS cells moves to 0.7.0, and harness 0.11.1 holds it. WST gets the heartbeat of the server through the router of T03, and the ws class through each hop. Each of the 33 cells holds or is measured in CI.

### TOX · The toxics of Toxiproxy

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-14
- **Shipped:** 2026-10-17
- **Links:** [#28](https://github.com/mark1russell7/systems/pull/28)

Each toxic gets a prediction from the source of Toxiproxy. A `reset_peer` toxic on a live connection closes it with FINs, and the client reads an end of file.

### LISTING · The listing of the router holds the softirqs

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39057994070), [#41](https://github.com/mark1russell7/systems/pull/41), [The next run](https://github.com/mark1russell7/systems/actions/runs/39074841434)

The router of T03 lists the conntrack table each 50 ms. A listing walks each bucket of the table with the softirqs off, and a runner has 262144 buckets. One reply of 13,306 waited 6.8 ms in a listing, and one netem cell failed on it. The workflows give the table 16384 buckets. In the next full run, each of the 234 cells holds or measures, and the longest time of a segment through the router was 0.315 ms.

### STAMPS · The error of the Sentinel stamps from each calibration

- **Status:** done
- **Area:** catalogs
- **Depends on:** SITE-REFRESH
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39074841434), [#54](https://github.com/mark1russell7/systems/pull/54)

Each stage band of T12 includes the error of the stamps of the observer: 0.705 ms, the maximum of the first calibration. The calibration of the full run read 402 stamps, with a maximum of 1.003 ms, and each stage held. The catalog takes 1.003 ms, the 99.9th percentile of the 799 stamps of the two calibrations.

### PG · PostgreSQL

- **Status:** in progress
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-18
- **Shipped:**
- **Links:** [#62](https://github.com/mark1russell7/systems/pull/62), [#64](https://github.com/mark1russell7/systems/pull/64), [#68](https://github.com/mark1russell7/systems/pull/68), [#70](https://github.com/mark1russell7/systems/pull/70), [#76](https://github.com/mark1russell7/systems/pull/76), [#77](https://github.com/mark1russell7/systems/pull/77), [#78](https://github.com/mark1russell7/systems/pull/78), [#79](https://github.com/mark1russell7/systems/pull/79), [#80](https://github.com/mark1russell7/systems/pull/80), [#81](https://github.com/mark1russell7/systems/pull/81), [#82](https://github.com/mark1russell7/systems/pull/82), [#83](https://github.com/mark1russell7/systems/pull/83), [#84](https://github.com/mark1russell7/systems/pull/84), [#85](https://github.com/mark1russell7/systems/pull/85), [#86](https://github.com/mark1russell7/systems/pull/86), [#90](https://github.com/mark1russell7/systems/pull/90), [#91](https://github.com/mark1russell7/systems/pull/91), [#92](https://github.com/mark1russell7/systems/pull/92), [#93](https://github.com/mark1russell7/systems/pull/93), [#94](https://github.com/mark1russell7/systems/pull/94), [#95](https://github.com/mark1russell7/systems/pull/95)

The next system of the S1 order, with its clients and PgBouncer. At its defaults and its borders, the plan of R3 has 329 cells with PostgreSQL. HikariCP with pgjdbc is the client of 160 of them, Npgsql of 47 and node-postgres of 36. T10, through a pooler, has 132 of them.

- The first step is two machine documents from their sources: node-postgres 8.23.1 with pg-pool 3.14.0, and a backend of PostgreSQL 17.11 (machines 0.3.1, #62).
- The harness has a client of node-postgres and a target of PostgreSQL 17.11 (harness 0.11.2, #64).
- The six T01 cells at the defaults hold, with 11 runs each on the runner of GitHub (#64):
  - A reset of a query in flight gives ECONNRESET in 0.6 ms. A FIN to an idle client gives EOF in 18 µs.
  - An unreachable host gives EHOSTUNREACH at 3.120 s, when the kernel stops with `tcp_retries2 = 3`.
  - A stall of 1 s recovers in 1.643 s. A frozen server has no detector in 60 s.
  - Behind a black hole, the pool ends its idle client at its idle timer, 10.004 s after the last segment. The kernel stamps the FIN of the pool. The pool emits `remove` only when the socket closes, and behind a black hole the FIN gets no answer.
- Seven more T01 cells of node-postgres hold, with 11 runs each (#68):
  - A reset of the SYN refuses the first connect in 3.1 ms (ECONNREFUSED).
  - With no fault, the pool ends its idle client 10.004 s after the last segment, as behind a black hole.
  - The server holds each reply 5 s. Nothing ends the query, and the reply comes at 5.006 s.
  - `query_timeout` ends a query in a black hole at 9.503 s and 10.503 s, on each side of the slowest poll of 10 s (O13).
  - `connectionTimeoutMillis` ends the first connect at 29.007 s and 31.009 s, on each side of the startup budget of 30 s (O15). The kernel gives up on the SYNs only at 131 s.
  - A cell that starts into a fault counts from the first connect. The pg client writes a `connecting` line for it (harness 0.11.3).
- The borders of O03 of node-postgres hold through a router that forgets an idle flow in silence, with 11 runs each (#81). On each side the pool closes its idle client at its own timer, thus the cells observe the socket of the server.
  - The router divides its idle timeout by 20, thus it forgets at 12 s.
  - Inside, the pool closes its client at 10 s, and its FIN reaches the server at 10.004 s.
  - Outside, at 14 s, the router forgets the flow first and drops the FIN. The socket of the server stays established for the 30 s of the window: a backend for a client that is gone.
  - Two forgets came 2.2 ms after the bound of the pump of the router and two listings. Harness 0.11.8 adds a slack of 5 ms to that bound.
- Six T01 cells of node-postgres wait, each with its reason:
  - Three need a fault that the harness cannot make: a restart at the same address, a fault at a reply, and a blocked event loop.
  - Write-write-read does not occur, because pg sets TCP_NODELAY.
  - Two are borders of O03 for a client that the application holds. The client of the harness gives its client back to the pool after each query.
- R3's plan has no T03 cell for node-postgres: each PostgreSQL cell of T03 has HikariCP as its client. The next client is HikariCP 7.1.0 over pgjdbc 42.7.13:
  - Its machine document is in machines 0.3.2 (#70). HikariCP reads no idle socket. Its keepalive checks an idle connection each 96 to 120 s from its creation, and at the defaults no timer of pgjdbc bounds a query.
  - The harness has its client, on Temurin 21.0.12.1 (harness 0.11.4, #71). Its lab test resets a query in flight.
  - Its first six T01 cells hold, with 11 runs each (#73). A reset of a query gives ECONNRESET in 0.6 ms, and the FIN of a stopped server gives EOF in 12 µs. An unreachable host gives EHOSTUNREACH at 3.120 s at `tcp_retries2 = 3`. A stall of 1 s recovers in 1.656 s. A freeze and an idle pool have no detector in 60 s.
  - The borders of O13 hold (#75). A read timeout of 9 s and 11 s closes the socket of a query in a black hole. The two are on each side of the slowest poll of 10 s.
    - The JDK waits for a read in poll(), and Linux ends that wait up to 0.1 % of its time late. The first cells measured it: 11.35 ms late at 11 s. The document gets that slack (machines 0.3.3).
    - The close of the socket ends the band. The fail line comes up to 9 ms later, when a new JVM builds the exception of pgjdbc.
  - The keepalive of the pool holds behind a black hole, with 11 runs (#76).
    - Its empty query is the first segment after the fault. The read timeout of the check closes the socket 5.003 s after that query (validationTimeout 5 s).
    - The harness counts from that segment (reference `first-sent`, harness 0.11.5).
    - The keepalive tasks of the pool share one thread (HikariPool.java:644-651). Behind the black hole, each check waits for the checks before it, and each one takes 5 s. Thus the check of the observed connection came 106 to 135 s after the connection, and not in the 96 to 120 s of its own keepalive.
    - The document says so (machines 0.3.6, #82). The latest start of such a check adds the check of each other connection of the pool: 165 s at the defaults. The cells hold with it.
  - The start of the pool holds, with 11 runs for each cell (#77). The pool tries once, and after a failure it sleeps 1 s. At the default `initializationFailTimeout` of 1 ms, the start then fails with PoolInitializationException (machines 0.3.4).
    - A reset of the first connect fails the start at 1.008 s.
    - The borders of O15 hold. Behind a black hole, a `connectTimeout` of 28 s fails the start at 29.026 s, and 30 s at 31.030 s. The two are on each side of the startup budget of 30 s.
    - The client starts the code of a connect and of a pool before its first line (harness 0.11.6). It also starts SecureRandom, which HikariCP reads for the UUID of each new connection. Before that, the first connect of a cell was 22 ms late.
  - The server holds the query in flight 5 s, and nothing ends it: the reply comes at 5.004 s (#78).
  - The borders of O03 hold through a router that forgets an idle flow in silence, with 11 runs each (#79). The cells divide each timer by 4, thus the router forgets at 60 s. HikariCP turns a keepalive below 30 s off, so the factor of 20 of the MongoDB catalog cannot apply.
    - Inside, a keepaliveTime of 55 s refreshes the flow, and nothing occurs in 150 s.
    - Outside, a keepaliveTime of 80 s comes after the router forgot the flow. The router drops the empty query of the check, and its read timeout closes the socket 5.004 s later.
  - The other 6 T01 cells of HikariCP wait, each with its reason.
  - Seven T03 cells of HikariCP hold, with 11 runs each (#80). Each goes through a router at the idle timeout of its cloud preset, in real time.
    - A fault at the router toward the client is the same fault for the socket of the client. A black hole of an idle connection, an unreachable host, a FIN and a stall each hold the band of their T01 cell.
    - An MTU black hole at the router takes each long segment of a reply of 2 MB. Nothing ends the read in 60 s.
    - The keepalive keeps an idle flow through the Azure NAT form (240 s) and the AWS NAT form (350 s). Nothing occurs in 300 s and in 400 s.
    - The 8 T03 cells with Supavisor 2.9 waited for a hop of Supavisor, which #92 adds.
- The borders of O07 hold for node-postgres and for HikariCP, with 11 runs each (#78). The server has a `statement_timeout` of 10 s, and the query in flight sleeps 20 s.
  - Inside, the timer of the client is longer: pg at 10.5 s and HikariCP at 11 s. The server ends the query with ERROR 57014 at 10.002 s (pg) and at 10.004 s (HikariCP).
  - Outside, the timer of the client is shorter. pg gives up at 9.503 s, and the read timeout of HikariCP closes its socket at 9.010 s. The server goes on with the statement.
  - The harness sends a slow text only in the query in flight (`inflight`, harness 0.11.7). The server gets its settings on its command line.
- PgBouncer 1.26.1 has its two machine documents and a hop of the harness (#83), the first step of T10.
  - The documents come from its C source at its tag (machines 0.3.7): one client connection, and one server connection of a pool. Each timer of PgBouncer is a check of its janitor, each 333.3 ms.
  - At the defaults PgBouncer checks an idle server older than 30 s with the empty query before its next use, and no timer bounds that check.
  - The hop builds PgBouncer from its release tarball, by its SHA-256 (harness 0.11.9). Its lab test passes: a reset of the server reaches a client of node-postgres as FATAL 08P01 "server conn crashed?".
- The first three T10 cells of HikariCP hold through PgBouncer, with 11 runs each (#84). A fault at the server is between PgBouncer and the server.
  - Behind a black hole of the server, the keepalive of HikariCP sends its empty query to PgBouncer, and no reply comes. Its read timeout closes the socket at 5.002 s, as on the direct pair.
  - The server holds the query in flight 5 s, and nothing ends it: the reply comes at 5.006 s.
  - HikariCP of the earlier epoch has no keepalive, thus nothing finds the black hole in 60 s.
  - The two documents of PgBouncer decide that no timer of PgBouncer ends a query first: its earliest is query_wait_timeout, 120 s.
  - The other T10 cells at the defaults wait. Some need Pgpool-II or Supavisor, and some need several clients, SIGHUP or a console command at a hop, or a fault timed to a reply.
- The PostgreSQL page of the site shows the 44 cells of the catalogs from one run at main ([39127973566](https://github.com/mark1russell7/systems/actions/runs/39127973566)). Each holds, with 484 counted runs and no void run (#85).
- The first borders of T10 hold through PgBouncer, with 11 runs each (#86):
  - query_timeout of PgBouncer against a query of 5 s. At 6 s, the reply comes at 5.004 s. At 4 s, a pass of the janitor ends the query, and PgBouncer closes the client with FATAL 08P01 at 4.127 s.
  - A frozen server whose kernel acknowledges the query, against a read timeout of 10 s. A hold of 9 s gives the reply at 9.010 s, and a hold of 11 s ends at the read timeout, 10.011 s.
  - O07 with one more hop. With a socketTimeout of 11 s, the server ends the query with ERROR 57014 at 10.004 s. With 9 s, the read timeout closes the socket at 9.010 s.
  - O01 for node-postgres, against a client_idle_timeout of 12 s. The pool closes its idle client at 10.003 s. At an idle timer of 14 s, PgBouncer closes the client first, at 12.304 s.
    - The pool sends the message `Terminate`, and it ends its socket only in the callback of that write. PgBouncer closes the client when it reads the message, and its FIN comes first. Thus the end is an end of file, not the close of the pool.
  - The read timeout against the give-up of the kernel of PgBouncer, with tcp_retries2 = 4 in its namespace. The cells observe the server socket of PgBouncer. A socketTimeout of 5 s comes first, and PgBouncer closes its server socket at 5.005 s. At 15 s, the kernel of PgBouncer gives up first, 12.832 s after its first retransmission.
    - These two cells keep one connection in the pool. At its fixed size of 10, the pool still adds connections when the fault comes. Each one sends a query through the one server of PgBouncer. Such a query took the server into the black hole, and PgBouncer opened a new server for the query of the cell.
- The other T10 borders wait, each with its reason. Most of them name the knob of another system. Others need a transaction or several clients.
- Pgpool-II 4.7.3 has its machine document and a hop of the harness, the second pooler of T10 (#90).
  - The document comes from its C source at its tag (machines 0.3.8): one session of a child of Pgpool-II. An idle session waits in one select() on the client and the server. A query waits on the server only, in steps of 30 s, and after each step Pgpool-II writes a dummy ParameterStatus to the client. No timer of Pgpool-II ends a query.
  - The FIN of the server gives FATAL XX000 to the client, with no failover. A read error of the server, or a failed connect to it, gives a failover at the defaults.
  - The hop builds Pgpool-II from the source tarball of its tag, by its SHA-256 (harness 0.11.11). Its lab test passes: the FIN of the server reaches a client of node-postgres as an end of file.
  - Behind a pooler, the run reuses a connection of the pooler to the server, which the run did not open. The judge then times the FIN of the server from the first socket toward the pooler that leaves ESTABLISHED after the outset (harness 0.11.11).
- Five T10 cells hold through Pgpool-II, with 11 runs each (#90):
  - The FIN of the server ends the session of Pgpool-II, and the idle client of node-postgres gets an end of file 0.7 ms later.
  - A frozen server: Pgpool-II waits on it with no bound, and nothing ends the query in 60 s.
  - O07 with Pgpool-II as the hop. With a socketTimeout of 11 s, the server ends the query with ERROR 57014 at 10.005 s. With 9 s, the read timeout closes the socket at 9.009 s.
  - Behind a black hole, the keepalive of HikariCP sends its empty query through Pgpool-II. Its read timeout closes the socket at 5.002 s, as on the direct pair.
  - That cell keeps one connection (minimumIdle 1), and each run has a new environment. At the fixed size of 10, the warm-up held. Then the next run got an error 0.1 ms after its check, and the client after it got no connection. The pool opens a new connection after each failed check, and Pgpool-II then connects through the black hole. A failed connect gives a failover, and with its only server detached Pgpool-II refuses each client (harness 0.11.11, `fresh`).
- The border of K-proxy-timeouts against T_syn holds through PgBouncer, with 11 runs each (#91). The client starts into a black hole of the server, and PgBouncer connects to the server for its first login. The cells observe that socket of PgBouncer from its SYN.
  - Inside, server_connect_timeout is 128 s. The connect timer of PgBouncer closes the socket in SYN_SENT at 128.0005 s, with no error and no FIN.
  - Outside, server_connect_timeout is 140 s. The kernel of PgBouncer gives up on the SYNs first, with ETIMEDOUT at 133.26 s and not at 131 s.
  - Each wait of the SYN is a timer of the wheel. At HZ 1000 the give-up can be up to 6.08 s late, because the wait of 64 s can be 4.096 s late (algebra 0.7.2, machines 0.3.9).
  - The judge reads a band on the socket that a hop opens toward the target (harness 0.11.12). The band counts from its SYN, and it ends at its error or at its close in SYN_SENT.
- Supavisor 2.9.13 in transaction mode has two machine documents and a hop, the third pooler of T10 (#92).
  - The documents come from its Elixir source at its tag (machines 0.3.10). Between two transactions a client holds no server connection. At the defaults Supavisor writes a heartbeat to an idle client each 60 s.
  - A failed connect of the pool gives FATAL 08006 to a waiting client, and the next connect waits 2.5 s. No timer of Supavisor bounds a query.
  - In 2.9.13 client_idle_timeout ends no session: its timer fires an event that no clause of the client handler takes.
  - The hop is the image of Supabase by its digest, with one tenant on the server of the cell. A proxy hop takes an environment, and a hop that does not start gives its last lines (harness 0.11.13).
- Four T10 cells of node-postgres hold through Supavisor, with 11 runs each (#92):
  - An idle client behind a black hole of the server holds no server connection. The pool closes it at 10.003 s, and Supavisor closes it at its `Terminate`.
  - Behind a frozen server, and behind a black hole with a query in flight, Supavisor waits on the server with no bound. Nothing ends the query in 60 s.
  - The server holds the query 5 s, and the reply comes at 5.007 s.
- T10.defaults.3 waits: through Supavisor, the FIN of the server ends an idle client of HikariCP in two ways (run 39164922565).
  - In 6 of 11 runs the next login of the pool got 57P03 while the server shut down. Supavisor then shut the pool down, and each idle client got FATAL 57P01 and its close at once.
  - In 5 runs the connect came after the server. Then the client ended at its next check, with FATAL 08006 and the FIN 1.4 to 2.3 s after its empty query.
- The fixes for two runs of the full PostgreSQL run 39160356281, which had 2 failures:
  - Behind PgBouncer, the judge read a socket that the run opened, but PgBouncer sent the query through a server from the warm-up. Thus the judge reads the socket of the hop that carries the request (harness 0.11.14).
  - The connect timer of PgBouncer closed its socket at 127.998993 s, 1 ms early. libevent counts a timeout from its cached time of the pass. Thus the band has an early slack of 10 ms (machines 0.3.11).
- Seven T03 cells of HikariCP have the chain of R3 for Supavisor 2.9 (machines 0.3.12). A router of a cloud preset is in front of Supavisor, and Supavisor is in front of the server. Each holds in run 39170773426, with 11 runs (#94).
  - A fault at the router acts between the client and Supavisor. Each band is the band of the same fault at the router alone, and no timer of Supavisor ends the client in the band.
  - Behind a simplex drop to the client, the empty query of the check reaches Supavisor, but its answer does not come back. The read timeout of the check closes the socket 5.003 s after that query, as behind a black hole (5.005 s).
  - An unreachable host with tcp_retries2 = 3 gives EHOSTUNREACH 3.120 s after the first retransmission. Through the Azure NAT form and the AWS NAT form, the keepalive keeps the flow for 300 s and 400 s.
  - After a stall, the first segment back can be the reply of Supavisor, one step of Supavisor later. The median is 1.662 s, and a warm-up came at 1.6988 s, after the band of the router alone.
  - ranch gives each client socket of Supavisor a send timeout of 30 s that closes it. Behind the MTU black hole, the FIN of that close waits behind the long segments, thus the client gets nothing in 60 s. In run 39170773426, the socket of Supavisor closed 30.068 to 30.086 s after the fault.
  - T03.defaults.61 waits: a fin through Supavisor is the race of T10.defaults.3.
- An event at a pooler (harness 0.11.15): a signal to its program, or a query on its console. Three T10 cells that waited for it go to CI.
  - T10.defaults.15 and .8: SIGHUP to PgBouncer and to Pgpool-II while the server holds the query 5 s. The documents take the reload with no transition, thus the reply comes as with no reload (machines 0.3.13).
  - T10.defaults.7: PAUSE on the console of PgBouncer, then a query of node-postgres. The query waits in the queue, and query_wait_timeout ends it with FATAL 08P01 at 120 s.
  - The injector sends the query of the console in the simple query protocol of PostgreSQL, and it stamps the query and its ReadyForQuery. After the run, RESUME lifts the PAUSE.

### RABBIT · RabbitMQ

- **Status:** later
- **Area:** catalogs
- **Depends on:** PG
- **Started:**
- **Shipped:**
- **Links:**

The heartbeats of AMQP and the timers of the broker.

### H2 · HTTP/2 and gRPC

- **Status:** later
- **Area:** catalogs
- **Depends on:** HTTP
- **Started:**
- **Shipped:**
- **Links:**

The PING frames of HTTP/2, the keepalive of gRPC and the enforcement policy of a gRPC server.

## Kubernetes

### KIND · Kubernetes endpoints in kind

- **Status:** done
- **Area:** catalogs
- **Depends on:** S2
- **Started:** 2026-10-15
- **Shipped:** 2026-10-18
- **Links:** [The results](https://mark1russell7.github.io/systems/results/kind/), [#34](https://github.com/mark1russell7/systems/pull/34), [The run at main](https://github.com/mark1russell7/systems/actions/runs/39090689204), [#59](https://github.com/mark1russell7/systems/pull/59)

T07 is the lifecycle of the endpoints of a Service, and T18 is a fleet whose readiness needs Redis. In the run at main of 2026-10-18, 26 of the 31 cells hold, 3 are calibrations and 2 are measurements, and no cell fails. KIND-LONE gave the cause of each lone failure of 2026-10-17.

### KIND-LONE · The cause of the lone failures in kind

- **Status:** done
- **Area:** catalogs
- **Depends on:** KIND
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:** [#35](https://github.com/mark1russell7/systems/pull/35), [#56](https://github.com/mark1russell7/systems/pull/56), [The run at main](https://github.com/mark1russell7/systems/actions/runs/39090689204), [#59](https://github.com/mark1russell7/systems/pull/59)

One failure is a late propagation. The others are SYNs that met an entry in SYN_SENT on their port, from a SYN with no answer up to 120 s before. The agent of kind 0.1.4 reads the conntrack table of each node each second, through netlink on a runner. It showed the old entry of a lone timeout on its port, 35 s old.

The first SYNs came between the runs, where the lab keeps no line. Thus the lab deletes these entries before each run. Then the T07 run had no timeout. One refusal is left in nftables mode, 34 ms after a deletion, probably the ICMP error of a reject rule. kind 0.1.5 counts these errors.

The run of #50 gives a cause in the model of conntrack, not in the lab. The deleted pod reset a connection, and conntrack kept its flow in CLOSE for 10 s, with the NAT to that pod. A SYN on a CLOSE entry looks up again only after a FIN, or after a reset from the client. Thus a client that used the same port 6.8 s later sent its SYN to the deleted pod, and the request timed out. From kind 0.1.6, a window can give that mechanism (`afterReset`), and the catalog gives it to a deletion without a hold in iptables and nftables. Judged again with the catalog, the run of #50 has no failure.

The run at main of 2026-10-18 has no failure either: 26 cells hold. The same cell had the same case, 8.2 s after its reset, and the prediction held it. The refusal of nftables did not come again in the two full runs. If it comes again, the ICMP counter of the agent tells its cause.

## The engines and the models

### ENGINES · The engines on npm

- **Status:** done
- **Area:** engines
- **Depends on:**
- **Started:** 2026-10-13
- **Shipped:** 2026-10-17
- **Links:** [npm](https://www.npmjs.com/~mark1russell7)

quantity 0.2.0, algebra 0.7.1, service 0.5.2, prober 0.3.1, harness 0.11.4 and kind 0.1.7. CI publishes each version change of main.

### MACHINES · The first version of @mark1russell7/machines

- **Status:** done
- **Area:** engines
- **Depends on:**
- **Started:** 2026-10-16
- **Shipped:** 2026-10-18
- **Links:** [packages/machines](https://github.com/mark1russell7/systems/tree/main/packages/machines), [npm](https://www.npmjs.com/package/@mark1russell7/machines)

The one home of each machine document. Its first version on npm is 0.3.7, published on 2026-10-18 with OIDC and provenance. Version 0.3.1 adds the two documents of PostgreSQL to 0.3.0, and 0.3.2 adds HikariCP over pgjdbc. Version 0.3.3 adds the slack of poll() for HikariCP, and 0.3.4 adds the start check of the pool. Version 0.3.5 gives a bound to the alarm of a PostgreSQL backend. Version 0.3.6 tells that the keepalive checks of HikariCP share one thread, and 0.3.7 adds the two documents of PgBouncer 1.26.1. Version 0.3.8 adds the document of Pgpool-II 4.7.3, and 0.3.9 gives the SYN give-up of Linux TCP its lateness on the wheel. Version 0.3.10 adds the two documents of Supavisor 2.9.13. Version 0.3.11 lets the connect timer of PgBouncer fire up to 10 ms early.

release.yml publishes each later version from main, as for the other packages.

### DELACK · The delayed ACK of Linux TCP

- **Status:** done
- **Area:** engines
- **Depends on:** MACHINES
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [#31](https://github.com/mark1russell7/systems/pull/31), [#32](https://github.com/mark1russell7/systems/pull/32)

The document of Linux TCP has the delayed-ACK timer of Linux 6.6. Each idle forget of a router counts from the ACK of the last reply, at once or up to 41 ms later.

## The corpus in jarvis

### IMPORT · The corpus imports the machine documents

- **Status:** done
- **Area:** corpus
- **Depends on:** MACHINES
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:**

jarvis imports the documents of `@mark1russell7/machines` by a procedure. It takes machines 0.3.7 from npm, and it is in jarvis since 2026-10-18.

### LAND · The CI records of 2026-10-17 in the corpus

- **Status:** done
- **Area:** corpus
- **Depends on:** IMPORT
- **Started:** 2026-10-17
- **Shipped:** 2026-10-18
- **Links:**

The full catalog run (234 cells), the kind run (31 cells) and the 5 canonical cells are in the corpus, with the import. Each record of a run is in the store of the corpus.

## The site

### SITE-R3 · A page for R3's queue

- **Status:** done
- **Area:** site
- **Depends on:** REDIS
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The page](https://mark1russell7.github.io/systems/results/r3/), [#36](https://github.com/mark1russell7/systems/pull/36)

The 121 cells of the queue and the canonical cells, judged again from their raw records.

### SITE-KIND · The kind results of 2026-10-17

- **Status:** done
- **Area:** site
- **Depends on:** KIND
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The page](https://mark1russell7.github.io/systems/results/kind/), [#34](https://github.com/mark1russell7/systems/pull/34), [#59](https://github.com/mark1russell7/systems/pull/59)

The kind page shows the run of 2026-10-17, with each lone failure and its time. The run at main of 2026-10-18 replaces it (#59): 26 cells hold, and no cell fails.

### SITE-REFRESH · The catalog pages from a run of main

- **Status:** done
- **Area:** site
- **Depends on:** DELACK, LISTING
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39074841434), [#42](https://github.com/mark1russell7/systems/pull/42), [#53](https://github.com/mark1russell7/systems/pull/53)

The full run of the catalogs at main gives five pages their copies: the network failures, the topologies, HTTP, MongoDB and Valkey under Sentinel. Each export takes its own cells, at the HZ of the runner. Of the 203 cells of these pages, 183 hold and 20 measure, and no cell fails. The topologies page has no T01 slice, because the page of the network failures gives each T01 cell from the same lab.

### SITE-PG · The page of the PostgreSQL results

- **Status:** done
- **Area:** site
- **Depends on:** PG
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [The page](https://mark1russell7.github.io/systems/results/pg/), [The run at main](https://github.com/mark1russell7/systems/actions/runs/39169339494), [#74](https://github.com/mark1russell7/systems/pull/74), [#95](https://github.com/mark1russell7/systems/pull/95)

The page gives the 65 PostgreSQL cells of one run at main. They are T01 for each client, T03 through a router, and T10 through PgBouncer, Pgpool-II and Supavisor. Each cell holds, with 715 counted runs and no void run. The export `scripts/pg.ts` reads each raw record again with the judge of the harness, and it stops when a prediction disagrees with the catalog. The map of the cells has a row for each pooler, and the ledger and the home page add the page.

### CANONICAL · The canonical cells, measured to the close of Redis

- **Status:** done
- **Area:** site
- **Depends on:** REDIS
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39045508827), [The page](https://mark1russell7.github.io/systems/results/r3/), [#38](https://github.com/mark1russell7/systems/pull/38)

Five cells put the idle close of Redis against the keepalive of the kernel, both at 600 s. Each of the 55 runs ended 600.09 s to 600.97 s after the last segment, at the idle close of Redis.

### SITE-UX · The weekly round of the site and the tracker

- **Status:** in progress
- **Area:** site
- **Depends on:**
- **Started:** 2026-10-18
- **Shipped:**
- **Links:** [#88](https://github.com/mark1russell7/systems/pull/88), [#89](https://github.com/mark1russell7/systems/pull/89)

Each week, one round makes the site and the tracker easier to read, with a visual where it makes a result clear (Mark, 2026-10-18).

- Round 1, 2026-10-18:
  - The tracker shows the count of the done items first, and the items that can start. The record of each item shows as steps. The map lights the chain of the item under the pointer, and a chart shows the items shipped each day.
  - CI takes a screenshot of each page of the site at 390 px and at 1280 px, in light and in dark (#88). Its report names each page that is wider than its screen, and each error of a page. No page is wider than a phone, and no page has an error. The pages of results are long: 33,241 px for PostgreSQL on a phone, and 74,767 px for R3.
  - Each page of results has a map of its cells under its summary, and each tile links to the frame of its cell. The PostgreSQL page has a chart for each of its 8 borders (#89).

## Decisions for Mark

### D-IDENTITY · A scenario identity without the defaults

- **Status:** waiting on Mark
- **Area:** decisions
- **Depends on:** IMPORT
- **Started:** 2026-10-17
- **Shipped:**
- **Links:**
- **Waiting on Mark:** Choose how a scenario is identified: by the settings that the landing stores, or by the defaults of the documents. The first lands the older runs again.

A catalog cell gives each knob, and a compiled cell gives only the knobs that it moves. With the defaults out of the identity, both cells of one scenario become one entity.

### D-EXTEND · A verdict for a late propagation in kind

- **Status:** waiting on Mark
- **Area:** decisions
- **Depends on:** KIND-LONE
- **Started:** 2026-10-17
- **Shipped:**
- **Links:**
- **Waiting on Mark:** Decide if a failure before the rules of its node drop the pod, but after the calibrated band, is `extend` or `fails`.

The calibration gives the propagation from 33 samples. A run can measure a longer tail, and its failures then come in the window of the law but outside the band.

### D-R2 · R2's choice of systems where the app runs

- **Status:** waiting on Mark
- **Area:** decisions
- **Depends on:** S0
- **Started:** 2026-10-08
- **Shipped:**
- **Links:**
- **Waiting on Mark:** In the shared checkout of jarvis, after a sync and a restart, enter `pnpm --filter @jarvis/systems-pages build`. Then enter `./jarvis options save --input @packages/systems-pages/R2/options.json`.

The last step of S0. The options document of R2 lands where the app runs. A second landing does no harm.

### D-REVIEW · The judgments of 2026-10-16 and 2026-10-17

- **Status:** waiting on Mark
- **Area:** decisions
- **Depends on:**
- **Started:** 2026-10-16
- **Shipped:**
- **Links:**
- **Waiting on Mark:** Read the decisions of 2026-10-16 and 2026-10-17 in jarvis, and answer any that you want changed.

The mechanisms of MongoDB, the name of the step-down window, the ack delay as a mechanism, and the first version of `@mark1russell7/machines`.
