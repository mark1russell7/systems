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

- **Status:** later
- **Area:** program
- **Depends on:** S1
- **Started:**
- **Shipped:**
- **Links:** [@mark1russell7/service](https://www.npmjs.com/package/@mark1russell7/service)

A service declares its clients, timeouts, retries, checks and state machines as data that the algebra reads. Mark designs it together with the S1 clients.

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

### TOX · The toxics of Toxiproxy

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-14
- **Shipped:** 2026-10-17
- **Links:** [#28](https://github.com/mark1russell7/systems/pull/28)

Each toxic gets a prediction from the source of Toxiproxy. A `reset_peer` toxic on a live connection closes it with FINs, and the client reads an end of file.

### LISTING · The listing of the router holds the softirqs

- **Status:** in progress
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-17
- **Shipped:**
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39057994070)

The router of T03 lists the conntrack table each 50 ms. A listing walks each bucket of the table with the softirqs off, and a runner has 262144 buckets. One reply of 13,306 waited 6.8 ms in a listing, and one netem cell failed on it. The workflows give the table 16384 buckets.

### PG · PostgreSQL

- **Status:** later
- **Area:** catalogs
- **Depends on:** S1
- **Started:**
- **Shipped:**
- **Links:**

The next system of the S1 order, with its clients and PgBouncer.

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

- **Status:** in progress
- **Area:** catalogs
- **Depends on:** S2
- **Started:** 2026-10-15
- **Shipped:**
- **Links:** [The results](https://mark1russell7.github.io/systems/results/kind/), [#34](https://github.com/mark1russell7/systems/pull/34)

T07 is the lifecycle of the endpoints of a Service, and T18 is a fleet whose readiness needs Redis. Of 31 cells, 22 hold, and 4 fail on one or two lone requests.

### KIND-LONE · The cause of the lone failures in kind

- **Status:** in progress
- **Area:** catalogs
- **Depends on:** KIND
- **Started:** 2026-10-17
- **Shipped:**
- **Links:** [#35](https://github.com/mark1russell7/systems/pull/35)

One failure is a stale SYN_SENT entry on a reused port, and one is a late propagation. The others need a capture of the SYNs and resets to the deleted pod.

## The engines and the models

### ENGINES · The engines on npm

- **Status:** done
- **Area:** engines
- **Depends on:**
- **Started:** 2026-10-13
- **Shipped:** 2026-10-17
- **Links:** [npm](https://www.npmjs.com/~mark1russell7)

quantity 0.2.0, algebra 0.7.1, service 0.4.1, prober 0.3.1, harness 0.11.0 and kind 0.1.3. CI publishes each version change of main.

### MACHINES · The first version of @mark1russell7/machines

- **Status:** waiting on Mark
- **Area:** engines
- **Depends on:**
- **Started:** 2026-10-16
- **Shipped:**
- **Links:** [packages/machines](https://github.com/mark1russell7/systems/tree/main/packages/machines)
- **Waiting on Mark:** Touch your security key for the first publish of machines 0.3.0, in the session that owns npm. On 2026-10-17, npm refused it with a 429.

The one home of each machine document. Its first version is 0.3.0. The session that owns npm publishes it from main. Then release.yml publishes each later version.

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

- **Status:** blocked
- **Area:** corpus
- **Depends on:** MACHINES
- **Started:** 2026-10-17
- **Shipped:**
- **Links:**

jarvis imports the 15 documents of `@mark1russell7/machines` by a procedure. The work is complete, and it waits for npm to serve the package.

### LAND · The CI records of 2026-10-17 in the corpus

- **Status:** blocked
- **Area:** corpus
- **Depends on:** IMPORT
- **Started:** 2026-10-17
- **Shipped:**
- **Links:**

The full catalog run (234 cells), the kind run (31 cells) and the 5 canonical cells are landed in the same work as the import. They ship with it.

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
- **Links:** [The page](https://mark1russell7.github.io/systems/results/kind/), [#34](https://github.com/mark1russell7/systems/pull/34)

The kind page shows the run of 2026-10-17, with each lone failure and its time.

### SITE-REFRESH · The catalog pages from a run of main

- **Status:** in progress
- **Area:** site
- **Depends on:** DELACK, LISTING
- **Started:** 2026-10-17
- **Shipped:**
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39057994070)

A full run of the catalogs at main gives each page its next copy. Its predictions have the delayed ACK and the EOF of Toxiproxy. The export scripts read the run of one catalog. For a full run on the runner, each script takes its own cells, at the HZ of the runner. The next full run comes after LISTING.

### CANONICAL · The canonical cells, measured to the close of Redis

- **Status:** done
- **Area:** site
- **Depends on:** REDIS
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39045508827), [The page](https://mark1russell7.github.io/systems/results/r3/), [#38](https://github.com/mark1russell7/systems/pull/38)

Five cells put the idle close of Redis against the keepalive of the kernel, both at 600 s. Each of the 55 runs ended 600.09 s to 600.97 s after the last segment, at the idle close of Redis.

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
