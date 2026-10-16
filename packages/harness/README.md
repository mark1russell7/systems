# @mark1russell7/harness

A fault-injection harness for connection timers. In a cell, a client connects to a stock target in new Docker environments. The harness injects a fault, and it measures what the kernel did. Then the harness judges the measurement against the prediction of the cell.

The harness does not compute predictions. The author of a cell computes the prediction, for example from a timer algebra, and puts it in the cell.

## The cell

A **cell** (`cell.ts`) is all that one measurement needs, as data:

- **The topology.** A stock target image, pinned by digest, and the hops between the client and the target (`Cell.topology`). Without hops, the client and the target are a direct pair. A replicated group under its Sentinels can replace the target (`Cell.group`).
- **The settings.** The sysctls of the client namespace, and the socket options of the client.
- **The workload.** A connection that stays idle, a connection with a request in flight, or a stream of requests. A stream of `GET` requests for a long value keeps many segments in flight.
- **The fault.** A black hole, a reset, a frozen process, or a stall. In a topology, also a fault at a router or a proxy, or a router that forgets a flow. Also a proxy that closes an idle connection, or a toxic of Toxiproxy.
- **The prediction.** An interval [T_lo, T_hi] after the event that arms the timer, or silence in a window. After a stall, the prediction also tells when the connection recovers. A silent prediction can also tell when the reply comes back (`replies`).
- **The assumptions of the band.** A band can name the range of first round trips that it assumes (`rtt`), and the proxy times that it includes (`through`).

## The environment

`openLab(target, client, topology)` (`lab.ts`) builds one environment with Testcontainers:

- A chain of new networks, and the target on the last network. A direct pair has one network.
- A client container that holds its network namespace.
- A privileged sidecar in the namespace of the client, for its sysctls and its routes. Docker Desktop keeps `/proc/sys` read-only in a container that operates.
- Each hop of the topology, on the network of each of its sides.
- An injector sidecar in the namespace of the target, with NET_ADMIN. Thus the image of the target stays stock.
- The prober ([`@mark1russell7/prober`](https://www.npmjs.com/package/@mark1russell7/prober)): a privileged container that loads the kernel program. It watches the namespace of the client, of the target and of each hop. Each run keeps its records from its start to its end. A run whose records the prober lost is void.

Each command is an argv array.

## The topologies

A topology (`Topology`) is the chain of hops from the client to the target, as data. Each hop is on two networks, one for each side. Network j joins element j and element j + 1: the client is element 0, and the target is the last element.

- **A router** (`RouterHop`) is the router image of the harness. It forwards, and it translates the addresses of the side of the client (NAT) with conntrack. Its idle timeout is `nf_conntrack_tcp_timeout_established`, in whole seconds. The router is privileged, thus it sets the sysctls of its own namespace, and the `sysctls` of its hop. An injector sidecar shares its namespace. Its form (`MiddleboxForm`) tells what a late packet meets after the router forgets the flow:

  | Form | At the expiry | A late packet from inside | A late packet from outside |
  | --- | --- | --- | --- |
  | `reset-both` | a reset to the two ends | dropped | dropped |
  | `reset-next` | nothing | a reset to its sender | dropped |
  | `silent-drop` | nothing | dropped | dropped |
  | `recreate` | nothing | passes, and the flow starts again | dropped |
  | `none` | nothing | passes, and the flow starts again | a reset from the stack of the router |

- **A proxy** (`ProxyHop`) is a stock image, pinned by digest, that ends each TCP connection and opens its own to the next hop. Its files go into it before it starts, and `{{next}}` in them is the address and port of the next hop. An injector sidecar shares its namespace. A privileged sidecar sets its sysctls when the hop names them.

The element before a router reaches the networks after the router through it. Its privileged sidecar, or the router itself, adds each route. A router translates the address of the side of the client, thus the target and each later hop see the router as the peer.

A lookup treats an expired conntrack entry as gone, thus the router forgets a flow at its timeout, to the jiffy. The DESTROY event of the entry waits for the garbage collector or a list of the table. Thus `ctwatch.py` in the router lists the table each `pump` (`PUMP`, 0.1 s by default). A DESTROY then follows an expiry within the pump and two lists of the table.

`LISTING` (20 ms) is the longest list of the table that a prediction assumes. A longer list writes a `pump-slow` line, and a run with one near a detection by a timer of conntrack is void. The `reset-both` form sends its resets on the DESTROY event. Each reset has the sequence number that its end expects. A raw sniffer reads it from the last acknowledgment of that end.

The lines of each router (`Lab.middlebox`) are the conntrack events and the resets that it sent, on CLOCK_MONOTONIC. Each run keeps the lines from its start to its end.

## The groups

A group (`Group`, `Cell.group`) is a replicated group under an external failover authority, as data. It is a primary and its replicas, and the Sentinels that decide which member is the primary. A group cell has no hops, and the group replaces its target.

- **The parts.** Each member and each Sentinel is a container from one stock image, pinned by digest. Each part has its own network namespace, thus a fault can act on one part. The server of each part is the child of a shell. Thus a fin can stop the server, and the container stays up.
- **The data.** The group gives its members, its Sentinels and the quorum. It also gives the settings of each member (`memberSettings`) and of each Sentinel for the group (`sentinelSettings`), for example `down-after-milliseconds`. The first member is the primary when an environment starts.
- **The sidecars.** Each part has an injector sidecar in its network namespace and in its process namespace. Thus the injector can send a signal to the server of the part, with monotonic stamps around the `kill(2)` calls.
- **The client.** The client of each run is ioredis 6.0.0 in Sentinel mode (`client-sentinel.mjs`).
  - It asks the Sentinels for the primary of the group. Then it writes a stream of sequence numbers: `SET w:<n> <n>`.
  - It sends each write when the reply to the write before it came and the interval passed.
  - Each write is a `sent` line, then an `ack` line or a `fail` line. An `ack` line has the address of the server that accepted the write, and a `fail` line has its error.
- **The observer.** A container of its own subscribes to each channel of each Sentinel (`observer.mjs`).
  - Each Sentinel publishes each of its events on a channel with the name of the event. The observer stamps each message on CLOCK_MONOTONIC when it arrives.
  - No fault rule names the address of the observer, thus the timeline stays whole.
- **The prober** watches the namespace of the client. A calibration (`Cell.calibrates` is `sentinels`) makes it watch each Sentinel too.

The roles of a group move: after a failover, a replica is the primary. Thus a fault names a part by its role at the start of a run (`GroupPlace`): `primary`, `replica` or `sentinel`.

Each run of a group cell starts from a group that converged:

- Each Sentinel agrees on one primary with no flag but `master`, and it knows each replica and each other Sentinel.
- Each replica follows that primary with its link up, and the primary has no failover in progress.

The harness then removes each key from the group. After the run, the group converges again, and the keys that it holds tell which writes it kept.

A Sentinel that aborted a failover does not try again for 2 × `failover-timeout`. Thus after a run with an aborted failover, each Sentinel forgets the state of the group (`SENTINEL RESET`). The next run then starts from a group that each Sentinel knows again.

## The clients and the agents

- **A client image** (`ClientImage`, `Cell.client`) replaces the TCP client of the harness in each run. It operates in the namespace of the client. Its command gets the arguments of the TCP client, and it prints the same JSON lines.
- **An agent** (`lab.agent(image, command, { pid })`) is a container in the network namespace of the target. With `pid`, it also shares the process namespace of the target, thus it can signal the server process. Its JSON lines and its `exec` stay available to the caller.

## The images

The harness builds three images. The tag of each image comes from the content of all the files that its Dockerfile reads. The harness copies these files into a new build context, from its own package and from the prober package. Thus the build works in a workspace and from npm.

- **The harness image** (`image/Dockerfile`) has two stages, each a digest-pinned Alpine. `Cargo.lock` pins the crates. The image holds:
  - the kernel program of the prober, compiled against the BTF of the kernel that builds it, and its Rust collector.
  - `client`, the TCP client of a cell. Rust's `std::net` sets no socket option by itself, thus the measurement gets the timers of the namespace. The client also samples `TCP_INFO` each 2 ms, a second vantage on its socket. It waits in `poll()`, which does not lock the socket. A keepalive timer that finds its socket held tries again HZ/20 later.
  - In a stream, a reply of the `client` is whole at its CRLF, or after the length of a bulk string. The client then writes a `replied` line.
  - `inject`, which applies a fault in one `iptables-restore` commit, with monotonic stamps around the commit. Thus the start of a fault is known in the VM. A `docker exec` from Windows comes 190 ms late at the median. With `--via DEV`, the rules go in the FORWARD chain, on the device toward one side.
  - `inject` also sends a signal to a process by its name (`signal`), and one command to a server of the Redis protocol (`resp`). Stamps bracket each.
- **The Node client image** (`image/node`) is a driver client: ioredis 6.0.0 on Node 24.21.0. The digest of the image and an npm lockfile pin them. `client-ioredis.mjs` prints the lines of the TCP client on the same clock, and it adds the status changes of ioredis as `status` lines. The same image holds the client of a group in Sentinel mode (`client-sentinel.mjs`) and the observer of its Sentinels (`observer.mjs`).
- **The router image** (`image/router`) is a digest-pinned Alpine with conntrack-tools, nftables, iproute2 and Python. `mbx.sh` sets the form of the router in one nftables table, `ctwatch.py` writes the conntrack events, and `resetter.py` sends the resets of the `reset-both` form. Each run records its packages in the manifest.

The build does the `cargo test` of the two crates. Thus the record decoder passes its tests before an image exists. Each amount that the native programs print is a quantity in a canonical unit. For example, an RTO is in `jiffy`, a round trip in `us`, and a segment in `B`.

ioredis sets the keepalive of its socket itself, after it connects. Thus a cell sets the keepalive of a driver through the keepAlive option of ioredis (`probe.driver`). The keepalive sysctls of the namespace do not apply to it.

## The faults

- **A black hole** is DROP rules in the two directions, in the namespace of the peer of the observer. Thus the measurement gets the kernel timers of the observer. For the client, the rules go in the namespace of the target, through the injector. For the server, they go in the namespace of the client, through its admin sidecar. Rules in the namespace of the observer make its sends fail with EPERM, and the kernel records only a retransmission that goes out (`FaultSide`).
- **A reset** is a `REJECT --reject-with tcp-reset` rule in the namespace of the target, for the segments of the client. The next send of the client gets a reset one round trip later. It is the reference fault of the calibration.
- **A frozen process** is the cgroup freezer (`docker pause`), while the kernel stays up.
- **A stall** is a black hole that stops by itself, `Cell.stall` after the send of the request. The run reads the stamp of the client on the send. Then `inject clear PEER --at NS` holds the end in the VM until that instant (`lab.heal`). Thus the latency of a docker exec does not change the length of the stall.
- **An ICMP unreachable** (`unreachable`, `Cell.icmp`) answers each segment from the observer with host, net or port unreachable, or admin prohibited. Linux keeps it as a soft error, continues to retransmit, and gives the errno of the ICMP at the timeout. Host and net unreachable also revert the backoff (RFC 6069).
- **A simplex partition** (`simplex`, `Cell.drops`) drops the segments to the server, or the segments to the client, but not both.
- **A FIN** (`fin`) stops the process of the peer with SIGKILL while its kernel stays up. For the client, the target starts its server as the child of a shell (`Target.command`), and `Target.kill` stops it. For the server, the harness stops the container of the client.
- **An MTU black hole** (`mtu-blackhole`, `Cell.mtu`) drops each segment longer than the length, in the namespace that receives it.
- **netem** (`netem`, `Cell.netem`) is tc netem on the egress of the target: loss, duplication, reordering or corruption. The outcome is a distribution. At a hop, netem is on the egress of the device of the hop toward one side.
- **A latency** (`Cell.latency`) is tc netem delay on the egress of the target before the client connects. Thus the round trip and the RTO include it.
- **A fault at a proxy** (`Cell.faultAt`) puts the rules of a fault in the namespace of the proxy, toward the client or toward the target. The rules act on the sockets of the proxy.
- **A fault at a router** (`Cell.faultAt`) puts FORWARD rules in the namespace of the router, through its injector sidecar. A router forwards past INPUT and OUTPUT. Each rule faces one side by the device toward it, and by the address of the peer on that side:
  - A black hole drops what comes in from that side (`-i DEV -s PEER`) and what goes out to it (`-o DEV -d PEER`). A simplex partition drops one of the two.
  - A reset answers each segment from that side with a reset from the router. The reset has the address that the segment went to.
  - An ICMP unreachable comes from the address of the router on that device, not from the peer. Its rate limit is in the `sysctls` of the router.
  - The rules of the fault are in the filter table of iptables. The form of the router is a table of nftables at the same priority. Thus the two can both drop a packet, and an accept of one does not pass a drop of the other.
  - Conntrack sees each packet before a FORWARD rule drops it. Thus a retransmission into a black hole at the router refreshes the flow. The resets of the `reset-both` form leave from the stack of the router, past its own FORWARD rules.
- **No fault** (`none`) injects nothing. A calibration cell measures the path itself (`Cell.calibrates`).
- **A forgotten flow** (`middlebox-forget`) injects nothing. The router of the topology forgets an idle flow at its own timeout. `Cell.idleBefore` holds an in-flight request until after the forget.
- **An idle proxy** (`proxy-idle`) injects nothing. The proxy closes an idle connection at its own timeout.
- **A toxic** (`toxic`, `Cell.toxic`) is one toxic of Toxiproxy, added through its HTTP API by `inject http`, with monotonic stamps around the request. Its name is `fault`, and the harness removes it after the run. A cell whose fault is another one adds its toxic first: a slow close, then the close of the server.
- **A close of the server** (`server-close`) makes the server close the connection of each client, with `Target.close`: `CLIENT KILL` for Redis.
- **A fault on a group** acts on the part that `Cell.faultAt` names by its role:
  - A black hole (`blackhole`) drops each segment between the part and each peer. A reset (`rst`) answers each segment from a peer with a reset, thus the part refuses each connection.
  - A partial partition (`partition`) is a black hole between the part and some of its peers (`GroupPlace.cuts`). `group` cuts the part from the other members and the Sentinels, and `clients` cuts it from the client.
  - The rules for each peer go into one commit. The injector takes a list of peers, `A,B,C`.
  - A frozen process (`freeze-process`) is SIGSTOP to the server of the part, and SIGCONT thaws it. A FIN (`fin`) is SIGKILL, and the server starts again after the run.
  - A planned failover (`planned-failover`) is `SENTINEL FAILOVER <group>` to the first Sentinel, or `SENTINEL FAILOVER <group> COORDINATED` (`Cell.coordinated`). The injector stamps the write of the command and its reply.
  - A fault with a hold (`Cell.hold`) lifts at that time after its commit. The injector waits for that instant in the VM. A stall (`Cell.stall`) lifts at its length after the first write into it.

A length match and netem act on GSO super-packets of up to 64 KB, not on segments, while TSO, GSO and GRO are on. Thus the cells of `mtu-blackhole` and `netem` turn them off on the two ends (`lab.offload`). They also turn them off on the two devices of a hop where the fault is.

Each run starts from kernels that keep nothing from the run before it (`lab.forget()`). When a connection closes, each kernel keeps TCP metrics for the address of its peer. These metrics set the first round trip of the next connection, and thus its RTO. The harness removes the `tcp_metrics` of the two namespaces before each run.

## The measurement

`measure(cell, run)` (`observe.ts`) reads a run from the records of the kernel:

- **The socket.** The socket of the run is the socket of its observer. For the client, it is the socket that the client connected from, in its namespace. In a topology, the address of a hop serves each run. Thus the socket of the target or of a proxy is the socket that became ESTABLISHED in the run (`socketOf`).
- **The time.** It times the detection from the reference event of the prediction to the error report of the kernel. eBPF stamps the two events. For keepalive, the reference is the last received segment. For the give-up, it is the first retransmission of the RTO timer, not the tail loss probe one RTO before it. For a reset, it is the send of the client, which no kernel record marks. The client stamps the send before its write.
- **The other views.** It also gives the same interval from the `TCP_INFO` samples of the client, and the delay before the client saw the error. It also gives the steps of the kernel: each keepalive probe, or each expiry of the RTO timer.
- **Void runs.** A run is void when the timer that drives the measurement was two jiffies or more behind its wheel slot in the timed interval. The wheel does a slot in the tick when it is due. Thus such a firing measured the host, which stopped a vCPU, not the kernel. A keepalive timer that found its socket held also makes the run void. A run whose fault came too late is void too.
- **The first round trip.** The measurement gives the first round trip of the socket of the observer (`rtt`). It is the smoothed round trip in the first record of the socket: the sample of the handshake. A run whose first round trip is above the range of its prediction is void, with the reason `rtt-over-assumption` and the value. Such a run measured another path than the band assumes. For example, a round trip of 4.826 ms makes an RTO of 52 jiffies, and a ladder that assumes 1 ms has 51.
- **Findings.** A finding is a wrong errno, a detector that did not fire, or a detection where the prediction is silence. A router that forgot the flow in the window of a silent prediction is also a finding.
- **A reply.** A silent prediction with `replies` times the send of the request to the first segment with data that comes back. A proxy can acknowledge the request first, with no data.
- **A toxic.** A toxic counts from the start of its commit (`fault`), as the injector stamps it.
- **A topology.** A run in a topology also gives the bytes that the client read after its request, and when a router forgot its flow (`forgot`).
- **Recovery.** After a stall (`prediction.recovers`), it times the send to the first segment back after the stall stopped. That segment is the answer of the server to the retransmission that got through. A run whose stall stopped outside the window of its prediction is void. A run where nothing came back is a finding.
- **An end of file.** A FIN counts from the change of state of the socket of the peer when it closes (`peer-closed`). It ends at the change of the socket of the observer to CLOSE_WAIT. The kernel stamps the two changes.
- **A stream.** In a stream (`probe.mode` is `stream`), the client sends `count` requests. The run keeps the time from each send to the last byte of its reply (`samples`). A record without `replied` lines gives the time to the first data.
- **Reordering.** A measurement-only run also gives what reordering, duplicates and losses did (`reordering`). At the client, it counts the arrivals beyond a hole and the arrivals of data that it had already, against `rcv_nxt`. From the sender, it gives the most SACKed and lost segments, the DSACKs, the fast retransmissions, and the reordering degree and count of the kernel.
- **An arrival is not always one segment.** The segments that arrive while the owner holds the socket wait in its backlog, and the kernel joins the contiguous ones. Thus the kernel counts out-of-order segments (`rcv_ooopack`), and the prober counts arrivals.
- **A proxy's own time.** A calibration cell (`Cell.calibrates`) gives the time of its proxy for each request and its reply (`crossings`). Each time goes from an arrival on one socket of the proxy to its next write on the other socket (a `tx` record).
- **A router that forgets in silence.** A silent prediction can say that the router forgets the flow in a band after the last segment (`Prediction.middlebox`). The run then holds when the forget is in that band and nothing detects it. A missing forget, or one outside its band, is a finding. Without it, the router must keep the flow.
- **A group** (`measureGroup`, `timeline.ts`). The time counts from the start of the commit of the fault, or from the first write into a stall.
  - It ends at the first write that a primary accepted after the fault. That primary is a new one, or the same one after the lift, as the prediction says (`GroupPrediction.lands`).
  - The time of the acceptance is the last segment with data from that primary at the stamp of the client, or before it.
  - **The timeline.** Each stage is the first announcement of its event by any Sentinel, from the fault. The stages are `+sdown` and `+odown` of the primary, `+try-failover` and `+elected-leader`. Then `+selected-slave`, `+promoted-slave`, `+switch-master` and `+convert-to-slave`.
  - **The writes.** The run gives the writes that the old primary accepted after the fault, and the writes that a primary accepted and the group lost. It also gives each write whose outcome the client did not see. The lost writes are the cost of a split brain.
  - **The errors on the way.** The run gives each kind of error that the client met after the fault, with its first time and its count.
  - **Void runs.** A run is void when a Sentinel entered its TILT mode, or when the election split its votes. Both measured another path than the band assumes. A run whose Sentinels reached `+odown` and started no failover is void: the hold-off of an earlier failover stopped them. A band whose hold lifted more than δ_abs late is void too. The rules of the RTT and of a slow commit apply.
  - **The stamps.** A calibration gives the delay of each stamp of the observer after the write of its Sentinel that it read (`lags`).

## The verdict

`verdictOf(prediction, runs)` (`verdict.ts`) judges a cell:

- **Containment.** Each run lands in [T_lo − δ_abs, T_hi + δ_abs]. `NOISE` (δ_abs) is 4 ms, from the calibration: the worst reset took 1.141 ms, and δ_abs is one jiffy at the minimum.
- **Median equivalence.** The order-statistic interval of the median must be in the band, made 5 % wider.
- **Extension.** A median across the edge of the band extends the cell from 11 runs to 22, then 44. Then the verdict is inconclusive.
- **Recovery.** The recovery after a stall gets the same test as a detection, by its band. A detection is then a finding.
- **Measurements.** A cell whose outcome is a distribution (`detects: null`) has no band. Its decision is `measured`, and the verdict gives the median, the 99th percentile and the slowest reply time. It adds the sum of what reordering did, when anything came out of order, twice or SACKed.
- **A reference.** A measurement-only cell that names a reference (`from`) gives the count of each outcome. It also gives the median and the range of the time from the reference. The time ends at the end of the connection, or at the last data.
- **A calibration.** A calibration cell gives the spread of the time of its proxy in each direction (`proxy`). The spread is the count, the median, the 99th and 99.9th percentiles by nearest rank, and the maximum.
- **A reply.** A reply in its band (`replies`) gets the same test as a detection.
- **The time of a proxy.** A band through a proxy includes an upper quantile of the time of the proxy for each crossing (`through`). The author of the cell adds it from a calibration cell, and the verdict tests the band as it is.
- **A group** (`GroupVerdict`). The band of the first accepted write gets the tests of a detection.
  - Each stage that the prediction gives a band (`GroupPrediction.stages`) gets its own containment: [T_lo − δ_abs, T_hi + the error of the stamps + δ_abs].
  - A run that did not announce the stage is outside too. A stage outside its band fails that stage. The decision of the cell stays the decision of its band.
  - The verdict also gives the median of each stage, the lost writes of each run, and the errors on the way.

The distribution test needs a simulator, which does not exist at this time.

## Runs

- **`runCell(cell)`** (`run.ts`) divides the 11 runs of a cell across two new environments. It records the manifest of each environment, and it removes the fault after each run.
  - Each environment does one warm-up before its counted runs. On a loaded machine, a new environment is sometimes slow at first. A reset cell once measured 23 ms against a median of 0.3 ms. The result keeps the warm-ups apart (`warmups`), and the verdict does not count them. A cell whose fault ends its environment, a client `fin`, does a dry warm-up without the fault.
  - The `concurrency` of a cell sets how many environments operate at the same time, each with its own prober.
  - The manifest holds the kernel release, the architecture, the boot id and the Docker version. It also holds the image ids, the packages of the image, the client and the sysctls as read back.
  - A cell whose probe names a `driver` opens its labs with the client of that driver (`openLab(target, "ioredis")`).
  - The harness sets the `targetSettings` of a cell in the target before a client connects, with the `settings` commands of the target (`redis-cli CONFIG SET`, then `CONFIG GET`).
  - A group cell opens a group environment (`openGroupLab`), and each run is `groupOnce`. Its warm-up is a whole run with its fault, because no fault of a group ends its environment. The manifest also holds the settings of each member and of each Sentinel, as each part read them.
- **The observer.** A cell observes the client, the server, or a socket of a proxy toward one side (`observer`). A cell on the server side measures the socket of the target for the connection of the client. The run waits for the error of that socket. `freeze-process` freezes the peer of the observer: the target for the client, the client for the server.
  - A cell on the server side sets the sysctls of the target through `targetSysctls`, with a privileged sidecar in the namespace of the target. That sidecar starts only when a cell asks for it.
  - Its in-flight data is the reply of the server. Thus the client sends `probe.request` first, for example a BLPOP with a timeout, and the fault occurs while the server holds it.
- **The pause before the fault.** In every other run, the fault comes 250 ms after the client's first reply (`QUIET_MS`). That is more than Linux's longest delayed ACK, 200 ms. A fault that comes earlier meets the client's delayed ACK of the reply, not the request or the idle time that the cell measures. On a fast host the fault came 35 ms after the reply, and the ACK met a reset first.
- **`judge(cell, runs)`** (`run.ts`) measures and judges the raw records of a cell with the code at this time. `runCell` uses it during a cell. A holder of raw records can judge them again after a change to `observe.ts` or to the verdict.
- **Testcontainers loads when a lab first opens.** Code that only measures and judges does not load it.

## Installation

```sh
pnpm add @mark1russell7/harness zod
```

A run needs Docker, and privileged containers for the prober and the sidecars. The kernel must have BTF (`/sys/kernel/btf/vmlinux`).

## Tests

`pnpm --filter @mark1russell7/harness test` starts the tests. They measure test records with the shape of real kernel records (keepalive, and the tail loss probe before the retransmissions of the RTO timer). They also test the containment, the median equivalence, the extension and the silence of the verdict.

The tests also measure a group run from test lines. They find the first accepted write, the stages, the writes that the group kept, and the void runs. They test the views that make a group healthy, and the peers that a fault on a part cuts.

The cells themselves need Docker and privileged containers. CI does not start them. `HARNESS_LAB=1` starts the lab tests on Docker. They start a client image and an agent, and they put a reset and netem at a router. They also fail a group of Valkey 9.1 over with a planned failover.

`pnpm --filter @mark1russell7/harness build` writes the package for npm into `build/`.
