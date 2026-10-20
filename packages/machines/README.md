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
| `UNDICI_RETRY` | `undici-retry-agent` | One request through a `RetryAgent` of undici 8.12.2 | driver | 7 implemented, 1 normative |
| `GO_TRANSPORT` | `go-nethttp-transport` | One connection of the `http.Transport` of Go 1.27.2 | driver | 7 implemented |
| `PROCEDURES_WS_CLIENT` | `procedures-ws-client` | The WebSocket client of `@procedures/client` 0.3.0 | driver | 9 implemented, 1 documented |
| `PROCEDURES_WS_SERVER` | `procedures-ws-server` | The WebSocket server of `@procedures/client` 0.3.0 | server | 4 implemented |
| `MONGODB_NODE` | `mongodb-node` | The MongoDB Node driver 7.7.0, for one server of a replica set | driver | 19 implemented |
| `MONGOD_REPL` | `mongod-replication` | The replication of mongod 9.0.4: one member of a replica set | server | 29 implemented |
| `MONGOD_SESSION` | `mongod-session` | One client connection of mongod 9.0.4 | server | 6 implemented |
| `NODE_POSTGRES` | `node-postgres` | node-postgres 8.23.1 with pg-pool 3.14.0: one client of a `pg.Pool` | driver | 30 implemented, 2 documented, 1 derived |
| `POSTGRES_SESSION` | `postgres-session` | One client connection of a PostgreSQL 17.11 backend | server | 41 implemented, 2 documented |
| `HIKARICP_PGJDBC` | `hikaricp-pgjdbc` | HikariCP 7.1.0 over pgjdbc 42.7.13: one connection of a pool | driver | 41 implemented, 1 documented, 2 derived |
| `PGBOUNCER_CLIENT` | `pgbouncer-client` | PgBouncer 1.26.1 in transaction pooling: one client connection | proxy | 30 implemented |
| `PGBOUNCER_SERVER` | `pgbouncer-server` | PgBouncer 1.26.1 in transaction pooling: one server connection of a pool | proxy | 27 implemented, 1 observed |
| `PGPOOL_SESSION` | `pgpool-session` | Pgpool-II 4.7.3 with one backend: one session of a client in its child process | proxy | 16 implemented |
| `SUPAVISOR_CLIENT` | `supavisor-client` | Supavisor 2.9.13 in transaction mode: one client connection | proxy | 16 implemented, 1 observed |
| `SUPAVISOR_SERVER` | `supavisor-server` | Supavisor 2.9.13 in transaction mode: one server connection of the pool of a tenant | proxy | 10 implemented, 1 observed |
| `AMQPLIB` | `amqplib` | amqplib 2.2.0: one connection to an AMQP 0-9-1 broker, its heartbeat and an RPC of its channel | driver | 18 implemented, 1 documented |
| `RABBITMQ_CONNECTION` | `rabbitmq-connection` | RabbitMQ 4.3.6: one connection of AMQP 0-9-1 on the broker | server | 14 implemented, 1 documented |
| `ATEN_DETECTOR` | `aten` | aten 0.6.0: one node that the failure detector of another node of RabbitMQ watches | server | 7 implemented |
| `RA_MEMBER` | `ra-member` | ra 3.1.10: one member of the Raft cluster of a quorum queue of RabbitMQ 4.3.6 | server | 25 implemented |
| `GRPC_JS` | `grpc-js` | grpc-js 1.14.6: one channel to a gRPC server, its HTTP/2 transport, its keepalive and a unary call | driver | 26 implemented, 1 observed |
| `GRPC_GO_SERVER` | `grpc-go-server` | A server of grpc-go v1.84.0: one HTTP/2 connection, its keepalive, its policy for PINGs and its TCP socket | server | 13 implemented, 1 documented |
| `ETCD_SERVER` | `etcd-server` | The server of etcd v3.6.15 on grpc-go v1.83.2: one gRPC connection of a client | server | 19 implemented, 1 documented |
| `ENVOY_HTTP2` | `envoy-http2` | Envoy 1.39.4 as an HTTP/2 proxy of gRPC: one connection of a client, its streams, the local replies and the close | proxy | 16 implemented |
| `TOXIPROXY_LINK` | `toxiproxy-link` | Toxiproxy 2.12.0 with no toxic: one proxied TCP connection and its close | proxy | 9 implemented |
| `DOCKER_PROXY_LINK` | `docker-proxy-link` | docker-proxy of Docker Engine 29.1.5: one proxied TCP connection and its close | proxy | 9 implemented |
| `CADDY_HTTP2` | `caddy-http2` | Caddy 2.11.7 as an HTTP/2 proxy of gRPC: one connection of a client, its idle close, its replies and its stop | proxy | 12 implemented |

Twenty-eight documents operate on Linux TCP (`over`). Seven documents operate on no other document: Linux TCP, conntrack, the Sentinel, the replication of mongod, aten, the member of Ra and the `RetryAgent` of undici. The `RetryAgent` is one request above the sockets of a `Client`. Its timer is the delay of a retry. Each retry can go on a new socket. The `conditions` of each document give the range where it holds, for example a range of kernels.

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

### 0.3.18

- **Caddy 2.11.7 as a proxy of gRPC** (`caddy-http2`), from the source at its tag and of golang.org/x/net v0.59.0. With no stream open for 5 min, Caddy sends GOAWAY NO_ERROR, and it closes the connection 1 s later. A PING of the client does not reset that timer. A failure of the upstream before the headers of a response gives 502, thus UNAVAILABLE. Caddy retries no call at the defaults, and at SIGTERM it waits for each stream.

### 0.3.17

- **The proxies of T02 for gRPC: Envoy 1.39.4, Toxiproxy 2.12.0 and docker-proxy 29.1.5.** Three new documents, each from the source at its tag:
  - `envoy-http2`: one connection of a client through Envoy to one cluster of h2c. Envoy answers a failure of its upstream itself. Before the headers of a response, it sends a local reply of trailers only: 503 or 504, thus UNAVAILABLE. After the headers, it resets the stream with INTERNAL_ERROR. It retries no call at the defaults. The route ends each call 15 s after the end of its request. Envoy sets no keepalive of HTTP/2 or of TCP, and at SIGTERM it closes each connection with no GOAWAY.
  - `toxiproxy-link`: a TCP copy with no timer. Each socket gets the TCP keepalive of Go (15 s, 15 s, 9). An end of file or a reset of either side closes both sockets: Toxiproxy has no half-close.
  - `docker-proxy-link`: a TCP copy with no timer, with the same keepalive. A FIN passes as a half-close, and a reset of one side becomes a FIN toward the other. Docker stops the proxy with SIGINT at a stop or a restart of its container, and each connection then closes fully.

### 0.3.16

- **gRPC: grpc-js 1.14.6, a server of grpc-go v1.84.0, and the server of etcd v3.6.15.** Three new documents, each from the source at its tag:
  - `grpc-js`: one channel, its transport and a unary call. At the defaults the keepalive is off, a call has no deadline, and the connect has no timeout. grpc-js sets TCP_NODELAY and no TCP keepalive. When the transport ends, each call in flight ends with UNAVAILABLE, and grpc-js does not retry it.
  - `grpc-go-server`: one connection of a server of grpc-go. The server sends a PING after 2 h with no read, and it closes the connection 20 s after it. Its keepalive is on, thus each accepted connection gets a TCP_USER_TIMEOUT of 20 s. With the TCP keepalive of Go (15 s, 15 s, 9), an idle connection to a client that is gone ends 30 s after the last data. The third PING that breaks the policy gives GOAWAY too_many_pings. A call with a deadline gets a timer of it at the server, which resets the stream at its end. Thus the deadline of grpc-js and the deadline at the server race: run 39272272260 ended 4 of 11 such calls with CANCELLED, not DEADLINE_EXCEEDED.
  - `etcd-server`: the same transport with the values of etcd. A client can ping each 5 s with a stream open. etcd serves gRPC through cmux, thus its connections get no TCP_USER_TIMEOUT. Its listener sets the keepalive idle to 30 s: an idle connection to a client that is gone ends 165 s after the last data.

### 0.3.15

- **The cluster of a quorum queue of RabbitMQ 4.3.6.** Two new documents, each from the source in the release of RabbitMQ:
  - `aten`: the failure detector between the nodes, aten 0.6.0. Each node sends a heartbeat to each other node each 100 ms. The detector polls each 5 s in RabbitMQ (1 s at the defaults of aten). It reports a node down when the time since its last heartbeat is 1.5 times its gaps. Thus a silent node is down 150 ms to approximately 5.2 s after its last heartbeat.
  - `ra-member`: one member of the Raft cluster of a quorum queue, ra 3.1.10. When aten reports the node of the leader down, a follower waits 5 s to 6 s, and then it asks for pre-votes. A majority makes a candidate, and the votes of a majority make the leader. A leader ignores aten, thus it stays the leader in a minority and commits nothing.

### 0.3.14

- **amqplib 2.2.0 and RabbitMQ 4.3.6.** Two new documents, each from the source at its tag:
  - `amqplib`: one connection and one channel. At the defaults it takes the heartbeat of the broker, 60 s. It ends the connection 2 to 3 heartbeats after the last bytes of the broker. An idle connection sends a heartbeat frame each 60 s. Nagle is on, and an RPC has no timer.
  - `rabbitmq-connection`: one connection on the broker. It sends a heartbeat frame each 30 s on an idle connection. It ends the connection 2 to 3 heartbeats after the last bytes of the client. Each socket has linger 0, thus each close of the broker is a reset. The listener of ranch 2.3.0 gives each socket a send timeout of 30 s.

### 0.3.13

- **A reload of a pooler.** `pgbouncer-client`, `pgbouncer-server` and `pgpool-session` have the event `local.reload`: SIGHUP, which reads the configuration again. No transition takes it, thus a session keeps its state, its server and each timer.
  - PgBouncer: src/main.c:619-627, and src/loader.c:394-419 closes a server only when the connection of its database changed.
  - Pgpool-II: src/main/pgpool_main.c:3551-3566 sends SIGHUP to each child, and a child in a session reads the configuration again in the loop of its query (src/protocol/pool_process_query.c:456-466).

### 0.3.12

- **The send timeout of the client socket of Supavisor.** Supavisor 2.9.13 locks ranch 2.2.0. ranch gives each client socket a send timeout of 30 s that closes the socket (src/ranch_tcp.erl:108-109). Thus a write of a reply that waits 30 s ends the client. `supavisor-client` gives it as a source and a note, with no timer. A write waits only when the client takes no data, and on a broken path the FIN of the close waits behind the data. In run 39170773426, behind an MTU black hole, the socket closed 30.068 to 30.086 s after the fault in each of 11 runs.

### 0.3.11

- **The connect timer of PgBouncer can fire early.** libevent 2.1 counts a timeout from its cached time of the pass, not from the clock (event.c, `event_add_nolock` with `gettime` and `tv_cache`). Thus server_connect_timeout can fire up to one pass early, and its band has an early slack of 10 ms. In run 39160356281 the timer closed the socket at 127.998993 s, 1.007 ms before 128 s.

### 0.3.10

- **Supavisor 2.9.13, in transaction mode.** Two new documents, each from the Elixir source at the tag v2.9.13:
  - `supavisor-client`: one client connection. Between two transactions the client holds no server connection, thus a fault of the server reaches an idle client only through the pool. At the defaults Supavisor writes a heartbeat to an idle client each 60 s. A checkout waits up to 15 s for a server connection, then FATAL XX000. Each client socket has SO_KEEPALIVE.
  - `supavisor-server`: one server connection of the pool. The connect has a timeout of 5 s, and a failed connect gives FATAL 08006 to a client that waits for it. The next connect of the pool waits the rest of 2.5 s. The server socket has no keepalive.
  - A server that shuts down can end each idle client of the tenant. When a login of the pool gets 57P03, Supavisor shuts the pool down gracefully: each client outside a transaction gets FATAL 57P01 and its close. In run 39164922565 that came in 6 of 11 runs, and the other 5 met a refused connect, which keeps the pool.
  - In 2.9.13, client_idle_timeout ends no session. Its timer fires an event that no clause of the client handler takes, thus the document gives it no timer.

### 0.3.9

- **The SYN give-up of Linux TCP has its lateness.** Each wait of the SYN is a timer of the wheel, which rounds it up at its level. At the defaults and HZ 1000, the wait of 64 s can be 4.096 s late. Thus the give-up is 131 s to 137.08 s. At HZ 250 it is up to 5.056 s late. The lateness needs `@mark1russell7/algebra` 0.7.2.

### 0.3.8

- **Pgpool-II 4.7.3, with one backend.** A new document, `pgpool-session`, from the C source at the tag V4_7_3. It is one session of a client in its child process, on the socket of the client:
  - Between two queries, the child waits in one select() on the client and on the backend. Thus the close of either side ends the session at once.
  - While a query is in flight, the child waits on the backend only, in steps of 30 s. After each step it writes a dummy ParameterStatus to the client. No timer of Pgpool-II ends the query.
  - The FIN of the backend ends the session with FATAL XX000. A failed read of the backend and a failed connect to it ask for a failover (failover_on_backend_error).
  - At the defaults, no timer bounds an idle session: client_idle_limit is 0. When it is set, the session ends one tick of 1 s after the limit.

### 0.3.7

- **PgBouncer 1.26.1, in transaction pooling.** Two new documents, each from the C source at the tag pgbouncer_1_26_1. Each of them operates on one socket, on Linux TCP:
  - `pgbouncer-client` is one client connection: its login, its wait in the queue, and its transactions. Between two transactions PgBouncer reads the socket, and in the queue it does not.
  - `pgbouncer-server` is one server connection of a pool: its connect and its login, its checks, and its close. It also gives the wait of the pool after a failed login (`server_login_retry`).
  - Each timer of PgBouncer is a check of its janitor, each 333.3 ms, thus up to one period late. Only the TCP connect has its own timer, of libevent.
  - At the defaults, an idle server older than 30 s gets the empty query as a check before its next use. No timer bounds the reply of the check.

### 0.3.6

- **`hikaricp-pgjdbc`: the queue of the keepalive checks.** The keepalive task of each connection operates on the one thread of the housekeeper (HikariPool.java:644-656). Behind a silent fault, each check waits for its read timeout. Thus the check of one connection can wait for the checks of the other connections. The note of the timer `keepalive` says so. No value of a document changes.

### 0.3.5

- **`postgres-session`: the slack of the SIGALRM of a backend.** The knob `alarm_slack` has the value 10 ms. It is an assumption of the document, as the slack of the two client documents: the source gives no bound. The handler of SIGALRM sets the latch of the backend (timeout.c:364-377). pg_sleep waits on that latch, and it checks for interrupts before each wait (adt/misc.c:391-412). Thus a statement timer ends a sleep at once.
  - The source of pg_sleep is new. No other part of a document changes.

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
