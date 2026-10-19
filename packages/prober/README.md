# @mark1russell7/prober

An eBPF prober for TCP. It records what the kernel did to each socket, and eBPF stamps each record on CLOCK_MONOTONIC, the clock that all containers on a VM share.

The package has three parts:

- **`bpf/prober.bpf.c`**, in C: a libbpf CO-RE program. The image of [`@mark1russell7/harness`](https://www.npmjs.com/package/@mark1russell7/harness) compiles it against the BTF of the kernel that it operates on.
- **`native/`**, in Rust, on libbpf-rs: the record decoder and the `prober` collector.
- **`src/`**, in TypeScript: the record contract for the readers of the lines of the collector, `KernelRecord` and `RECORD_KINDS`.

## The records

The kernel program records these events:

- Each TCP state change, and the owner of the socket at connect and at accept.
- Retransmissions, resets, error reports and the destruction of a socket.
- TIME_WAIT sockets and request sockets.
- Each keepalive probe or zero-window probe that `tcp_write_wakeup` sends.
- Each segment that an established socket receives (`tcp_probe`).
- Each write of the owner of a socket (`tx`, at the entry of `tcp_sendmsg`), with the first sequence number of the bytes and their length. The time of a proxy is from an arrival on one of its sockets to a write on the other.
- The state of the retransmit timer at each retransmission.
- Each time that the timer wheel fires the keepalive timer or the retransmit timer of a socket (`timer`).

The state of the retransmit timer tells the tail loss probe from the retransmissions of the RTO timer. Only the RTO timer counts toward `tcp_retries2`.

Linux 7.0 moved the two timers of TCP. Before it, the retransmit timer is `icsk_retransmit_timer` of the connection socket, and the keepalive timer is `sk_timer` of the socket. From it, the retransmit timer is `tcp_retransmit_timer` of the socket, and the keepalive timer is `icsk_keepalive_timer` of the connection socket. From 0.3.2, the program names each field through a flavor of CO-RE. Thus it compiles and finds the socket of each timer on either kernel.

Each record with TCP state (`tcp`) also has the SACK scoreboard and the reordering state of the socket, by the names of `tcp_info`:

- **`sacked`** and **`lost`** are the segments that the peer SACKed and that the kernel marked lost.
- **`reordering`** is the reordering degree of the kernel, in segments. It starts at `tcp_reordering`, and it increases when the kernel detects reordering. **`reord_seen`** counts those detections.
- **`dsack_dups`** counts the DSACK blocks that arrived: segments that the peer got two times.
- **`rcv_ooopack`** counts the segments that arrived out of order.

A record of version 0.1 does not have these fields, and it has no `tx` records.

A `timer` record has three more fields:

- **`behind`** is the number of jiffies between the slot of the timer on the wheel and the time that the CPU fired it. The wheel fires a slot in its tick. Thus a timer behind its slot shows a delay of its CPU, for example a vCPU that the host stopped.
- **`late`** is the number of jiffies after the expiry that the owner of the timer set. It is the rounding of the wheel.
- **`owned`** tells that the owner of the socket held the socket when the timer fired. A keepalive timer then sends nothing, and it tries again HZ/20 later.

To find the slot, `timer_expire_entry` keeps, for each CPU, the timer that the wheel fires and its slot. The function of the timer then finds itself there.

Each amount in a record is a quantity in a canonical unit of [`@mark1russell7/quantity`](https://www.npmjs.com/package/@mark1russell7/quantity). An RTO or the delay of a timer is in `jiffy`, a round trip is in `us`, and a segment is in `B`.

## The collector

The Rust crate has two parts:

- The library has the record decoder, which reads the C struct field by field with no `unsafe`. It also has the clock, the quantities and the names of the errno values, which the tools of the harness share.
- The `collector` feature adds the `prober` binary. It loads the kernel program and watches the network namespaces that it gets by inode. It prints each record as one JSON line.

Each second, the collector also prints the clock track and the number of records that the ring buffer dropped.

## The contract, written three times

The C enum that the kernel side stamps, the names of the Rust decoder and `RECORD_KINDS` must agree in sequence. Otherwise, a record reads as the wrong kind. `src/index.test.ts` reads the other two and compares them.

The line of a record is fixed to the byte:

- Its keys are in byte sequence, as serde_json writes each object that it holds.
- An amount is `{"unit":…,"value":N.0}`.
- Strings have the escapes of serde_json.
- A task name that is not UTF-8 decodes as `String::from_utf8_lossy` of Rust decodes it.

## Three collectors

Three collectors load the same `prober.bpf.o` and print the same lines:

- `native/`, Rust on libbpf-rs: the collector that the harness uses
- `go/`, Go on cilium/ebpf v0.22: pure Go, with no cgo, in one static binary
- `c/prober.c`, C on libbpf 1.6

The Go and C collectors are in the repository for the comparison. They are not in the npm package. A decision to keep them or to remove them is open.

Each collector has a `--decode FILE` mode, which reads raw records from a file and not from the kernel. This mode holds the three to one contract:

- `fixtures/records.bin` has 48 raw records, and one record that is cut short. The records have each kind, each optional field, the extremes of each integer, the escapes of JSON and each way to break UTF-8. `src/fixture.ts` makes the file, and its test keeps the committed bytes the same as the output.
- The Rust test compares the writer of the crate with the output of serde, record by record. It also compares the names with the lossy decoder of the standard library.
- The comparison image (`image/Dockerfile`) decodes the fixture with the three collectors. The build stops unless each line is the same, byte for byte.

Then `image/compare.sh` starts the three collectors live in one privileged container. A loopback storm of short connections (`c/storm.c`) gives each record that the life of a connection has.

## The results

These results are from 2026-10-11, on kernel 6.6.87.2 under Docker Desktop, with 16 CPUs. Each collector writes its line by hand into one buffer, and it writes the buffer one time. The first versions did not do this, and that difference was larger than the difference between the languages.

|                                                   | Rust                        | Go                          | C                           |
| ------------------------------------------------- | --------------------------- | --------------------------- | --------------------------- |
| The decoder and the writer alone, on raw records   | 3.34 M a second             | 2.49 M a second             | 3.46 M a second             |
| The three on one storm: the same records          | 39,839                      | 39,839, none different      | 39,839, none different      |
| Alone, 20,000 connections, 3 rounds: records lost | none (0.65–0.78 M a second) | none (0.70–0.75 M a second) | none (0.61–0.67 M a second) |
| CPU for those ≈ 407,000 records                   | 240–330 ms                  | 400–440 ms                  | 260–290 ms                  |
| Peak memory (with the 16 MiB ring)                | 34 MB                       | 85–91 MB                    | 33 MB                       |
| The start: load, verify, attach                   | 1.0–1.1 s                   | 1.0–1.2 s                   | 1.2 s                       |
| Binary                                            | 0.8 MB (libbpf inside)      | 3.6 MB (static)             | 49 KB (and libbpf.so)       |
| A clean release build                             | 20 s                        | 8 s                         | 1 s                         |

- Rust and C have the same cost when they have the same loop. Go uses approximately 50 % more CPU and two times the memory for its runtime. It gives a static binary with no C toolchain.
- The start is the verifier and the attach of the kernel, which are the same in each language.
- The first versions show the cost of the loop. With serde, which made a map for each record, Rust dropped a third of the records of a heavy storm. Go made and sorted an object for each record, and it dropped more than half. C used `fprintf` one time for each field. It kept up with a slower storm only, and it dropped up to a quarter of a faster storm.

To start the comparison again, use this command:

```sh
LOOM_PROBER_COMPARE=1 pnpm --filter @mark1russell7/prober exec vitest run src/compare.test.ts
```

The test holds what does not change with the load of the host. These are the bytes, and the same records with none lost under a light storm. It prints the numbers of the heavy storm.

## Installation

```sh
pnpm add @mark1russell7/prober zod
```

The package uses `@mark1russell7/quantity`, and `quantity` uses `zod` as a peer dependency. Thus the application installs `zod`. The npm package has the kernel program, the Rust crate and the fixture, thus an image can compile them from `node_modules`.

## Tests

- `pnpm --filter @mark1russell7/prober test` compares the contract in C, Rust and TypeScript, and it holds the fixture to its generator.
- `cargo test --features collector` in the build of the image of the harness tests the record decoder. It also tests the names of tail loss probes, RTO retransmissions and fast retransmissions.
- The cells of [`@mark1russell7/harness`](https://www.npmjs.com/package/@mark1russell7/harness) measure each interval from these records. The `TCP_INFO` samples of the client agree with them within one sample, and a run with records that the collector dropped is void.
