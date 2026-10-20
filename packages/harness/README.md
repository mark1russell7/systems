# @mark1russell7/harness

A fault-injection harness for connection timers. In a cell, a client connects to a stock target in new Docker environments. The harness injects a fault, and it measures what the kernel did. Then the harness judges the measurement against the prediction of the cell.

The harness does not compute predictions. The author of a cell computes the prediction, for example from a timer algebra, and puts it in the cell.

## The cell

A **cell** (`cell.ts`) is all that one measurement needs, as data:

- **The topology.** A stock target image, pinned by digest, and the hops between the client and the target (`Cell.topology`). Without hops, the client and the target are a direct pair. A replicated group under its Sentinels can replace the target (`Cell.group`).
- **The subject.** The program under test, as data. Its image is an image pinned by digest, a build context, or an image that the harness ships (`Cell.client`, `Target.subject`).
- **The settings.** The sysctls of the client namespace, and the socket options of the client.
- **The workload.** A connection that stays idle, a connection with a request in flight, or a stream of requests. A stream of `GET` requests for a long value keeps many segments in flight.
- **The fault.** A black hole, a reset, a frozen process, or a stall. In a topology, also a fault at a router or a proxy, or a router that forgets a flow. Also a proxy that closes an idle connection, or a toxic of Toxiproxy.
- **The prediction.** An interval [T_lo, T_hi] after the event that arms the timer, or silence in a window. After a stall, the prediction also tells when the connection recovers. A silent prediction can also tell when the reply comes back (`replies`).
- **A detection by the program.** The timer can be a timer of the program of the observer, for example a heartbeat. The program then drops the connection itself (`DROPPED`). A detection can also give the waits of the reconnect of the client (`reconnects`).
- **The assumptions of the band.** A band can name the range of first round trips that it assumes (`rtt`), and the proxy times that it includes (`through`).

## The environment

`openLab(target, client, topology)` (`lab.ts`) builds one environment with Testcontainers:

- A chain of new networks, and the target on the last network. A direct pair has one network.
- A client container that holds its network namespace.
- A privileged sidecar in the namespace of the client, for its sysctls and its routes. Docker Desktop keeps `/proc/sys` read-only in a container that operates.
- Each hop of the topology, on the network of each of its sides.
- An injector sidecar in the namespace of the target, with NET_ADMIN. Thus the image of the target stays stock.
- The manifest of each environment gives the HZ of its kernel, from /proc/config.gz. A host without that file (a hosted runner) gets HZ from two readings of /proc/timer_list, one second apart: its jiffies against the time of the kernel (`hzOf`). `hzFrom` tells which.
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

- **A proxy** (`ProxyHop`) is a stock image, pinned by digest, that ends each TCP connection and opens its own to the next hop. Its files go into it before it starts, and `{{next}}` in them is the address and port of the next hop. Its `command` and its `environment` replace those of its image. An injector sidecar shares its namespace. A privileged sidecar sets its sysctls when the hop names them.
  - The lab keeps the last 60 lines of the output of each proxy. A proxy that does not start gives them in its error.

The element before a router reaches the networks after the router through it. Its privileged sidecar, or the router itself, adds each route. A router translates the address of the side of the client, thus the target and each later hop see the router as the peer.

A lookup treats an expired conntrack entry as gone, thus the router forgets a flow at its timeout, to the jiffy. The DESTROY event of the entry waits for the garbage collector or a list of the table. Thus `ctwatch.py` in the router lists the table each `pump` (`PUMP`, 0.1 s by default). A DESTROY then follows an expiry within the pump and two lists of the table.

`LISTING` (20 ms) is the longest list of the table that a prediction assumes. A longer list writes a `pump-slow` line, and a run with one near a detection by a timer of conntrack is void. `PUMP_SLACK` (5 ms) is how late the pump can be after its interval and two lists. Its sleep can end late, and the read of the event takes time. Thus a DESTROY follows an expiry within the interval of the pump, two lists and that slack.

The `reset-both` form sends its resets on the DESTROY event. Each reset has the sequence number that its end expects. A raw sniffer reads it from the last acknowledgment of that end.

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

## The replica sets

A replica set (`ReplicaSet`, `Cell.replicaSet`) is a replicated group with no external authority, as data. Its members elect their own primary, and the client finds the primary with its own monitors. The set replaces the target of its cell.

- **The members.** Each member is a container from one stock image, pinned by digest, in its own network namespace. Its server is the child of a shell, with the name of the set and the options of the set (`args`).
- **The start.** The first member starts the set (`rs.initiate`) with the address of each member, as the client reaches it, and with the settings of the set. An example of a setting is `electionTimeoutMillis`.
- **The sidecars.** Each member has an injector sidecar in its network namespace and in its process namespace, as a member of a group has.
- **The client.** The client of each run is the MongoDB driver (`image/mongo`). It knows the address of each member and the name of the set. It writes a stream of sequence numbers with the write concern of the cell (`Cell.writeConcern`).
- **The timeline.** A log consumer reads the JSON log of each member. A run keeps the lines of replication, of its heartbeats, of the elections, of the rollbacks and of the commands (`KEPT`).
- **The clocks.** The log of mongod has the wall clock in ms. The client writes the wall clock beside the monotonic clock each second (`clocks`). Thus the run puts each line of a member on the monotonic clock (`clockOffsetOf`).
- **The prober** watches the namespace of the client.

Each run of a replica set cell starts from a set that converged. The member that answers is the one primary, and it accepts writes. Each other member is a healthy secondary at the optime of the primary. The harness then removes each write from the set, with a write concern of each member. After the run, the set converges again, and the writes that it holds tell which writes it kept.

A step-down holds its old primary out of the elections for 60 s. Thus before each run, each secondary can stand for election again (`rs.freeze(0)`), and no run inherits that hold.

A fault names a member by its role at the start of a run: `primary`, or `replica` for a secondary. A cut from one member (`one`, `one-way`) cuts the first other member in the sequence of the set.

## The clusters of RabbitMQ

A cluster (`Cluster`, `Cell.cluster`) is a cluster of RabbitMQ nodes with one quorum queue, as data. The members of the queue elect its leader by Raft, one member on each node. The cluster replaces the target of its cell.

- **The nodes.** Each node is a container from one stock image, pinned by digest, in its own network namespace. Its hostname is the name of its node (`rabbit@<name>`), and all nodes share one Erlang cookie. Its server is the child of a shell.
- **The start.** The nodes form the cluster from the list of their names (`classic_config`), and the lab waits until each node runs in it. Then the admin (`image/amqp/admin-cluster.mjs`) declares the queue on the first node, with the leader locator `client-local`.
- **The sidecars.** Each node has an injector sidecar in its network namespace and in its process namespace.
- **The client.** The client of each run is amqplib, in `image/amqp/client-cluster.mjs`. The client publishes a stream of sequence numbers on a confirm channel through one node. That node is the last follower, or the node of the leader (`Cell.clientAt`). The library does not connect again by itself. When the connection ends, the client connects to the next node after 1 s, as an application does.
- **The timeline.** A log consumer reads the console log of each node. A run keeps the lines of the queue, each warning and error, and the lines of the maintenance mode. Ra writes a NOTICE for each change from or to the leader, and an INFO for each new leader that a follower detects.
- **The clocks.** The log has the wall clock in µs. The run puts each line on the monotonic clock with the clock lines of the client.

Each run starts from a queue that converged (`rabbitmq-queues quorum_status`): one leader, and a follower on each other node in its term at its commit index. The run then purges the queue. After the run, the queue converges again, and the admin reads the sequence numbers that the queue holds.

A step-down (`step-down`) moves the leadership to the first follower (`rabbitmq-queues transfer_leadership`). A drain (`drain`) puts the node in maintenance mode (`rabbitmq-upgrade drain`), and the run revives the node after it. Each of them starts an Erlang VM for the tools first. Thus its stamp is a line of the log, and not the command. For a step-down it is the NOTICE of the old leader that gives the leadership away (`GIVES_AWAY`). A drain stops the member of the leader, thus its stamp is the first follower that sees its monitor of the leader go down (`MONITOR_DOWN`).

## The clients and the agents

- **A client image** (`ClientImage`, `Cell.client`) replaces the TCP client of the harness in each run. It operates in the namespace of the client. Its command gets the arguments of the TCP client, and it prints the same JSON lines. Its image is a stock image by its name, or the source of the image of a subject (`ImageSource`).
- **A client by its name** (`Cell.client`) is a client that the harness ships (`SHIPPED_CLIENTS`): the source of its image and its command. Thus each client of the harness is data too.
- **An HTTP client** (`Cell.client`: `go-http`, `http-agent` or `undici`) is a client of the harness from its own image. It sends a GET of the root, then a second request (`probe.http`):
  - after the signal (`inflight`), into the fault
  - or by itself, a gap after its first reply (`gap`), for the keep-alive race.
- **A client of a keyed limiter.** The flag `limiter-key` (`probe.http.options`) makes the client of undici or of Go send a key of its process in the header `x-limiter-key`. Thus each run has its own count in the limiter of the target.
  - The flag `retry` sends each request of undici through its `RetryAgent`, at the defaults of undici. Each `retry-` flag sets one option over them.
  - The client of undici then writes an `attempt` line for each send of a request, with its number `n` and its socket. A `RetryAgent` that gives up gives `UND_ERR_REQ_RETRY` on the `error` line, with the status of the last reply and the count of sends.
- **The lines of an HTTP client.** It writes the lines of the TCP client, with the number `i` of the request on each line of a request. It also writes the connection of each try of a request (`request`, then `retry`), with its local address and a flag for a reused connection. Each connection gets a `conn` line, and each end of a connection a line (`eof`, `conn-error`, `closed`). The end of the second request is a `done` line.
- **A target with a script.** A target can take files before it starts (`Target.files`), for example the script of a Node server on the stock Node image. A target that writes JSON lines (`Target.lines`) gives them to each run (`Run.server`). The manifest holds the sha256 of each file and the first line of the target.
- **The WebSocket client** (`Cell.client` is `procedures-ws`) is the `WebSocketTransport` of `@procedures/client` 0.7.0: the `client` program of the `procedures` subject. The cell gives each of its settings (`probe.ws`): the class of its sockets, the heartbeat, the reconnect, and the times of a call.
  - Its first request is `harness.echo`. In flight, its request into the fault is `harness.echo`, or `harness.hold` for a held reply.
  - It writes the lines of the TCP client. It also writes a line for each act of the program: `ping`, `drop`, `reconnecting` and `dial`.
  - The class of its sockets is the global `WebSocket` of Node, with the transport of the root entry. Or it is the `WebSocket` of the `ws` package, with the transport of the Node entry `@procedures/client/node`.
  - The transport gets a subclass of that class. The subclass writes a line, then gives the work to its class. Thus the transport, undici and ws operate as they do without it.
  - The subclass has `terminate()` only when its class has it, because the transport drops a socket with `terminate()` when it exists.
- **A target from the image of a subject** (`Target.subject`). The target operates the image of a subject in place of its stock image. `Target.image` is then the stock base of that image, and the manifest names both. The procedures server is a script in the image of the WebSocket client (`server-ws.mjs`). Thus the client and the server use one release of the package.
- **A target from an image of the harness** (`Target.harness`) is a short form. `harness: "procedures"` is `subject: { kind: "shipped", name: "procedures" }`.
- **An agent** (`lab.agent(image, command, { pid })`) is a container in the network namespace of the target. With `pid`, it also shares the process namespace of the target, thus it can signal the server process. Its JSON lines and its `exec` stay available to the caller.

## The subjects

A subject (`Subject`, `image.ts`) is the program under test, as data. The harness does not import the program. It starts the image of the program. Thus another repository can give its own subject, with its own release in it.

- **The source of an image** (`ImageSource`) tells where the image comes from:
  - `pinned`: an image of a registry with its digest, `name@sha256:<64 hex digits>`. The lab pulls it.
  - `build`: a build context that the caller gives. `context` is its folder, `dockerfile` is its Dockerfile, and `files` are the files and folders that the Dockerfile reads.
  - `shipped`: an image that the harness ships, by its name (`SHIPPED_NAMES`).
- **A relative folder** of a build starts at the working folder of the process. A record holds the source of each image as the cell gives it. Thus give a relative folder, and the record names no path of the machine.
- **A subject** gives the source of its image and its stock base, pinned by digest. It also gives the command of each of its programs by their roles, for example `client` and `server`.
- **A subject in a cell.** `subjectClient(subject)` gives the client of a cell, and `programOf(subject, role)` gives the command of a program. A target operates the image of the subject (`Target.subject`), and its stock image is the base of the subject.
- **A client that the harness ships keeps its name.** `subjectClient` gives `procedures-ws` for the `procedures` subject. Thus the records of a cell on that subject stay the same.
- **The subjects of the harness** (`SUBJECTS`). `procedures` is `@procedures/client` 0.7.0 on Node: its WebSocket client and its server, from one image.

These rules keep a build the same in each run:

- A pinned image names its digest. A tag alone can move.
- Each `FROM` of the Dockerfile of a build names a digest, an earlier stage, or `scratch`.
- Each `package.json` and `Cargo.toml` of a build has a lockfile in its folder or in a folder above it.
- Each path of a build stays in its context.
- The tag of a build is its name, then 12 digits of a sha256. The sha256 reads the path of the Dockerfile, and the path and the content of each file. Thus a changed program cannot operate as an old one.

The images that the harness ships obey the same rules. A source that breaks a rule fails before Docker starts (`planOf`, `imageProblems`, `subjectProblems`). A pinned image, or a stock image by its name, does not load Testcontainers before the lab starts it.

The entry `@mark1russell7/harness/schema` has the zod schemas of a source (`imageSourceSchema`), a client (`clientSchema`) and a subject (`subjectSchema`). A runner that reads a subject as JSON examines it with them. The root entry does not import zod.

## The images

The harness ships sixteen images, each as a shipped source (`ImageSource`). The tag of each image comes from the path of its Dockerfile and the content of all the files that its Dockerfile reads. The harness copies these files into a new build context, from its own package and from the prober package. Thus the build works in a workspace and from npm.

From 0.11.20, the harness builds each image with the CLI of Docker (`docker build`), thus with BuildKit where the CLI has it. Testcontainers reads nothing of the output of a build, and its error is "Failed to build image" only. The error of a failed build holds each line of its output that names an error, and its last 15 lines (`buildFailure`). Thus the host of a lab needs the CLI of Docker and its daemon.

- **The harness image** (`image/Dockerfile`) has two stages, each a digest-pinned Alpine. `Cargo.lock` pins the crates. The image holds:
  - the kernel program of the prober, compiled against the BTF of the kernel that builds it, and its Rust collector.
  - `client`, the TCP client of a cell. Rust's `std::net` sets no socket option by itself, thus the measurement gets the timers of the namespace. The client also samples `TCP_INFO` each 2 ms, a second vantage on its socket. It waits in `poll()`, which does not lock the socket. A keepalive timer that finds its socket held tries again HZ/20 later.
  - In a stream, a reply of the `client` is whole at its CRLF, or after the length of a bulk string. The client then writes a `replied` line.
  - `inject`, which applies a fault in one `iptables-restore` commit, with monotonic stamps around the commit. Thus the start of a fault is known in the VM. A `docker exec` from Windows comes 190 ms late at the median. With `--via DEV`, the rules go in the FORWARD chain, on the device toward one side.
  - `inject` also sends a signal to a process by its name (`signal`), and one command to a server of the Redis protocol (`resp`). Stamps bracket each.
- **The Node client image** (`image/node`) is a driver client: ioredis 6.0.0 on Node 24.21.0. The digest of the image and an npm lockfile pin them. `client-ioredis.mjs` prints the lines of the TCP client on the same clock, and it adds the status changes of ioredis as `status` lines. The same image holds the client of a group in Sentinel mode (`client-sentinel.mjs`) and the observer of its Sentinels (`observer.mjs`).
- **The Go HTTP image** (`image/go-http`) is the `http.Transport` of Go 1.27.2 at its defaults (`client-go`). The program uses the standard library only, thus the digest of the Go builder pins all of its code. The build does `gofmt` and `go vet` first. A wrapper on each connection writes what the read loop of the transport reads. The trace of the transport writes each try of a request.
- **The Node HTTP image** (`image/node-http`) holds the `http.Agent` of Node 24.21.0 (`client-agent.mjs`) and an HTTP/1.1 `Client` of undici 8.12.2 (`client-undici.mjs`). The digest of the image and an npm lockfile pin them. It is apart from the image of ioredis, thus the cells of ioredis keep their image.
- **The PostgreSQL client image** (`image/pg`) is node-postgres: pg 8.23.1 with pg-pool 3.14.0 on Node 24.21.0. The digest of the image and an npm lockfile pin them. `client-pg.mjs` makes one `pg.Pool` with the options of the cell (`Cell.driverOptions`), and it prints the lines of the TCP client on the same clock. The first query makes the connection, and the reply gives the client back to the pool, where it is idle. An error of the pool for that idle client is the detection of an idle cell. The probe is `{ driver: { name: "pg", query, inflight } }`, with `SELECT 1` as the query when the cell gives none.
  - `inflight` is the text of the query in flight: the second query of an in-flight run. The first query then makes the pool ready at once, and only the query in flight is slow, for example `SELECT pg_sleep(20)`. The HikariCP client reads it too.
- **The HikariCP client image** (`image/hikari`) is HikariCP 7.1.0 over pgjdbc 42.7.13 on Temurin 21.0.12.1. The digests of the two stages and the SHA-256 of each jar pin them. The probe is `{ driver: { name: "hikari", query, inflight } }`.
  - `ClientHikari.java` makes one `HikariDataSource` with the properties of the cell (`Cell.driverOptions`). A name with the prefix `dataSource.` is a property of pgjdbc.
  - The user is `postgres`, unless the cell gives `username` (and `password`). Supavisor finds the tenant of a client in its user, for example `postgres.harness`.
  - It prints the lines of the pg client on the same clock. Each socket comes from the `PGStream` of its connection, and a `pool` line gives each change of the counts of the pool. The errno of a failure is the SQLState of pgjdbc.
  - Before its first line, it loads the classes of a connect and of a pool on the loopback of its namespace. It also starts the SecureRandom that HikariCP reads for the UUID of each new connection. Then it parses an ERROR of the server, as for the timeout of a statement. A new JVM loads each class at its first use. Thus a band does not time that load.
- **The RabbitMQ client image** (`image/amqp`) is amqplib 2.2.0 on Node 24.21.0. The digest of the image and an npm lockfile pin them. The probe is `{ driver: { name: "amqp" } }`.
  - `client-amqp.mjs` opens one connection and one channel. Each operation is an RPC of the channel: the first declares a queue that the broker names, and each later one declares it passively (checkQueue). The queue is exclusive, because RabbitMQ 4.3 refuses a transient queue that is not.
  - The options of the cell (`Cell.driverOptions`) give `heartbeat` in seconds, the user and its password (guest at the defaults), and the socket options of amqplib.
  - It prints the lines of the pg client on the same clock. A `connection` line gives each event of the connection, and a `channel` line each event of the channel. The errno of a failure is the error of the connection when it has one.
- **The gRPC client image** (`image/grpc`) is grpc-js 1.14.6 on Node 24.21.0. The digest of the image and an npm lockfile pin them. The probe is `{ driver: { name: "grpc", hold } }`.
  - `client-grpc.mjs` opens one channel with no TLS. Each operation is a unary call of `grpc.health.v1.Health/Check`, with the messages encoded in the script. The first call makes the connection.
  - The options of the cell (`Cell.driverOptions`) are the channel options of grpc-js (`grpc.*`), and `deadline_ms` for the deadline of each call. With `hold`, the call in flight asks the server of the harness to hold its reply that long.
  - grpc-js does not give its socket, thus the script names each socket from `net.connect`, as the MongoDB client does. A `state` line gives each change of the connectivity state of the channel, and a `log` line each line that grpc-js logs.
  - The errno of a failure is the error of the socket when it has one. It is EOF for an end by the server, else the status of the call.
  - With `op: "watch"`, the operation in flight is a stream of `grpc.health.v1.Health/Watch`, which stays open. A GOAWAY of the server with `too_many_pings` gives the errno `too_many_pings`: grpc-js logs that refusal before the end of the socket.
- **The grpc-go image** (`image/grpc-go`) is the gRPC server of the harness, a server of grpc-go v1.84.0, built with Go 1.27.2 on a digest-pinned Alpine. A target takes it as the image of a subject: `{ kind: "shipped", name: "grpc-go" }`.
  - `go mod tidy` gets the modules of grpc-go at its tag, and the go command checks each module against the checksum database of Go. The build log prints the go.sum. The build does `gofmt` and `go vet` first.
  - The server is at the defaults of grpc-go and of Go, and each flag sets one value over them. The flags set the keepalive, the policy for PINGs, the age of a connection and the TCP keepalive of the listener.
  - It serves `grpc.health.v1.Health`. A check of the service `hold:<ms>` holds its reply for that time, and Watch holds a stream open. It writes JSON lines on the monotonic clock (`Target.lines`).
- **The etcd image** (`image/etcd`) is etcd v3.6.15 on a digest-pinned Alpine. The binaries come unchanged from the image of etcd, pinned by digest. That image has no shell, and a cell holds the server as the child of a shell. A target takes it as the image of a subject: `{ kind: "shipped", name: "etcd" }`.
- **The MongoDB client image** (`image/mongo`) is the driver mongodb 7.7.0 on Node 24.21.0. The digest of the image and an npm lockfile pin them. `client-mongo.mjs` prints the lines of the TCP client on the same clock:
  - Each socket of the driver is a `socket` line with its role: `monitor`, `rtt` or `pool`. The stack of the call that makes the socket gives the role.
  - The events of the driver are `sdam` lines (the heartbeats and the changes of each server), `cmap` lines (the pools) and `command` lines (each try of an operation).
  - Each operation is a `sent` line, then an `ack` line or a `fail` line. An `ack` line has the server that accepted it. A `fail` line has the name and the labels of its error.
  - The same image holds `stepdown-mongo.mjs`, the sender of `replSetStepDown`.
- **The procedures image** (`image/procedures`) is the image of the `procedures` subject. It holds `@procedures/client` 0.7.0 and `ws` 8.22.0 on Node 24.21.0, whose WebSocket is undici 7.29.1. The digest of the image and an npm lockfile pin them. It holds the WebSocket client (`client-ws.mjs`) and the script of the procedures server (`server-ws.mjs`). Each takes each of its settings as a flag, and it has no default. The lockfile holds one copy of `ws`, and the client stops when `@procedures/client/node` resolves another one.
- **The router image** (`image/router`) is a digest-pinned Alpine with conntrack-tools, nftables, iproute2 and Python. `mbx.sh` sets the form of the router in one nftables table, `ctwatch.py` writes the conntrack events, and `resetter.py` sends the resets of the `reset-both` form. Each run records its packages in the manifest.
- **The PgBouncer image** (`image/pgbouncer`) is PgBouncer 1.26.1, a pooler hop, on a digest-pinned Alpine. The build gets the release tarball of pgbouncer.org and checks its SHA-256 before it builds. The C sources of that tarball are those of the tag that the machine documents cite.
  - A hop takes the image as a shipped source: `{ kind: "shipped", name: "pgbouncer" }`. A proxy hop also takes a stock image by its digest.
  - A cell gives its configuration as files of the hop (`ProxyHop.files`): `/etc/pgbouncer/pgbouncer.ini` and `/etc/pgbouncer/userlist.txt`. In them, `{{next.host}}` and `{{next.port}}` are the host and the port of the server.
  - PgBouncer does not start as root, thus it operates as its own user.
- **The Pgpool-II image** (`image/pgpool`) is Pgpool-II 4.7.3, a pooler hop, on a digest-pinned Alpine. The build gets the source of the tag V4_7_3 from GitHub and checks its SHA-256 before it builds. The tree of git holds no `configure`, thus the build runs autoreconf, and bison and flex make the parser.
- **The docker-proxy image** (`image/docker-proxy`) is docker-proxy of Docker Engine 29.1.5, the userland proxy of a published port, as a proxy hop. The build gets the static bundle of Docker 29.1.5 and checks its SHA-256. The proxy writes its status to fd 3, the pipe of its parent in Docker. Thus a cell starts it with `3>/dev/null`.
  - A hop takes the image as a shipped source: `{ kind: "shipped", name: "pgpool" }`.
  - A cell gives its configuration as one file of the hop: `/etc/pgpool/pgpool.conf`. Each other file that Pgpool-II reads is empty in the image. Pgpool-II operates in the foreground as its own user.

The build does the `cargo test` of the two crates. Thus the record decoder passes its tests before an image exists. Each amount that the native programs print is a quantity in a canonical unit. For example, an RTO is in `jiffy`, a round trip in `us`, and a segment in `B`.

ioredis sets the keepalive of its socket itself, after it connects. Thus a cell sets the keepalive of a driver through the keepAlive option of ioredis (`probe.driver`). The keepalive sysctls of the namespace do not apply to it.

## The faults

- **A black hole** is DROP rules in the two directions, in the namespace of the peer of the observer. Thus the measurement gets the kernel timers of the observer. For the client, the rules go in the namespace of the target, through the injector. For the server, they go in the namespace of the client, through its admin sidecar. Rules in the namespace of the observer make its sends fail with EPERM, and the kernel records only a retransmission that goes out (`FaultSide`).
- **A reset** is a `REJECT --reject-with tcp-reset` rule in the namespace of the target, for the segments of the client. The next send of the client gets a reset one round trip later. It is the reference fault of the calibration.
- **A frozen process** is the cgroup freezer (`docker pause`), while the kernel stays up. A target that names its server process (`Target.program`) freezes by SIGSTOP from a sidecar in its process namespace, with stamps (`lab.signal`). A hold (`Cell.hold`) then thaws it with SIGCONT at that time after the freeze.
- **A fault before the client** (`Cell.before`) holds before the client starts. Thus the first selection of the driver meets it. It is a black hole, a reset or an ICMP unreachable.
- **A stall** is a black hole that stops by itself, `Cell.stall` after the send of the request. The run reads the stamp of the client on the send. Then `inject clear PEER --at NS` holds the end in the VM until that instant (`lab.heal`). Thus the latency of a docker exec does not change the length of the stall. An idle client sends only the pings of its heartbeat, thus its stall counts from its first ping into the stall.
- **An ICMP unreachable** (`unreachable`, `Cell.icmp`) answers each segment from the observer with host, net or port unreachable, or admin prohibited. Linux keeps it as a soft error, continues to retransmit, and gives the errno of the ICMP at the timeout. Host and net unreachable also revert the backoff (RFC 6069).
- **A simplex partition** (`simplex`, `Cell.drops`) drops the segments to the server, or the segments to the client, but not both.
- **A FIN** (`fin`) stops the process of the peer with SIGKILL while its kernel stays up. For the client, the target starts its server as the child of a shell (`Target.command`), and `Target.kill` stops it. For the server, the harness stops the container of the client.
- **An MTU black hole** (`mtu-blackhole`, `Cell.mtu`) drops each segment longer than the length, in the namespace that receives it. At a router (`Cell.faultAt`), it drops what the router forwards from one side.
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
- **A stall of the application** (`app-stall`) injects nothing. The server process holds the reply, because the request asks for it (`HttpProbe.hold`), and its kernel stays up.
- **An event at a proxy** (`hop-event`, `Cell.event`) is a signal to the program of the proxy, or a query on its console. Examples are a reload of the configuration, a stop of a proxy and PAUSE on the console of PgBouncer.
  - A signal goes to each process of `ProxyHop.program`: HUP, TERM, INT, STOP or CONT (`HopSignal`). A sidecar in the network and process namespaces of the proxy sends it (`inject signal NAME HUP`). The lab starts that sidecar at the first signal.
  - STOP blocks the event loop of the proxy: its processes stop, and its kernel keeps each socket. With a hold (`Cell.hold`), CONT thaws it at that time after the stop, from inside the VM (`--at`). The lift thaws a proxy that its hold did not thaw.
  - A query goes from the injector of the proxy to its console on 127.0.0.1, as a user that the console trusts (`inject query`). The injector speaks the simple query of the PostgreSQL protocol. Its stamps bracket the query and its ReadyForQuery. After the run, the harness sends the `undo` of the query, for example RESUME after PAUSE.
  - Without `inFlight`, the event comes first, and the request meets it. With `inFlight`, the request goes first, and the event comes while it is in flight. A run whose order is not that order is void.
- **A fault on a group** acts on the part that `Cell.faultAt` names by its role:
  - A black hole (`blackhole`) drops each segment between the part and each peer. A reset (`rst`) answers each segment from a peer with a reset, thus the part refuses each connection.
  - A partial partition (`partition`) is a black hole between the part and some of its peers (`GroupPlace.cuts`). `group` cuts the part from the other members and the Sentinels, and `clients` cuts it from the client.
  - The rules for each peer go into one commit. The injector takes a list of peers, `A,B,C`.
  - A frozen process (`freeze-process`) is SIGSTOP to the server of the part, and SIGCONT thaws it. A FIN (`fin`) is SIGKILL, and the server starts again after the run.
  - A planned failover (`planned-failover`) is `SENTINEL FAILOVER <group>` to the first Sentinel, or `SENTINEL FAILOVER <group> COORDINATED` (`Cell.coordinated`). The injector stamps the write of the command and its reply.
  - A fault with a hold (`Cell.hold`) lifts at that time after its commit. The injector waits for that instant in the VM. A stall (`Cell.stall`) lifts at its length after the first write into it.
  - A step-down (`step-down`) is `replSetStepDown` to the primary of a replica set (`STEP_DOWN`). A client of its own sends it, and it stamps the command when the driver writes it.

A length match and netem act on GSO super-packets of up to 64 KB, not on segments, while TSO, GSO and GRO are on. Thus the cells of `mtu-blackhole` and `netem` turn them off on the two ends (`lab.offload`). They also turn them off on the two devices of a hop where the fault is.

Each run starts from kernels that keep nothing from the run before it (`lab.forget()`). When a connection closes, each kernel keeps TCP metrics for the address of its peer. These metrics set the first round trip of the next connection, and thus its RTO. The harness removes the `tcp_metrics` of the two namespaces before each run.

## The measurement

`measure(cell, run)` (`observe.ts`) reads a run from the records of the kernel:

- **The socket.** The socket of the run is the socket of its observer. For the client, it is the socket that the client connected from, in its namespace. In a topology, the address of a hop serves each run. Thus the socket of the target or of a proxy is the socket that became ESTABLISHED in the run (`socketOf`).
- **The time.** It times the detection from the reference event of the prediction to the error report of the kernel. eBPF stamps the two events. For keepalive, the reference is the last received segment. For the give-up, it is the first retransmission of the RTO timer after the fault holds, not the tail loss probe one RTO before it. For a reset, it is the send of the client, which no kernel record marks. The client stamps the send before its write.
- **The other views.** It also gives the same interval from the `TCP_INFO` samples of the client, and the delay before the client saw the error. It also gives the steps of the kernel: each keepalive probe, or each expiry of the RTO timer.
- **Void runs.** A run is void when the timer that drives the measurement was two jiffies or more behind its wheel slot in the timed interval. The wheel does a slot in the tick when it is due. Thus such a firing measured the host, which stopped a vCPU, not the kernel. A keepalive timer that found its socket held also makes the run void. A run whose fault came too late is void too.
  - The rule is in time when the run knows its HZ (`Run.hz`, from the manifest). Then the delay must reach two jiffies and δ_abs, the larger of the two (`delayVoids`). Each band includes δ_abs, thus a smaller delay does not change a result. At HZ 250 two jiffies are 8 ms, more than a δ_abs of 4 ms, and the rule stays the same. At HZ 1000 two jiffies are 2 ms. A run without its HZ keeps the rule in jiffies.
- **The first round trip.** The measurement gives the first round trip of the socket of the observer (`rtt`). It is the smoothed round trip in the first record of the socket: the sample of the handshake. A run whose first round trip is above the range of its prediction is void, with the reason `rtt-over-assumption` and the value. Such a run measured another path than the band assumes. For example, a round trip of 4.826 ms makes an RTO of 52 jiffies, and a ladder that assumes 1 ms has 51.
- **Findings.** A finding is a wrong errno, a detector that did not fire, or a detection where the prediction is silence. A router that forgot the flow in the window of a silent prediction is also a finding.
- **A reply.** A silent prediction with `replies` times the send of the request to the first segment with data that comes back. A proxy can acknowledge the request first, with no data.
- **A toxic.** A toxic counts from the start of its commit (`fault`), as the injector stamps it.
- **A topology.** A run in a topology also gives the bytes that the client read after its request, and when a router forgot its flow (`forgot`).
- **Recovery.** After a stall (`prediction.recovers`), it times the send to the first segment back after the stall stopped. That segment is the answer of the server to the retransmission that got through. A run whose stall stopped outside the window of its prediction is void. A run where nothing came back is a finding.
- **An end of file.** A FIN counts from the change of state of the socket of the peer when it closes (`peer-closed`). It ends at the change of the socket of the observer to CLOSE_WAIT. The kernel stamps the two changes.
- **A check of a pool.** A check on an idle connection counts from the first segment with data that the socket sends after the fault (`first-sent`). The keepalive of HikariCP comes at a phase from the creation of its connection. Thus no line of the client gives its time, and the kernel stamps it. The prediction gives the latest time of that send after the reply (`startsBy`), and the run waits that much longer.
- **A heartbeat of a driver.** The receive check of a heartbeat counts the bytes of the peer, not an ACK. Thus its band counts from the last segment with data that the socket received before the end of the band (`last-data`). An idle client of amqplib sends its own heartbeat frames. The ACK of the broker for one of them can come after the last data of the broker.
- **The connect of a pooler.** A band of a driver can be on the socket that a hop opens toward the target (`socket: "upstream"`). It is the first socket of a hop that moves to SYN_SENT after the outset. A pooler connects to the server by itself, thus no line of the client names that socket.
  - A connect timer counts from the change of that socket to SYN_SENT (`syn-sent`).
  - The band ends at the error that the kernel reports, for example ETIMEDOUT after the SYNs. Without an error, it ends when the program closes its socket in SYN_SENT (`closed`). That close has no error and no FIN, only the change to CLOSE. A refused connect also leaves SYN_SENT, but it has its error.
- **A detection by the program** (`application.ts`). The kernel has no report of it. Thus the program of the observer writes a line before each of its own acts, and the kernel stamps each act on the socket.
  - The program writes `ping` before each ping of its heartbeat. The kernel stamps the write of the ping (`tx`).
  - The reference is the first ping that got no answer (`ping-sent`): no segment with data reached the socket after its write, up to the detection. Its write starts the timer of the heartbeat that the fault met. The fault can come at any time, and its stamps are not necessary.
  - The program writes `drop` before it drops the connection itself. The detection is the kernel's stamp of that drop: the write of its close frame, or the change of its socket out of ESTABLISHED. Without such a record in δ_abs, it is the stamp of the line.
  - A drop counts when it comes before each report of the kernel. A report of the kernel that comes first is the detection, and the drop after it is not.
  - The second view is the stamps of the program: from its `ping` line to its `drop` line. The steps are the later pings, each from the reference.
  - The lines of a client name the socket by its local address (`local`), and the lines of a server by its peer (`peer`). For the server, the lines are the lines of the target. A line whose address is null is about a try that did not open.
  - The harness reads the peer of a server from the records of its socket. Behind a router, that peer is the address of the router, not the address of the client.
  - A first ping without an answer can come late, for example at a beat of a server whose phase no document gives. Then the prediction gives its latest time after the reply (`startsBy`), and the run waits that much longer.
  - A prediction can say how the program drops (`drop`). A close frame (`frame`) is a write, and the socket stays ESTABLISHED after it. A close (`close`) closes the socket in δ_abs: a FIN or an abort. Another drop is a finding. A FIN of the peer that answers a close frame is no close by the program. The run gives the time from the `drop` line to the close by the program (`left`).
  - The client process ends at the end of each run, and its kernel then closes each socket that is still open. A prediction can say that the program is that client process (`exits`). Then a close in δ_abs of that end is no close by the program: `left` stays null, and `exited` gives the time.
  - The end of the process is the first change out of ESTABLISHED of another socket of the client after its last `dial` line (`exitOf`). The program dropped none of these sockets.
  - A heartbeat is a timer of the program. The retransmit timer of its ping fires in the same interval. Thus a run whose retransmit timer was two jiffies or more behind its wheel slot is void: the VM stopped a vCPU.
- **The reconnect** (`reconnectOf`). A prediction with `reconnects` also reads what the client did after the detection.
  - Each wait goes from a `reconnecting` line, where the program starts its timer, to its next `dial` line, where it makes the socket. A wait outside its band, widened by δ_abs, is a finding. A try that did not come is a finding too.
  - The kernel gives the time from the detection to the first SYN of a new socket (`syn`). It also gives the time to the first new socket in ESTABLISHED (`established`).
  - It also gives the time from each `dial` line to its SYN (`connects`): the work of the program before connect(2).
  - A measurement-only prediction can give `reconnects` too. The end of its connection has no band, but each wait has one. A wait outside its band is a finding of its run, and the verdict names that run. The decision stays `measured`.
- **A call in flight of a WebSocket client** (`callOf`). The run gives its error or its reply, and the time from the detection to its end.
- **A stream.** In a stream (`probe.mode` is `stream`), the client sends `count` requests. The run keeps the time from each send to the last byte of its reply (`samples`). A record without `replied` lines gives the time to the first data.
- **Reordering.** A measurement-only run also gives what reordering, duplicates and losses did (`reordering`). At the client, it counts the arrivals beyond a hole and the arrivals of data that it had already, against `rcv_nxt`. From the sender, it gives the most SACKed and lost segments, the DSACKs, the fast retransmissions, and the reordering degree and count of the kernel.
- **An arrival is not always one segment.** The segments that arrive while the owner holds the socket wait in its backlog, and the kernel joins the contiguous ones. Thus the kernel counts out-of-order segments (`rcv_ooopack`), and the prober counts arrivals.
- **A proxy's own time.** A calibration cell (`Cell.calibrates`) gives the time of its proxy for each request and its reply (`crossings`). Each time goes from an arrival on one socket of the proxy to its next write on the other socket (a `tx` record).
- **An HTTP client** (`requestOf`). The run gives what the second request met (`request`): the connection of its first try, a new try, and its error or its reply. The prediction gives the same (`Prediction.request`), and another outcome is a finding.
  - In a gap, the idle connection counts from the first reply, and the run gives the gap from the lines of the client.
  - A new try that gets no connection writes only its failed dial (`dial-error`). That line counts as a new try.
  - A close of the observer itself (errno `CLOSED`) is the change of its socket from ESTABLISHED to FIN_WAIT1: its pool closed an idle connection.
  - A timer of the client or the server is not a timer of the kernel. Thus a delayed keepalive timer of the socket does not make such a run void.
- **A router that forgets in silence.** A silent prediction can say that the router forgets the flow in a band after the last segment (`Prediction.middlebox`). The run then holds when the forget is in that band and nothing detects it. A missing forget, or one outside its band, is a finding. Without it, the router must keep the flow.
- **A group** (`measureGroup`, `timeline.ts`). The time counts from the start of the commit of the fault, or from the first write into a stall.
  - It ends at the first write that a primary accepted after the fault. That primary is a new one, or the same one after the lift, as the prediction says (`GroupPrediction.lands`).
  - The time of the acceptance is the last segment with data from that primary at the stamp of the client, or before it.
  - **The timeline.** Each stage is the first announcement of its event by any Sentinel, from the fault. The stages are `+sdown` and `+odown` of the primary, `+try-failover` and `+elected-leader`. Then `+selected-slave`, `+promoted-slave`, `+switch-master` and `+convert-to-slave`.
  - **The writes.** The run gives the writes that the old primary accepted after the fault, and the writes that a primary accepted and the group lost. It also gives each write whose outcome the client did not see. The lost writes are the cost of a split brain.
  - **The errors on the way.** The run gives each kind of error that the client met after the fault, with its first time and its count.
  - **Void runs.** A run is void when a Sentinel entered its TILT mode, or when the election split its votes. Both measured another path than the band assumes. A run whose Sentinels reached `+odown` and started no failover is void: the hold-off of an earlier failover stopped them. A band whose hold lifted more than δ_abs late is void too. The rules of the RTT and of a slow commit apply.
  - **The stamps.** A calibration gives the delay of each stamp of the observer after the write of its Sentinel that it read (`lags`).
- **A replica set** (`measureGroup`, `replicaSetStagesOf`). The outcome is the first accepted write of a write that the client sent after the commit of the fault. Thus a partial cut, which leaves the old primary its writes, gives the first write after the fault.
- **A cluster of RabbitMQ** (`measureGroup`, `clusterStagesOf`). The outcome is the first confirm of a publish that the client sent after the commit of the fault, through any node. The stages are the NOTICE and the INFO lines of Ra (`NODE_MARKS`).
  - The time of the acceptance is the last segment with data on a socket of the pool. The monitor and the pinger have their own sockets to each member.
  - **The timeline.** A log line of a member marks each stage. The first stages are a member that marks the old primary DOWN, the start of an election and its win. The last stages are the end of the catch-up, the first write of the new primary, and the step-down of the old primary.
  - The lines of the client mark the discovery of the new primary, the write-off of the old one, and the first accepted write.
  - A stage that the prediction names as quiet (`GroupPrediction.quiet`) is a finding when a run shows it. An election that another member wins is a failover.
- **A driver band** (`measureDriver`, `driver.ts`). A driver with more than one socket names the socket of its band (`DriverBand.socket`).
  - The band counts from its reference on that socket. It ends at a line of the client (`ends`), or at the report of the kernel on the socket.
  - A band that a line ends is a timer of the driver. It counts from the last segment with data that the socket received or sent. The idle timer of a Node socket starts again at each read and each write of data.
  - A band can name that segment as its reference (`last-data`). For example, an idle gRPC client goes to IDLE at a GOAWAY of its proxy. The idle timer of the proxy counts from the last data of the stream.
  - A reference that this judge does not know (for example `ping-sent`) does not come. Thus its band is a finding. Before 0.11.22, such a reference counted from the first close of a socket of the peer. Through a proxy, that close can be the idle close of a socket toward the target. Since 0.11.23, the TCP judge does the same.
  - A retry after a refusal counts from that refusal (`last-reply`), for example a 429 with `Retry-After`. That is the last segment with data that a socket of the client received before the line that ends the band. Each band gets its own, thus each retry counts from the refusal before it.
  - The retry can go on a new connection. For example, undici closes an idle socket 3 s after a reply of a server at its defaults, before a retry 30 s later. Thus `last-reply` reads each socket of the client.
  - The bands from `last-reply` follow one another. Thus the deadline of the client and the wait of the run hold their sum: five retries of 30 s take 150 s (`longestOf`).
  - The MongoDB client is ready when its first write has its reply and its monitor streams. The monitor sends its first awaited hello `minHeartbeatFrequencyMS` (500 ms) after its first check. A fault before that hello meets the start of the stream, not the stream that a cell measures.
  - Each later band (`then`) has its own reference and line. A later band outside its band, or absent, is a finding. So is a line that the prediction names as quiet, after the fault.
  - For a silent prediction, a flow of an open socket of the driver that a router forgot is a finding.
  - A silent prediction can give a band for the forget of the flow of the socket of the driver (`Prediction.middlebox`). The band counts from the last segment that the socket got before the fault. A forget of another socket of the driver is still a finding.

## The verdict

`verdictOf(prediction, runs)` (`verdict.ts`) judges a cell:

- **Containment.** Each run lands in [T_lo − δ_abs, T_hi + δ_abs]. `NOISE` (δ_abs) is 4 ms, from the calibration of the first environment: the worst reset took 1.141 ms, and δ_abs is one jiffy at the minimum.
  - **δ_abs of an environment.** A cell can give the δ_abs of its environment (`Cell.noise`). Stage 0 measures it in each environment. On a hosted runner of GitHub at HZ 1000, the worst reset took 0.147 ms, thus δ_abs is one jiffy, 1 ms. These read it (`noiseOf`): the bands, the pairing of a program line with its kernel record, and the drop of a program.
  - **The injector has its own bound.** A fault that the injector commits or lifts late makes a run void. That bound is `INJECT` (4 ms), not δ_abs. Stage 0 measures the commit apart. On a hosted runner it took up to 2.75 ms at 4 environments.
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

- **An HTTP client** (`Verdict.requests`). The verdict counts each outcome of the second request over the counted runs. A measurement-only cell also gives them in its reason.
- **The reconnect** (`Verdict.reconnect`). A wait outside its band is a finding of its run, thus the cell fails. The verdict gives the spread of each wait, of the first SYN, of the first ESTABLISHED and of the work before each connect(2). Its reason says the medians.
- **A call in flight** (`Verdict.calls`). The verdict counts each outcome of the call in flight of a WebSocket client, and its reason says them.
- **The socket after a drop** (`Verdict.left`). The verdict gives the spread of the time from a drop to the close of its socket by the program. It also counts the runs where the program did not close it. For the runs where the socket stayed open until the end of the client process, it gives the spread of that end (`exited`).

The distribution test needs a simulator, which does not exist at this time.

## Runs

- **`runCell(cell)`** (`run.ts`) divides the 11 runs of a cell across two new environments. It records the manifest of each environment, and it removes the fault after each run.
  - Each environment does one warm-up before its counted runs. On a loaded machine, a new environment is sometimes slow at first. A reset cell once measured 23 ms against a median of 0.3 ms. The result keeps the warm-ups apart (`warmups`), and the verdict does not count them. A cell whose fault ends its environment, a client `fin`, does a dry warm-up without the fault.
  - A cell with `fresh` also does a dry warm-up: its fault can change the environment for the runs after it. Behind a black hole, Pgpool-II can detach its only server, and then it refuses each new client. Such a cell has an environment for each run.
  - The `concurrency` of a cell sets how many environments operate at the same time, each with its own prober.
  - The manifest holds the kernel release, the architecture, the boot id and the Docker version. It also holds the image ids, the packages of the image, the client and the sysctls as read back.
  - A cell whose probe names a `driver` opens its labs with the client of that driver (`openLab(target, "ioredis")`).
  - The harness sets the `targetSettings` of a cell in the target before a client connects, with the `settings` commands of the target (`redis-cli CONFIG SET`, then `CONFIG GET`).
  - A group cell opens a group environment (`openGroupLab`), and each run is `groupOnce`. Its warm-up is a whole run with its fault, because no fault of a group ends its environment. The manifest also holds the settings of each member and of each Sentinel, as each part read them.
  - A replica set cell opens a replica set environment (`openReplicaSetLab`), and each run is `replicaSetOnce`. A run with a hold continues to the end of the hold, thus its record shows what the set did in all of it.
  - A cluster cell opens a cluster environment (`openClusterLab`), and each run is `clusterOnce`.
  - A driver cell (`prediction.driver`) waits for the end of its band and of each later band. A silent driver cell waits for its window.
- **The observer.** A cell observes the client, the server, or a socket of a proxy toward one side (`observer`). A cell on the server side measures the socket of the target for the connection of the client. The run waits for the error of that socket. `freeze-process` freezes the peer of the observer: the target for the client, the client for the server.
  - A socket of a proxy toward the target is the socket that carries the request of the run. It is the first socket of the hop that sends data to the target after the request. A pooler can reuse a server connection from the warm-up of the environment. Then the first socket that it opens in the run is not the socket of the request. A run without such a socket uses the first socket that the run opens.
  - A cell on the server side sets the sysctls of the target through `targetSysctls`, with a privileged sidecar in the namespace of the target. That sidecar starts only when a cell asks for it.
  - Its in-flight data is the reply of the server. Thus the client sends `probe.request` first, for example a BLPOP with a timeout, and the fault occurs while the server holds it.
- **The pause before the fault.** In every other run, the fault comes 250 ms after the client's first reply (`QUIET_MS`). That is more than Linux's longest delayed ACK, 200 ms. A fault that comes earlier meets the client's delayed ACK of the reply, not the request or the idle time that the cell measures. On a fast host the fault came 35 ms after the reply, and the ACK met a reset first.
  - A run of a group has no such pause. Its fault comes after the 20th accepted write of its stream, and each band of a group counts from the fault.
  - An HTTP client in a gap counts its gap from its own first reply, thus the pause does not change it. Its run ends at the end of its second request (`done`).
- **An HTTP client.** A run of an HTTP client in flight ends at the end of its second request, after a new try of the client. The client waits one second after it (`LINGER_MS`), thus its own close comes after the window.
- **A program with its own detector.** The wait for the detection also ends at a `drop` line of the client, or of a target that writes lines. After the harness removes the fault, the run waits for the tries that the prediction gives: one `dial` line for each.
- **`judge(cell, runs)`** (`run.ts`) measures and judges the raw records of a cell with the code at this time. `runCell` uses it during a cell. A holder of raw records can judge them again after a change to `observe.ts` or to the verdict.
- **Testcontainers loads when a lab first opens.** Code that only measures and judges does not load it.

## Installation

```sh
pnpm add @mark1russell7/harness zod
```

A run needs Docker, and privileged containers for the prober and the sidecars. The kernel must have BTF (`/sys/kernel/btf/vmlinux`). The schemas of the data of a caller are in the entry `@mark1russell7/harness/schema`.

## Tests

`pnpm --filter @mark1russell7/harness test` starts the tests. They measure test records with the shape of real kernel records (keepalive, and the tail loss probe before the retransmissions of the RTO timer). They also test the containment, the median equivalence, the extension and the silence of the verdict.

The tests also measure a group run from test lines. They find the first accepted write, the stages, the writes that the group kept, and the void runs. They test the views that make a group healthy, and the peers that a fault on a part cuts.

The tests of a replica set read the log of mongod, and they put its lines on the monotonic clock. They test the views that make a set healthy and the peers of each cut. They measure the stages of a set and the bands of a driver from test lines.

The tests of a cluster read the console log of RabbitMQ. They test the views that make a queue healthy, and the peers of each cut. They measure the stages of a cluster from test lines.

The tests of `image.ts` plan the build of each image that the harness ships, and of a build context of a caller. They test the rules of a build, the problems of a source and of a subject, and the schemas.

The tests of `application.ts` measure a heartbeat of a program from test lines and records. They find the first ping without an answer, the drop, the waits of the reconnect and the call in flight. They also test a report of the kernel before the drop, a VM that stopped, the heartbeat of a server, and an idle stall.

The cells themselves need Docker and privileged containers. CI does not start them. `HARNESS_LAB=1` starts the lab tests on Docker. They start a client image and an agent, and they put a reset and netem at a router. They also fail a group of Valkey 9.1 over with a planned failover.

In the lab tests, each HTTP client sends two requests on one connection to a Node server, from a script in the stock Node image. The procedures WebSocket client drops a silent connection on its heartbeat, and it connects again to the procedures server. With the global `WebSocket`, the drop writes a close frame. With the `WebSocket` of ws, the socket leaves ESTABLISHED at once. The subject of that test is a build context that the test gives, as another repository gives its own subject.

The lab tests also step a replica set of three members of MongoDB 9.0.4 down, and they write the free memory of the machine. They also reset a write of the MongoDB driver in flight to a set of one member. They move the leadership of a quorum queue of a cluster of three nodes of RabbitMQ 4.3.6.

`pnpm --filter @mark1russell7/harness build` writes the package for npm into `build/`.
