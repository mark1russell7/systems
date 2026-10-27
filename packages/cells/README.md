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

`predict` asks `@mark1russell7/algebra` for each cell. The machine documents come from `@mark1russell7/machines`, and the snapshot `src/__snapshots__/predictions.json` holds the prediction of each cell of each catalog. A change that moves a prediction changes its line of the snapshot.

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

- **The idle timeouts of HAProxy** against a keepalive on each side. `HAPROXY_TCP` gives each timeout, and a keepalive probe resets neither of them.
  - `timeout server` sends a FIN to the client at once: 4.989 s to 5.011 s after the last data.
  - `timeout client` sends a FIN to Redis first. The FIN to the client follows the FIN of Redis, and `REDIS_CLIENT` does not give that FIN. Thus this cell stays measurement-only.
- **A black hole on each leg, from each side.** Each socket that can detect it is an observer: the client, the socket of HAProxy toward each side, and the socket of Redis. Linux TCP predicts each of them. HAProxy has kernel keepalive on its sockets (`clitcpka`, `srvtcpka`), at 3 s idle and 3 probes 1 s apart.
- **What the client sees** when HAProxy gives up on the server is measurement-only. `HAPROXY_TCP` gives no event for an error of the socket toward the server.

## The TOX catalog

The TOX catalog has Toxiproxy 2.12.0 as the subject, between the client and Redis 7.4 (`src/toxiproxy.ts`).

- **Each toxic** gets a cell: latency, timeout, reset_peer, slow_close, bandwidth, limit_data and slicer. Each prediction comes from the semantics that the documentation of Toxiproxy states. A toxic whose documentation gives no time is measurement-only.
- **The time of Toxiproxy.** The documentation states no time of its own. Thus each band adds the time of Toxiproxy for each crossing (`through`). A request crosses toward the target, and a reply or a close toward the client. Each time is the 99th percentile of its calibration cell.
- **The close translation.** A reset and a black hole on the upstream connection of Toxiproxy are measurement-only, because Toxiproxy documents no close. The same faults on the direct pair, with iptables or netem, have predictions from the algebra.

## The T12 catalog

T12 is a replicated group under an external failover authority: clients → three Sentinels → a primary and two replicas, all Valkey 9.1.2, quorum 2 (`src/t12.ts`). The client is ioredis 6.0.0 in Sentinel mode, at its defaults, with a stream of writes. The name of each cell starts with the cell of the plan that it stands for, for example `T12.defaults.6`.

- **Two machine documents** of `@mark1russell7/machines` give the timers. Comments cite each fact by its file and line.
  - `SENTINEL` is the Sentinel of Valkey 9.1.2, from `src/sentinel.c` at that tag. It gives the tick, the ping period, down-after, the asks, the election, the promotion and the conversion.
  - `IOREDIS_SENTINEL` is the Sentinel path of ioredis 6.0.0. It gives the reconnect ladder, the connects that each ask a Sentinel, and the give-up of the offline queue.
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
- **The documents.** Each system has a machine document from its source at its version, in `@mark1russell7/machines`: `NODE_HTTP_SERVER`, `GO_TRANSPORT`, `NODE_HTTP_AGENT` and `UNDICI_CLIENT`. Each fact has its file and its line. The settings that a cell gives are in `src/http/settings.ts`.
- **The lateness of a user timer.** A Node or Go timer sleeps in `epoll_wait`. The kernel lets that sleep end late by a slack: the remaining time divided by 1000, at most 100 ms (`nodeTimerLateness` and `goTimerLateness` of `@mark1russell7/machines`). Thus the 6 s keep-alive timer of the Node server can fire 7 ms late.
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
- **The border of O01.** The plan gives O01 a margin of 0.26 s at S = 6 s. The documents give a margin of a few milliseconds: the lateness of C, the handling time, the early bound of S and the round trip. Thus the cells on each side of the border of the plan predict no race.

### The handling time

Each band of a client counts from the last segment of the reply that the kernel of the client received (`last-received`). A Node client arms its pool timer later, on its event loop, after the program read the whole reply. The time between them is the handling time (`HANDLING` in `race.ts`).

- **Where each client arms its timer.** The agent arms its free socket timer in its handler of the `free` event. The socket emits `free` on the next tick after the end of the response (`lib/_http_client.js:1017-1051`, `lib/_http_agent.js:201-265`). undici arms its keep-alive timer in `resumeH1`. A `setImmediate` after the parse of the reply starts that function (`lib/dispatcher/client-h1.js:842-846`, `:1151-1154`).
- **No source bounds it.** It is the time of the program. Each run of a cell starts a new client process, thus each race meets the first reply of a process. That reply starts code for the first time. In run 38931350785, the first reply took 1.5 ms to 9.7 ms to the `ready` line of the program. The second reply took less than 1.3 ms.
- **The calibration.** The cells `CAL agent` and `CAL undici` give the client a pool timer of 1 ms against a hint of 6. The timer fires after its arm. Thus each time from the last segment to the FIN of the client is more than the handling time of its run. Four copies of each cell go to four runners, because the CPU of a runner changes the handling time.
- **The bound.** `HANDLING` is the largest time that the calibration counted. The two CI calibrations 38974653161 and 38975675034 gave 88 counted times for each client, on eight runners with six types of CPU. The agent had a median of 4.977 ms and a maximum of 6.73 ms. undici had a median of 7.844 ms and a maximum of 11.182 ms. The reader `handling.test.ts` reads the records of a calibration and gives the spread.
- **What it changes.** The handling time goes on the high bound of the pool expiry and of the gap of a Node client. A client with no reuse closes at its decision, in the handling time. The orderings of the race stay the same. Go handles its first reply in less than 0.71 ms, thus it gets no handling time.
- **The bands that it repairs.** The CI run 38931350785 refuted four bands, each by the handling time:

| Cell | The band before | What the runs showed | The band with the handling time (HZ 1000) |
| --- | --- | --- | --- |
| `T01.border-off.124` undici, a GET 5.95 s after the reply | [5.898, 5.9079] s | 8 of 11 runs above the band and δ_abs, by up to 0.95 ms. The `ready` line came 5.9 ms to 6.5 ms after the last segment, and the timer arms after it. | [5.898, 5.919082] s |
| `T01` undici, a GET 4 s after the reply | [2.998, 3.005] s | 4 of 11 runs above the band and δ_abs, by up to 1.4 ms. | [2.998, 3.016182] s |
| `T01` undici, a hint of 2 (no reuse) | [0, 0.001] s | 1 run at 5.7 ms. undici closes in the parse of the reply, 4.2 ms to 5.7 ms after the last segment. | [0, 0.011182] s |
| `T01` agent, a hint of 1 (no reuse) | [0, 0.001] s | Each run inside the band and δ_abs. But the interval of the median, [4.19, 4.76] ms, is above the band, thus the verdict fails. | [0, 0.00673] s |

The CI run 38976874040 tested the 13 race cells of the Node clients and the 8 CAL cells with these bands, and each one holds. Its CAL cells stay below `HANDLING`: 6.263 ms for the agent, and 9.022 ms for undici.

### The faults

Each prediction of a fault composes the document of the client, or of the server, over Linux TCP (`stackedDetection`). Thus the keepalive of Go or the `keepAliveMsecs` of the agent is the keepalive of the kernel.

- **A timer of the client can come first.** At its defaults, Go closes an idle connection at C (90 s), before its keepalive window ends (165 s). Thus a black hole behind an idle Go connection gives no error.
- **A new try meets the fault.** Go sends a GET again after a failure on a reused connection. Its SYN then meets the fault: a reset gives ECONNREFUSED, an ICMP error gives EHOSTUNREACH, and a black hole gives the dial timeout.
- **The server stays out of the way.** The fault cells set `keepAliveTimeout` to 60 s, thus the FIN of the server does not compete with the detection of the cell.
- **A trigger that the harness cannot do waits.** Its reason is in the catalog (`HTTP_WAITING`). Apache HttpClient 5 and the AWS SDK are out of the scope of this step (`HTTP_OUT_OF_SCOPE`).

## The cells of the keyed limiter

These cells (`src/limiter.ts`, SYS-28) put a real client against the 429 of the keyed limiter of `@mark1russell7/service`. They give the pairs of the laws O29 and O30 at the defaults of each client. O29 bounds the longest Retry-After by the retry window of the caller. O30 bounds the delay of a retry from below by the longest Retry-After.

- **The target.** The `http.Server` of Node 24.21.0 over the keyed limiter of service 0.6.0 from npm (`targets/service-limiter/`). The harness builds the folder, and an npm lockfile pins it. The limiter is a sliding window of one take in a window for each key.
- **The check of the declaration.** Before it listens, the server lints its declaration with O29 and O30 (`declaration.mjs`). The target does not know its callers, thus each rule gives `depends` and names the symbol of the caller. The side of the limiter is its window in whole seconds. Each other finding stops the server, thus the cell fails. A test applies the same check to each cell on the service of the workspace.
- **The version in the records.** The name of each cell has the MAJOR and the MINOR of the service (`LIMITER_SERVICE`). The line `listening` of the target has the whole version and the findings of the check.
- **A pair of versions.** The input `pair` of `cells.yml` compares two versions of the service on demand, for example `0.5.6,0.6.0`. For each version, the job copies the target with that version in `package.json`. It makes each lockfile from the registry as it was at one time, the same for each shard. The cells of the control come first, then the cells of the candidate in the same order (`limiterPair`). If the count of shards divides the count of selected specs, the two cells of a spec operate on one runner, one after the other.
- **The check in a pair.** Only the candidate checks its declaration. The control starts with `--lint off`, because an older version can lack that `lint()`. The server reads its spec from `spec.mjs`, which does not import the service.
- **The first pair.** The record of 0.5.6 against 0.6.0 is `packages/site/src/data/limiter-pair-2026-10-27.json`. It has no detectable shift. The ROADMAP (SYS-28) gives its table and its caveat.
- **The key.** Each client sends a key of its process (`limiter-key`). Thus the first request of a run takes the one unit, and the second request meets the 429. Its Retry-After is the time until the first take leaves the window, in whole seconds, rounded up.
- **The clients.** The `RetryAgent` of undici 8.12.2 at its defaults, a `Client` of undici, and the `Transport` of Go 1.27.2. The two last send nothing again: the caller gets the 429 at once (O29.3, O29.4).
- **The documents.** The bands come from the timer `oldest` of `SLIDING_WINDOW_MACHINE` (service) and the timer `retry_after` of `UNDICI_RETRY` (machines). The agent waits the Retry-After, capped at 30 s, late by the slack of its Node timer and the handling of the refusal (`retryPlan`).
- **The borders.** A Retry-After of 30 s holds O30 (O30.1), and one of 60 s sends each retry 30 s early (O30.2). Five retries of 30 s are the window of the agent. Thus 150 s holds O29 at its border (O29.1), and 151 s ends with `UND_ERR_REQ_RETRY` (O29.2).
- **Each retry.** Each retry counts from the refusal before it (the reference `last-reply` of the harness). It can go on a new connection, because undici closes an idle socket 3 s after a reply of a Node server at its defaults.
- **The names.** The plan of R3 does not have these laws yet, thus each cell takes the name of its law and a number. A cell of the plan for the same pair becomes an alias when the corpus of the law gets these pairs.

## The WS catalog

The WS catalog has the WebSocket client and server of `@procedures/client` 0.7.0 on a direct pair (`src/ws.ts`). The client is the harness client `procedures-ws`, and the server is a script in its image. Each cell gives each setting of the client and of the server.

- **0.7.0 against the documents of 0.3.0.** The cells operate 0.7.0. The documents stay at 0.3.0 until `@mark1russell7/machines` 0.3.0 is on npm. The code that they read is the same in 0.7.0, at these lines of `dist/adapters/websocket`:
  - The heartbeat of the client is `startHeartbeat` (`client/transport.js:394-414`), on `heartbeat()` of `@mark1russell7/service` 0.4.1. The build of service 0.4.1 is the build of 0.4.0.
  - The drop is `dropConnection` (`client/transport.js:320-339`): `terminate()` when the class has it, else `close()`. 0.7.0 leaves an empty error handler on the socket (`detach`, `:90-95`), and 0.3.0 left none.
  - The reconnect is `reconnectDelay` (`client/transport.js:136-143`) and `scheduleReconnect` (`:372-388`). The time limit of the handshake is at `:244-253`, and a failed handshake drops at `:302-306`.
  - The heartbeat of the server is `beat()` (`server/transport.js:94-112`), on one `setInterval` from the start of the transport (`:147-151`). A pong sets the misses to 0 (`:241`).
  - 0.7.0 adds a `seq` to each stream frame, and a keep-alive to an NDJSON stream of HTTP. A call of these cells is no stream, and the cells use no HTTP transport.
- **The class of the sockets.** Since 0.4.0, the root entry keeps the global `WebSocket`. The Node entry `@procedures/client/node` uses the `WebSocket` of ws (`client/node.js:27-31`). The client of the harness takes the transport of the entry of its class, and the image holds one copy of ws.
- **The documents** (`PROCEDURES_WS_CLIENT` and `PROCEDURES_WS_SERVER` of `@mark1russell7/machines`) are the client and the server of 0.3.0, from the files of the release and of `@mark1russell7/service` 0.4.0. Each fact has its file and its line.
  - The states and the events come from the document of the client repository at commit 1f50f47 (`WEBSOCKET_CONNECTION_MACHINE`). The timers come from the code of 0.3.0.
  - The heartbeat of the client is `heartbeat()` of the service. It sends a ping only when no pong is awaited, and `misses` misses in sequence drop the connection. With one miss, the drop comes one timeout after the ping that got no answer.
  - The reconnect waits min(initialDelay × multiplier^(n − 1), maxDelay) before try n, less its jitter. The cells set the jitter to 0. The algebra reads the wait with `pow` (`@mark1russell7/algebra` 0.6.0).
  - A drop of a socket of the global `WebSocket` writes a close frame and destroys nothing. Thus the kernel stamps the drop as a write, and the socket stays ESTABLISHED below. A socket of the `WebSocket` of ws ends at once with `terminate()`.
  - undici turns keepalive on with 60 s, and libuv adds 1 s and 10 probes. The ws package turns no keepalive on. Thus the keepalive sysctls of the namespace do not reach the socket of the client.
  - The heartbeat of the server pings each connection at each beat of a `setInterval`. It ends a connection after `misses` beats without a pong: `misses` beats after its first ping without an answer.
- **The lateness of a timer of the program.** Each timer of the program is a Node timer, with the lateness of `nodeTimerLateness`. That is the slack of `epoll_wait`, the truncation of the loop clock to 1 ms, and the step of the coarse clock. The early bound is the truncation and the step. The time of the loop in other callbacks is the time of the application, and δ_abs holds a small part of it.
- **The handling of a drop.** The kernel stamps a drop at its act: the write of a close frame, or the close of the socket. That act comes after the program handled the firing of its timer. Thus the high bound of each drop by a heartbeat adds `DROP_HANDLING` of the harness (1.5 ms).
  - In 585 drops with a close frame in CI, the write came up to 1.017 ms after the `drop` line. Before, only δ_abs (1 ms) held that time.
  - The band of a drop after a pong timeout of 1 s is 0.999 s to 1.0035 s at HZ 250, and 0.998 s to 1.0045 s at HZ 1000. The slowest of 495 timed runs took 1.003761 s.
  - The bands of the kernel, of a reset and of a FIN do not change.
- **The claims.** Each cell gives each knob of Linux TCP at the observer too.
  - A black hole, idle or with a call in flight, and a frozen server: the heartbeat drops the connection one pong timeout after its ping. The kernel of a frozen server acknowledges the ping, thus only the heartbeat finds it.
  - The drop of each class. The global `WebSocket` writes a close frame, and its socket stays ESTABLISHED. With the `WebSocket` of ws, the socket leaves ESTABLISHED at once.
  - The end of the client process. The harness ends the client after its last try, and the kernel then closes each socket that is still open. Each client cell with a drop says so (`exits`), thus that close is no close by the program.
  - In the CI records of WS and WST, the global `WebSocket` did not close its socket in any run. With no close frame of the peer in reply, the socket stayed open until the process ended, 0.52 s to 0.545 s after the drop. The `WebSocket` of ws closed its socket 0.3 ms to 1 ms after the drop. The CI run 39045185957 shows it with the flag.
  - At `tcp_retries2` = 8 the kernel gives up 102.2 s after its first retransmission, and the keepalive of undici waits 60 s. Thus the heartbeat comes first.
  - A stall of 1 s: the retransmission after the stall moves the ping, and the pong comes back before the timeout of 3 s. Nothing drops.
  - A reset and a FIN: the kernel tells the client at once. The reconnect then waits its backoff: 0.5 s, then 1 s and 2 s after each refused try.
  - Where the timer of the kernel is shorter, the kernel wins: the give-up at `tcp_retries2` = 3 comes before a pong timeout of 10 s. A client without a heartbeat waits for the keepalive of undici: 70 s.
  - The heartbeat of the server at 1 s and 2 misses drops a silent client 2 s after its first ping without an answer. Without the heartbeat, a silent client stays, and only the kernel finds it with a reply in flight.

## The WST catalog

The WST catalog has the client and the server of the WS catalog through a topology (`src/ws-topologies.ts`). Each cell gives each setting of the client and of the server, as the WS catalog does. Only the cells of the server give the server a heartbeat.

- **The router of T03.** The router forgets an idle flow at 5 s. The key question is O03 of the ordering law: does the heartbeat refresh the router before it forgets the flow?
  - The ping timer realizes the idle refresh in `PROCEDURES_WS_CLIENT`. Each tick writes a ping, whatever data the connection carries, and the pong comes back.
  - `o03Ws` decides O03 with the ping at its latest, against the forget at its earliest. The keepalive of the socket class is a refresh too, but undici waits 60 s.
  - A heartbeat of 4 s keeps the flow, and the cell is silent for 15 s. A router that forgets the flow in that window is a finding.
  - With a heartbeat of 6 s, the router forgets the flow before the first ping. The heartbeat counts from the open, and `FIRST_REPLY` (0.5 s) bounds the first request.
- **What the client sees** with a heartbeat of 6 s:
  - `reset-both`: a reset at the forget, 5 s to 5.131 s after the last reply at HZ 1000. The band includes the delayed ACK of the client after that reply.
  - `reset-next`: the ping meets a reset from the router, in one round trip.
  - `silent-drop`: the ping goes into nothing, and the pong timeout drops the connection 1 s after the ping.
  - Then the reconnect waits 0.5 s. Its SYN makes a new flow, and each form lets a SYN through.
- **HAProxy of T02**, in TCP mode, on the port of the procedures server. Each ping and its pong is data on the two legs.
  - `HAPROXY_TCP` gives a timer to each side. Only bytes reset it, thus a keepalive probe refreshes nothing. O03 reads the earlier timeout as the forget of the middlebox (`forgetterOf`).
  - A heartbeat of 4 s against 5 s on each side keeps the connection, and the cell is silent for 15 s.
  - With a heartbeat of 6 s, `timeout server` of 5 s sends a FIN to the client at once. The band is 4.989 s to 5.011 s after the last data (`haproxyIdle`).
  - With a heartbeat of 6 s, `timeout client` of 5 s sends a FIN to the server. The server of ws answers with its own FIN (`ps.peer-end`), and then HAProxy sends a FIN to the client. Thus the band gets one round trip and one step of HAProxy more.
  - Then the reconnect waits 0.5 s, as after the FIN of the server in the WS catalog.
- **A black hole on each leg of HAProxy.** The heartbeat detects each one, 1 s after the ping.
  - On the client leg, nothing comes back.
  - On the target leg, the kernel of HAProxy acknowledges the ping, as the kernel of a frozen server does. Thus only the heartbeat finds it.
- **The ws class through each hop.** The cells above use the global `WebSocket`. Each one has a twin with the `WebSocket` of ws, the default class of `@procedures/client/node` (`the ws class`).
  - The ws class sets no keepalive, thus only the heartbeat refreshes a flow at the router. O03 gives the same verdicts, because the keepalive of undici waits 60 s.
  - The bands are the bands of the global `WebSocket`. A drop by the heartbeat closes the socket at once with `terminate()`, where the global `WebSocket` writes a close frame.
- **The heartbeat of the server through the router of T03.** The client has no heartbeat and no reconnect, and the server is the observer.
  - Each beat pings each connection, and the WebSocket of the client answers with a pong. Thus a beat refreshes the flow.
  - `PROCEDURES_WS_SERVER` realizes no idle refresh. Thus the refresh of O03 is its heartbeat timer at one miss: one interval, with the lateness of one Node timer (`beatOf`).
  - A beat each 4 s keeps the flow, and the cell is silent for 15 s. A router that forgets the flow in that window is a finding.
  - With a beat each 6 s, the router forgets the flow before the next beat. Then the ping from outside meets the form of the router.
  - `reset-next` drops the ping. The heartbeat drops the connection 2 beats after it: 11.996 s to 12.016 s at HZ 1000.
  - `none` answers the ping with a reset from the stack of the router, in one round trip.
- **The reference of a beat.** One `setInterval` of the server beats for all connections, from the start of the transport. No document gives the phase of a beat after the accept. Thus each band of the server counts from its first ping without an answer.
  - A beat before the forget refreshes the flow. Thus that ping comes at most one forget and one beat after the reply: 11.14 s at HZ 1000 (`startsBy`). The run waits for it.
  - No cell has `reset-both` with a beat each 6 s. That reset comes at the forget, and a ping can refresh the flow after the reply.
  - The harness counts a forget from the last segment before the reply. Thus it has no reference for that cell.
- **The lines of the server.** A line of the server names the connection by its peer. Behind the router, the peer is the address of the router. The harness 0.11.1 reads that peer from the socket of the server.

The cells of WST go one at a time, as the cells of T03.

### What the runs in CI showed

The CI dispatches 38993929671 and 38993943667 did each cell of WST 11 times, on runners at HZ 1000 with a δ_abs of 1 ms. Each cell with a band holds in the two dispatches.

- **The router.** With a heartbeat of 4 s, no router forgot a flow in 22 runs. With 6 s, the router forgot each flow 5.042 s to 5.098 s after the last reply.
- **The delayed ACK.** The Node client delays its ACK of the last reply, thus each forget came 42 ms or more after that reply. The TCP client of T03 does not: its router forgot each flow 4.999 s to 5.045 s after the reply. The band of T03 ([5, 5.09] s) has no term for the delay. Thus 4 of the 22 resets of WST are later than that band and δ_abs.
  - Linux gives the reason. The first data of a socket starts quick-ACK mode, and the kernel acknowledges at once. A send within the ACK timeout after a receive starts ping-pong mode, which stops the quick ACKs. The TCP client sends one request, thus it acknowledges its reply at once. The Node client sends its upgrade, then its frames, thus it delays its ACK.
  - Linux TCP's document gives the two cases as one time, the ack delay (`systems.mechanism.ack-delay`). It is 0 to max(`TCP_DELACK_MIN`, srtt), at most `TCP_DELACK_MAX`, plus the rounding of the wheel: 0 to 41 ms at HZ 1000 on the runner.
  - The idle bands of T03, MongoDB's T03 and WST take that term (`ackDelay`). Thus the reset of both ends at 5 s is [5, 5.131] s at HZ 1000. In flight, the last segment is a retransmission and no ACK follows it, thus that band takes no term.
- **What the client saw.** `reset-both` reset the client 5.046 s to 5.094 s after the last reply. `reset-next` reset the ping 0.087 ms to 0.131 ms after its write. `silent-drop` dropped the connection 1.001 s to 1.003 s after the ping.
- **Void runs.** 4 of the 22 runs of `silent-drop` are void: the retransmit timer of the ping was 2 to 4 jiffies behind its slot.
- **HAProxy.** A heartbeat of 4 s kept each connection for 15 s. At 6 s, HAProxy closed the connection with a FIN 5.0002 s to 5.0022 s after the last reply, for `timeout client` and for `timeout server`.
- **A black hole on a leg of HAProxy.** The heartbeat dropped the connection 1.001 s to 1.003 s after the ping, on each leg.
- **The reconnect.** In each cell, each wait of the reconnect was 0.499 s to 0.502 s, in its band. The first SYN came 0.502 s to 0.511 s after the detection.

### What the runs of 0.7.0 in CI showed

The CI dispatches 39070231927 and 39073727730 did each cell of WS and WST 11 times on 0.7.0, at HZ 1000 with a δ_abs of 1 ms. Each cell of WS and each cell of the global `WebSocket` in WST holds again, or is measured, in the two dispatches.

- **The ws class.** Each twin holds, or is measured, where its cell of the global `WebSocket` is. After a drop by the heartbeat, `terminate()` closed the socket 0.53 ms to 0.93 ms after the drop line.
- **A forget behind the ws class.** `reset-both` reset the client 5.0026 s to 5.0909 s after the last reply. In one run, the client acknowledged the reply at once, thus the forget came 2.6 ms after it.
- **The heartbeat of the server.** A beat each 4 s kept each flow for 15 s in 22 runs. With a beat each 6 s:
  - `reset-next`: the heartbeat dropped the connection 11.9998 s to 12.0119 s after the first ping without an answer, in 17 counted runs.
  - `none`: the reset came 0.073 ms to 0.15 ms after that ping.
- **The failure of the first dispatch.** It waited 10 s for the band of `none`, which is 1 ms wide. In 3 of 11 runs, a beat refreshed the flow before the forget, and the next beat was due at 10.6 s. The client process ended first.
  - The second dispatch waits for the latest ping (`startsBy`), and each of its 11 runs detected it. In each one, a beat refreshed the flow first.
- **Void runs.** In the second dispatch, 5 of 11 runs of `reset-next` are void. The retransmit timer of the ping was 2 to 7 jiffies behind its slot. That ping stays in flight for 12 s, thus its timer fires more times than in a cell of the client.

## The calibration of the proxies

The CAL catalog (`src/calibration.ts`) measures the own time of each proxy: HAProxy as T02 has it, and Toxiproxy with no toxic. Stage 0 measures δ_abs in the same way, on a path with no timer.

- A stream of 100 PINGs goes through the proxy to Redis, with nothing injected (`none`). The concurrency is 1, as for the cells through the proxy.
- Each request gives a time toward the target. It starts at the arrival on the socket of the proxy toward the client. It stops at the write on the socket toward the target. Each reply gives a time toward the client, the other way. The writes are the `tx` records of the prober.
- `PROXY_TIMES` holds the 99th percentile of each direction, by nearest rank. A band through a proxy adds it for each crossing.

## The environments of stage 0

Stage 0 measures δ_abs in each environment: the latency of the pipeline on a path that has no timer. `src/environments.ts` holds each runner image that it calibrated, by `$ImageOS $ImageVersion`.

- The runner gives each cell the δ_abs of its image (`Cell.noise`), when the cell gives none. A band and the rule of a late timer read it.
- The pairing of a program line with its kernel record reads the window of its run (SYS-25). That window is δ_abs, or the jitter bound that the run measured when it is longer. Each line of `summary.ndjson` gives that bound and window as `pairing`: `noise`, `bound`, `delta`, and `widened`, the count of runs with a longer window.
- The image `ubuntu24 20261012.334.1` has a δ_abs of 1 ms: the worst reset took 0.147 ms at HZ 1000. Its concurrency cap is 4.
- A cell on an image that stage 0 did not calibrate keeps 4 ms, the δ_abs of the first environment. A new image gets its calibration before its cells get a smaller δ_abs.

## The MongoDB catalogs

The MongoDB catalogs (`src/mongo/`) put the Node driver `mongodb` 7.7.0 on Node 24.21.0 against replica sets of mongod 9.0.4 (`mongo:9.0.4`, pinned by digest). T01 and T03 use a set of one member, because the monitor of the driver needs a set. T11 uses a set of three members. Each cell has the identifier of the cell of the plan that it stands for.

The machine documents of `@mark1russell7/machines` come from the source at the pinned versions, and each fact names its file and line:

- **The driver** (`MONGODB_NODE`). The monitor streams `hello` and writes a silent server off after `connectTimeoutMS + heartbeatFrequencyMS`: 40 s at the defaults. A timeout of the monitor clears the pool and interrupts each operation in flight. An end of the stream by the kernel does not interrupt it. A retryable operation retries one time, after a new selection of `serverSelectionTimeoutMS`. Each socket gets `setKeepAlive(true, 120000)`, thus keepalive at 120 s and 10 probes 1 s apart.
- **The replication of mongod** (`MONGOD_REPL`). A member sends a heartbeat each 2 s, and a window of 10 s without an answer marks the target DOWN. A secondary starts an election 10 s after its last contact with the primary, plus an offset of less than 1.5 s. A primary steps down when it cannot see a majority for 10 s. A new primary waits in its catch-up for an answer or a failure from each other member.
- **The sync source of a secondary** (`MONGOD_REPL`). A secondary keeps a silent primary as its sync source until its oplog fetcher gives up, 17 s to 18 s after the fault:
  - The exhaust read times out at 10 s. This timeout is `SO_RCVTIMEO`, a kernel timer, thus the timer wheel makes it up to 512 ms late at HZ 1000.
  - The fetcher makes one new cursor after 5 ms, and that cursor times out at 7 s.
  - The reporter of the secondary keeps a `replSetUpdatePosition` to the silent primary for its network timeout of 30 s. It sent it at the last batch, or at its keepalive 5 s later. Until the command ends, a new primary learns the position of that secondary only from the response to each heartbeat, each 2 s.
- **The connections of mongod** (`MONGOD_SESSION`). `mongod` lowers the keepalive idle time of each socket to 300 s and its interval to 1 s. Thus its window is 309 s at the Linux defaults. An awaitable `hello` answers after `maxAwaitTimeMS`, which the driver sets to `heartbeatFrequencyMS`. The source gives no bound for the lateness of that wait, thus the document assumes 20 ms. In CI, it was 1 ms to 10.6 ms.

The predictions compose these documents:

- **T01 and T03** (`single.ts`). The driver's document goes over Linux TCP on each socket: the monitor's socket and the pool's socket. The first detection on the monitor's socket is the write-off, or the kernel's keepalive when its delay is shorter. The operation in flight then fails, and its retry selects again. With one member, the selection times out while the fault holds. Each band counts from an event of one socket, the fault, or the start of the client.
- **An ICMP unreachable stops the monitor's stream** (`single.ts`). The client's ACKs do not get to the server, and each ICMP is only a soft error on the client's socket. The RTO of the server fires before its next reply, and its window of one segment holds that reply. Thus one reply gets to the driver, `heartbeatFrequencyMS` after the monitor's request. The write-off comes 40 s after that reply: 50 s after the request.
- **T03, a forgotten flow** (`t03.ts`). O03 decides each flow of the driver against the router: the pool connection by its keepalive, the monitor by its heartbeat or its keepalive. The border cells divide each timer of the chain by 20. The defaults stage keeps each preset at its own idle timeout. The idle time of the router counts from the last segment of the flow.
  - That segment is the client's ACK of the last reply. Its delay is the ack delay of Linux TCP's document: at once in quick-ACK mode, else up to max(`TCP_DELACK_MIN`, srtt), 40 ms on a fast path.
- **T11, the timeline** (`model.ts`, `t11.ts`). The stages are the first member that marks the primary DOWN, the start of the election and the win. Then come the end of the catch-up and the first write of the new primary. Then the client finds the new primary, and its first write lands. When the old primary is silent to the client, that write lands at the driver's write-off. The catch-up has two modes: the window to the old primary that is open at the win, or a new window of 10 s.
- **T11, the first write** (`landingOf`). A write with w majority on the new primary waits for the other secondary. The first write has two modes:
  - `chained`: the other secondary syncs from the new primary already, and the write lands in a round trip.
  - `direct`: the other secondary syncs from the old primary. It takes the new primary only when its fetcher gives up, and the new primary learns its position at the response to a heartbeat. Thus each write waits up to 2 s, until the reporter of that secondary ends its command at 30 s to 35 s.
  - The harness counts the first write that the client sends after the commit of the fault. The write in flight at the commit can go out before it, thus the counted write can be the second write.
- **A step-down** can make the other secondary wait one heartbeat. The step-up of the new primary ends the cursor of a secondary on it. The new primary is not ahead of that secondary until the next write. A member with no sync source sends its heartbeats each 500 ms, and it takes the new primary at the next one.

The defaults stage starts in real time. A cell whose trigger the harness cannot do, or whose breakpoint names another system, waits with its reason (`*_WAITING`). A cell of the plan that is the same as another cell is an alias (`*_ALIASES`).

The client of these cells is the MongoDB client of the harness (`image/mongo/client-mongo.mjs`), with its npm lockfile. It writes the lines of the TCP client of the harness. It also writes each socket of the driver by its role, and the events of the driver's monitor and pool. Each try of an operation gets a line, with its server.

`harness.ts` gives each MongoDB cell as a cell of the harness (`MONGO_CELLS`):

- **T01 and T03.** The target is a set of one member (`MONGO_ONE`). Its setup starts the set with the address of the member and waits until it accepts writes. A freeze stops `mongod` with SIGSTOP, with stamps, and a hold thaws it.
- **The bands of the driver.** Each band names the socket of its reference and the line of the client that ends it. The first band is the band of the cell, and each other band is a later band of the driver (`then`). A band of an errno ends at the report of the kernel on its socket.
- **A stall** is the stall of Linux TCP, from the catalog of T01. The pool's socket carries the write through it.
- **T11.** The cell has a replica set of three members (`replicaSetOf`), at the defaults of mongod 9.0.4 with the settings of the cell. The stages of a member include an error of 2 ms in their stamps. The wall clock of mongod and of the client is in whole ms.
- **A partial cut** holds for 40 s. Its prediction names the stages that must not come (`quiet`): an election of another member, and the write-off of the old primary.
- **The cache.** Each member starts with a cache of 0.25 GB for WiredTiger (`SERVER_ARGS`), thus three members fit on one runner. No timer reads the cache.

### What the runs in CI showed

The first CI pass of the 58 cells refuted 7 of them. The log lines of the members and the kernel records of the client gave each cause:

- **No election took a second round.** In each run of T11, the dry run won, and the real vote won at once. The late first writes came after the election.
- **The other secondary.** In 5 to 11 runs of each 11, it synced from the old primary. Its first write on the new primary then waited 6 s to 8 s, and each later write approximately 2 s, until 35 s.
- **`catchUpTimeoutMillis` 0** ends the catch-up at the win. It does not shorten the wait for the other secondary.
- **An unreachable host.** In each run, the monitor wrote the server off 50.004 s to 50.015 s after its request.
- **A step-down.** In one run of 11, the other secondary had no sync source for 500 ms, and the first write waited for it.
- **A forgotten flow.** The router reset the flow 42 ms to 95 ms after the last reply, thus each run had the delayed ACK in it.

## The T07 catalog

T07 is the endpoint lifecycle of a Service in kind (`src/t07.ts`, on `@mark1russell7/kind`). A client on each node sends a request each 20 ms, each on a new connection to the ClusterIP. The server is the service of this repository, as a Deployment of 2 replicas on 2 workers.

- **The question** is O04 with the hold of the service. The listener of a leaving pod stays open for its preStop sleep and its hold of `fail readiness`. A connection fails when the rules of its node select the pod after that.
- **The client timeout** is 2 s (`T07_WORKLOAD` in `src/kind.ts`). The kernel sends a SYN or a SYN-ACK again after 1 s (`TCP_TIMEOUT_INIT`), and the timer wheel adds up to 64 ms. With a timeout of 1 s, the client stopped before that retransmission. With 2 s, one lost segment does not fail a request, and a kernel record shows the retransmission with its port.
- **The calibration** (`CAL.T07.<mode>`) deletes a pod with a preStop sleep of 10 s. Each node gives its propagation: the time from the deletion to the first poll of its rules without the pod. `PROPAGATION` in `src/kind.ts` holds the shortest and the longest time for each mode.
- **The deletion pair**, in each mode. With the hold of the design (2 s), `lint()` finds that O04 holds, and nothing fails. With no hold, O04 is violated. Then a refused connection can start only between the stop of the intake and the propagation.
- **The rolling update.** The Deployment deletes each old pod some milliseconds after kube-proxy syncs for a new ready pod. Then kube-proxy waits `minSyncPeriod` (1 s) from the end of that sync to the next sync. Thus the rules drop the old pod up to 1.105 s after its deletion (`afterSync`). The hold of 2 s is longer, thus O04 holds. In CI, the drops came 0.215 s to 1.077 s after the deletion.
- **The pause pair**, in each mode: kube-proxy on one node stops with SIGSTOP 0.5 s before a deletion, for 5 s. With the hold of 2 s, the clients of that node meet failed connections until that node syncs. A connection is refused while the pod is alive, and it gets no answer when the address of the pod is gone. With a hold of 8 s, nothing fails.
- **A stale entry of a SYN.** A connection with no answer leaves its entry in the state SYN_SENT for 120 s (`SYN_SENT` in `src/kind.ts`). A later connection from the same source port goes through that entry to the old address, and it times out. The kernel gives the ports of the client in a sequence (RFC 6056, algorithm 4), thus a port comes back in the 120 s. The cluster keeps its entries from one run to the next.
- **The prediction of a pause cell** thus opens its window 122 s before the stop of the intake. It closes the window 122 s after the sync. That time is the life of the entry and the client timeout. It still holds each failure to the paused node, at least one, and the last one after the sync.
- **The stale ports in CI, with a client timeout of 1 s.** The records of the dispatch 38939322660 have 108 failures outside the window. Each one was a timeout on the paused node. A timeout of an earlier window used its port 10.7 s to 84.1 s before. Conntrack keeps an entry after a hit, thus 7 of 95 ports failed two times. IPVS expires its entry at the first hit (`ip_vs_core.c`), thus each of its 40 ports failed one time.
- **The stale ports in CI, with 2 s.** In the dispatch 38976696189, iptables and nftables gave 61 failures outside the window, 9.2 s to 61.5 s after a timeout on the same port. IPVS drops the first SYN on a stale entry, and it expires the entry (`ip_vs_core.c`, lines 1997–2028). Then the retransmission of the SYN goes to a live pod. Thus 10 stale ports of IPVS got a slow answer, and no failure came outside the window.
- **A lone timeout, a finding.** In iptables mode, one request can time out while the rules of its node select only live pods. The CI run of 2026-10-16, with 1 s, had 4 in 115,481 requests of iptables, in `CAL.T07.iptables` too. Thus `T07.border-off.68` and `T07.defaults.23` failed. ipvs and nftables had none.
- **The lone timeout is not a lost segment.** With 2 s, two lone timeouts came between runs, in `T07.defaults.9` and `T07.defaults.25`. The kernel sent each SYN again after 1 s, and the retransmission also got no answer. Thus a state of the path for that port stops the connection, not a loss.
- **The cause of the lone timeout stays open.** The client names the port of a failed request only. Thus the lines do not show an earlier connection on that port. The cells can fail again on such a timeout.
- **The other triggers** use the mode of their cell of the plan: a rolling update, a scale-in, a node drain and a crash. A liveness restart operates with and without the coupling of liveness to readiness.

## The T18 catalog

T18 is a health-gated fleet in kind (`src/t18.ts`): 3 replicas behind a Service, and each one needs Redis 7.4. The round trip of the Redis client gates readiness.

- **A fault of Redis** fails each replica, and the Service has no endpoint. The band is the latch (`failSpan`), then 3 probes of the kubelet 10 s apart, then the propagation. At the defaults, that is 28 s to 48.1 s for a Redis that refuses, and to 50.1 s for a silent one.
- **The faults** are a reset, a frozen Redis, a black hole, and a Redis that goes away without a close. A declaration whose round trip gates nothing stays ready, degraded.
- **Liveness.** A liveness that the runtime couples to readiness restarts each replica 28 s to 50 s after a black hole. Without the coupling, no replica restarts.
- **The stall** of the event loop of one replica removes that replica 21 s to 31 s after its start, and the propagation follows.
- **A rolling update while Redis has no endpoint** does not continue until Redis is back.
- **A throttle** of `cpu.max` is measured: the quota bounds the stall in each period, not the CPU that the replica needs.

Kubernetes keeps its timers in real time, thus these cells are not compressed.

## The S2 cells: how callers learn that a pod cannot serve

The S2 cells (`src/callers.ts`, `CALLERS_CELLS`) measure the dimension "how callers learn that a pod cannot serve". One replica of 2 cannot serve for 30 s: a flag file fails its route with 503 and its readiness check (`cannot-serve`). The cells measure when the callers stop getting errors, and how many requests fail.

- **Three candidates, one cell.** `S2.T07.<mode>.endpoints` (A) keeps each connection open, thus the endpoints alone tell the callers. `S2.T07.<mode>.lame-duck` (B) is the service as it is: its edge sends `Connection: close` while it is not ready. A and B differ only in the field `lameDuck` of the declaration.
- **C on HTTP/2.** `S2.T07.<mode>.goaway` (C) is B on an edge of HTTP/2 without TLS: the field `protocol` is `h2c`. While the service is not ready, the same transport sends GOAWAY on each session. A client of HTTP/2 opens one connection to an origin, thus C has one session for each client (`MULTIPLEXED`). C is one more value of the candidate, not a new family of cells.
- **D: C with the session check.** `S2.T07.<mode>.session-check` (D) is C, and each client checks its session (`CHECKED`). The check is `sessionCheck` of `@mark1russell7/service/http-client`, with `keepalive_time` 0.5 s and `keepalive_timeout` 0.5 s (`SESSION_CHECK`). A stream timeout closes its session, and so does a PING with no ACK. The server of D is the server of C.
- **E: B with the shared gate** (`src/gate.ts`, `GATE_CELLS`). E is B on the design with Redis, with `sharedGate` of the declaration. The readiness probe of the kubelet leaves out each check of Redis, because each replica shares it. The second signal is the declaration: no replica can tell alone if its peers fail too. The cells are an S6 candidate, measured in three incidents:
  - `S2.T07.<mode>.shared-gate.dependency` and `S2.T07.<mode>.shared-gate.flapping`: the black-holed and the flapping shared dependency. No replica leaves the Service, thus E has the bands of A (`gateDependencyOf`). The first failure can come up to 39 ms after the fault (`FAULT_LAG`).
  - `S2.T07.<mode>.shared-gate`: a pod that cannot serve, where the gate must not hurt. The flag fails a check of no dependency, thus E has the bands and the removal of B (`gateCannotServeOf`).
  - Kind run 40533209929 held each of the 9 cells in 3 of 3 runs. E failed 4,325 to 4,729 requests by the median run in the shared dependency, and B failed 4,126 to 4,452. Thus the gate did not cut the failures of B by 50 %, and it stays in the kind lab (S6.md).
- **Keep-alive clients** (`KEEP_ALIVE`, 8 connections for each client). kube-proxy selects a backend only for a new connection, and an established flow keeps its conntrack NAT. Thus a client with a new connection for each request cannot tell the candidates apart. In `ipvs`, a graceful delete sets the weight of the backend to 0, and its open connections stay.
- **Each mode from one definition** (`CALLERS_MODES`). The mode is only a parameter of the cell: `iptables`, `ipvs` and `nftables`, each with its calibrated propagation (`PROPAGATION`). The mode changes only the end of the window of the lame duck.
- **The smallest scenario.** T07 with 2 workers, 2 replicas, and the readiness probe of the chart (2 s, 3 times).
- **The predictions** (`learnWindow` of `@mark1russell7/kind`). B ends 8 s after the fault at the earliest: the latch, the probe, the propagation and one turn of 160 ms. Its latest end is 24.265 s in `iptables`, 24.469 s in `ipvs` and 24.239 s in `nftables`. A ends up to 6.16 s after the heal in each mode: the recovery of the readiness and one turn. C has the latch and the removal of B, and a turn of 20 ms on one session. Thus it ends 140 ms earlier than B at the latest: 24.125 s, 24.329 s and 24.099 s.
- **The expected failed requests** (`expectedFailures`). Each connection on the target fails one request in each turn of 160 ms. Thus the count follows the connections on the target at the fault (`targetConnections`).
  - IPVS selects the backends in turn (`SELECTION`), thus 12 of the 24 connections go to the target. A expects 2,250 to 2,712, and the lame duck 600 to 1,350.
  - The rules of iptables and nftables select at random, thus the count of connections is binomial. The band of 7 to 17 has a chance of 95 % at the least. A expects 1,313 to 3,842, and the lame duck 350 to 1,913.
  - The run 40358038728 had 8 to 16 connections on the target in these two modes. Each why text and the site give the expected count.
  - C has 3 sessions in all, and each session on the target fails 50 requests each second until the latch. The band is 0 to 3 sessions in each mode. At random, a run has no session on the target with a chance of 1/8. In turn, the first pick of each node is not known. C expects 0 to 2,700.
  - C has the mean of B: an eighth of the connections, each with 8 times the requests. Its band is wider, because a client on the target fails each of its requests, and a client on the other replica fails none.
  - A run of C with no session on the target has no failure, thus the prediction of C is not `certain`.
  - D has the window and the count of C, because the target answers each stream at once. Thus the session check closes no session before the GOAWAY.
- **A partitioned pod** (`S2.T07.<mode>.<candidate>.partition`). The same cells, with a black hole between the clients and the target for 22 s (`PARTITION_HOLD`). The trigger is `blackhole` with `partition`, in the namespace of the target only. The kubelet probes from the node, thus the readiness and the endpoint stay, and B is the same as A. `partitionOf` gives each prediction:
  - A and B: each connection on the target fails one request at its timeout, then a new connection picks again. The failures are negative binomial at random (12 to 39), and 21 to 24 in turn. The last one starts up to 2.24 s after the fault at random, and 0.64 s in turn.
  - C: a session on the target fails each stream until the first retransmission after the heal. `recovery` of the algebra gives the time of that retransmission, from the timer of TCP on a kind node (`KIND_TCP`). Thus the last failure starts 23.479 s to 26.988 s after the fault.
  - D (`checkedOf`): the PING of the check closes the first session on the target 0.98 s to 1.5 s after the fault. That is before the stream timeout of 2 s. A next session on the target does not connect, and the check closes it 1 s after its first stream. The picks are those of A and B, on 3 sessions. In turn, 0 to 228 requests fail, and the last one starts up to 1.5 s after the fault. At random, 0 to 534 requests fail, and the last one starts up to 11.7 s after the fault.
- **A stalled pod** (`S2.T07.<mode>.<candidate>.stall`). The same cells, with the event loop of the target blocked for 12 s (`STALL_HOLD`). This is a gray failure: the kernel accepts each connection, but the app and its probes do not answer. The trigger is `app-stall`. `stallOf` gives each prediction:
  - The readiness probe fails at its timeout, thus the target leaves the rules 5 s to 7.309 s after the fault (`stallRemovalBand`). The watchdog of the service fails one check, thus the service stays ready and sends no signal in band.
  - The hold is longer than the latest removal and than the idle close of the server (6 s). It is shorter than the first restart by the liveness probe (21 s).
  - A and B: the picks of a partition (`picksOf`). The last pick of a chain comes before the earliest removal, thus the removal changes nothing.
  - C: a session on the target fails each stream at its timeout until one timeout before the resume, 9.98 s to 10 s after the fault. At the resume, the server closes each quiet session with GOAWAY, and the client sends each stream again.
  - D: the session check of a partition (`checkedOf`). A next session on the target connects, but its PING gets no ACK. The removal ends each chain, thus the last failure starts up to 8.105 s after the fault at random.
- **A failed prober** (`S2.T07.<mode>.<candidate>.prober`). The cells of a pod that cannot serve, with the flag `serves` on the trigger. The flag file then fails only the readiness check of the target, and its route still serves. Thus each removal is false. `falseOf` gives each prediction, as a departure (`leaves`) with a window of the failed requests:
  - The latch of the check trips 8 s to 18 s after the fault. Then the controller of the service is not ready, and the service refuses each request with a 503.
  - The kubelet and the propagation remove the target 12 s to 24.309 s after the fault (`removalBand`), with each candidate.
  - A: each connection on the target stays open. Thus each request on it fails from the trip until the readiness of the service recovers, up to 6.16 s after the heal.
  - B, C and D: each refusal closes its connection, and the next connection picks a backend. A chain of picks of the target ends at the first pick of the other replica. The target answers each stream at once, thus D is the same as C.
- **A black-holed shared dependency** (`S2.T07.<mode>.<candidate>.dependency`). The cells of a pod that cannot serve, on the design with Redis (`DESIGN_REDIS`), where the round trip of Redis gates readiness. A black hole comes between Redis and each replica for 27 s (`DEPENDENCY_HOLD`). The trigger is `blackhole` with no `partition`. `dependencyOf` gives each prediction, as an empty Service (`removal`) with a window of the failed requests:
  - Each request needs Redis, thus each request fails from the fault until the callers recover. Before the latch of a replica trips (8 s to 20 s), each request on it fails slowly. Then the service refuses each request at once with a 503.
  - The kubelet and the propagation remove both replicas 12 s to 26.309 s after the fault (`removalBand`). Then the Service is empty, for each candidate.
  - The hold is longer than the latest removal. The client of Redis connects again in its retry window of 30 s.
  - A: each connection stays open, thus A recovers when the readiness of the service recovers, up to 9.26 s after the heal.
  - B, C and D: the lame duck closes each connection, and the empty Service refuses each new one. Thus they recover only when the kubelet and the propagation add the replicas again, up to 11.57 s after the heal.
  - The time until callers know is the start of the last slow failure before the heal, 7.98 s to 22 s after the fault.
- **A flapping dependency** (`S2.T07.<mode>.<candidate>.flapping`). The cells of the shared dependency, with the black hole 3 times in one run (`FLAP_FAULTS`). Each fault holds for 27 s (`FLAP_HOLD`), and a rest of 15 s comes after each heal (`FLAP_REST`). The trigger has these as `flaps`, and the span of the faults is 111 s. `flappingOf` gives each prediction:
  - Each fault has the bands of the shared dependency, with the corrections of its run. The failed requests of a run have 3 times the band of one fault (`each`).
  - A knows at the latch, 7.98 s to 22 s after each fault. B, C and D fail slowly until each heal, 24.98 s to 27.5 s after each fault. Their last failure can start up to 2 s before the heal.
  - The removal checks the empty Service after each fault, and a ready Service with its backends at each later fault.
  - The rest is longer than the latest recovery after a heal. Thus each fault starts from a steady state.
- **A lost zone** (`S2.T07.<mode>.<candidate>.zone`). The cells of a pod that cannot serve, on a cluster with a zone label on each node. The last worker is the only node of zone-b, and the zone spread puts one replica on it. The clients are only in zone-a (`ZONE_CLIENTS`). The trigger `zone-loss` drops each packet on the link of that node and freezes its cgroup for 70 s (`ZONE_HOLD`). `lostZoneOf` gives each prediction, as a departure (`leaves`) with a window of the failed requests:
  - The node lifecycle controller removes the target when the lease of the node expires. The bands come from the defaults of Kubernetes v1.37.0 (`NODE_LIFECYCLE`): a grace of 50 s, a monitor period of 5 s and a renew interval of 10 s. Thus the target leaves the rules 39.6 s to 55.559 s after the fault (`nodeLossBand`).
  - The hold is longer than the latest removal, and shorter than the toleration of 300 s. Thus no pod is evicted. The target is ready again 0 s to 26.85 s after the heal (`nodeReturnBand`).
  - A and B: the picks of a partition (`picksOf`), on the connections of 2 clients. The last pick of a chain comes before the earliest removal, thus the removal changes nothing.
  - C: a session on the target fails each stream until the first retransmission after the heal (`crossingOf`). The heal comes between the 8th retransmission (51 s) and the 9th (102.2 s).
  - D: the session check of a partition (`checkedOf`), on 2 clients.
  - Each run starts only when the lost node is ready for the node lifecycle controller, with no taint of the last loss.
- **A slow dependency** (`S2.T07.<mode>.<candidate>.slow`). The twin of the black-holed shared dependency, with the same rest and hold (`SLOW_HOLD`, 27 s). The trigger `latency` delays each packet that Redis sends by 300 ms (`SLOW_DELAY`), with `tc netem` on the link of the Redis pod. The heal sets the delay to 0 ms, waits `NETEM_DRAIN`, then removes the qdisc. `slowOf` gives each prediction, as `stays` with a window of the failed requests or `none`:
  - The delay is longer than the turn of a connection of HTTP/1.1 (160 ms), and shorter than each bound of a check. Thus no replica leaves the Service, and no request is refused.
  - A and B: the queue of each connection grows, thus each request fails at its timeout from 0.96 s to 2.24 s after the fault. The last failure starts 1.74 s to 2.02 s before the heal.
  - C and D: each stream waits for Redis on its own, thus no request fails. D hears a frame in each tick and sends no PING.
  - Kind run 40521784305 held each of the 12 cells in 3 of 3 runs. The last failure of A and B started 1.70 s to 1.73 s before the heal, in the noise of the judge but after its band.
- **The scores of S6** (`src/scores.ts`, `scoreCallers`). The function gives each candidate of each mode a score on each criterion of S6, from one copy of a kind run for each incident. A score is `measured`, `bounded`, `derived` (a value of the code, for example 0 PINGs) or `not measured`. A measured score has the prediction next to the values, and each score names its run and its cell. A criterion that the copy cannot support gives its reason and no number. The script `packages/site/scripts/scores.ts` writes the scorecard that the kind page shows.

## The runner

`CELLS=1 pnpm --filter @systems/cells test` starts the catalogs on `@mark1russell7/harness`. It needs Docker and privileged containers. The names of the cells start with their catalog: `T01`, `T03`, `T02`, `TOX`, `T12`, `CAL`, `WS` or `WST`. The name of a MongoDB cell starts with its cell of the plan, for example `T11.defaults.9`, and it names `mongodb-node-7.7`.

- `CELLS_ONLY` selects the cells whose names match a regular expression.
- `CELLS_SHARD=i/n` takes every n-th cell from the i-th. Thus two processes can share the catalog.
- `CELLS_OUT` is the folder of the output (the default is `out/`). Each cell writes its raw record there, in the format that jarvis lands, and one line of its verdict to `summary.ndjson`. The record keeps the warm-up run of each environment apart from the counted runs.

`KIND_LAB=1 pnpm --filter @systems/cells test` starts the T07 and T18 catalogs in kind. Each group of cells with one kube-proxy mode gets two new clusters in sequence. Each cluster does its share of the 11 runs of each cell. `KIND_ONLY` selects cells by their names, and `KIND_OUT` is the folder of the output (the default is `out/kind/`). CI starts the kind catalogs on the runners of GitHub (`.github/workflows/kind.yml`), with `KIND_SHARD=i/n`, and not on a shared machine. `KIND_JUDGE=<folder>` judges the downloaded records again with the cells as they are at this time.

Without `CELLS=1`, only the tests of the catalog start. Each cell has a prediction or the reason that it has none, and the bands agree with the algebra.
