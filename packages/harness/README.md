# @mark1russell7/harness

A fault-injection harness for connection timers. In a cell, a client connects to a stock target in new Docker environments. The harness injects a fault, and it measures what the kernel did. Then the harness judges the measurement against the prediction of the cell.

The harness does not compute predictions. The author of a cell computes the prediction, for example from a timer algebra, and puts it in the cell.

## The cell

A **cell** (`cell.ts`) is all that one measurement needs, as data:

- **The topology.** A stock target image, pinned by digest.
- **The settings.** The sysctls of the client namespace, and the socket options of the client.
- **The workload.** A connection that stays idle, or a connection with a request in flight.
- **The fault.** A black hole, a reset, a frozen process, or a stall.
- **The prediction.** An interval [T_lo, T_hi] after the event that arms the timer, or silence in a window. After a stall, the prediction also tells when the connection recovers.

## The environment

`openLab(target)` (`lab.ts`) builds one environment with Testcontainers:

- A new network and the target.
- A client container that holds its network namespace.
- A privileged sidecar in the namespace of the client, for its sysctls. Docker Desktop keeps `/proc/sys` read-only in a container that operates.
- An injector sidecar in the namespace of the target, with NET_ADMIN. Thus the image of the target stays stock.
- The prober ([`@mark1russell7/prober`](https://www.npmjs.com/package/@mark1russell7/prober)): a privileged container that loads the kernel program and watches the two namespaces. Each run keeps its records from its start to its end. A run whose records the prober lost is void.

Each command is an argv array.

## The images

The harness builds two images. The tag of each image comes from the content of all the files that its Dockerfile reads. The harness copies these files into a new build context, from its own package and from the prober package. Thus the build works in a workspace and from npm.

- **The harness image** (`image/Dockerfile`) has two stages, each a digest-pinned Alpine. `Cargo.lock` pins the crates. The image holds:
  - the kernel program of the prober, compiled against the BTF of the kernel that builds it, and its Rust collector.
  - `client`, the TCP client of a cell. Rust's `std::net` sets no socket option by itself, thus the measurement gets the timers of the namespace. The client also samples `TCP_INFO` each 2 ms, a second vantage on its socket. It waits in `poll()`, which does not lock the socket. A keepalive timer that finds its socket held tries again HZ/20 later.
  - `inject`, which applies a fault in one `iptables-restore` commit, with monotonic stamps around the commit. Thus the start of a fault is known in the VM. A `docker exec` from Windows comes 190 ms late at the median.
- **The Node client image** (`image/node`) is a driver client: ioredis 6.0.0 on Node 24.21.0. The digest of the image and an npm lockfile pin them. `client-ioredis.mjs` prints the lines of the TCP client on the same clock, and it adds the status changes of ioredis as `status` lines.

The build does the `cargo test` of the two crates. Thus the record decoder passes its tests before an image exists. Each amount that the native programs print is a quantity in a canonical unit. For example, an RTO is in `jiffy`, a round trip in `us`, and a segment in `B`.

ioredis sets the keepalive of its socket itself, after it connects. Thus a cell sets the keepalive of a driver through the keepAlive option of ioredis (`probe.driver`). The keepalive sysctls of the namespace do not apply to it.

## The faults

- **A black hole** is DROP rules in the two directions, in the namespace of the peer of the observer. Thus the measurement gets the kernel timers of the observer. For the client, the rules go in the namespace of the target, through the injector. For the server, they go in the namespace of the client, through its admin sidecar. Rules in the namespace of the observer make its sends fail with EPERM, and the kernel records only a retransmission that goes out (`FaultSide`).
- **A reset** is a `REJECT --reject-with tcp-reset` rule in the namespace of the target, for the segments of the client. The next send of the client gets a reset one round trip later. It is the reference fault of the calibration.
- **A frozen process** is the cgroup freezer (`docker pause`), while the kernel stays up.
- **A stall** is a black hole that stops by itself, `Cell.stall` after the send of the request. The run reads the stamp of the client on the send. Then `inject clear PEER --at NS` holds the end in the VM until that instant (`lab.heal`). Thus the latency of a docker exec does not change the length of the stall.

Each run starts from kernels that keep nothing from the run before it (`lab.forget()`). When a connection closes, each kernel keeps TCP metrics for the address of its peer. These metrics set the first round trip of the next connection, and thus its RTO. The harness removes the `tcp_metrics` of the two namespaces before each run.

## The measurement

`measure(cell, run)` (`observe.ts`) reads a run from the records of the kernel:

- **The socket.** The socket of the run is the socket that the client connected from, in its namespace.
- **The time.** It times the detection from the reference event of the prediction to the error report of the kernel. eBPF stamps the two events. For keepalive, the reference is the last received segment. For the give-up, it is the first retransmission of the RTO timer, not the tail loss probe one RTO before it. For a reset, it is the send of the client, which no kernel record marks. The client stamps the send before its write.
- **The other views.** It also gives the same interval from the `TCP_INFO` samples of the client, and the delay before the client saw the error. It also gives the steps of the kernel: each keepalive probe, or each expiry of the RTO timer.
- **Void runs.** A run is void when the timer that drives the measurement was two jiffies or more behind its wheel slot in the timed interval. The wheel does a slot in the tick when it is due. Thus such a firing measured the host, which stopped a vCPU, not the kernel. A keepalive timer that found its socket held also makes the run void. A run whose fault came too late is void too.
- **Findings.** A finding is a wrong errno, a detector that did not fire, or a detection where the prediction is silence.
- **Recovery.** After a stall (`prediction.recovers`), it times the send to the first segment back after the stall stopped. That segment is the answer of the server to the retransmission that got through. A run whose stall stopped outside the window of its prediction is void. A run where nothing came back is a finding.

## The verdict

`verdictOf(prediction, runs)` (`verdict.ts`) judges a cell:

- **Containment.** Each run lands in [T_lo − δ_abs, T_hi + δ_abs]. `NOISE` (δ_abs) is 4 ms, from the calibration: the worst reset took 1.141 ms, and δ_abs is one jiffy at the minimum.
- **Median equivalence.** The order-statistic interval of the median must be in the band, made 5 % wider.
- **Extension.** A median across the edge of the band extends the cell from 11 runs to 22, then 44. Then the verdict is inconclusive.
- **Recovery.** The recovery after a stall gets the same test as a detection, by its band. A detection is then a finding.

The distribution test needs a simulator, which does not exist at this time.

## Runs

- **`runCell(cell)`** (`run.ts`) divides the 11 runs of a cell across two new environments. It records the manifest of each environment, and it removes the fault after each run.
  - The `concurrency` of a cell sets how many environments operate at the same time, each with its own prober.
  - The manifest holds the kernel release, the architecture, the boot id and the Docker version. It also holds the image ids, the packages of the image, the client and the sysctls as read back.
  - A cell whose probe names a `driver` opens its labs with the client of that driver (`openLab(target, "ioredis")`).
  - The harness sets the `targetSettings` of a cell in the target before a client connects, with the `settings` commands of the target (`redis-cli CONFIG SET`, then `CONFIG GET`).
- **The observer.** A cell observes the client, or the server (`observer`). A cell on the server side measures the socket of the target for the connection of the client. The run waits for the error of that socket. `freeze-process` freezes the peer of the observer: the target for the client, the client for the server.
  - A cell on the server side sets the sysctls of the target through `targetSysctls`, with a privileged sidecar in the namespace of the target. That sidecar starts only when a cell asks for it.
  - Its in-flight data is the reply of the server. Thus the client sends `probe.request` first, for example a BLPOP with a timeout, and the fault occurs while the server holds it.
- **`judge(cell, runs)`** (`run.ts`) measures and judges the raw records of a cell with the code at this time. `runCell` uses it during a cell. A holder of raw records can judge them again after a change to `observe.ts` or to the verdict.
- **Testcontainers loads when a lab first opens.** Code that only measures and judges does not load it.

## Installation

```sh
pnpm add @mark1russell7/harness zod
```

A run needs Docker, and privileged containers for the prober and the sidecars. The kernel must have BTF (`/sys/kernel/btf/vmlinux`).

## Tests

`pnpm --filter @mark1russell7/harness test` starts the tests. They measure test records with the shape of real kernel records (keepalive, and the tail loss probe before the retransmissions of the RTO timer). They also test the containment, the median equivalence, the extension and the silence of the verdict.

The cells themselves need Docker and privileged containers. CI does not start them.

`pnpm --filter @mark1russell7/harness build` writes the package for npm into `build/`.
