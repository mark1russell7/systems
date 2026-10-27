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

- **Status:** done
- **Area:** program
- **Depends on:** S0
- **Started:** 2026-10-08
- **Shipped:** 2026-10-25
- **Links:** [The results](https://mark1russell7.github.io/systems/results/cells/)

Each system of the S1 set gets a matrix of cells, and the algebra predicts each cell. A prediction must match the harness in its tolerance.

H2 was the last system of the set, and its last cell held on 2026-10-25. Thus each system of S1 has its matrix, and each counted cell holds.

### S2 · Intermediaries and Kubernetes

- **Status:** in progress
- **Area:** program
- **Depends on:** S1
- **Started:** 2026-10-15
- **Shipped:**
- **Links:** [The kind results](https://mark1russell7.github.io/systems/results/kind/)

kube-proxy in each mode, Cilium, Istio, kube-vip, CoreDNS, MetalLB and Pulsar, with drains and the lifecycle of a pod. kind checks each one.

The first step measures how callers learn that a pod cannot serve: endpoint propagation (A) or an in-band `Connection: close` (B), on keep-alive clients (the cells `S2.T07.<mode>.endpoints` and `S2.T07.<mode>.lame-duck`). The next step measures the two candidates in each mode of kube-proxy from one definition, and the kind page shows them side by side. Candidate C sends GOAWAY on HTTP/2 from the same transport of the service (the cells `S2.T07.<mode>.goaway`). Each client has one session, thus fewer connections fail more requests each, and the window ends 140 ms earlier.

Kind run 40358038728 held all 9 cells in 3 of 3 runs. With iptables, the median failed requests for A, B and C were 3044, 813 and 1087. With IPVS they were 2449, 983 and 2133, and with nftables 2562, 1092 and 706.

Cilium is the fourth mode of the T07 cells. It replaces kube-proxy in a cluster of kind with no kube-proxy, from a pinned chart. Kind run 40558968382 started 21 cells of Cilium, and 20 held in each counted run. C in the stall failed in 1 of 3 runs, by a bias that the next band must add. Each finding of kube-proxy holds in Cilium, thus the rule of the service does not change ([S6](S6.md#the-cilium-column)).

### S3 · Outcomes under failure and load

- **Status:** later
- **Area:** program
- **Depends on:** S1
- **Started:**
- **Shipped:**
- **Links:**

Histories of operations and their checkers, load, exhaustion, retry storms and metastability. Kafka and etcd join the set.

### S4 · The host, the NIC and the cloud

- **Status:** later
- **Area:** program
- **Depends on:** S1, HW-1
- **Started:**
- **Shipped:**
- **Links:**

VMs with a kernel for each node, the failover of a host, block storage and shared fate. The cloud adds managed load balancers and real zones.

Mark's decision of 2026-10-19: the VM tier runs on the hosted Linux runners of GitHub. Their KVM lets QEMU start one VM for each node. systems is public, thus its CI is free. The tier needs no hardware from Mark. The SR-IOV NIC and a cloud account wait until S4 starts. HW-1 holds that choice.

### HW-1 · The lab for the NIC and the cloud parts of S4

- **Status:** waiting
- **Area:** program
- **Depends on:**
- **Waiting on:** Mark, with no hurry, because S4 has not started. Pick one: (1) an SR-IOV NIC in a box of yours, (2) a cloud account with VMs, or (3) the two. If you want, Claude first researches which used cards fit.
- **Started:**
- **Shipped:**
- **Links:**

The NIC part of S4 tests the virtual functions of SR-IOV, their failover, and a firmware upgrade of the card. The hosted runners of GitHub cannot test these. Their VM has no physical NIC, thus it cannot make virtual functions, fail them over or change firmware.

A cloud account gives the managed load balancers and the real zones of S4. It does not give the NIC tests: the provider keeps the physical function and the firmware. Thus option (1) covers the NIC, option (2) covers the cloud, and the two are separate choices.

The research for option (1) names cards that support SR-IOV and the failover of a virtual function under Linux. It also names the cards whose firmware a Linux tool can upgrade. It checks first if a box of yours already has such a card.

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

On 2026-10-17, Mark decided the design of the server stack (D1 to D18). These decisions replace the co-design gate for the runner, its HTTP entry, the composition, the requests, the signals and the profiles. On 2026-10-25, Mark chose a shared core for the wrappers of the S1 clients. Each driver has a thin entry on that core. Mark asked for as much unification as possible. Thus the table of [S6.md](S6.md) gives a reason for each part that stays separate.

The design of health and routing is decided. The kind cells scored the candidates A to E on eight incidents, from PR #194 to PR #242, and the rule of the service stays. S6 stays in progress for SYS-6, SYS-17 and SYS-36.

[PR #157](https://github.com/mark1russell7/systems/pull/157) adds the PostgreSQL client (`./pg`) on the shared core of the clients, and moves the Redis client onto that core.

[PR #161](https://github.com/mark1russell7/systems/pull/161) adds the MongoDB client (`./mongodb`) on that core, and it moves the checks that pg and MongoDB share into the core.

[PR #162](https://github.com/mark1russell7/systems/pull/162) adds the RabbitMQ client (`./rabbitmq`) on that core. It moves the ready wait and the backoff of Redis into the core, for both clients.

[PR #163](https://github.com/mark1russell7/systems/pull/163) adds the HTTP client (`./http-client`) over the agent of Node, on that core. It moves the timer of a call and the problems of a wrapper timer, an age and a keepalive into the core.

[PR #164](https://github.com/mark1russell7/systems/pull/164) adds the WebSocket client (`./websocket`) over ws, on that core. It moves the retry schedule, the misses problem and the status line judge into the core.

[PR #166](https://github.com/mark1russell7/systems/pull/166) adds the gRPC client (`./grpc`) over grpc-js, on that core, and moves the O01 problem into a general form. With it, each S1 client has its wrapper on the shared core.

[PR #171](https://github.com/mark1russell7/systems/pull/171) gives the catalog of the checks of a client (B19), in the shared core. With `catalog`, each other step of a client is a check that gates nothing.

[PR #174](https://github.com/mark1russell7/systems/pull/174) gives the metrics of the health runtime (B18): `health.metrics()` counts the outcomes, the durations, the episodes of failure and the transitions.

[PR #176](https://github.com/mark1russell7/systems/pull/176) gives the marks of the timers (E10). `compressionOf()` tells which verdicts of the law a compression of the timers by k changes.

[PR #177](https://github.com/mark1russell7/systems/pull/177) makes the values of a scenario claims for a version (E2). Each finding names the epoch of each value that it reads, and a distribution binds its p99.

[PR #179](https://github.com/mark1russell7/systems/pull/179) keeps apart the four ways that a pod stops (B11). `lintStop()` applies the rules of the drain that guard each way.

[PR #181](https://github.com/mark1russell7/systems/pull/181) moves the kind cells onto `lintStop()`. `stopOf(cell)` reads the way from the plan of the cell, and the crash cell of T07 gets no drain rule.

[PR #194](https://github.com/mark1russell7/systems/pull/194) starts the scores of health and routing (`scoreCallers` of the cells, and the table "How callers learn" of the kind page). Each candidate of each mode gets a score on each criterion, with its run, its cell and its prediction. Kind run 40358038728 gives the failed requests, and it bounds the time until callers know. The other criteria and the other six incidents are not measured, each with its reason. B and C each beat A in each mode, and neither one wins in each mode. Thus the service keeps one rule with A as an opt-in: while it is not ready, it closes each connection in band ([S6.md](S6.md#unified-or-separate-how-callers-learn)).

[PR #196](https://github.com/mark1russell7/systems/pull/196) scores a second incident: a partitioned pod. A black hole comes between the clients and the target for 22 s, and the readiness of the target stays. Kind run [40380943331](https://github.com/mark1russell7/systems/actions/runs/40380943331) held each of the 9 cells in 3 of 3 runs, and the prediction of commit 401f702 held. A and B learned in 1.4 s at the most, and C learned only after the heal, 26.14 s to 26.63 s after the fault. The scorecard measures the time until callers know of a partition, from the start of the last failed request of each run. The rule of the service stays, and the client of HTTP/2 needs its own check of the session.

[PR #199](https://github.com/mark1russell7/systems/pull/199) adds that check: `sessionCheck` of `./http-client`, an opt-in with the heartbeat of the service. Candidate D is C with the check. Kind run [40394320219](https://github.com/mark1russell7/systems/actions/runs/40394320219) held each of the 6 cells of D in 3 of 3 runs, and the prediction of commit f066a10 held. For a pod that cannot serve, the check closed no session, and D and C had one band. In a partition, D learned in 1.07 s to 1.46 s by the median run, and C needed approximately 26 s. Thus the session check is part of the default rule of the client of HTTP/2, with `keepalive_time` 0.5 s and `keepalive_timeout` 0.5 s.

[PR #202](https://github.com/mark1russell7/systems/pull/202) scores a third incident: a stalled pod, a gray failure. The event loop of the target stops for 12 s, and its readiness probe removes it 5 s to 7.3 s after the fault. Kind run [40406199754](https://github.com/mark1russell7/systems/actions/runs/40406199754) held each of the 12 cells in 3 of 3 runs, and the prediction of commit bd3697f held each count. A and B learned in 1.15 s at the most, D in 1.28 s to 3.3 s by the median run, and C only at the resume. The last failure of C was up to 72 ms after its band, in the noise of the judge, thus its time score shows a failure. The decision of S6 does not change.

[PR #206](https://github.com/mark1russell7/systems/pull/206) scores a fourth incident: a failed prober. The readiness check of the target fails for 30 s while its route serves, thus each removal is false. Kind run [40419289511](https://github.com/mark1russell7/systems/actions/runs/40419289511) held each of the 12 cells in 3 of 3 runs, and each removal was in the band of commit 5b871cb. A failed 1,529 to 1,690 requests by the median run, and B, C and D failed 3 to 25. One run of C in nftables had 12 failed requests, over its band of 0 to 9, thus its count score shows a failure. The decision of S6 does not change, and the other four incidents need a dependency or zones that T07 does not have.

[PR #211](https://github.com/mark1russell7/systems/pull/211) scores a fifth incident: a black-holed shared dependency. Redis gates the readiness of both replicas, and it is black-holed for 27 s. Kind run [40430856093](https://github.com/mark1russell7/systems/actions/runs/40430856093) held 11 of the 12 cells in 3 of 3 runs, against the prediction of commit bbe898e. B had the fewest failed requests in each mode and recovered first. B, C and D failed slowly on the empty Service until the heal, thus their time until callers know misses its band. Readiness follows the dependency, and the defaults do not change ([S6.md](S6.md#unified-or-separate-how-callers-learn)).

[PR #214](https://github.com/mark1russell7/systems/pull/214) scores the probe load. A, B and C send no PING by their code, thus their score is 0, from the code. The session check of D sends 2 PINGs each second for each session at the most. It sends them only while the session is quiet with a stream in flight. Kind run [40440516571](https://github.com/mark1russell7/systems/actions/runs/40440516571) held each of the 15 cells of D in 3 of 3 runs. Each count of PINGs was in the band of commit 47909ad, with 51 PINGs in a run at the most. The check stays an opt-in, because the package has no client of HTTP/2 and no caller of the fleet uses one ([S6.md](S6.md#the-probe-load-of-the-session-check)).

[PR #235](https://github.com/mark1russell7/systems/pull/235) scores a sixth incident: a flapping dependency. The black hole of PR #211 comes three times in one run, for 27 s each, with a rest of 15 s after each heal. Kind run [40464814086](https://github.com/mark1russell7/systems/actions/runs/40464814086) held each of the 12 cells in 3 of 3 runs. The prediction of commit c8bca00 held each count, each removal, each recovery, each time until callers know and each count of PINGs. The first failure of a fault came up to 39 ms after the fault, after its band of 20 ms but in the noise of the judge. Each fault was the same as the first one, thus the decision of S6 does not change ([S6.md](S6.md#unified-or-separate-how-callers-learn)).

[PR #238](https://github.com/mark1russell7/systems/pull/238) scores a seventh incident: a lost zone. The only node of the zone of the target is frozen for 70 s, thus the node lifecycle controller removes the target. Kind run [40494462562](https://github.com/mark1russell7/systems/actions/runs/40494462562) held 11 of the 12 cells, because one run started before the controller saw the node Ready. After commit 4ddc04d, kind run [40500297695](https://github.com/mark1russell7/systems/actions/runs/40500297695) held each of the 12 cells in 3 of 3 runs, in the bands of commit 9f53fbc. C failed until the 9th retransmission, up to 10,487 requests in a run, and D failed 285 at the most. Thus the decision of S6 does not change ([S6.md](S6.md#unified-or-separate-how-callers-learn)).

[PR #240](https://github.com/mark1russell7/systems/pull/240) scores the eighth and last incident: a slow dependency. Each packet that Redis sends waits 300 ms for 27 s, and each check of Redis still passes. Kind run [40521784305](https://github.com/mark1russell7/systems/actions/runs/40521784305) held each of the 12 cells in 3 of 3 runs, and no replica left the Service.

A and B failed 3,481 to 3,490 requests in each run, each one a timeout, because a connection of HTTP/1.1 queues its requests. C and D failed none. The last failure of A and B started up to 38 ms after its band of commit 93a58b6, in the noise of the judge. The rule gives no signal while the service stays ready, thus the decision of S6 does not change ([S6.md](S6.md#unified-or-separate-how-callers-learn)).

[PR #242](https://github.com/mark1russell7/systems/pull/242) measures the shared gate (E), a candidate that keeps the endpoints in a shared failure. The readiness probe of the kubelet leaves out each check of the shared Redis, and the controller still refuses each request with a 503. Kind run [40533209929](https://github.com/mark1russell7/systems/actions/runs/40533209929) held each of the 9 cells in 3 of 3 runs, in the bands of commit 221b5bc. E failed 4,325 to 4,729 requests by the median run in the shared dependency, and B 4,126 to 4,452. The rule of that commit needed a cut of 50 % in each mode, thus the gate stays in the kind lab, off by default ([S6.md](S6.md#the-shared-gate-e)).

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

### CI-2 · The CI calls the reusable workflow of the template

- **Status:** done
- **Area:** program
- **Depends on:**
- **Started:** 2026-10-26
- **Shipped:** 2026-10-26
- **Links:** [#169](https://github.com/mark1russell7/systems/pull/169)

`ci.yml` calls `reusable-ci.yml` of the template for the typecheck, the tests, the build and the writing rules. The pack test calls `reusable-release-build.yml` of the template, so `ci.yml` does not use `scripts/release`. The ruleset of main still gets its check `ci`: a job with that name fails when a different job of `ci.yml` fails.

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

- **Status:** later
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

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-12
- **Started:** 2026-10-27
- **Shipped:** 2026-10-27
- **Links:** [#225](https://github.com/mark1russell7/systems/pull/225), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The zod schemas of `@mark1russell7/algebra` move into a new entry, `./schema`, as in `quantity`. Then zod becomes an optional peer of the algebra too. The root of the algebra no longer gives the schemas, thus the change breaks its API and comes in algebra 0.8.0.

`machineSchema` is in `@mark1russell7/algebra/schema`, and a test fails if the root entry imports zod. The machines, the service tests and the cells tests import the schema from that entry.

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

- **Status:** later
- **Area:** server stack
- **Depends on:** S6
- **Started:** 2026-10-18
- **Shipped:**
- **Links:** [#65](https://github.com/mark1russell7/systems/pull/65), [The WS, WST and PG run](https://github.com/mark1russell7/systems/actions/runs/39101123561), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

`@mark1russell7/harness` accepts the image of a subject as data (D16). Thus another repository can give its own subject, with its own release in it.

The source of an image is an image pinned by digest, a build context, or an image that the harness ships. Each build has a digest on each `FROM` and a lockfile for each manifest. The procedures image is the shipped subject `SUBJECTS.procedures`. The WS and WST catalogs take a subject, and `cells.yml` takes one as JSON (`subject`). #65 has the change, and `image/procedures` stays until SYS-18.

### SYS-18 · The procedures image leaves the harness

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-17
- **Started:** 2026-10-20
- **Shipped:** 2026-10-24
- **Links:** [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb), [The WS run on the client subject](https://github.com/mark1russell7/systems/actions/runs/39390678218)

After CLI-33, the client owns the image of its procedures subject. Then the harness removes `image/procedures`, and the README of the harness no longer describes that image.

- CLI-33 is client #122 (2408cea). In the client repository, `harness/procedures-subject` builds `@procedures/client` 0.22.0 from its checkout. Its image has the programs of the subject that the harness shipped.
- cells.yml checks out the client repository at `CLIENT_REF` (2408cea) and gives the subject of its checkout to the WS and WST cells. The input `subject` still replaces it. The catalogs take a copy of that subject (`PROCEDURES`), and a test holds the commit to the workflow.
- harness 0.12.0 (MINOR: a breaking change before 1.0.0) removes `image/procedures`, `SUBJECTS`, `proceduresImage`, the shipped name `procedures`, the client name `procedures-ws` and `Target.harness`. The lab test of the WebSocket client builds the subject of a checkout of the client repository (`HARNESS_PROCEDURES`).
- machines 0.3.23: the documents `procedures-ws-client` and `procedures-ws-server` cite the source of 2408cea, with `@mark1russell7/service` 0.5.8. Each fact and each default is the same as in 0.3.0.

### SYS-24 · The progress check names the loops that mark it

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-14
- **Started:** 2026-10-25
- **Shipped:** 2026-10-25
- **Links:** [#158](https://github.com/mark1russell7/systems/pull/158), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

A check of the kind `progress` fires when no loop marks progress in its stall time. Today each app gives that time by hand: jarvis gives 370 s for its weather poll (JAR-4). With a field `marks`, the check names its loops. Then `lint()` finds a stall time that is shorter than the interval of the slowest loop, with its jitter and its timeout. It is a PATCH: an optional field and a new finding.

#158 adds `marks: { loops, stall }` to a check, and `lint()` gives a `progress` finding for a short stall time or an unknown loop.

### SYS-25 · The pairing window from the jitter of the runner

- **Status:** done
- **Area:** engines
- **Depends on:**
- **Started:** 2026-10-27
- **Shipped:** 2026-10-27
- **Links:** [#224](https://github.com/mark1russell7/systems/pull/224), [The WS run](https://github.com/mark1russell7/systems/actions/runs/40453803841)

A run pairs each event of a program with its record of the kernel in δ_abs, 1 ms. On a runner of GitHub the jitter of a program is 1.06 to 1.74 ms, thus a single run can fail on it. Thus the harness measures that jitter in each run and records it (`Run.jitter`). The pairing window of the run is the larger of δ_abs and the measured bound (`pairingOf`).

- The decision of 2026-10-19 keeps the rule of one miss. A verdict does not wait for a miss to repeat. Only the window changes.
- The bound is the longest delay from an act of the program to the first write of data on its socket. An act is a `write` line or a `ping` line before the fault. That write must come before the next act and before the fault.
- The acts that a cell judges come after the fault, thus a late act cannot widen its own window.
- Each measurement gives its bound and its window (`Measured.pairing`), and each line of `summary.ndjson` gives `pairing`. A record from before SYS-25 has no bound, thus its window is δ_abs, 1 ms.
- In the 33 records of the nightly run 40446582383, only the cells of the `ws` class got a longer window: 1.009 ms to 1.519 ms. Each decision stayed the same.
- The WS run 40453803841 on the branch held each of its 33 cells, and each line gave `pairing`. Only 10 cells of the `ws` class got a longer window, 1.027 ms to 2.129 ms.
- The prediction of that run said that each bound stays below 2 ms. One cell missed it: the silent drop at 5 s with a heartbeat of 6 s, at 2.129 ms. Thus the jitter of a runner can be above 2 ms.

- Stage 0 calibrated the runner image `ubuntu24 20261023.334.3` on 2026-10-24 (runs 40128274924 and 40129876394). The worst of 90 resets took 0.316 ms, thus δ_abs stays 1 ms and the cap stays 4.

### SYS-26 · The image of the kind lab goes through the resolver of images

- **Status:** done
- **Area:** engines
- **Depends on:** SYS-17
- **Started:** 2026-10-26
- **Shipped:** 2026-10-26
- **Links:** [#183](https://github.com/mark1russell7/systems/pull/183)

The kind lab builds its image with its own code. As a `build` source of SYS-17, it goes through `planOf` and `imageOf`. Then their rules apply: each FROM has a digest, and each manifest of packages has a lockfile.

- The kind lab still stages its context, because the stage builds and packs packages of the workspace. `labSource()` gives that context as a `build` source, and `labImage()` resolves it with `imageOf`. Thus the build goes through the CLI of Docker, with the waits of the harness between its tries. It comes in kind 0.10.1, a PATCH: one new export. #183 has the change.

### SYS-27 · A process port for a service in a process that another part owns

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-21
- **Started:** 2026-10-18
- **Shipped:** 2026-10-18
- **Links:** [#72](https://github.com/mark1russell7/systems/pull/72), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

Some entries start a service in a process that they do not own. Examples are a script, a test of an application, and `createPeer` of the client (CLI-7). Before, such an entry wrote its own small runner, or it gave the port of the process of Node. The new port `embeddedProcess()` adds no signal handler, it does not hold the process, and its `exit` only records the code. Thus the full lifecycle runs, and only the owner of the process handles its signals. It comes in service 0.5.2, a PATCH: one new export.

### SYS-28 · A keyed rate limiter in service

- **Status:** done
- **Area:** server stack
- **Depends on:**
- **Started:** 2026-10-19
- **Shipped:** 2026-10-20
- **Links:** [#106](https://github.com/mark1russell7/systems/pull/106), [#119](https://github.com/mark1russell7/systems/pull/119), [#229](https://github.com/mark1russell7/systems/pull/229), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

No package of systems or of the client had a rate limit for each tenant or principal. Graph limits its writes for each tenant with a sliding window of its own. With SYS-28, `svc.limiter(name, { key, policy, store, evict })` declares a keyed limiter as data, with no defaults, and `describe()` shows it. `keyedLimiter` makes its runtime: a token bucket or a sliding window for each key, on the injected monotonic clock. A refusal gives `retryAfter` as a `Quantity`, and the HTTP edge gives 429 with `Retry-After` in whole seconds.

The store is an interface, and each store decides a take in one atomic step on its own clock. `memoryStore` is the store of one replica. Without a shared store, each replica holds limit / N, and that sum holds only on average. A shared store declares `onStoreFailure`, `open` or `closed`, with no default. The eviction is exact, the count of keys has a bound, and a new key at the cap waits at most the idle span.

`lint()` applies two new rules to each limiter. O29 bounds the longest `Retry-After` by the retry window of the caller, at the cap of keys too. O30 bounds the retry delay of the caller from below. Their identifiers are provisional, because the corpus of the law does not have them yet.

It comes in service 0.5.3, a PATCH: new exports. The store in Redis (`redisLimiterStore`, one script that reads `TIME`) comes in 0.5.4, also a PATCH. The client item CLI-40 builds the admission step of the procedures server on it.

The machine of one key is a document in service 0.5.7 (#119): `TOKEN_BUCKET_MACHINE` and `SLIDING_WINDOW_MACHINE`. A test replays each take of the runtime against it, and the algebra bounds each time of the runtime by its timers.

Six cells put a real client against the 429 of the limiter of service 0.5.6 from npm. Each one holds in 11 of 11 runs:

- The `RetryAgent` of undici 8.12.2 at its defaults waits the `Retry-After`, capped at 30 s. Each retry comes from 30.001 s to 30.009 s after the refusal before it.
- O30.1: a `Retry-After` of 30 s, and one retry gets in. O30.2: 60 s, and the first retry comes 30 s early, the limiter refuses it with `Retry-After: 30`, and the second gets in.
- O29.1: 150 s, five retries of 30 s, and the last gets in. O29.2: 151 s, and the agent gives up with `UND_ERR_REQ_RETRY` and the 429.
- O29.3 and O29.4: a `Client` of undici and the `Transport` of Go give the 429 to the caller in 2 ms, and send nothing again.
- The machine document of the agent is `UNDICI_RETRY` (machines 0.3.19), from its source. The harness counts each retry from the refusal before it (`last-reply`, harness 0.11.23), on a new connection too.

The corpus of the law gets O29 and O30 with these pairs and the family `K-rate-limit`.

With #229, the target moves to service 0.6.0, and its server checks its declaration with `lint()` before it listens. The first run of 0.6.0 held each cell, but its runners were not the runners of the run of 0.5.6. Against that unpaired control, the median of O29.1 moved by −1.282 ms, over its tolerance of 1 ms. Thus a paired run compared the two versions on the same runners.

In the paired run 40471731235, each of six shards started the cell of 0.5.6 and then the cell of 0.6.0, for each spec. Each runner had the image ubuntu24 20261023.334.3, 4 CPUs and HZ 1000. Each of the 12 cells holds in 11 of 11 runs. In the table, d is the median of 0.6.0 less the median of 0.5.6. Its 95% interval comes from a percentile bootstrap, with 10,000 resamples of each version and the seed 20261027.

| Cell  | d (ms) | 95% interval (ms) | Tolerance (ms) | Unpaired d (ms) | Runs needed |
| ----- | -----: | ----------------- | -------------: | --------------: | ----------: |
| O30.1 | −0.818 | −2.870 to 0.104   |              1 |          −0.392 |        1399 |
| O30.2 | −0.006 | −0.686 to 1.430   |              1 |          −0.308 |          23 |
| O29.1 |  0.287 | −0.371 to 1.063   |              1 |          −1.282 |          14 |
| O29.2 |  0.148 | −0.797 to 1.004   |              1 |          −0.041 |          12 |
| O29.3 | −0.056 | −0.312 to 0.096   |            0.5 |           0.078 |           4 |
| O29.4 | −0.025 | −0.195 to 0.404   |            0.5 |          −0.410 |           8 |

The result is no detectable shift, not equivalence. Each d is in its tolerance, and each interval contains 0. But the intervals of O30.1, O30.2, O29.1 and O29.2 each cross their tolerance on one side. Thus 11 runs cannot rule out a shift of approximately 1 to 3 ms in those cells.

The column "Runs needed" gives the runs of each version that put the interval inside ± tolerance at this d. With the interval [lo, hi] of 11 runs, n = ⌈11 × max(((hi − d) / (tol − d))², ((d − lo) / (tol + d))²)⌉. If a margin is 0 or less, no count of runs is sufficient at this d. The record is `packages/site/src/data/limiter-pair-2026-10-27.json`, with each value, the summaries and the CPU of each runner.

The standing catalog is the six cells of 0.6.0. The input `pair` of `cells.yml` starts a paired run of two versions on demand. The cells README tells how. #229 has no release, because the cells and the site are private packages.

### SYS-29 · The drain of httpTransport waits for the answers of the cut calls

- **Status:** done
- **Area:** server stack
- **Depends on:**
- **Started:** 2026-10-19
- **Shipped:** 2026-10-19
- **Links:** [#111](https://github.com/mark1russell7/systems/pull/111), [#113](https://github.com/mark1russell7/systems/pull/113), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The client item CLI-48 found it. At the deadline of the drain, the timer of the transport and the cut of the requests come at the same time. With `setTimeout`, the timer of the transport comes first. Then the drain ended before the cut calls had their answers. The close of the sockets raced the 503, the 500 or the in-band end of each call.

With the fix, the drain of `httpTransport` also waits at its deadline for each answer that is to come or to go out. That is a response that `writeOutcome` writes, or an ended response whose bytes did not go. Thus the sequence of the two timers has no effect, and each app on `httpTransport` gets the fix. The cap of the phase bounds the wait. A client that does not read its answer holds the drain to the cap.

A phase fails only for its own work (the review of the systems session). At the cap, a drain that waits only for the bytes of its answers did its work. Thus the cap is not a failure, and the exit code stays 0, as before 0.5.5. The event `phase.cap` gives the cause and the count, for example `answers not flushed: 2`. A call whose end did not come, or other work that did not end, still fails the phase with exit code 1.

It comes in service 0.5.5, a PATCH: a bug fix, with no change to an export.

The drain waits only for work that it owns and can cut (the second review). `life.request` of a lifecycle records that lifecycle as the owner of each stream that it makes. A stream of `writeOutcome` from another lifecycle, or from none, does not hold the drain and does not count at the cap. Thus the drain ends at its deadline for such a stream, as in 0.5.4. The record of the drain gives their count, for example `streams outside the lifecycle: 1`. With this change in service 0.5.6, a PATCH, each exit code is the exit code of 0.5.4.

### SYS-30 · The probes of the runner can leave out the report

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-2
- **Started:** 2026-10-19
- **Shipped:** 2026-10-20
- **Links:** [#122](https://github.com/mark1russell7/systems/pull/122), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The client item CLI-9 found it. `probeHandler()` and `probeServer()` of `@mark1russell7/service/http` always answer `/report` with the probes. Thus a probe server of its own also gives the whole report, and no option keeps it off the port.

With SYS-30, the option `kinds` of both functions names the probes that answer. The default is all four of `PROBE_KINDS`, thus a caller without the option sees no change. The path of a kind that the list does not name is not a probe. `probeHandler` gives it to the next handler, and `probeServer` answers it with 404, as each other path. The call refuses an empty list, an unknown kind and a kind two times, and the error names the bad part.

It comes in service 0.5.8, a PATCH: a new optional option and new exports, before 1.0.0.

### SYS-31 · A machine document for HAProxy

- **Status:** done
- **Area:** catalogs
- **Depends on:** WS
- **Started:** 2026-10-26
- **Shipped:** 2026-10-26
- **Links:** [PR #185](https://github.com/mark1russell7/systems/pull/185), [the WST cells](https://github.com/mark1russell7/systems/blob/main/packages/cells/src/ws-topologies.ts), [the document](https://github.com/mark1russell7/systems/blob/main/packages/machines/src/proxy/haproxy.ts)

The client item O17 found it. HAProxy had no machine document. Thus three WST cells of an idle timeout of HAProxy had no band, and each one was a measurement.

With SYS-31, the machines package has `HAPROXY_TCP`: HAProxy 3.2.25 in TCP mode, with citations to its source at that tag. It gives the inactivity timeout of each side and the events that reset each one. Only bytes reset a timer, thus a keepalive probe resets nothing.

Thus the algebra gives a band to each of the three cells:

- O03 reads HAProxy as a middlebox. A heartbeat of 4 s against 5 s on each side is silent.
- `timeout server` sends a FIN to the client at once: 4.989 s to 5.011 s after the last data.
- `timeout client` sends a FIN to the server, and the server of ws answers with its own. Thus its band gets one round trip and one step of HAProxy more.

The `timeout server` cell of T02 gets the same band. The `timeout client` cell of T02 stays a measurement, because the document of Redis does not give its FIN back.

It shipped in [PR #185](https://github.com/mark1russell7/systems/pull/185).

It comes in machines as a PATCH: a new export before 1.0.0.

### SYS-32 · The service gives its drain rules from a light entry

- **Status:** done
- **Area:** server stack
- **Depends on:**
- **Started:** 2026-10-27
- **Shipped:** 2026-10-27
- **Links:** [#228](https://github.com/mark1russell7/systems/pull/228), [template #26](https://github.com/mark1russell7/template/pull/26), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The entry `@mark1russell7/service/rules` gives O04, O09, O10, O16 and `DRAIN_RULES` as data, and it loads no module at run time. Kind imports the rules from the entry and gives them again, thus the exports of kind do not change.

The review of the template item OTH-5 found it. `lint()` of the service takes its rules from the caller. But the drain rules, O10, O16 and the others, are only in `@mark1russell7/kind`, and kind loads Testcontainers. Thus each new service copies the data of the rules into its tests.

With SYS-32, an entry of the service that loads no Testcontainers, for example `./rules`, gives the rules as data. The preset of the template then imports it, and the rules have one source.

It comes in service as a PATCH: a new entry and new exports, before 1.0.0.

### SYS-33 · The idle close keeps an answer that still goes

- **Status:** done
- **Area:** server stack
- **Depends on:**
- **Started:** 2026-10-25
- **Shipped:** 2026-10-25
- **Links:** [#141](https://github.com/mark1russell7/systems/pull/141), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The server-stack session found it in a review. `stopIntake()` and each sweep of `httpTransport` use `closeIdleConnections()` of Node. `server.close()` uses it too. Node counts a connection idle at the `end()` of its response, also while the bytes of the body still go. Thus the call destroyed the socket of a slow client, and the client lost the end of a large answer.

A test on the loopback ends a body of 64 MB to a client that does not read. Before the fix, the client got 2.6 MB of it on Node 22.19, 24 and 26, at the stop and at a sweep.

With the fix, the transport replaces `closeIdleConnections` on its server. For the time of the call, each answer whose bytes did not go shows as not ended. Thus Node keeps its socket, and a later sweep closes the connection when it is idle. The fake server counts a connection idle as Node does. Without the fix, three unit tests on the fake server fail.

It comes in service 0.5.9, a PATCH: a bug fix, with no change to an export.

### SYS-34 · The alerts of the first security scan

- **Status:** done
- **Area:** server stack
- **Depends on:**
- **Started:** 2026-10-25
- **Shipped:** 2026-10-25
- **Links:** [#149](https://github.com/mark1russell7/systems/pull/149), [The server stack](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

The first scan of the shared security workflow gave five alerts of high severity. Each one has a fix, and none is dismissed.

- **The probes of the service (`js/reflected-xss`).** The 404 of an unknown controller repeated its name from the path: each JSON body escapes `<`, `>` and `&`, and each answer gets `nosniff`.
- **The HTTP target of the cells (`js/resource-exhaustion`, two alerts).** A request set a timer and a buffer with no bound, thus a hold above 600 s or a body above 64 MiB gets 400.
- **The copies of the site (`js/redos`).** The pattern that puts a list of numbers on one line backtracked exponentially on negative numbers, thus its new pattern has no nested quantifier.
- **The `undici` 8.11.2 of the lockfile (CVE-2026-109869).** The ranges of `testcontainers` and of the site take a fix, thus the lockfile moves to 8.12.3, with no change to a range.
- **The `zod` 4.6.5 of the lockfile (CVE-2023-54404).** The ranges of Astro take a fix, thus the lockfile moves each copy of `zod` to 4.6.7, with no change to a range.

The health runtime gives only `application/health+json`, thus no probe answer was HTML. The review of the alert found a bug too. A controller name, for example `constructor`, found a key of each object, thus its readiness answered 200 in place of 404. With the fix, only an own key is a controller.

The cells ask for a hold of 60 s and a body of 2 MB at most, and a test keeps each cell under the bounds. The output of the new pattern is the same for each copy of the site. The lockfile also closes two alerts of `undici` with medium severity.

It comes in service 0.5.10, a PATCH: a bug fix, with no change to an export.

### SYS-35 · The findings of the second audit

- **Status:** done
- **Area:** engines
- **Depends on:**
- **Started:** 2026-10-25
- **Shipped:** 2026-10-25
- **Links:** [#151](https://github.com/mark1russell7/systems/pull/151)

A second review read the files that the first review did not read. It gave 14 findings. 13 are real, and each one has a fix. The last one is not a defect: the store of the limiter target cannot throw.

- **The throughput of the prober.** `compare.sh` cut the fixture at the old record size of 184 bytes, thus each copy started inside a record of 216 bytes.
- **The takes of the queue drain.** Each take raced one pending promise, thus the drain kept each job that it took until its intake stopped.
- **The ERROR event of 410 in the watcher of kind.** The watch opened again with its expired resource version, and it got the same error each time.
- **A response that the connection cuts, in the watcher of kind.** The watch opened again only at the end of a response, thus a cut stopped it.
- **The law with absent timers on each side.** `inf < inf` and NaN gave `violated`, but the inequality holds only because a timer is absent: `unbounded`.
- **The cuts `one` and `one-way` of the group lab.** The lab cut each peer in both directions, not one member.
- **The deletions in a kind record.** The schema named the field `windows`, thus each read of a record dropped the deletions that the judge wrote.
- **The screenshot server of the site.** A path with `..%2F` got a file outside `dist`.
- **The items of a request stream.** Each item raced one pending promise, thus a long stream kept each item until its end.
- **The AMQP cluster client of the harness.** A connection whose channel did not open stayed open after the next connect.
- **The platform clock of the service.** A delay above the limit of `setTimeout`, approximately 24.8 days, started its function after 1 ms.
- **The tables of the algebra.** A key of `Object.prototype`, for example `toString`, was a function or a model.
- **The resetter of the router.** A flow on a reused 4-tuple got the closed flag of the last flow, thus the resetter sent no reset.

It comes in service 0.5.11, kind 0.8.2, harness 0.12.4 and algebra 0.7.4, each a PATCH: bug fixes, with no change to an export. The law fix makes a wrong verdict right, because `<=` already gave `unbounded` for the same case.

The watcher fixes changed `packages/kind/image/watch.mjs`. Thus a kind run on the last head of #151 ran the 29 cells of T07 before the merge. 25 hold, 3 are calibrations and 1 is measured, each with 11 counted runs and no void.

### SYS-36 · The service hosts a user service on Windows and Linux

- **Status:** later
- **Area:** server stack
- **Depends on:**
- **Started:**
- **Shipped:**
- **Links:**

A review of duplicate code found the code that runs a program as a user service in four places. Two copies have approximately 200 lines that are almost the same. There are also four task files for Windows and five checks that a process runs.

A new entry `@mark1russell7/service/host` gives this code one source. It installs a Windows task or a systemd user unit, and it keeps a discovery file. It also holds a lock for one instance and checks that a process runs. The service already has the runner, the backoff and the drain.

It comes as a PATCH before 1.0.0: a new entry and new exports.

### SYS-37 · The service has a logger port

- **Status:** done
- **Area:** server stack
- **Depends on:**
- **Started:** 2026-10-26
- **Shipped:** 2026-10-26
- **Links:** [#186](https://github.com/mark1russell7/systems/pull/186)

The server stack found that service 0.5.16 has no logger. With this item, `run({ logger })` and `start({ logger })` take a `Logger`, as they take the clock. The port has one method, `log(level, message, fields)`, thus an adapter to another logger is a few lines.

The logger is not a second set of calls. It is one sink of the stream of lifecycle events that `record` already gets (`logEvents`). Thus each machine writes to the two, and a new event gets its entry with no change to the lifecycle.

`run()` logs each step of the startup, each phase with its cap, its outcome and its duration, and the exit code, at `info`. A phase at its cap is `warn`, each error of the lifecycle is `error`, and the polls are `debug`. `consoleLogger()` writes `info` and above to the console. Without a logger, the runtime writes no log, as before. `testLogger()` of `./testing` keeps each entry for the tests.

It comes as a PATCH before 1.0.0: a new optional option and new exports.

### SYS-22 · The law binds each server transport at @server

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-7
- **Started:** 2026-10-26
- **Shipped:** 2026-10-27
- **Links:** [#221](https://github.com/mark1russell7/systems/pull/221)

The server stack made this item. A rule with a symbol at `@server`, for example O19, also applies one time for each server transport of the service. The knobs of the transport bind at `@server`, and the scenario gives the client side. It comes in service 0.6.0, a MINOR before 1.0.0, with SYS-23, SYS-38 and SYS-39.

### SYS-23 · The law compares the bounds of a loop with the caps of its phases

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-7
- **Started:** 2026-10-26
- **Shipped:** 2026-10-27
- **Links:** [#219](https://github.com/mark1russell7/systems/pull/219)

The server stack made this item. `BOUND_RULES` compare `unit_processing_time` with the cap of `drain` (`unit-bound`), and `close_bound` with the cap of `close transports` (`close-bound`). Each rule applies one time for each consumer and each worker. `problems()` gives only a phase that is missing. The change of `problems()` is a break, thus it comes in the MINOR 0.6.0.

### SYS-38 · A compression reads the bound rules

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-23
- **Started:** 2026-10-27
- **Shipped:** 2026-10-27
- **Links:** [#223](https://github.com/mark1russell7/systems/pull/223)

The review of SYS-23 found that `compressionOf` read only the rules that the caller gave. Thus a compression did not see `unit-bound` and `close-bound`, which `lint()` always applies. With this item, `compressionOf` reads the service rules and `BOUND_RULES`, with the same bindings as `lint()`. A test compresses the drain of a queue and finds the change of `unit-bound`.

### SYS-39 · Two parts with one name give a finding

- **Status:** done
- **Area:** server stack
- **Depends on:** SYS-22
- **Started:** 2026-10-27
- **Shipped:** 2026-10-27
- **Links:** [#223](https://github.com/mark1russell7/systems/pull/223)

The review of SYS-22 found that a server transport and a dependency with one name give findings with one scope. Then a reader cannot tell them apart. With this item, `lint()` gives a `violated` finding of `NAME_RULE` (`unique-names`) for two parts with one name in a set of scopes. The sets are the dependencies and the server transports, the consumers and the workers, and the limiters. A description that was correct before can get this finding, thus it comes in the MINOR 0.6.0.

### SYS-40 · The backlog after a resume, from the sessions on the target

- **Status:** later
- **Area:** catalogs
- **Depends on:** S2, KIND
- **Started:** 2026-10-27
- **Links:** [#246](https://github.com/mark1russell7/systems/pull/246), [The Cilium run](https://github.com/mark1russell7/systems/actions/runs/40558968382)

The Cilium cells of #246 found a term that the bands do not have. In each of 3 runs, C of the stall had failed requests after the band end of 10 s. After the resume, the target drains a backlog from each of its sessions. Thus the backlog grows with the sessions on the target. The kube-proxy cells of C overshot the same band by up to 72 ms, thus the term is not specific to Cilium.

The record gives 3 pairs. With 499 failed requests, the last failure came 45 ms after the band end. With 1,001, it came 94 ms after it, and with 1,507, 166 ms after it. The band gives approximately 501 failed requests for each connection, thus these runs had 1, 2 and 3 connections on the target. The record does not give the sessions of each run, thus this mapping is not verified.

The term: with n sessions on the target, the window of a stall closes up to n × d after the band end. The value d is the drain time of one session after the resume. The failed requests can grow by up to n × r. The value r is the requests of one session that fail in the drain time. The next band of a stall carries this term for each candidate that keeps its sessions through the stall.

The first test is a cell of C of the stall with 1, 2, 3 and 6 sessions on the target. It records the sessions on the target in each run. The prediction: the value d is 40 ms to 70 ms, and the value r is 0 to 3 requests. Thus with 1 session, the last failure comes 40 ms to 70 ms after the band end. With 6 sessions, it comes 240 ms to 420 ms after it. The decision rule: if the overshoot with 6 sessions is more than 420 ms, the term is not linear in n. Then the next band adds a new term.

The bands of the test and its fleet entry are committed before the dispatch. The old bands stay as committed.

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
- **Links:** [#29](https://github.com/mark1russell7/systems/pull/29), [The run of the drop bound](https://github.com/mark1russell7/systems/actions/runs/40123441278)

The client of `@procedures/client` drops a silent connection on its own heartbeat. The harness times the drop and the reconnect, behind routers and HAProxy too.

- harness 0.12.1 (PATCH: a bug fix before 1.0.0) pairs a `drop` line with its act in the handling time of the program. That bound is `DROP_HANDLING` (1.5 ms), not δ_abs (1 ms).
- In CI, a close frame came up to 1.017 ms after its `drop` line. Two such drops failed their cells, with their times in the band. These are the runs 39390222333 and 39903020657 of the client repository.
- The high bound of each drop by a heartbeat in WS and WST adds the same 1.5 ms. The other bands do not change.
- The CI run 40123441278 holds 27 cells of WS and WST and measures 6. Its largest gap from a `drop` line to its act was 0.726 ms.

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

- **Status:** done
- **Area:** catalogs
- **Depends on:** S1
- **Started:** 2026-10-18
- **Shipped:** 2026-10-19
- **Links:** [#62](https://github.com/mark1russell7/systems/pull/62), [#64](https://github.com/mark1russell7/systems/pull/64), [#68](https://github.com/mark1russell7/systems/pull/68), [#70](https://github.com/mark1russell7/systems/pull/70), [#76](https://github.com/mark1russell7/systems/pull/76), [#77](https://github.com/mark1russell7/systems/pull/77), [#78](https://github.com/mark1russell7/systems/pull/78), [#79](https://github.com/mark1russell7/systems/pull/79), [#80](https://github.com/mark1russell7/systems/pull/80), [#81](https://github.com/mark1russell7/systems/pull/81), [#82](https://github.com/mark1russell7/systems/pull/82), [#83](https://github.com/mark1russell7/systems/pull/83), [#84](https://github.com/mark1russell7/systems/pull/84), [#85](https://github.com/mark1russell7/systems/pull/85), [#86](https://github.com/mark1russell7/systems/pull/86), [#90](https://github.com/mark1russell7/systems/pull/90), [#91](https://github.com/mark1russell7/systems/pull/91), [#92](https://github.com/mark1russell7/systems/pull/92), [#93](https://github.com/mark1russell7/systems/pull/93), [#94](https://github.com/mark1russell7/systems/pull/94), [#95](https://github.com/mark1russell7/systems/pull/95), [#96](https://github.com/mark1russell7/systems/pull/96), [#97](https://github.com/mark1russell7/systems/pull/97)

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
- An event at a pooler (harness 0.11.15): a signal to its program, or a query on its console. Three T10 cells that waited for it hold in run 39179720297, with 11 runs each (#97).
  - T10.defaults.15 and .8: SIGHUP to PgBouncer and to Pgpool-II while the server holds the query 5 s. The documents take the reload with no transition, thus the reply comes as with no reload (machines 0.3.13). The signal came 232 to 236 ms after the query, and the reply came at 5.006 s and at 5.008 s.
  - T10.defaults.7: PAUSE on the console of PgBouncer, then a query of node-postgres. The query waits in the queue, and query_wait_timeout ends it with FATAL 08P01 at 120.044 s.
  - The injector sends the query of the console in the simple query protocol of PostgreSQL, and it stamps the query and its ReadyForQuery. After the run, RESUME lifts the PAUSE.
- The page of the PostgreSQL results gives the 75 cells of run 39182922975 at main, and each one holds (#98). Each cell of the plan over these systems has a cell, an alias or a reason to wait. A cell that waits needs a feature that the harness does not have yet. Examples are several clients, a fault timed to a reply, and two nodes of Supavisor.

### RABBIT · RabbitMQ

- **Status:** done
- **Area:** catalogs
- **Depends on:** PG
- **Started:** 2026-10-19
- **Shipped:** 2026-10-19
- **Links:** [The results](https://mark1russell7.github.io/systems/results/rabbitmq/), [#100](https://github.com/mark1russell7/systems/pull/100), [#102](https://github.com/mark1russell7/systems/pull/102), [The run at main](https://github.com/mark1russell7/systems/actions/runs/39234193377)

The heartbeats of AMQP and the timers of the broker. R3 puts 54 cells on amqplib 2.2 and RabbitMQ 4.3. 17 are in T01: 13 at the defaults, and the borders of O03 and O17. 13 are in the array stage of T01, and 24 are in T11. Each cell of the plan has a cell, an alias or a reason to wait. The 21 cells hold in one run at main.

- The facts from the sources, amqplib 2.2.0 and RabbitMQ 4.3.6:
  - amqplib sets TCP_NODELAY only when the caller asks, thus Nagle is on at the defaults. It sets no keepalive and no connect timeout.
  - The heartbeat of the server, 60 s, is the heartbeat of the client when the client gives none. Each side sends a heartbeat frame each 30 s when it sent nothing. Each side checks for data each 60 s, and it ends the connection after two checks with no data. That end comes 2 to 3 intervals after the last data.
  - amqplib ends its connection with a FIN. RabbitMQ closes each socket with linger 0, thus its end of a connection is a reset.
  - RabbitMQ locks ranch 2.3.0, which gives each client socket a send timeout of 30 s that closes it.
- The steps:
  - The machine documents of amqplib and of a connection of RabbitMQ, each fact from the source at its tag.
  - A client of amqplib in the harness, and RabbitMQ as a target, pinned by digest.
  - The T01 catalog at the defaults, with the borders of O03 and O17. Then the array stage, and T11.
  - The page of the results on the site.
- The two machine documents, `amqplib` and `rabbitmq-connection`, and a client of amqplib in the harness (machines 0.3.14, harness 0.11.16, #100).
- 12 cells of T01 hold on the runners of GitHub, with 11 runs each (#100):
  - A reset of an RPC in flight gives ECONNRESET in 0.9 ms. A reset of the SYN refuses the first connect in 4.1 ms.
  - A stopped broker resets each client at once, in 44 µs, because each socket of RabbitMQ has linger 0.
  - An unreachable host with `tcp_retries2` = 3 gives EHOSTUNREACH 3.120 s after the first retransmission.
  - After a stall of 1 s, the reply comes at the third firing of the RTO timer, with a median of 1.710 s.
  - With no fault, the heartbeat frames of the broker keep an idle connection for 300 s.
  - Behind a black hole, the heartbeat of amqplib ends an idle connection 180.009 s after the last data. A frozen broker ends an RPC in flight the same way, at 180.008 s.
  - O03 against a router that forgets an idle flow at 30 s. At a heartbeat of 40 s, the frames of the broker each 20 s keep the flow for 150 s. At 80 s, the router forgets the flow, and the heartbeat ends it 240.013 s after the last data.
  - O17 with `tcp_retries2` = 7. A heartbeat of 15 s ends the connection 45.009 s after the last data, before the kernel gives up. At 60 s the kernel gives up first, with ETIMEDOUT 53.016 s after its first retransmission.
- The first runs found four facts that the first bands did not have:
  - A repeating timer of Node counts its next interval from the time its callback ran. Thus the lateness of each heartbeat check adds to the next one.
  - Linux counts the RTO from the smoothed round trip. Each sample of amqplib is the time to the reply of the broker, which ACKs the RPC. Thus the RTO after a stall holds the reply time of the broker.
  - amqplib tunes the smaller heartbeat of the broker and the client. A heartbeat of 80 s against the 60 s of the broker is 60 s, thus O03 sets the heartbeat at the broker too.
  - After its own FIN, a client gets a reset when the run lifts a freeze: the thawed broker closes its socket with linger 0. That reset is not a detection.
- The array stage of T01 gives each of the 13 cells at the defaults a practice profile, with the same trigger (#100).
  - These profiles name the defaults of RabbitMQ, PostgreSQL, gRPC or a managed Redis. No profile sets a knob of amqplib, of RabbitMQ, or of the Linux TCP that the cell reads.
  - Thus 8 array cells are aliases of their cells at the defaults, and 5 wait for the reasons of those cells.
  - DP44 gives the client a connect timeout of 5 s. The client clears that timeout when the connection opens, thus it does not change a fault with an operation in flight.
- The page of the RabbitMQ results gives the 12 cells of T01 from run [39216875830](https://github.com/mark1russell7/systems/actions/runs/39216875830) at main (#101). Each holds, with 132 counted runs and no void run.
- T11 is a cluster of three nodes of RabbitMQ 4.3.6 with one quorum queue (#102). The client of amqplib publishes a stream of sequence numbers with confirms through one node.
  - Two machine documents come from the release tarball of RabbitMQ 4.3.6 (machines 0.3.15). `aten` is the failure detector between the nodes, aten 0.6.0. RabbitMQ sets its poll to 5 s, thus a silent node is down 150 ms to 5.2 s after its last heartbeat. `ra-member` is one member of the queue, ra 3.1.10. A follower elects 5 s to 6 s after aten reports the node of its leader down.
  - A leader of Ra ignores aten. Thus in a minority it stays the leader, and it commits nothing.
  - A drain does not transfer the leadership: it stops the member of the leader, and a follower elects after 1 ms to 100 ms.
  - The harness has a cluster lab. The nodes form the cluster from the list of their names, and the timeline comes from the NOTICE and the INFO lines of Ra. The client connects to the next node when its connection ends (harness 0.11.17).
  - 9 cells at the defaults hold, with 11 runs each (runs 39218896659 and 39222600732). With the client on a follower, the first confirm comes 6.61 s after a freeze of the node of the leader. It comes at 6.68 s after a black hole, and at 8.05 s after a complete partition. The band is 5.05 s to 12.0 s.
  - The first run measured 6.1 s to 10.4 s against a band of 1.05 s to 4.0 s. RabbitMQ sets the poll interval of aten to 5000 ms, for fewer false elections, and aten itself polls each 1000 ms.
  - A step-down gives the first confirm 28.7 ms after the NOTICE of the old leader, and a drain 35 ms after the first monitor-down. A cut of one follower, in two directions or in one, gives no new leader, and the confirms go on.
  - With the client on the node of the leader, only the heartbeat of amqplib ends its connection. The client then connects to the next node, and its first confirm comes at 180.012 s after a freeze and at 180.039 s after a black hole.
  - 5 cells at the defaults wait, each with its reason. The 12 cells of the array stage are 7 aliases and 5 cells that wait. Linux sends no keepalive probe while data is in flight, thus the keepalive of DP42 can end only some runs.
- The page of the RabbitMQ results gives the 21 cells of T01 and T11 from run [39234193377](https://github.com/mark1russell7/systems/actions/runs/39234193377) at main (#103). Each holds, with 231 counted runs and no void run. The border of O03 is a heartbeat of 60 s, because the broker sends a frame each half heartbeat.

### H2 · HTTP/2 and gRPC

- **Status:** done
- **Area:** catalogs
- **Depends on:** HTTP
- **Started:** 2026-10-19
- **Shipped:** 2026-10-25
- **Links:** [The results](https://mark1russell7.github.io/systems/results/grpc/), [The results of T15](https://mark1russell7.github.io/systems/results/mesh/), [#105](https://github.com/mark1russell7/systems/pull/105), [The run at main](https://github.com/mark1russell7/systems/actions/runs/39288251967)

The PING frames of HTTP/2, the keepalive of gRPC and the enforcement policy of a gRPC server. R3 puts 148 cells on grpc-js 1.14 and on a server of grpc-go. 66 are in T01: 27 at the defaults, 12 borders of O03, O17, O25 and O26, and 27 in the array stage. The other cells are 22 in T02 (proxies), 22 in T03 (the routers of the clouds), 16 in T07 (kind) and 22 in T15 (Istio).

- The facts from the sources: grpc-js 1.14.6, grpc-go v1.84.0, and etcd v3.6.15 on grpc-go v1.83.2.
  - grpc-js sets TCP_NODELAY on each connection. It sets no TCP keepalive and no connect timeout.
  - The keepalive of grpc-js is off at the defaults. When it is on, the client waits 20 s for the ACK of each PING. A GOAWAY with `too_many_pings` doubles its keepalive time.
  - A call of grpc-js has no deadline at the defaults. Thus a call on a silent connection waits for the kernel.
  - When a connection ends, each call in flight on it ends with UNAVAILABLE, and grpc-js does not retry it. It retries only a call that did not start, and once a stream that the server refused.
  - grpc-js connects again after 1 s, then each wait is 1.6 times longer, up to 120 s, with a jitter of 20 %. A channel with no call for 30 min goes idle.
  - A server of grpc-go sends a PING after 2 h with no read. It closes the connection when the ACK does not come in 20 s.
  - Because its keepalive is on, grpc-go gives each accepted connection a TCP_USER_TIMEOUT of 20 s. Go accepts each connection with a TCP keepalive of 15 s idle, 15 s between probes and 9 probes. Thus an idle connection to a client that is gone ends 30 s after the last data, at the second firing of the keepalive.
  - A PING from the client is a strike when it comes less than 5 min after the last one. With no stream open, the minimum is 2 h. Headers or data from the server clear the strikes. The third strike gives GOAWAY ENHANCE_YOUR_CALM with `too_many_pings`, and the server closes the connection.
  - etcd sets the keepalive of its server to 2 h and 20 s. A client can ping each 5 s, but not with no stream open.
  - The server of etcd serves gRPC and HTTP on one port through cmux. The transport of grpc-go sets TCP_USER_TIMEOUT only on a TCPConn of Go, thus the client connections of etcd have none. The listener of etcd sets the keepalive idle to 30 s. The 15 s between probes and the 9 probes of Go stay. Thus an idle connection to a client that is gone ends 165 s after the last data.
  - etcd registers the health service of gRPC. Thus one client of the harness operates on both servers.
- The steps:
  - The machine documents of grpc-js, of a server of grpc-go, and of the server of etcd, each fact from the source at its tag.
  - A client of grpc-js in the harness, which calls `grpc.health.v1.Health/Check`. A server of grpc-go in the harness, built from its tag, that can hold a reply for a cell. A target of etcd, pinned by digest.
  - The T01 catalog at the defaults, with the borders of O03, O17, O25 and O26. Then the array stage, then T03, T02, T07 and T15.
  - The page of the results on the site.
- The three machine documents, `grpc-js`, `grpc-go-server` and `etcd-server` (machines 0.3.16, #105). The harness has a client of grpc-js, a server of grpc-go built from its tag, and etcd on Alpine (harness 0.11.18). Its three lab tests pass in run 39269486870.
  - Under TCP_USER_TIMEOUT, the keepalive of Linux aborts at K + k·I, with k = max(1, ⌈(U − K) / I⌉) (tcp_timer.c). The documents give the socket that count.
- The T01 catalog of grpc-js has 32 cells, with 11 runs each (#105). Each of the other cells of the plan in T01 is an alias or waits with its reason.
  - At the defaults, 17 cells hold in run 39272272260. A reset of a call gives ECONNRESET in 1.3 ms. The FIN of a stopped server ends an idle connection in 46 µs. A reset of the SYN fails the first call with UNAVAILABLE in 13 ms to 17 ms. An unreachable host with `tcp_retries2` = 3 gives EHOSTUNREACH 3.120 s after the first retransmission. The reply after a stall of 1 s comes back at 1.700 s.
  - A black hole and a frozen server end nothing in 60 s: grpc-js has no keepalive and no deadline. The server of the harness holds a reply 5 s, and it comes at 5.004 s. Nothing ends an idle connection in 300 s, to each server.
  - In the array stage, the keepalive of DP24 ends the transport behind a frozen etcd at 80.012 s. It is a PING after 60 s, and its wait of 20 s. Against grpc-go the keepalive is 300 s, at the MinTime of the server, and the transport ends at 320.006 s.
  - Two deadlines race. A call with a deadline gets a timer of the same time at the server of grpc-go, from the header grpc-timeout. The server resets the stream at its end. With a deadline of 4 s, 4 of 11 calls got CANCELLED and not DEADLINE_EXCEEDED, thus that cell of DP44 is a measurement. Its next run gave 8 DEADLINE_EXCEEDED and 3 CANCELLED, with a median of 4.003 s.
  - O03, O17 and O25 observe the socket of the server. A router forgets the flow at 35 s. A probe of the listener of grpc-go at 15 s keeps the flow. At 45 s the kernel of the server aborts the socket at 60.947 s. etcd probes at 30 s, with no TCP_USER_TIMEOUT. A router at 45 s keeps the flow, and behind one at 20 s the kernel of etcd aborts the socket at 168.691 s. A PING of etcd 10 s after the last read closes the connection at 30.002 s with a Timeout of 20 s. With 120 s, the kernel gives up first, 52.168 s after the first retransmission. TCP_USER_TIMEOUT of 20 s on grpc-go aborts an idle connection to a gone client at 30.599 s. With 160 s, above the 150 s of the keepalive alone, the abort moves to 169.010 s.
  - O26: the PINGs of grpc-js on a stream in flight, against a MinTime of 5 s. With a keepalive of 6 s, the call held 30 s gets its reply at 30.003 s, and a Watch of etcd stays open. With 4 s, the server sends GOAWAY too_many_pings at the fourth PING. The held call to grpc-go ended 16.034 s after the start of the client, and grpc-js logged it 16.007 s after the reply to the first call. The first PING clears the strikes, because the server wrote a reply since the last one.
- The page of the results gives the 32 cells of T01 from the run at main 39288251967. 31 cells hold, and the race of the two deadlines is a measurement: 2 of 11 calls got CANCELLED. The cells counted 352 runs, and no run was void. The export `scripts/grpc.ts` reads each raw record again with the judge of the harness. The ledger and the map of the cells add the page.
  - T03 is on the page too, from the run at main 39319194195: each of its 9 cells holds. With T01, the page gives 41 cells, of which 40 hold and 1 is a measurement, with 462 counted runs. GitHub was moving its runners to Linux 7.0 in that run, thus the page names the kernels 6.17 and 7.0, each with HZ 1000.
  - T02 is on the page too, from the run at main 39356655803: each of its 5 cells holds, through Envoy, Caddy, Toxiproxy and docker-proxy. The cells through nginx and Traefik are on the page too, from the run at main 39384829327: each one holds. The page gives 48 cells, of which 47 hold and 1 is a measurement, with 539 counted runs.
- The T03 catalog of grpc-js has 9 cells, with 11 runs each (#108). Each cell goes through one router at the idle timeout of its cloud preset. Each of the other 13 cells of the plan in T03 is an alias or waits with its reason. Each of the 9 cells holds.
  - A fault at the router toward the client gives the band of the same fault on the direct pair. EHOSTUNREACH came at 3.120 s, a reset at 1.0 ms, the reply after a stall at 1.681 s, and the FIN of a stopped server at 0.1 ms.
  - The listener of grpc-go probes each 15 s. Thus an idle flow lives through the GCP form (600 s) for 700 s, and through the AWS form (350 s) under DP11 for 400 s.
  - A simplex drop toward the client ends in a reset of the router. TCP_USER_TIMEOUT aborts the socket of the server with a reset. Conntrack sees that reset before the rule drops it, and each later packet arms the CLOSE timeout of 10 s again. The 8th retransmission of the client finds no entry, and the router of the reset-next form resets it, at 53.552 s.
  - Behind a black hole toward the client, nothing at the client detects the fault. The keepalive of the listener aborts the socket of the server at 30 s, and its reset takes the entry to CLOSE. The router forgets the flow 10 s later: 40.377 s to 40.839 s after the last segment of the client. From harness 0.11.19, the judge of a driver cell tests that band.
  - Shards of these runs failed with "Failed to build image", on the new image of the runners of GitHub. That image has Linux 7.0. Linux 7.0 moved the retransmit timer and the keepalive timer of TCP to new fields, and the prober did not compile against them. From prober 0.3.2, the prober reads each field of either kernel (#112). From harness 0.11.20, the harness builds each image with the CLI of Docker. Thus the error of a failed build shows the error of its compiler.
- The plan of T02: grpc-js through one proxy to grpc-go. R3 gives 8 cells at the defaults and 14 in the array stage. The proxies are Envoy 1.39, Traefik 3.7, Caddy 2.11, nginx before 1.29.7, Toxiproxy 2.12 and docker-proxy 29.1. The facts come from the source at these tags: Envoy v1.39.4, Traefik v3.7.15, Caddy v2.11.7, nginx release-1.29.6, Toxiproxy v2.12.0 and moby docker-v29.1.5.
  - A proxy answers a fault of its upstream itself. Before the headers of the response, Envoy, Traefik, Caddy and nginx send a 502, 503 or 504. grpc-js reads UNAVAILABLE. After the headers, each one resets the stream with INTERNAL_ERROR, and grpc-js reads INTERNAL. None of them retries a call at its defaults.
  - Envoy ends each call 15 s after the end of its request, at the timeout of its route: 504 "upstream request timeout", thus UNAVAILABLE. It forwards `grpc-timeout` and does not read it. Thus a call into a black hole through Envoy ends at 15 s, where on the direct pair nothing ends it.
  - Each of the four sends GOAWAY(NO_ERROR) on a connection with no stream at its idle close. That is 1 h for Envoy, 180 s for Traefik, 5 min for Caddy and 75 s for nginx. A PING of the client does not reset it. Traefik ends a stream at 60 s when its request still sends (`readTimeout`). Caddy ends a stream whose request sends nothing for 60 s (`read_body_idle`).
  - At SIGTERM, Envoy and nginx close each connection with no GOAWAY. Traefik sends GOAWAY and closes each connection 10 s later. Caddy waits for each stream at its defaults.
  - Toxiproxy and docker-proxy copy TCP and know no HTTP. Toxiproxy has no half-close: a FIN of either side closes both sockets. But docker-proxy passes a FIN as a half-close, and it ends each connection when Docker stops it. Neither has a timer. Go gives each of their sockets a TCP keepalive of 15 s, 15 s and 9 probes.
- The steps of T02: the machine documents of the six proxies, and then their hops in the harness. A hop has an image pinned by digest, a static configuration and a ready line. Then a `hop-event` gets a signal other than HUP (a stop), and then the catalog follows. A cell of the array stage whose profile sets no knob of a proxy is an alias of its cell at the defaults.
- The first cells of T02 go through Envoy, Toxiproxy and docker-proxy (machines 0.3.17, harness 0.11.21). Each band comes from the document of its proxy:
  - T02.defaults.31: a reset at Envoy toward the server, with a call in flight. Envoy answers with its local reply, UNAVAILABLE, on the open connection.
  - T02.defaults.35 and .36: a stop of Toxiproxy (SIGTERM) and of docker-proxy (SIGINT, as Docker stops it at a restart). The exit of the proxy closes the idle connection.
  - T02.defaults.48: the FIN of the stopped server, which Toxiproxy passes as a close of the client.
  - 4 array cells are aliases. The cells over Traefik, Caddy and nginx wait for their documents. 4 cells of docker-proxy wait, because it counts no request.
- Caddy 2.11.7 has its document (machines 0.3.18, #115). T02.defaults.41 is an idle gap through Caddy: Caddy sends GOAWAY 5 min after the last data, and grpc-js goes from READY to IDLE. It holds in 11 of 11 runs at 300.007 s (median), in run 39344223699. T02.array.41 is its alias.
  - The first run of the cell found a bug in the judge, not in Caddy. The judge of a driver had no case for the reference `last-data`. Thus it counted from the close of the peer. Through Caddy, that close was the idle close of the upstream socket at 120 s. harness 0.11.22 fixes it.
- The facts of nginx and Traefik come from their sources too, for the cells that wait.
  - At a reload of its dynamic file, Traefik 3.7.15 only swaps the handler of each entrypoint. Thus a reload sends nothing to the client. The idle timeout of 180 s counts from the end of the last stream, not from the reload.
  - nginx 1.29.6 has one worker at its defaults. During a call, the only timer of the call is `grpc_read_timeout` (60 s). After a stop of the worker of more than 60 s, its timers fire before it reads the reply of the server. Thus the client gets 504, and grpc-js reads UNAVAILABLE.
- nginx 1.29.6 has its document (machines 0.3.20). A hop event can stop a proxy and continue it at the end of a hold (harness 0.11.24).
  - T02.defaults.34: the server holds a call 5 s, and the worker of nginx stops for 90 s. The reply waits in the socket, and the read timer comes due. At the resume, nginx answers 504 before it reads the reply. It holds in 11 of 11 runs at 90.003 s (median), in run 39360323602. Each run gave `UNAVAILABLE: Received HTTP status code 504`.
  - T02.array.34 waits. DP08 sets a keepalive of the upstream, thus an `upstream {}` block, where nginx 1.29.6 and 1.29.7 differ. Its workload is busy, and the client of the harness holds one call in flight.
- Traefik 3.7.15 has its document (machines 0.3.21). A hop event can write a file of a proxy, and the proxy confirms the change by a line of its output (harness 0.11.25).
  - T02.array.77: in an idle gap, the reload changes a spare router, and Traefik confirms it. Nothing reaches the client, and the GOAWAY of the idle timeout comes 180 s after the last stream. It holds in 11 of 11 runs at 180.010 s (median), in run 39379039853.
  - The first run failed: the GOAWAY came up to 86 ms late. A control with no reload gave the same lateness, thus it is in the process of Traefik, not in the reload. The document gives a slack of 0.1 s, as an observation. The band stays below the time of the reload plus 180 s. Thus a reload that arms the timer again fails the cell.
- T07 over gRPC: the kind lab has a stack `grpc` (kind 0.2.0, harness 0.11.26). The server is grpc-go, with the gRPC probes of the kubelet. Each node has a client of grpc-js with one channel to the ClusterIP, and the channel holds one connection. 5 cells start: a deletion, a scale-in and two node drains with no preStop, and a scale-in with the preStop of DP28.
  - At SIGTERM, grpc-go sends GOAWAY, and a client on that pod connects again. Until the propagation, the rules can send that connect to the pod, which refuses it. Then each call fails at once until the next connect, after the first backoff of grpc-js. That backoff is 1 s, because grpc-js adds no jitter to the first wait. Thus the window ends at most one backoff after the propagation.
  - With the preStop of 20 s of DP28, the GOAWAY comes after the propagation, thus no call fails.
  - The channels go to the replica that stays after a run, and a new replica gets no client. In the first kind run (39388068896), the target by name had no client in 49 of 55 runs. Thus a run of gRPC stops the replica that answers the most clients. A scale-in first gives that replica a deletion cost of -1. Where the target had clients, each failed call came in its window. In a drain with nftables, one client got refusals from 9 ms to 1.025 s after the GOAWAY.
  - Each of the 5 cells holds in 11 of 11 runs, in kind run 39390098968, with clients on the target in each run. In the drains and the scale-in, calls failed in 19 of 33 runs. Each failing client lost 50 calls, for 984 ms to 1021 ms. The last failure came 1.009 s to 1.034 s after the deletion. In IPVS, no reconnect met the leaving pod in 33 GOAWAYs. With the preStop of DP28, no call failed.
  - The first backoff of grpc-js has no jitter, and the jitter of each later wait compounds (backoff-timeout.ts:169-181). The document of grpc-js gives both from machines 0.3.22.
  - 2 array cells are aliases, and 9 cells wait. A rolling update needs a window for each old pod. The server grpc-go has no seam for a liveness restart. The lab has no Cilium.
- The rolling updates of T07 over gRPC (kind 0.2.1). A window can be one window for each deleted replica (`each`). Each window counts from the intake and the deletion of its own replica.
  - A rolling update deletes each old pod immediately after a sync of kube-proxy, thus the propagation waits `minSyncPeriod` (`afterSync`). That is longer than 1 s, and a pod can refuse more than one connect.
  - The connect k of a client starts at the earliest after the lower bounds of the waits 0 to k − 1 of grpc-js. K is the largest k whose sum is at most the propagation. The window ends at most the wait K after the propagation.
  - A propagation shorter than 1 s gives K = 0, thus the 5 cells keep their bands. In IPVS after a sync, K = 1, and the window ends 3.239 s after the deletion.
  - T07.defaults.12 is a rolling update in IPVS. T07.array.12 is its alias: DP53 sets no knob on the path to the ClusterIP, and T07 has no cloud load balancer.
  - T07.array.46 is a rolling update in iptables under DP29: a preStop sleep of 60 s in a grace of 30 s. The kubelet waits for the hook for the grace at the most. Then it sends SIGTERM with a grace of 2 s (`kuberuntime_container.go` at v1.37.0, lines 801–808 and 895–915).
  - The API server refuses a sleep action that is longer than the grace (`validation.go`, line 3483). Thus the lab gives such a sleep as a command of the container.
- Each of the 7 cells of T07 over gRPC holds in 11 of 11 runs, in kind run 40123580623. Each run had 2 or 3 of the 3 clients on its target.
  - In the drains and the scale-in, calls failed in 17 of 33 runs. Each failed call was refused. The last failure came 0.994 s to 1.024 s after the deletion. With the preStop of DP28, and in the deletion in IPVS, no call failed.
  - Under DP29, grpc-go got SIGTERM 30.003 s to 30.021 s after each of the 22 deletions, and no call failed.
  - In the rolling update in IPVS, no connect was refused. The two old pods went 0.50 s to 0.60 s apart. One sync dropped both, 1.12 s to 1.28 s after the first deletion. The first old pod stopped 0.16 s to 0.22 s after its deletion.
  - Thus at the GOAWAY of the second pod, IPVS sent reconnects to the first pod, and their SYNs got no answer. 81 calls in 9 of 11 runs timed out. Each one started 8 ms to 104 ms after the second deletion, in its window.
  - A SYN retransmission reached a new pod approximately 2.1 s after the second deletion. The window holds because the client stops a call after 2 s. The next item gives the model of this stalled SYN.
  - 6 cells wait: the 2 liveness restarts, because grpc-go has no seam for them, and the 4 cells of Cilium.
- The stalled SYN of T07 over gRPC has its model (algebra 0.7.3, machines 0.3.24). In a rolling update, a reconnect can go to an old pod that is gone.
  - The SYN timer of Linux TCP is a backoff timer of the document (`syn_retransmit`). Its waits 0 to `tcp_syn_linear_timeouts` are 1 s (`tcp_timer.c` at 6.6, lines 604 and 624–631). At HZ 1000, each wait is up to 64 ms late.
  - A pod that still runs refuses a connect, because its listener is closed. A pod that is gone gives no answer, and the calls wait in the queue of the channel.
  - The kube-proxy of v1.37.0 sets `expire_nodest_conn` (`proxier.go`, line 281). At the drop of a pod, it gives the real server the weight 0, or it deletes it.
  - The first SYN after the drop expires its entry of IPVS. IPVS drops that SYN, because its conntrack entry is confirmed (`ip_vs_core.c` at 6.17, lines 1997–2048). The next SYN gets a live pod.
  - The timer arms again at each firing, thus the connect comes two waits after the drop at the most. Thus the window of each old pod ends 3.437 s after its deletion, not 3.239 s.
  - In 10 runs of 40123580623, the record has the first retransmission, 1.030 s to 1.077 s after the second deletion. Each came after the drop and got no answer.
  - In 9 runs, the record has the second retransmission, 2.055 s to 2.101 s after the second deletion. A new pod accepted it in each of the 8 records with the accept.
  - A run ends when its rollout is complete. In 2 of the 11 runs, that came 0.842 s and 2.049 s after the second deletion, before the calls in the queue ended. Thus no failure of these runs is in the record.
  - Conntrack keeps the NAT of a SYN to a pod that is gone (`SYN_SENT`). Thus a rolling update in iptables or nftables with SIGTERM before the propagation has no model yet.
  - The records of 40123580623, judged again, hold each of the 7 cells. T07.defaults.12 holds in 11 of 11 runs of kind run 40128267098 with the new band.
  - In 40128267098, each run had a stalled SYN to the first old pod, and the first retransmission came after the drop. Only 1 run recorded the second one, 2.063 s after the second deletion, and its 2 failed calls.
  - The other 10 runs ended 1.915 s to 2.028 s after the second deletion, before the calls in the queue ended. Thus the record of a rolling update needs a longer observation.
  - In each of the 11 runs, a node dropped the first old pod 1.312 s to 1.391 s after its deletion. That is after the bound of `afterSync`, 1.309 s.
- The liveness restart of T07 over gRPC has a seam (harness 0.12.2, kind 0.2.2). With `--fail-file`, grpc-go serves the service `liveness`, and the flag file fails its check.
  - For the trigger `liveness-restart`, the liveness probe is the gRPC probe of `liveness`. The readiness probe stays the check of `""`.
  - T07.defaults.35 is a liveness restart in nftables at the defaults of Kubernetes. T07.array.35 is its alias, because DP26 sets each value at its default.
  - The kubelet of v1.37.0 stops the container after 3 failed probes (`worker.go`, lines 366–390). The same sync starts the new container with no back-off (`kuberuntime_manager.go`, lines 1447–1470 and 1954–1961).
  - A sync sets the status of the pod before its stop and its start (`kubelet.go`, lines 2108, 2135 and 2267). Thus the endpoint stays ready through the stop.
  - A client on the pod connects again after the GOAWAY. Until the new container listens, the pod refuses that connect. No document bounds the start of a container, thus the window has no end.
  - T07.defaults.35 holds in 11 of 11 runs, in kind run 40131135561. Each run had 2 or 3 of the 3 clients on its target.
  - The kubelet stopped the container 20.362 s to 29.792 s after the flag, 8 ms to 13 ms after the third failed probe. The new container listened 0.114 s to 0.147 s after the stop.
  - Calls failed in 9 of 11 runs, and each failed call was refused. Each failing client lost 50 or 51 calls, from 2 ms to 1.008 s after the stop.
  - The next sync of the kubelet made the pod not ready 0.125 s to 0.176 s after the stop. Its readiness probe passed 16 ms to 41 ms later, and in 2 runs 0.994 s and 10.007 s later.
  - The rules of each node dropped the pod 0.150 s to 0.238 s after the stop. Thus the next connect of each failing client, after the first backoff, went to the other pod.
  - 4 cells of T07 over gRPC wait, because the lab has no Cilium.
- The fix of both findings (kind 0.2.3). A run observes until each predicted window can close, and until each request that started in it ended (`observationEnd`).
  - For a window, that is its latest end reference, plus the end of its band, the timeout of the workload and δ. With `each`, it is the latest deletion. Each other prediction keeps its observation.
  - Thus a run of the rolling update in IPVS observes 5.846 s after the second deletion. Before, it ended approximately 2 s after it.
  - The cause of the late drop: the runner of kube-proxy waits `minSyncPeriod` from the end of a sync, not from the change (`bounded_frequency_runner.go` at v1.37.0, lines 48–51 and 132–141).
  - In each run, the new pod came into the EndpointSlice 41 ms to 93 ms before the first deletion, not ready yet. That change started a sync at once.
  - The deletion came during that sync. Then one sync of each node added both new pods and dropped both old pods, 1.232 s to 1.391 s after the first deletion.
  - Thus `afterSync` has one more sync: the sync at the change, `minSyncPeriod` after its end, then the idle propagation. The bound of one sync is the idle propagation of the mode.
  - iptables and nftables apply all rules at the end of a sync, with one iptables-restore or one transaction (`iptables/proxier.go`, line 1384, and `nftables/proxier.go`, line 1872). Thus an idle propagation holds each step of a sync.
  - IPVS changes the real servers in its loop over the Services, and then it syncs its ipsets and restores iptables (`ipvs/proxier.go`, lines 771–859 and 1168–1188). For IPVS, the bound of one sync is an assumption.
  - The new bounds are 1.618 s for IPVS, 1.21 s for iptables and 1.158 s for nftables. The window of each old pod in IPVS ends 3.746 s after its deletion, not 3.437 s.
  - A window can give the propagation that it assumes (`propagation`). A drop after that band makes the cell `extend`. Only the rolling update gives it, because its band comes from the source of kube-proxy.
  - The idle cells do not give it yet. In run 39090689204, nftables dropped a pod 0.301 s after its deletion, after its calibration of 0.079 s and δ. In run 40131899989, T07.defaults.30 (nftables) had a drop at 0.208 s.
  - Also, IPVS syncs 30 s after each sync with no change (`ipvs/proxier.go`, line 387). A deletion soon after such a sync waits `minSyncPeriod`, and the idle calibration does not bound it.
- Each of the 28 cells of T07 holds, is a calibration or is a measurement in kind run 40131899989 (kind 0.2.3). 24 cells hold, 3 are calibrations and 1 is a measurement, and no run was void.
  - T07.defaults.12 holds in 11 of 11 runs. 10 of 11 runs recorded failed calls, 127 timeouts in all. Before the fix, only 1 of 11 runs did.
  - Each run observed 5.98 s to 6.03 s after the second deletion. Each failed call started 0.009 s to 0.123 s after the second deletion and ended at its timeout of 2 s.
  - The rules dropped each old pod 1.365 s after its deletion at the most, in the new bound of 1.618 s.
  - In CAL.T07.ipvs, a change in the wait after a sync reached the rules 0.293 s to 0.368 s after `minSyncPeriod`. That count starts at the change that started the sync. It is less than two idle propagations, 0.618 s.
  - In the drains and the scale-in, calls failed in 16 of 33 runs, and each failed call was refused. Under DP29 (T07.array.46), the rules dropped each old pod 1.056 s after its deletion at the most.
- The plan of T15 over gRPC: grpc-js through two hops of an Istio 1.31.3 mesh in the kind lab, to grpc-go. R3 gives 22 cells. 14 start, 6 are aliases and 2 wait with their reasons.
  - Each step is a pull request that `kind.yml` starts with `only='^T15'` and 11 runs of each cell. Each step merges on green and on the verdicts in `summary.ndjson`.
  - Step 1 (done, kind run 40147396211): the sidecar flavor in kind, with istioctl and the images pinned. The calibration of the propagation to each client sidecar, and T15.defaults.13 as a measurement.
    - Each cell had 11 counted runs, and no run was void.
    - In CAL.T15.sidecar, each client sidecar dropped the pod 0.128 s to 0.205 s after the deletion, with a median of 0.168 s in 33 drops.
    - T15.defaults.13 had no failed call in each of its 11 runs.
  - Step 2 (done, kind run 40151861479): the documents of the sidecar and of pilot-agent, and the trigger `authorization-policy`. T15.defaults.13 gets its band, and T15.defaults.5 starts.
    - Each cell had 11 counted runs, no run was void, and no run failed.
    - The deleted pod left each client sidecar 0.066 s to 0.147 s after the deletion.
    - A policy reached each server sidecar 0.154 s to 0.292 s after its apply.
    - T15.defaults.13 and T15.defaults.5 hold.
  - Step 3 (done, kind run 40157650738): the ambient flavor, with istio-cni, ztunnel and the document `ztunnel-hbone`. T15.defaults.12 is a reset on the HBONE leg.
    - Each cell had 11 counted runs, no run was void, and no run failed.
    - The deleted pod left each client sidecar 0.063 s to 0.133 s after the deletion.
    - A policy reached each server sidecar 0.163 s to 0.225 s after its apply.
    - T15.defaults.13, T15.defaults.5 and T15.defaults.12 hold.
  - Step 4 (done, kind run 40162204803): a line at each close of the socket of a client, and the trigger `idle`. T15.defaults.2 is a black hole, and T15.defaults.10 is an idle gap.
    - The run had 3 shards. Each cell had 11 counted runs, no run was void, and no run failed.
    - T15.defaults.12, .2, .10, .13 and .5 hold, and CAL.T15.sidecar and CAL.T15.policy ran as calibrations. The median of T15.defaults.2 was 20.949 s.
  - Step 5 (done, kind run 40168931281): the restarts of ztunnel. T15.defaults.14 is a control, and T15.border-off.85 and .86 are the borders of O10.
    - The run had 4 shards. Each cell had 11 counted runs, no run was void, and no run failed.
    - T15.defaults.12, .2, .10, .14, .13, .5, .85 and .86 hold. The median of .85 was 29.02 s in [29, 29.52] s, and the median of .86 was 30.047 s in [30, 30.52] s.
  - Step 6 (done, kind runs 40181243549 and 40202010754): the borders of O03, O17 and O02, with a stateful middlebox and a sysctl of a pod. T15.border-off.79 and .80 are the borders of O03, .87 and .88 of O17, and .77 of O02.
    - Kind run 40181243549: 13 of the 15 cells hold or are calibrations. T15.border-off.79 failed 11 of 11 runs, and .77 failed 2 of 11.
    - The lab of .79 was wrong. The sysctls of conntrack also forgot the local leg from ztunnel to grpc-go, and istio-cni needs its conntrack entry. In kind 0.8.1, the middlebox uses the match recent, and conntrack stays as it is. The lab of .80 changes with it.
    - The prediction of .77 was too strict. The server answers the GOAWAY of the client at once, and its FIN can come first. The band `answer` accepts CLOSE_WAIT from the release to one round trip and one step after the band.
    - Kind run 40202010754 started .79, .80 and .77 again, on 3 shards. Each cell had 11 counted runs, no run was void, and each cell holds.
    - In .79, no socket of a client ended. The median of .80 was 38.852 s in [28.98, 39.73] s, and the median of .77 was 300.046 s in [300, 300.62] s.
  - Step 7 (done, #155): the border of O22, the 2 cells that wait, and the page of the results.
    - T15.border-off.92 is the border of O22. It sets the lifetime of each workload certificate of ztunnel to 600 s, and its clients stay busy for 630 s.
    - The prediction is that no socket of a client ends: an open tunnel outlives its certificate. Thus the law O22 is violated.
    - T15.border-off.78 and .91 wait with their reasons, in `T15_GRPC_WAITING`. Thus the plan has 14 cells that start, 6 aliases and 2 cells that wait.
    - Kind run 40220699919: T15.border-off.92 holds in 11 of 11 runs. The raw record gives each leaf certificate a validity of 720 s: the TTL of 600 s and a backdate of 120 s.
    - The page [gRPC through Istio](https://mark1russell7.github.io/systems/results/mesh/) gives the 16 cells of the three kind runs. 14 cells hold and 2 are calibrations, with 176 counted runs and no void run.
    - The judge does not read the certificates of the record yet. A later check can compare each validity with the TTL of the cell.
- The decisions of the plan of T15. None needs Mark, because no money, account or key is in them.
  - The plan has pairs with no constraint by mesh mode. T15.defaults.14 and T15.array.14 run as a control, because the borders of O10 already restart ztunnel under ambient.
  - O17 moves through `tcp_retries2` of the client pod. The PING of ztunnel is a constant, and the middlebox half of O17 is the line of O03.
  - The middlebox of O03 is in the namespace of the server pod, because kind has no router between its nodes. The cell names the substitution.
  - The lab uses Istio 1.31.3, not the 1.31.1 of R3, because it is the newest patch. Its release notes change no default that a cell reads.
  - Each image loads with `kind load` under a tag that holds its digest, as the images of Redis and grpc-go do. A pull-through registry on the kind network is the fallback.
  - The middlebox uses a table of the match recent in the namespace of each server pod, keyed on the address of each client pod. A `ct timeout` object of nftables acts only on a flow that conntrack has not confirmed yet (`nft_ct.c` of Linux v6.17, line 915). The sysctls of conntrack also forget the local leg from ztunnel to the app.
  - T15.border-off.88 sets `tcp_retries2` 4, not the 5 of the plan. With 5, TCP gives up 12.8 s to 26.936 s after the PING: on each side of the PING timeout of 20 s.
  - The release of the pool of ztunnel counts from the last checkout of the connection, not from the end of the last stream. Thus T15.border-off.77 gives each client a new channel for 5 s at the fault, and its band tells the two apart.
- Step 1 of T15 (kind 0.3.0). A cell can name a mesh (`mesh`), and the template `T15` is new. The cells of one mesh flavor share a cluster.
  - The install is `istioctl install` of 1.31.3, pinned by the sha256 of its tar file. The digests of their index on Docker Hub pin istiod and the proxy.
  - The profile is `minimal`, not `default`: the profile `default` also has an ingress gateway, which no cell uses. The init container of the injector gets the image of the proxy too.
  - The agent polls `/clusters` of each client sidecar each 50 ms, with a filter that selects the server cluster. The propagation of a sidecar cell comes from these polls, not from the rules.
  - The watcher follows each sidecar. It keeps each access line of a failure, a retry or a local reply, and it only counts the other lines.
  - The release notes of 1.31.2 and 1.31.3 change no default of the retries, the timeouts, the drain or the native sidecars.
  - 1.31.2 makes the push of EDS cheaper, and 1.31.3 sends some unhealthy endpoints of a ServiceEntry. Neither changes the drop of an endpoint with the condition `terminating`, and the calibration measures the push at 1.31.3.
  - The injector of 1.31.3 changes a gRPC probe into an HTTP probe of pilot-agent (`app_probe.go`, lines 143–155). Then pilot-agent sends the gRPC check, with the service of the probe (`status/server.go`, lines 1194–1253).
  - The job raises the inotify limits of the runner to 512 instances and 524288 watches, the values of the known issues of kind.
- Step 2 of T15 (kind 0.4.0, machines 0.3.25). The documents `istio-sidecar-outbound`, `istio-sidecar-inbound` and `pilot-agent` hold the facts of the sidecar.
  - The window of T15.defaults.13 ends one push of EDS after the deletion: 0.205 s, from the calibration of step 1.
  - Each failure of that cell starts before the client sidecar of its node drops the pod. The timeout of 2 s ends such a call later.
  - The trigger `authorization-policy` applies a DENY policy for the account of the clients, and deletes it after 15 s.
  - The agent polls the counters of LDS of each server sidecar each 50 ms. CAL.T15.policy calibrates that update with an account that no pod has.
  - Each failure in the window of T15.defaults.5 must be PERMISSION_DENIED. Its band is the debounce of istiod until its calibration.
  - The inbound route of a port of gRPC has no retry policy (`route.go`, lines 1321–1341). A port of another protocol gets 2 retries on reset-before-request.
- Step 3 of T15 (kind 0.5.0, machines 0.3.26). The flavor `ambient` installs the profile `ambient` of 1.31.3: istiod, istio-cni and ztunnel on each node.
  - The digests of their index on Docker Hub pin istio-cni and ztunnel too. The chart of ztunnel reads only its own pull policy, thus the operator sets it there.
  - The namespace of an ambient cell has the label `istio.io/dataplane-mode=ambient`. Its pods have no sidecar, and ztunnel balances each connection, not each call.
  - The job loads the modules of the iptables rules of istio-cni first, and it prints each result. When a module does not load, each ambient cell waits with its name.
  - In T15, the trigger `rst` puts a rule in each server pod, with each client pod as a peer. A REJECT resets only the sender, thus the rule goes where the segments of the clients arrive.
  - The rules of all server pods commit at one instant. Before the heal, the lab reads the tables of each server pod, as evidence of which rule matched.
  - The watcher follows the log of each ztunnel. Its stamps are of the wall clock, thus no band reads them.
  - The document `ztunnel-hbone` gives the PING of ztunnel: 10 s after each PONG, then at most 20 s for the PONG. Both are constants, and data does not put a PING off.
  - The window of T15.defaults.12 starts by one call and one step of ztunnel after the fault: 0.03 s.
  - It ends by the wait 5 of the backoff of grpc-js after the heal: 26.101926 s. The heal comes at most 12 s after the fault, thus no later wait can be in progress.
  - The jitter of grpc-js adds up over its waits, thus the wait 5 is long. The clear uses the PIDs of the fault again, thus the heal comes soon after the hold.
  - T15.array.12 is an alias of T15.defaults.12. ztunnel reads no field of the DestinationRule of DP36 on an L4 path.
- Step 4 of T15 (kind 0.6.0). The gRPC client writes a line at the connect and at the close of each socket of its channel. SIGUSR1 stops its calls, and SIGUSR2 starts them again.
  - The trigger `idle` sends SIGUSR1 to the client of each client pod, and SIGUSR2 after the hold. The restore sends SIGUSR2 again.
  - The prediction `ends` is the close of the socket of each client in a band after a reference. With no band, no socket closes, and each client calls again on its socket.
  - T15.defaults.2 is a black hole of 45 s on the HBONE leg. The PING of ztunnel ends the connection 20 s to 30.03 s after the fault.
  - Its window ends 2 s before the heal to 3.046 s after it. The SYN timer of Linux 6.17 waits 1 s five times, thus the last SYN of a connect of 10 s is at 7 s.
  - T15.defaults.10 is a gap of 330 s in the calls. The release of the pool at 300 s does not close a connection with an open stream, thus nothing ends the socket.
  - T15.defaults.10 uses `ends` with no band, not `stays`. The judge of `stays` reads only the endpoints and the refusals, thus it holds when a socket closes and the client connects again.
  - T15.array.2 and T15.array.10 are aliases of the cells at the defaults. DP51 and DP52 set no knob that ztunnel reads on an L4 path.
- Step 5 of T15 (kind 0.7.0, machines 0.3.27). The trigger `ztunnel-restart` deletes the ztunnel pod of each node. A cell can set the environment of ztunnel (`mesh.ztunnel`), with its undo after the cell.
  - The chart of ztunnel sets `maxSurge` 1. Thus the controller of the DaemonSet makes the new pod at the deletion, not when the old pod is gone.
  - The reference `restart` is the first deletion of a ztunnel pod, as the watcher receives it. A run ends when each old pod is gone and each node has a ready new one.
  - The trigger deletes the pod of each node, not of one node. The flow of each client crosses the ztunnel of its own node, thus each client meets the restart.
  - T15.defaults.14 is a control: sidecar pods in the ambient flavor. ztunnel is on no path, thus no call fails.
  - T15.border-off.85 sets a deadline of 29 s in the grace of 30 s. ztunnel ends each socket 29 s to 29.52 s after the deletion.
  - T15.border-off.86 sets a deadline of 31 s. The SIGKILL at the end of the grace ends each socket 30 s to 30.52 s after the deletion.
  - The bands let the SIGTERM of the kubelet come up to 0.5 s after the deletion. That is an assumption, and the runs measure it.
  - T15.array.14 is an alias of T15.defaults.14. DP51 sets no knob of ztunnel.
- Step 6 of T15 (kind 0.8.0, machines 0.3.28). A plan can have steps before the fault (`prepare`). They are a sysctl of the namespace of a pod, a stateful middlebox, and a stop of the calls.
  - The middlebox is two chains in the namespace of each server pod, with a table of the match recent (kind 0.8.1). After the idle timeout with no segment, they drop each segment of the client pod on the port 15008: the silent-drop form. It stands in for `router-netns:azure-lb-240` (`substitutes`).
  - T15.border-off.79 forgets an idle flow at 11 s. Each PING of ztunnel refreshes the flow, thus nothing ends the tunnel in a gap of 120 s.
  - T15.border-off.80 forgets an idle flow at 9 s. The PING timeout ends the socket 28.98 s to 39.73 s after the fault.
  - T15.border-off.87 and .88 are quiet clients behind a black hole of 45 s, with `tcp_retries2` 6 and 4 in each client pod. With 6, the PING timeout ends the socket 20 s to 30.03 s after the fault. With 4, TCP gives up first with ETIMEDOUT, 6.4 s to 23.772 s after the fault.
  - T15.border-off.77 gives each client a new channel for 5 s at the fault of a gap of 330 s. The pool of ztunnel releases the tunnel 300 s to 300.62 s after the fault, and the side of the client closes it. The FIN of the answer of the peer can come first, up to 300.631 s (`answer`, kind 0.8.1). The prediction `ends` of the tunnel reads the state records of the prober.
  - A band from a signal lets the signal of each client come up to 0.5 s after the first one. That is an assumption, and the runs measure it.
  - `kind.yml` tries the kernel features of the borders in a new namespace of the runner, and it prints each result in `borders.txt`.
  - The document `ztunnel-hbone` gets the fix of the release: its timer starts at each checkout. The why of T15.defaults.10 cited the wrong fact, and its prediction stays the same.
- Step 7 of T15 (kind 0.9.0). The trigger `certificate-expiry` keeps the calls of each client going for the hold. No act of the lab touches a connection.
  - The cell sets `SECRET_TTL` of ztunnel to 600 s, through `mesh.ztunnel`. Each CSR of ztunnel asks for that lifetime (`config.rs` of ztunnel 1.31.3, lines 59, 104 and 868).
  - The CA of istiod signs the lifetime of the request, up to 90 days, with no minimum (`ca.go` of Istio 1.31.3, lines 460–469). It backdates each certificate by 120 s.
  - The renewal of ztunnel comes at the middle of the validity, 240 s after the issue (`certificate.rs`, lines 402–408). A renewal touches no open connection (`manager.rs`, lines 408–431).
  - Only a revocation in the CRL ends an open tunnel for its certificate. The release of the pool does not close a connection with an open stream (`pool.rs`, lines 142–146).
  - The step `certificates` reads the workload certificates of each ztunnel at the fault and at the heal, with `istioctl ztunnel-config certificate`. The lines `certificates` of a run give the validity of each leaf.
  - The judge does not read these lines. Thus a reader of the raw record checks that each leaf had a lifetime of 600 s.
  - T15.border-off.78 waits. The outside of O02 needs a release at or after an idle close of the peer, and the HBONE server has no idle close (`h2/server.rs`, lines 110–124 and 140–186).
  - T15.border-off.91 waits. The inside of O22 needs a maximum age of a connection, and the pool of ztunnel has none (`config.rs`, lines 74–75 and 790–797).
  - A maximum age of the connections of grpc-go is a setting of the server, not of ztunnel. That is another pair, for a later plan.
  - The export `scripts/kind.ts` writes the copy of T15 to its own file. A later run of a cell replaces its first run, by its id, also under a new name.

## Kubernetes

### KIND · Kubernetes endpoints in kind

- **Status:** done
- **Area:** catalogs
- **Depends on:** S2
- **Started:** 2026-10-15
- **Shipped:** 2026-10-18
- **Links:** [The results](https://mark1russell7.github.io/systems/results/kind/), [#34](https://github.com/mark1russell7/systems/pull/34), [The run at main](https://github.com/mark1russell7/systems/actions/runs/39090689204), [#59](https://github.com/mark1russell7/systems/pull/59)

T07 is the lifecycle of the endpoints of a Service, and T18 is a fleet whose readiness needs Redis. In the run at main of 2026-10-18, 26 of the 31 cells hold, 3 are calibrations and 2 are measurements, and no cell fails. KIND-LONE gave the cause of each lone failure of 2026-10-17.

From kind 0.2.3, a run observes until each predicted window can close (H2). The window of a pause of kube-proxy ends up to 122 s after the resume, because of a stale SYN_SENT entry. Thus each run of such a cell observes approximately 2 min more. `afterSync` has one more sync, thus the bound of the rolling update in iptables (T07.defaults.23) is 1.21 s, not 1.105 s. Its prediction stays no failure, because the intake stops 2 s after the deletion.

In kind run 40131899989, each of the 21 HTTP cells of T07 holds, is a calibration or is a measurement. The rules dropped each old pod of T07.defaults.23 1.050 s after its deletion at the most. Each run of a pause observed 124.4 s after the resume, and the longest shard took 60 min.

In iptables and nftables, stale SYN_SENT entries failed requests of the paused node up to 116.2 s after the resume. That is in the window of 122.1 s. In IPVS, no request failed later than 0.07 s after the resume. No request failed on another node.

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
- **Links:** [The page](https://mark1russell7.github.io/systems/results/pg/), [The run at main](https://github.com/mark1russell7/systems/actions/runs/39182922975), [#74](https://github.com/mark1russell7/systems/pull/74), [#95](https://github.com/mark1russell7/systems/pull/95)

The page gives the 75 PostgreSQL cells of one run at main. They are T01 for each client, T03 through a router and through a router and Supavisor, and T10 through PgBouncer, Pgpool-II and Supavisor. Each cell holds, with 825 counted runs and no void run. The export `scripts/pg.ts` reads each raw record again with the judge of the harness, and it stops when a prediction disagrees with the catalog. The map of the cells has a row for each pooler, and the ledger and the home page add the page.

### CANONICAL · The canonical cells, measured to the close of Redis

- **Status:** done
- **Area:** site
- **Depends on:** REDIS
- **Started:** 2026-10-17
- **Shipped:** 2026-10-17
- **Links:** [The run](https://github.com/mark1russell7/systems/actions/runs/39045508827), [The page](https://mark1russell7.github.io/systems/results/r3/), [#38](https://github.com/mark1russell7/systems/pull/38)

Five cells put the idle close of Redis against the keepalive of the kernel, both at 600 s. Each of the 55 runs ended 600.09 s to 600.97 s after the last segment, at the idle close of Redis.

### SITE-UX · The weekly round of the site and the tracker

- **Status:** later
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

<!-- ste-disable-next latin-abbreviation -- VIZ is the ID of the item, not the Latin abbreviation -->

### VIZ · Interactive visuals and docs: from processes and the kernel to the NIC

- **Status:** later
- **Area:** site
- **Depends on:**
- **Started:**
- **Shipped:**
- **Links:**

After the coding work, this item makes interactive visuals and documents that show how the systems operate, from end to end. Examples are the network calls, the processes that hold memory, the kernel and the NIC. Mark gives many ideas and examples (Mark, 2026-10-20). Before the work starts, Mark and the program agree on its scope.

## Decisions for Mark

### D-IDENTITY · A scenario identity without the defaults

- **Status:** done
- **Area:** decisions
- **Depends on:** IMPORT
- **Started:** 2026-10-17
- **Shipped:** 2026-10-20
- **Links:**

A catalog cell gives each knob, and a compiled cell gives only the knobs that it moves. With the defaults out of the identity, both cells of one scenario become one entity.

Decided on 2026-10-19: the identity of a scenario holds only the settings that differ from the defaults of the documents. It is the more general choice: one scenario is one entity, in each form of a cell.

Built in jarvis and merged on 2026-10-20. A setting leaves the identity only when a document names its key and its value is the default of that document. These documents are linux-tcp for the sysctls, and each server document for its settings. The projection after the merge gave each landed run its new id, and no file named an old one.

### D-EXTEND · A verdict for a late propagation in kind

- **Status:** done
- **Area:** decisions
- **Depends on:** KIND-LONE
- **Started:** 2026-10-17
- **Shipped:** 2026-10-19
- **Links:**

The calibration gives the propagation from 33 samples. A run can measure a longer tail, and its failures then come in the window of the law but outside the band.

Decided on 2026-10-19: such a cell is `extend`. The run agrees with the law, and only the calibrated band is short. `extend` does not count as a hold. A failure after the drop still fails the cell. kind 0.1.8 applies it, and the check of the run tells its tail (`tail`).

### D-R2 · R2's choice of systems where the app runs

- **Status:** done
- **Area:** decisions
- **Depends on:** S0
- **Started:** 2026-10-08
- **Shipped:** 2026-10-20
- **Links:**

The last step of S0. The options document of R2 lands where the app runs. A second landing does no harm.

Mark's answer of 2026-10-19: yes. The jarvis session landed it on 2026-10-20: the artifact "The systems the harness runs", from `@jarvis/systems-pages` built at the main of jarvis.

### D-REVIEW · The judgments of 2026-10-16 and 2026-10-17

- **Status:** done
- **Area:** decisions
- **Depends on:**
- **Started:** 2026-10-16
- **Shipped:** 2026-10-19
- **Links:**

The mechanisms of MongoDB, the name of the step-down window, the ack delay as a mechanism, and the first version of `@mark1russell7/machines`.

Mark's answer of 2026-10-19: keep each of them, as `decisions.md` in jarvis records them.
