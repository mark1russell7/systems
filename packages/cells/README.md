# @systems/cells

The cells of the systems program. A cell is one point of a topology: a fault, a workload, an observer and the settings of the timers. Each cell has the prediction that the algebra gives for it. This package is private, and it does not go to npm.

## The T01 catalog

T01 is the direct pair: a client and a stock Redis 7.4. The catalog (`src/catalog.ts`) crosses these axes, and each axis moves a prediction or tests one:

- **The manifestation.** A black hole, an ICMP unreachable (host, net, port, admin), a simplex drop in each direction, and a FIN. The FIN comes from a process that stopped with SIGKILL. Also a frozen process, a stall, an MTU black hole, and netem on each segment (loss, duplication, reordering, corruption, jitter).
- **The workload.** An idle connection, a request in flight, or a stream of requests. A stream of PINGs has one segment in flight. A stream of `GET` requests for a 256 KiB value has many, thus reordering and duplicates have segments to act on.
- **The observer.** The kernel of the client, or the server: the socket of Redis for the connection of the client.
- **The timers.** Keepalive at 5 s idle and 3 probes 2 s apart, `tcp_retries2` at 3 and 5, and the keepalive of Redis from `tcp-keepalive` 5.
- **The latency.** 0, 20 and 100 ms on the egress of the target. A longer round trip is a longer RTO, thus each step of the retransmission ladder moves.

Each cell gives each knob that its prediction reads. The namespace of the observer gets the knobs of Linux TCP as sysctls, and Redis gets its settings. Thus nothing comes from a default.

## The predictions

`predict` asks `@mark1russell7/algebra` for each cell:

- **A detection by a timer.** The first live timer of Linux TCP, or of Redis over Linux TCP for the server. The band is its duration, less how early it can fire, to its duration plus how late it can fire.
- **A soft error.** Linux keeps an ICMP error on an established socket as a soft error. Thus the give-up of the retransmissions gives the errno of the ICMP (EHOSTUNREACH, ENETUNREACH, ECONNREFUSED), not ETIMEDOUT. Keepalive gives ETIMEDOUT: its probe has the sequence number before `snd_una`, thus its ICMP is out of the window, and the kernel ignores it.
- **The revert of RFC 6069.** A host or net unreachable for each retransmission takes back one doubling of the backoff. Thus the give-up comes at most one RTO after its budget: 3.0 s to 3.268 s at `tcp_retries2 = 3`, where a black hole takes 3.0 s to 6.616 s. The cells set the ICMP rate limit of the sender of the ICMP to 0, thus each retransmission gets one ICMP.
- **A delivered event.** The kernel of a process that stopped with SIGKILL closes its socket with a FIN. The FIN comes one way after the close, with no errno: an end of file.
- **A recovery.** After a stall, the connection moves at the first retransmission after the stall, and the reply comes back one round trip later.
- **A distribution.** Under netem loss, duplication, reordering, corruption or jitter, the reply times are a distribution. These cells have no band. Their runs are measurements, and they keep each reply time for a simulator. They also keep what reordering did at the two ends: arrivals out of order, duplicates, SACKs, DSACKs, and the reordering degree of the kernel.
- **The first round trip.** Each band names the range of first round trips that it assumes (`rtt.ts`). The models read a round trip of 1 ms, and the latency of the cell. The range holds each round trip where the band stays within δ_abs of itself, with the same timer. A ladder of the RTO at HZ 250 holds up to 4 ms: above it, each RTO is one jiffy longer. A keepalive band does not read the round trip, thus it names no range.

## The T03 catalog

T03 is the stateful middlebox chain: client → NAT router (conntrack) → Redis 7.4 (`src/t03.ts`). The router forgets an idle flow at 5 s. This value is a cloud NAT's 350 s, scaled by 70 through `nf_conntrack_tcp_timeout_established` in the namespace of the router.

- **The key question** is O03 of the ordering law: does the keepalive of the endpoint refresh the router before it forgets the flow? `o03` decides it with the law of `@mark1russell7/service`. The refresh is the `idle-refresh-interval` of Linux TCP, or of Redis, at its latest. The forget is the `middlebox-idle` of the conntrack document, at its earliest. The margin is one round trip and one jiffy.
- **The border.** The keepalive idle time is 4 s on one side of the border and 6 s on the other. A keepalive probe at 4 s refreshes the flow, and the cell is silent for 15 s. A router that forgets the flow in that window is a finding.
- **DV-12's three cases**, when O03 does not hold. A router that resets both ends does it at the forget: the `expire_established` timer of conntrack, late by the pump and two listings at most. A router that resets the next packet answers the first keepalive probe. A router that drops silently leaves the endpoint to its whole keepalive window.
- **The next packet is a request.** After 8 s of idle time, the request meets a reset, the retransmissions to their give-up, or a flow that conntrack picks up again (`ct.none.established`).
- **The server.** The keepalive of Redis (`tcp-keepalive`) meets the reset of both ends, a dropped probe from outside, or the reset of the router's own stack (`none`).

A fault at the router (`T03_FAULT_SPECS`) is a set of FORWARD rules on its device toward one side. Its router is a plain NAT (`none`), and the client meets the manifestation of the direct pair with the same knobs:

- **A black hole at the router**, idle, gets the band of the direct pair's black hole. In flight, it gets the band of the give-up.
- **A reset from the router** comes at once after the request.
- **The ICMP unreachables of the router** come from the address of the router, not from the peer. The revert of RFC 6069 does not examine where an ICMP comes from. Thus host and net unreachable give the reverted band: 3.0 s to 3.268 s at `tcp_retries2 = 3`.
- **A simplex partition at the router** in each direction, and **netem delay** on the device toward each side.
- **The router forgets the flow behind its own black hole.** Conntrack sees each packet before the FORWARD rules drop it. A plain NAT then passes a late packet into the black hole, and the forget changes nothing. A router that resets both ends does it from its own stack, past its black hole: at the forget when idle. In flight, each retransmission refreshes the flow. The forget then comes one idle timeout after the last retransmission before a wait longer than 5 s: 6.528 s after the send, at `tcp_retries2 = 8`.

The cells of T03 go one at a time: the listing of a router evicts the expired flows of each namespace.

## The T02 catalog

T02 is the pooled request chain: client → HAProxy 3.2 in TCP mode → Redis 7.4 (`src/t02.ts`). HAProxy ends each connection, thus each leg has its own sockets and its own timers.

- **The idle timeouts of HAProxy** against a keepalive on each side. HAProxy has no machine document, thus these cells are measurement-only.
- **A black hole on each leg, from each side.** Each socket that can detect it is an observer: the client, the socket of HAProxy toward each side, and the socket of Redis. Linux TCP predicts each of them. HAProxy has kernel keepalive on its sockets (`clitcpka`, `srvtcpka`), at 3 s idle and 3 probes 1 s apart.
- **What the client sees** when HAProxy gives up on the server is measurement-only.

## The TOX catalog

The TOX catalog has Toxiproxy 2.12.0 as the subject, between the client and Redis 7.4 (`src/toxiproxy.ts`).

- **Each toxic** gets a cell: latency, timeout, reset_peer, slow_close, bandwidth, limit_data and slicer. Each prediction comes from the semantics that the documentation of Toxiproxy states. A toxic whose documentation gives no time is measurement-only.
- **The time of Toxiproxy.** The documentation states no time of its own. Thus each band adds the time of Toxiproxy for each crossing (`through`). A request crosses toward the target, and a reply or a close toward the client. Each time is the 99th percentile of its calibration cell.
- **The close translation.** A reset and a black hole on the upstream connection of Toxiproxy are measurement-only, because Toxiproxy documents no close. The same faults on the direct pair, with iptables or netem, have predictions from the algebra.

## The T12 catalog

T12 is a replicated group under an external failover authority: clients → three Sentinels → a primary and two replicas, all Valkey 9.1.2, quorum 2 (`src/t12.ts`). The client is ioredis 6.0.0 in Sentinel mode, at its defaults, with a stream of writes. The name of each cell starts with the cell of the plan that it stands for, for example `T12.defaults.6`.

- **Two machine documents** give the timers. Comments cite each fact by its file and line.
  - `src/sentinel.ts` is the Sentinel of Valkey 9.1.2, from `src/sentinel.c` at that tag. It gives the tick, the ping period, down-after, the asks, the election, the promotion and the conversion.
  - `src/ioredis-sentinel.ts` is the Sentinel path of ioredis 6.0.0. It gives the reconnect ladder, the connects that each ask a Sentinel, and the give-up of the offline queue.
- **The failover** (`failoverOf`) adds the stages, each from the Sentinel document:
  - The first PING without a PONG, then down-after-milliseconds and a tick.
  - The second Sentinel that is down, then a tick for the election, and a tick each for the selection and the promotion.
  - The next INFO of the replica, which shows the promotion to the leader. Then the hello of the leader, which switches the other Sentinels.
- **At the defaults,** the Sentinels name the new primary 30.2 s to 32.8 s after a primary goes silent.
- **The client.** The driver has no timer for the group: it moves only when its own connection closes.
  - A fin or a refusal closes it at once. Its reconnect ladder finds the new primary at the first connect after the Sentinels name it (`firstAfter`).
  - A frozen primary keeps the client until its thaw. The Sentinels convert the old primary one INFO period after its return, and their `CLIENT` command closes the client (`conversionOf`).
- **The triggers.** Each trigger of the plan's T12 cells over `valkey-9.1-sentinel` gets a cell at the position that the plan names: the primary.
  - `partition:partial` gets both directions. One cuts the primary from its Sentinels and its replicas, and its clients stay with it (DV-40). The other cuts the primary from its clients only.
  - `event:planned` gets the plain and the coordinated failover.
  - `event:bundle` waits: it is an event of Pulsar (`T12_WAITING`).
- **Measurement-only.** A black hole and the partition of DV-40 keep the client on the old primary while they hold.
  - After the lift, the old primary is a replica again only when a Sentinel reaches it. That occurs on the SYN backoff of its kernel, from a time that no document gives.
  - The coordinated failover rests on the FAILOVER command of the server, which has no document.
- **The borders.** A primary silence of 29 s and of 33 s, on each side of down-after-milliseconds. Also the failover against the give-up of the offline queue: 21 closes of ioredis 6 take 71.35 s to 75.9 s. Thus down-after-milliseconds of 69 s keeps the queue, and 76 s fails each queued write with `MaxRetriesPerRequestError` first.
- **The stamps.** Each stage band includes the error of the stamps of the observer (`STAMPS`). The calibration cell `T12_CAL` measures it: the prober records each write of a Sentinel to the observer.
- **The RTT.** A band of the group holds for each round trip from 0 to 2 ms (`GROUP_RTT_MS`).

The cells of T12 go one at a time: a group has 16 containers, and its timeline reads the scheduler of six processes.

## The HTTP catalog

The HTTP catalog (`src/http/`) has the cells of T01 and T03 with the Node HTTP server. They are the defaults stage, and the border cells of the keep-alive race. Each catalog entry has its prediction, and the name of the plan cell that it stands for. `cells.ts` makes each entry a cell of the harness.

- **The systems.** The server is the `http.Server` of Node 24.21.0, as a script on the stock Node image (`targets/node-http-server.mjs`). The clients are three, each from an image of the harness:
  - the `http.Transport` of Go 1.27.2 (`go-http`)
  - the `http.Agent` of Node 24.21.0 (`http-agent`)
  - an HTTP/1.1 `Client` of undici 8.12.2 (`undici`)
- **The lines.** Each client writes the JSON lines of the TCP client of the harness. For each request, it also writes its connection (the local port), a flag if the client reused it, a new try, and the outcome. The server writes a line at each accept, request, idle timeout and close.
- **The documents.** Each system has a machine document from its source at its version: `node-server.ts`, `go-transport.ts`, `node-agent.ts` and `undici.ts`. Each fact has its file and its line.
- **The lateness of a user timer.** A Node or Go timer sleeps in `epoll_wait`. The kernel lets that sleep end late by a slack: the remaining time divided by 1000, at most 100 ms (`timers.ts`). Thus the 6 s keep-alive timer of the Node server can fire 7 ms late.
- **The coarse clock.** At HZ 1000, the coarse clock of the kernel has a step of 1 ms. Then libuv reads its loop clock from the coarse clock. Thus each bound of a Node timer gets one more jiffy. The knob `hz` of each Node document comes from `CELLS_HZ`.

### The keep-alive race

Two requests go on one connection, with a gap g between the first reply and the second request (`race.ts`). The server closes an idle connection at S after its response: `keepAliveTimeout + keepAliveTimeoutBuffer`, 6 s at the defaults. The pool of the client drops it at C after the reply. The one-way delays cancel, except for the round trip:

| Ordering | Condition | What the second request meets |
| --- | --- | --- |
| `kept` | g + RTT < S, and g < C | the same connection, and a reply |
| `dropped` | C < g, and C < S | a new connection: the pool closed the old one |
| `fin-first` | S < g, and S < C | a new connection: the FIN came before the send |
| `crossed` | S − RTT < g < S, and g < C | the FIN of the server in flight, and a reset from its kernel |

In a crossing, each client does a different thing. Go sends a GET again on a new connection, and it gives a POST the end of file. The agent gives `socket hang up` (ECONNRESET), and undici gives `other side closed` (`UND_ERR_SOCKET`).

- **The width of the window.** The crossing window is one round trip wide. On the Docker bridge, the round trip is narrower than the bounds of S. Thus a cell with the gap at S is measurement-only. A cell with 100 ms of latency has a window that holds the bounds of S.
- **Only Go races.** The agent and undici take C from the hint of the server, less a buffer. The hint is S in whole seconds or less, thus their C stays below S. Go ignores the hint, and its C is 90 s.
- **The border of O01.** The plan gives O01 a margin of 0.26 s at S = 6 s. The documents give a margin of a few milliseconds: the lateness of C, the early bound of S and the round trip. Thus the cells on each side of the border of the plan predict no race.

### The faults

Each prediction of a fault composes the document of the client, or of the server, over Linux TCP (`stackedDetection`). Thus the keepalive of Go or the `keepAliveMsecs` of the agent is the keepalive of the kernel.

- **A timer of the client can come first.** At its defaults, Go closes an idle connection at C (90 s), before its keepalive window ends (165 s). Thus a black hole behind an idle Go connection gives no error.
- **A new try meets the fault.** Go sends a GET again after a failure on a reused connection. Its SYN then meets the fault: a reset gives ECONNREFUSED, an ICMP error gives EHOSTUNREACH, and a black hole gives the dial timeout.
- **The server stays out of the way.** The fault cells set `keepAliveTimeout` to 60 s, thus the FIN of the server does not compete with the detection of the cell.
- **A trigger that the harness cannot do waits.** Its reason is in the catalog (`HTTP_WAITING`). Apache HttpClient 5 and the AWS SDK are out of the scope of this step (`HTTP_OUT_OF_SCOPE`).

## The calibration of the proxies

The CAL catalog (`src/calibration.ts`) measures the own time of each proxy: HAProxy as T02 has it, and Toxiproxy with no toxic. Stage 0 measures δ_abs in the same way, on a path with no timer.

- A stream of 100 PINGs goes through the proxy to Redis, with nothing injected (`none`). The concurrency is 1, as for the cells through the proxy.
- Each request gives a time toward the target. It starts at the arrival on the socket of the proxy toward the client. It stops at the write on the socket toward the target. Each reply gives a time toward the client, the other way. The writes are the `tx` records of the prober.
- `PROXY_TIMES` holds the 99th percentile of each direction, by nearest rank. A band through a proxy adds it for each crossing.

## The runner

`CELLS=1 pnpm --filter @systems/cells test` starts the catalogs on `@mark1russell7/harness`. It needs Docker and privileged containers. The names of the cells start with their catalog: `T01`, `T03`, `T02`, `TOX`, `T12` or `CAL`.

- `CELLS_ONLY` selects the cells whose names match a regular expression.
- `CELLS_SHARD=i/n` takes every n-th cell from the i-th. Thus two processes can share the catalog.
- `CELLS_OUT` is the folder of the output (the default is `out/`). Each cell writes its raw record there, in the format that jarvis lands, and one line of its verdict to `summary.ndjson`. The record keeps the warm-up run of each environment apart from the counted runs.

Without `CELLS=1`, only the tests of the catalog start. Each cell has a prediction or the reason that it has none, and the bands agree with the algebra.
