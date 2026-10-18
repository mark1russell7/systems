# @mark1russell7/machines

The machine documents of the systems program, in one place. Each document is a state machine as data, in the format `mark1russell7.machine/1` of [`@mark1russell7/algebra`](https://www.npmjs.com/package/@mark1russell7/algebra). Each document describes one system at one version, from the source of that version.

## The machine document

A machine document gives the states, events, knobs, timers and transitions of one machine.

- **States and transitions.** A transition goes from one or more states to a state, on one or more events. Each transition can name the file and the line that it comes from (`source`).
- **Events.** Each event has a kind. The kinds are `rx` (a segment in), `tx` (a segment out), `app` (a call of the application), `timer`, `local`, `packet` and `peer`.
- **Knobs.** Each knob has its key in its system, its scope, its unit and its default.
- **Timers.** A timer has a duration over the knobs, the events that arm it and cancel it, and the event that it fires. It can also have a lateness and an early bound.
- **Realizations.** A document can give the time of a mechanism (`realizes`): one of its timers, or a time of its own over its knobs.
- **Layers.** A document can operate on another machine (`over`), as a driver operates on its kernel socket. `over.machine` names the machine below as `systems.machine.<id>`.
- **Sources.** Each document names its sources, and each source has a rung. The rung tells the type of the source:
  - `normative`: a specification, for example an RFC.
  - `implemented`: the code of the system at the version.
  - `documented`: the documentation of the system.
  - `observed`: a measurement of the system.
  - `derived`: a result of other sources.

The algebra reads these documents. It gives the closed form of each timer, the first detector of a failure, and the recovery after a stall.

## The documents

| Export | Identifier | System and version | Layer | Sources, by rung |
| --- | --- | --- | --- | --- |
| `LINUX_TCP` | `linux-tcp` | TCP of Linux 6.6, for kernels from 6.6 to 6.9 | kernel | 4 normative, 7 implemented |
| `NF_CONNTRACK_TCP` | `nf-conntrack-tcp` | The TCP state machine of conntrack on Linux 6.6.87.2 | middlebox | 4 implemented |
| `REDIS_CLIENT` | `redis-client` | One client connection of the Redis 8.10.2 server | server | 3 implemented, 1 documented |
| `IOREDIS_STATUS` | `ioredis-status` | The connection status of ioredis 6.0.0, standalone | driver | 5 implemented |
| `IOREDIS_SENTINEL` | `ioredis-sentinel` | ioredis 6.0.0 in Sentinel mode | driver | 10 implemented |
| `SENTINEL` | `valkey-sentinel` | One Sentinel of Valkey 9.1.2, and the failover that it leads | server | 8 implemented, 1 observed |
| `NODE_HTTP_SERVER` | `node-http-server` | One connection of the `http.Server` of Node 24.21.0 | server | 8 implemented |
| `NODE_HTTP_AGENT` | `node-http-agent` | One socket of the `http.Agent` of Node 24.21.0 | driver | 9 implemented |
| `UNDICI_CLIENT` | `undici-client-h1` | The socket of an HTTP/1.1 `Client` of undici 8.12.2 | driver | 8 implemented |
| `GO_TRANSPORT` | `go-nethttp-transport` | One connection of the `http.Transport` of Go 1.27.2 | driver | 7 implemented |
| `PROCEDURES_WS_CLIENT` | `procedures-ws-client` | The WebSocket client of `@procedures/client` 0.3.0 | driver | 9 implemented, 1 documented |
| `PROCEDURES_WS_SERVER` | `procedures-ws-server` | The WebSocket server of `@procedures/client` 0.3.0 | server | 4 implemented |
| `MONGODB_NODE` | `mongodb-node` | The MongoDB Node driver 7.7.0, for one server of a replica set | driver | 19 implemented |
| `MONGOD_REPL` | `mongod-replication` | The replication of mongod 9.0.4: one member of a replica set | server | 29 implemented |
| `MONGOD_SESSION` | `mongod-session` | One client connection of mongod 9.0.4 | server | 6 implemented |
| `NODE_POSTGRES` | `node-postgres` | node-postgres 8.23.1 with pg-pool 3.14.0: one client of a `pg.Pool` | driver | 30 implemented, 2 documented, 1 derived |
| `POSTGRES_SESSION` | `postgres-session` | One client connection of a PostgreSQL 17.11 backend | server | 40 implemented, 2 documented |
| `HIKARICP_PGJDBC` | `hikaricp-pgjdbc` | HikariCP 7.1.0 over pgjdbc 42.7.13: one connection of a pool | driver | 41 implemented, 1 documented, 2 derived |

Fourteen documents operate on Linux TCP (`over`). Linux TCP, conntrack, the Sentinel and the replication of mongod operate on no other document. The `conditions` of each document give the range where it holds, for example a range of kernels.

The package also gives these parts:

- **`MACHINES`** gives each document by its identifier, for example `MACHINES["linux-tcp"]`.
- **`MANIFESTATIONS`** gives, for each manifestation of a failure, the incoming events that continue to arrive at Linux TCP. A black hole lets nothing through. The kernel of a frozen process continues to send ACKs, thus `rx.ack` arrives.
- **The lateness of a user timer.** A Node timer and a Go timer sleep in `epoll_wait`, and the kernel lets that sleep end late. `nodeTimerLateness`, `NODE_TIMER_EARLY` and `goTimerLateness` give these bounds as expressions over the knobs. `nodeLateSeconds`, `nodeEarlySeconds` and `goLateSeconds` give the same bounds as numbers.
- **The fast timers of undici.** `undiciFastEarly` and `undiciFastLateness` give the bounds of a timer that counts in ticks of `UNDICI_TICK_MS`.

## How a program reads them

Import a document by its name, or find it in `MACHINES` by its identifier. The schema of the algebra examined each document at load, thus a program does not parse it again.

```ts
import { detection, timerOf } from "@mark1russell7/algebra";
import { LINUX_TCP, MACHINES, MANIFESTATIONS } from "@mark1russell7/machines";

const values = (name: string) =>
  ({
    keepidle: { value: 7200, unit: "s" },
    keepintvl: { value: 75, unit: "s" },
    keepcnt: { value: 9, unit: "count" },
  })[name];

timerOf(LINUX_TCP, "keepalive", values).duration; // { value: 7875, unit: "s" }

const blackhole = { name: "blackhole", passes: MANIFESTATIONS["blackhole"] ?? [] };
const idle = { state: "ESTABLISHED", inFlight: false };
detection(LINUX_TCP, idle, blackhole, values).first?.timer; // "keepalive"

MACHINES["ioredis-status"]?.over?.machine; // "systems.machine.linux-tcp"
```

The workspace of this repository uses the source. The npm package holds the build: ES modules, with each JSON document in the JavaScript.

## How a document changes

A document changes only for one of two reasons:

- **A reason from the source.** The change cites a fact of the source at its version: a file and a line, or a section of a specification. The citation goes in the `source` of a transition, a `note`, or a source of the document.
- **A measurement.** A run of the harness refutes a time or a transition of the document. The change names the run, and it adds a source with the rung `observed`.

A change to the version of a system changes its sources too. Each fact of the document then cites the new version.

In this repository, a snapshot of the predictions of the cells (`packages/cells/src/__snapshots__/predictions.json`) shows each prediction that a change to a document moves.

### 0.3.4

- **`hikaricp-pgjdbc`: the start check of the pool.** At its start, the pool tries once, and after a failure it sleeps 1 s (`start_check`). It tries again while `initializationFailTimeout` has not passed, and then the start fails with PoolInitializationException, with the error of the last try. At the default of 1 ms, the start fails after one try and one sleep. The source is HikariPool.java:567-599.
  - The knob `initializationFailTimeout`, the state `start-check` and three transitions are new. No other part of a document changes.

### 0.3.3

- **`hikaricp-pgjdbc`: the slack of poll().** The JDK waits for a read or a connect with a timeout in poll() (NioSocketImpl.java at `jdk-21.0.12+8`). Linux ends the wait of poll() up to 0.1 % of its time late, at most 100 ms (fs/select.c of Linux 6.6). Thus four timers get that lateness with the slack of the JVM: the connect, the SSLRequest, the read timeout and the check.
  - The cells of O13 measured it: a read timeout of 11 s closed its socket up to 11.35 ms late (run 39109649303).
  - The bands of the HikariCP cells with these timers move in the snapshot. No other document changes.

### 0.3.2

- **`hikaricp-pgjdbc`.** HikariCP 7.1.0 over pgjdbc 42.7.13, for one connection of a pool, from the tags `HikariCP-7.1.0` and `REL42.7.13`. The plan of R3 gives most of its PostgreSQL cells to this client.
  - HikariCP reads no idle socket. It checks a connection only at a borrow, after more than 500 ms of idle time, and at its keepalive. The keepalive comes each 96 to 120 s from the creation of the connection, and a use does not move it. Each check is an empty query with a read timeout of 5 s.
  - At the defaults, no timer of pgjdbc bounds a statement or the startup: `socketTimeout` is 0. The connect timeout of 10 s bounds only the TCP connect and the SSLRequest of sslmode `prefer`.
  - An I/O error of a statement is 08006, and HikariCP closes the connection at once. The lifetime of a connection is 22.5 to 30 min. At the defaults the pool has a fixed size of 10, thus its idle timer has no effect.
  - The login timeout that HikariCP gives the JVM does not apply, because pgjdbc reads its own `loginTimeout`, which is 0.
  - No prediction of the snapshot moves.

### 0.3.1

- **PostgreSQL.** Two documents give the first systems of the PG catalog, each from its source at its tag or its npm version:
  - `node-postgres`: pg 8.23.1 with pg-pool 3.14.0. At the defaults, no timer bounds the connect, a checkout from a full pool or a query. The pool removes an idle client after 10 s, and it emits `error` when an idle client fails. No socket of pg has keepalive, and neither package sends a query again.
  - `postgres-session`: a backend of PostgreSQL 17.11 (`REL_17_11`, the image `postgres:17.11`). It turns on SO_KEEPALIVE, and at its defaults the keepalive sysctls of the namespace apply. Each timeout is off at 0. A send to a lost client waits with no timeout, thus the kernel or SIGTERM ends it.

### 0.3.0

- **`linux-tcp`: the delayed ACK.** The timer `delayed_ack` arms on each segment of data (`rx.data`), and each segment that goes out stops it. It waits from `TCP_DELACK_MIN` (HZ/25) up to the smoothed round trip, and `TCP_DELACK_MAX` (HZ/5) at most. The models are `linux.delack` and `linux.delack-lateness` of the algebra 0.7.1.
  - The document realizes the ack delay (`systems.mechanism.ack-delay`): from at once to that wait. The kernel acknowledges at once in quick-ACK mode. Thus a client that sends one request acknowledges its reply at once, and a client of many requests waits.
  - The sources are `include/net/tcp.h`, `net/ipv4/tcp_output.c`, `net/ipv4/tcp_input.c` and `net/ipv4/tcp.c` of Linux 6.6, and RFC 1122 §4.2.3.2.
  - One prediction of the snapshot moves. The WST cell `router silent-drop` loses its bound on the round trip, 405 ms. The cap of 200 ms keeps the forget of the router before the first ping at each round trip.

### 0.2.0

- **The MongoDB documents realize the mechanisms of a reader.** In `mongod-replication`, the heartbeat window is the heartbeat detection time, and the liveness check is the step-down window. In `mongodb-node`, the selection timeout is the client retry window.
- **`redis-client`.** A blocking command holds its client in the state `BLOCKED`. The timer `blocked` gives its reply at its timeout, up to one serverCron tick and 1 ms late. The idle timer arms on the entry to `CONNECTED` and on each read, and it closes the client up to 1 s and one tick late. In 0.1.0 it armed on `accept` only, thus it did not fire at any time.
  - The knob `redis_hz` gives the tick. The sources are `src/timeout.c`, `src/blocked.c`, `src/ae.c` and `src/server.c` of Redis 8.10.2.
- **`off`.** Eight knobs give the value that turns their timers off, each 0. They are `tcp_user_timeout`, Redis's `timeout` and `blocking_timeout`, and two timeouts of Node's server. The MongoDB driver adds `connectTimeoutMS`, `socketTimeoutMS` and `waitQueueTimeoutMS`. Each catalog prediction stays the same.

## Installation

```sh
pnpm add @mark1russell7/machines @mark1russell7/algebra zod
```

The package uses `@mark1russell7/algebra` for the type `Machine` and the schema `machineSchema`. The algebra does not use this package. Both packages use `zod` as a peer dependency.

## Tests

`pnpm --filter @mark1russell7/machines test` starts the tests. They examine each document with the schema and the consistency checks of the algebra. They also compute the algebra on the real documents: the defaults of Linux 6.6, the backoff waits, recovery after a stall, and detection.

`pnpm --filter @mark1russell7/machines build` writes the package for npm into `build/`.
