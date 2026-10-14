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

## The runner

`CELLS=1 pnpm --filter @systems/cells test` starts the catalog on `@mark1russell7/harness`. It needs Docker and privileged containers.

- `CELLS_ONLY` selects the cells whose names match a regular expression.
- `CELLS_SHARD=i/n` takes every n-th cell from the i-th. Thus two processes can share the catalog.
- `CELLS_OUT` is the folder of the output (the default is `out/`). Each cell writes its raw record there, in the format that jarvis lands, and one line of its verdict to `summary.ndjson`.

Without `CELLS=1`, only the tests of the catalog start. Each cell has a prediction or the reason that it has none, and the bands agree with the algebra.
