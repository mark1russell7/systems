# @systems/cells

The cells of the systems program. A cell is one point of a topology: a fault, a workload, an observer and the settings of the timers. Each cell has the prediction that the algebra gives for it. This package is private, and it does not go to npm.

## The T01 catalog

T01 is the direct pair: a client and a stock Redis 7.4. The catalog (`src/catalog.ts`) crosses these axes, and each axis moves a prediction or tests one:

- **The manifestation.** A black hole, an ICMP unreachable (host, net, port, admin), a simplex drop in each direction, and a FIN. The FIN comes from a process that stopped with SIGKILL. Also a frozen process, a stall, an MTU black hole, and netem on each segment (loss, duplication, reordering, corruption, jitter).
- **The workload.** An idle connection, a request in flight, or a stream of requests.
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
- **A distribution.** Under netem loss, duplication, reordering, corruption or jitter, the reply times are a distribution. These cells have no band. Their runs are measurements, and they keep each reply time for a simulator.

## The T03 catalog

T03 is the stateful middlebox chain: client → NAT router (conntrack) → Redis 7.4 (`src/t03.ts`). The router forgets an idle flow at 5 s. This value is a cloud NAT's 350 s, scaled by 70 through `nf_conntrack_tcp_timeout_established` in the namespace of the router.

- **The key question** is O03 of the ordering law: does the keepalive of the endpoint refresh the router before it forgets the flow? `o03` decides it with the law of `@mark1russell7/service`. The refresh is the `idle-refresh-interval` of Linux TCP, or of Redis, at its latest. The forget is the `middlebox-idle` of the conntrack document, at its earliest. The margin is one round trip and one jiffy.
- **The border.** The keepalive idle time is 4 s on one side of the border and 6 s on the other. A keepalive probe at 4 s refreshes the flow, and the cell is silent for 15 s. A router that forgets the flow in that window is a finding.
- **DV-12's three cases**, when O03 does not hold. A router that resets both ends does it at the forget: the `expire_established` timer of conntrack, late by the pump and two listings at most. A router that resets the next packet answers the first keepalive probe. A router that drops silently leaves the endpoint to its whole keepalive window.
- **The next packet is a request.** After 8 s of idle time, the request meets a reset, the retransmissions to their give-up, or a flow that conntrack picks up again (`ct.none.established`).
- **The server.** The keepalive of Redis (`tcp-keepalive`) meets the reset of both ends, a dropped probe from outside, or the reset of the router's own stack (`none`).

The cells of T03 go one at a time: the listing of a router evicts the expired flows of each namespace.

## The T02 catalog

T02 is the pooled request chain: client → HAProxy 3.2 in TCP mode → Redis 7.4 (`src/t02.ts`). HAProxy ends each connection, thus each leg has its own sockets and its own timers.

- **The idle timeouts of HAProxy** against a keepalive on each side. HAProxy has no machine document, thus these cells are measurement-only.
- **A black hole on each leg, from each side.** Each socket that can detect it is an observer: the client, the socket of HAProxy toward each side, and the socket of Redis. Linux TCP predicts each of them. HAProxy has kernel keepalive on its sockets (`clitcpka`, `srvtcpka`), at 3 s idle and 3 probes 1 s apart.
- **What the client sees** when HAProxy gives up on the server is measurement-only.

## The TOX catalog

The TOX catalog has Toxiproxy 2.12.0 as the subject, between the client and Redis 7.4 (`src/toxiproxy.ts`).

- **Each toxic** gets a cell: latency, timeout, reset_peer, slow_close, bandwidth, limit_data and slicer. Each prediction comes from the semantics that the documentation of Toxiproxy states. A toxic whose documentation gives no time is measurement-only.
- **The close translation.** A reset and a black hole on the upstream connection of Toxiproxy are measurement-only, because Toxiproxy documents no close. The same faults on the direct pair, with iptables or netem, have predictions from the algebra.

## The runner

`CELLS=1 pnpm --filter @systems/cells test` starts the catalogs on `@mark1russell7/harness`. It needs Docker and privileged containers. The names of the cells start with their catalog: `T01`, `T03`, `T02` or `TOX`.

- `CELLS_ONLY` selects the cells whose names match a regular expression.
- `CELLS_SHARD=i/n` takes every n-th cell from the i-th. Thus two processes can share the catalog.
- `CELLS_OUT` is the folder of the output (the default is `out/`). Each cell writes its raw record there, in the format that jarvis lands, and one line of its verdict to `summary.ndjson`. The record keeps the warm-up run of each environment apart from the counted runs.

Without `CELLS=1`, only the tests of the catalog start. Each cell has a prediction or the reason that it has none, and the bands agree with the algebra.
