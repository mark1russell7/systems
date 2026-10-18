# @mark1russell7/service

A service that you declare as data before it starts. You compose it with plain calls: its dependencies, its checks, its policies and its shutdown. `describe()` gives the whole graph as data, and it starts nothing. `lint()` then applies the timer-ordering law to that graph. `start()` gives the graph to the health runtime, and `run()` starts the whole lifecycle.

This release has the declaration, its export, the law, the health runtime and the lifecycle. The wrappers of the clients come in a later release.

## What the package does

- **The builder.** `service(name)` gives a builder. You add each part with a call: `svc.dependency(…)`, `svc.server(…)`, `svc.controller("checkout").requires(…).route(…)`, `svc.check(check, run)`, the policies, the couplings and the shutdown phases.
- **No defaults.** The runtime has no defaults of its own. Thus `describe()` refuses a service that does not declare its readiness, its liveness, its startup budget, its shutdown phases or its cooperative window. The error tells which. `start()` also refuses a check without its function.
- **One timing shape.** Each policy has a `Timing`: a debounce of polls, or a window of time. Each converts to the other (`asWindow`, `asDebounce`). `failSpan` and `recoverSpan` give the earliest and the latest time to detect a change. At 3 polls of 5 s ± 20 %, a latch fails in 8–18 s on an error, and in 12–22 s on a 4 s timeout.
- **Checks.** A check names the step of the connection that it examines (`dial`, `round-trip`, `checkout` and others). It also tells if it uses the connection of the application, and which policy it controls. The policy has no default.
- **Idempotency for each operation.** One dependency has the two kinds of operation. A Redis GET is safe to send again. An INCR that goes again after a timeout counts two times. Thus each operation of a dependency, and each route of a controller, declares if it can go again: `true`, `false`, or keyed.
- **Keyed operations.** A keyed operation has the window that the server keeps its key for. `mayReissue` answers from the declaration of an operation. An operation without a declaration does not go again.
- **The law.** `evaluate` and `verdictOf` decide one rule of the timer-ordering law on one binding. A rule is data: linear inequalities over `symbol@hop`, with a margin. A verdict is `holds`, `violated`, `unbounded` (it holds only because a timer is absent) or `depends` (nothing is bound).
- **The linter.** `lint(description, scenario, rules)` applies the service rules (`SERVICE_RULES`) to a declaration. The declaration binds the symbols of the service: the polls of its checks, the windows of its policies, its drain. The scenario binds the symbols of the platform and of each dependency. A `depends` finding names the symbols that have no bound.
- **The hold.** The cap of the `fail readiness` phase binds `readiness_hold@process`, and a service without that phase holds for zero. The hold keeps the listener open after the signal, as a preStop sleep does. Thus O04 can compare the sum of the two with the propagation of the endpoints.

The format of a description is `mark1russell7.service/1`.

## The health runtime

`await svc.start()` closes the composition and gives a `Health`. The runtime reads each timing, poll and coupling from the description.

- **Checks on their own loops.** Each check polls on a fixed delay from the start of each poll, with its jitter. Each poll has a timeout, and the runtime aborts the signal of the check at that timeout. An answer is `"ok"`, `"error"` or `"indeterminate"`. A throw is an error with a flag. An indeterminate poll measured nothing, thus it moves no streak.
- **A pending use is not started again.** While a use of a check is pending, each later poll fails at once with the same cause. Thus a check that hangs fails a debounce of two polls or more as fast as an error does (`failSpan(timing, poll, "hang")`).
- **A latch for each check that gates a policy.** A debounce counts polls in sequence. A window measures time on the monotonic clock from the first failure of a sequence. A readiness latch starts tripped, thus readiness is earned. A liveness latch starts released.
- **The start.** `start()` makes one warm-up sweep of each check, bounded by each timeout, and then starts the loops. The startup probe fails until the sweep ends. `svc.health` gives the runtime from the start of `start()`, thus the probes can answer during the sweep. The verdict says when the sweep outlasts the startup budget.
- **The verdicts.** `health.verdict()` gives started, draining, ready, alive, each controller, each dependency and each check. The service is ready when it started, it does not drain, and each readiness latch is released. A controller is ready when its own dependencies are ready. Thus a failed dependency fails only the controllers that need it.
- **Couplings.** A declared coupling fails a policy when the other one fails, for example `{ from: "liveness", to: "readiness", effect: "fails" }`. Without a declaration, no coupling applies.
- **Late parts.** A check that joins after the start polls at once, and its readiness latch starts tripped until its first pass. A dependency that joins after the start is tripped until a check on it passes.
- **Probes from the cache.** `health.probe("startup" | "readiness" | "liveness" | "report", controller?)` gives a status (200 or 503) and an `application/health+json` body, for any HTTP framework. A probe starts no check. The report always answers 200, with the whole verdict.
- **Seams for tests.** `health.forceFail(name, true)` makes the polls of a check or a dependency fail at once. `health.drain()` fails readiness for good. `health.stop()` stops each loop and each timer, and the timers of the real clock do not keep a Node process alive.

## The lifecycle

`await svc.run()` starts the whole life of the service, and gives a `Lifecycle` when the startup ends. It refuses a declaration that it cannot start: a transport without its implementation, or a stage with work and no declared phase.

- **The parts.** `svc.server(name, knobs, impl)`, `svc.consumer(…)` and `svc.worker(…)` give a transport its implementation. Each transport has one contract: `start(signal, life)`, `stopIntake`, `drain(deadline, signal)`, `inFlight` and `close`. `svc.dependency(name, spec, handle)` gives a dependency a handle that connects and closes. `svc.healthServer(server)` gives the server of the probes.
- **The startup.** The health server starts first, thus the probes answer while the dependencies connect. Then each dependency connects, in its declared sequence. Then each transport starts, and the startup gate opens last, after one warm-up sweep of each check. A part that does not start fails the startup. Then only the parts that started stop, and the exit code is 1.
- **The startup budget.** When the gate is not open at the end of its budget, the gate says so. The runtime does not stop itself, because the startup probe of the platform acts on it.
- **The signals.** The runtime owns the handlers of SIGINT, SIGTERM and SIGQUIT. The first signal starts the shutdown. A signal during the startup gets its shutdown after the startup ends.
- **A repeat signal.** With `svc.onRepeatSignal("exit")`, a signal during the shutdown ends the process at once, with the code 1. With `"ignore"`, or without a declaration, a repeat signal has no effect. A second `shutdown()` and a second process trigger do not end the process.
- **Process triggers.** `svc.trigger("stdin-close")` starts the shutdown when the standard input ends, as when the parent of a stdio child stops. `"ipc-close"` starts it when the IPC channel to the parent closes. Each trigger is opt-in. The process must read its input, as a stdio transport does, or Node does not see the end.
- **The shutdown.** Readiness fails first. Then the declared phases occur in their sequence, and each phase races its cap. `svc.onPhase(name, work)` adds the work of an owner to a phase.
- **The stages.** A declared phase with the name of a stage gets the work of that stage. The stages are `fail readiness`, `stop intake`, `drain`, `close transports`, `stop the poller`, `tear down dependencies`, `close the health server` and `flush the output`. The phase `fail readiness` holds for its cap while the endpoints update. The signal of the service aborts after the poller stops. `describe()` refuses the stages out of their sequence.
- **The cooperative abort.** During the drain, the requests and the transports get a signal that aborts at the cap less the cooperative window. With the floor `half`, that time is half the cap at the least, and a window without a bound gives half the cap. With `svc.cooperativeFloor("none")`, a window of the whole cap aborts the work at the start of the drain.
- **Requests.** `life.request(controller, route, work)` does one request on a declared route. While the service cannot take new work, it refuses the request with a retryable 503. That occurs before the start, after the intake stops, or while the controller is not ready.
- **Requests while the transports start.** Each transport gets the lifecycle at its start, and `svc.lifecycle` gives it from the start of `run()`. Thus a transport tracks its requests from its start. A request before the end of the startup gets a retryable 503, and `keepAlive()` is false.
- **Cut requests.** When the drain cuts a request, an idempotent route answers 503, retryable. Each other route answers 500, because the work can have had its effect. A keyed route is retryable only while the server keeps its key.
- **Keep-alive.** `life.keepAlive()` is false while the service is not ready. Thus each response then closes its connection.
- **The exit.** Only the lifecycle ends the process, through its `ProcessPort`. The exit code is 0 after a clean shutdown. It is 1 after an error: a startup that failed, a phase whose work did not end in its cap, or a work that threw. A phase over its cap does not stop the sequence.
- **Exit codes.** `life.shutdown(cause, { code })` gives the exit code of the work, a whole number from 0 to 255. The first request with a code sets it. `svc.exitCode(trigger, code)` gives the code of a shutdown that a trigger starts, for example 130 for SIGINT. A code that is not 0 stays after an error. A code of 0, or no code, becomes 1 after an error.
- **The output.** The stage `flush the output` comes last. The owners of the phase write their last output first, for example a log or a trace exporter. Then the `ProcessPort` writes the buffered output of stdout and stderr, in the cap of the stage. Without this phase, the process exits without a wait, as in 0.4.
- **The watchdog.** `svc.watchdog(spec)` declares a check on the event loop. A blocked loop delays each timer, thus a tick that comes late by more than the threshold fails the check. A liveness window then reads the wedge of the process.

## The machines

The machines of the runtime are `mark1russell7.machine/1` documents, which `@mark1russell7/algebra` reads. They are the gate, the latch (a debounce), the window, the poller, the exit manager and the watchdog. `drainMachine(description)` gives the drain of a declaration, with one state for each phase. Each machine gives its transitions to `run({ record })` or `start({ record })`. `replay(doc, events)` gives each transition that the document does not permit. It is the replay of `@mark1russell7/algebra`, which reads a machine of any name.

The tests replay the real runtime against each document. They also compare each timer of the documents, from the algebra, with the time that the runtime keeps.

## Composition

A process has one service, and one entry that uses `run()`. A component gives parts to that service, and it does not start them. For example, a component is the procedures host of another repository, or one of the HTTP hosts of a process.

- **The parts.** A component gives a `TransportImpl` for each source of work, a `DependencyHandle` for each dependency that it owns, and each check with its `CheckFn`. It can also give work for a declared phase (`onPhase`).
- **The entry.** The entry declares one service: the parts of each component, the policies, the startup budget, the phases and the cooperative window. Only the entry uses `run()`. Thus the process has one set of signal handlers, one staged shutdown and one exit.
- **What a component does not do.** A component does not use `start()` or `run()`. It installs no signal handler, and it does not end the process. A service has one health server, thus the entry chooses it.
- **Names.** A service refuses a second part of one kind with the same name. Thus the entry gives each component a prefix, for example `app.http` and `ingest.http`.
- **The sequence.** The lifecycle connects the dependencies of all components in their declared sequence, and then it starts each transport. Each stage of the shutdown acts on the transports of all components together. The dependencies close in the reverse sequence.
- **Requests.** The transports start before the startup ends, but `run()` gives the `Lifecycle` only at that end. Thus each transport gets the lifecycle at its start (`start(signal, life)`), and its request tracking operates at once.
- **The builder form.** A component can also take the builder of the entry and declare its parts on it. The Redis client does this: `attach(svc, options)` declares its dependency, its handle and its checks.

```ts
import type { Extent } from "@mark1russell7/quantity";
import { service } from "@mark1russell7/service";
import type { Check, CheckFn, Dependency, DependencyHandle, ServiceBuilder, TransportImpl } from "@mark1russell7/service";

// the parts of a component, as data: the component declares nothing, and it does not run
interface Parts {
  readonly servers: ReadonlyArray<{ name: string; knobs: Record<string, Extent>; impl: TransportImpl }>;
  readonly dependencies: ReadonlyArray<{ name: string; spec: Omit<Dependency, "name">; handle: DependencyHandle }>;
  readonly checks: ReadonlyArray<{ check: Check; run: CheckFn }>;
}

const declare = (svc: ServiceBuilder, parts: Parts): void => {
  for (const { name, spec, handle } of parts.dependencies) svc.dependency(name, spec, handle);
  for (const { name, knobs, impl } of parts.servers) svc.server(name, knobs, impl);
  for (const { check, run } of parts.checks) svc.check(check, run);
};

const s = (value: number) => ({ value, unit: "s" });
const svc = service("app");
// three hosts in one process: each component gives its parts under its own prefix
for (const [prefix, port] of [["app", 4820], ["ingest", 4830], ["remote", 4840]] as const)
  declare(svc, createHost({ prefix, port }));
svc
  .healthServer(probes) // the entry chooses the one health server of the process
  .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
  .liveness({ type: "window", failAfter: s(45) })
  .startup(s(60))
  .phase("fail readiness", s(2))
  .phase("stop intake", s(5))
  .phase("drain", s(15))
  .phase("close transports", s(2))
  .phase("stop the poller", s(1))
  .phase("tear down dependencies", s(2))
  .phase("close the health server", s(1))
  .cooperativeWindow(s(5));

const life = await svc.run(); // only the entry calls run(), and the process exits after the shutdown
```

The requirements that the lifecycle follows are in [the requirements of S6](https://github.com/mark1russell7/systems/blob/main/docs/S6.md).

## Profiles

A profile is a part of a declaration as data: the phases, the cooperative window, the policies and the rules of the shutdown. `svc.profile(profile)` declares each field of a profile, as the method of that field does. The runtime still has no defaults, because the caller gives the profile. The caller changes a field with a spread, and `describe()` shows the values.

| Profile | For | What it declares |
| --- | --- | --- |
| `localDev` | A service on the computer of a developer | No readiness hold, caps that sum to 10 s, a flush of the output, and an exit on a second signal |
| `kubernetes({ grace, preStop })` | A pod | Caps from the grace less the preStop sleep, and no effect for a repeat signal |
| `ephemeral` | A command that runs one time, or a stdio child | No gating checks, an abort at the start of the drain, a flush of the output, and the exit codes 130, 143 and 131 |

- **Kubernetes.** The budget is the grace less the preStop sleep: the time from SIGTERM to SIGKILL. The stages get 2, 5, 15, 2, 1, 2 and 1 thirtieths of the budget, rounded down to the millisecond. The cooperative window is 5 thirtieths. Thus 2 thirtieths stay as a margin, and O10 and O16 hold.
- **The defaults of Kubernetes.** At a grace of 30 s and no preStop hook, the caps are 2, 5, 15, 2, 1, 2 and 1 s, with a window of 5 s. These are the caps of jarvis and of the kind lab.
- **Local development.** No load balancer routes to a computer of a developer, thus the profile has no readiness hold. A second Ctrl-C exits at once.
- **The policies.** `localDev` and `kubernetes` do not declare readiness, liveness or the startup budget, because they depend on the checks of the service.

```ts
import { kubernetes, service } from "@mark1russell7/service";

const s = (value: number) => ({ value, unit: "s" });
const svc = service("app")
  .profile({ ...kubernetes({ grace: s(60), preStop: s(5) }), onRepeatSignal: "exit" })
  .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
  .liveness({ type: "window", failAfter: s(45) })
  .startup(s(60));
```

### A small process

A command that runs one time and a stdio child also use `run()`. Then the process has one shutdown and one exit, with the code of its work. The minimal declaration has no probes, no health server and no checks.

```ts
import { ephemeral, service } from "@mark1russell7/service";

// a stdio child: the end of stdin starts the staged shutdown
const mcp = service("mcp").profile({ ...ephemeral, triggers: ["stdin-close"] }).server("stdio", {}, stdio);
mcp.controller("tools").route("tools/call", { idempotent: false });
await mcp.run();

// a command: it runs one time, and the process exits with its code
const tool = service("tool").profile(ephemeral);
tool.controller("command").route("RUN", { idempotent: false });
const life = await tool.run();
const outcome = await life.request("command", "RUN", (signal) => main(signal));
await life.shutdown("the command ended", { code: outcome.kind === "done" ? outcome.value : 1 });
```

- **The declaration.** The profile `ephemeral` gives the policies, the startup budget, the phases and the rules of the shutdown. The recipe passes `describe()` and `lint()`, and a test holds it to them.
- **Ctrl-C.** The floor of the cooperative abort is `none`, and the window is the whole drain. Thus a first Ctrl-C stops the work at once, and the process exits 130. A second Ctrl-C exits 1 at once.
- **The output.** The stage `flush the output` waits for stdout and stderr. Thus the last lines of a command are not cut.
- **The dependencies.** The phase `tear down dependencies` caps the close of the dependencies at 2 s.

## The timers

The clock, the heartbeat and the backoff have their own entries. Each entry imports no `node:` module, no zod and no other package. Thus a client in a browser can use them. Each entry is less than 1 kB of gzip. The root of the package also gives each function.

| Entry | Exports |
| --- | --- |
| `@mark1russell7/service/clock` | `Clock`, `Cancel`, `realClock`, `platformClock` |
| `@mark1russell7/service/heartbeat` | `heartbeat`, `detectionTime` |
| `@mark1russell7/service/backoff` | `backoffDelay`, `backoffBand`, `backoffProblems` |

- **The clock.** `platformClock({ unref })` gives a clock on `performance.now()` and `setTimeout`. With `unref: true`, its timers do not keep a Node process alive. `realClock` is that clock. Each cancel also has `unref`, for one timer.
- **The heartbeat.** `heartbeat(options)` sends a ping each interval, and a timeout bounds each ping. A ping without an answer at its timeout is a miss. The last of `misses` misses in sequence starts `onDead`.
- **Two kinds of ping.** A ping gives its answer as a promise, as a request and its reply do. Or the answer comes later through `answer()`, as a pong message does.
- **The hooks of a heartbeat.** At each tick, `due` tells if the tick sends a ping. `live` tells if a miss counts. `turn` waits one turn of the event loop before the heartbeat counts. Without `overlap`, the heartbeat sends one ping at a time.
- **The detection time.** `detectionTime(interval, timeout, misses)` gives the most time to find a silent peer: `misses` intervals plus a timeout. `heartbeatDetection` gives that time as an amount for the law.
- **The backoff.** `backoffDelay(policy, attempt, random)` gives the delay before a try: `base × factor^(attempt − 1)`, at most `cap`, with a jitter. The first try is 1.
- **The jitter.** The jitter `subtract` takes a random part of the delay away, and a fraction of 1 is the full jitter. The jitter `add` adds a random time up to an amount.
- **The band.** `backoffBand(policy, attempt)` gives the least and the most delay of one try. Without a try, it covers each try. The law reads the most delay from it. `backoffProblems(policy)` names each value that the delays cannot use.
- **Milliseconds.** These functions take times in milliseconds, as the clock does. The declaration and the law keep their amounts (`Quantity`).

```ts
import { backoffDelay } from "@mark1russell7/service/backoff";
import { heartbeat } from "@mark1russell7/service/heartbeat";

const beat = heartbeat({
  interval: 30_000,
  timeout: 10_000,
  misses: 2,
  ping: () => socket.send(JSON.stringify({ type: "ping" })),
  onDead: () => socket.close(),
});
socket.addEventListener("message", (event) => {
  if (JSON.parse(event.data).type === "pong") beat.answer();
});

// full jitter: a random time from 0 to the backoff
const delay = backoffDelay({ base: 1000, factor: 1.5, cap: 30_000, jitter: { kind: "subtract", fraction: 1 } }, attempt);
```

## The testing subpath

`@mark1russell7/service/testing` has the seams that a test of a service needs:

- `fakeClock()` gives a clock that moves only on `advance(ms)`. Pass it to `start({ clock })`, and the timing of the runtime is exact and repeatable. `block(ms)` moves the clock and starts no timer, as a blocked event loop does.
- `fakeProcess({ flush, clock })` gives a process port that takes signals and process triggers from a test (`signal(name)`, `trigger(name)`). It keeps each exit code in place of an exit. `flush` is its flush of the output, and `log` gives the time of each flush and each exit.
- `seeded(seed)` gives a seeded random number generator for the jitter (`start({ random })`).
- `scriptedCheck(behavior)` gives a check whose behavior a test sets: `"ok"`, `"error"`, `"indeterminate"`, `"throw"`, `"timeout"` or `"hang"`.
- `quietServer()` starts a TCP echo server that can go quiet. Its connections stay open while it is quiet, as with a frozen peer.
- `contractCases(declare)` generates the contract test of a declaration. The cases are the service at rest, each dependency unavailable, each dependency degraded by 100 ms, each recovery, and a negative control. A dependency that no check exercises is a finding, and so is a check whose timeout a latency of 100 ms fails.

## The Redis client

`@mark1russell7/service/redis` is the first client of the service: Redis, over ioredis 6. ioredis is an optional peer dependency. The client loads it only when it connects.

- **The declaration.** `redisClient(name, spec)` declares its knobs by the names of the ordering law: `connect_bound`, `request_timeout`, `driver_writeoff_time`, `heartbeat_interval`, `client_retry_window` and others. Each knob is necessary, and a bound that nobody gives is "infinite". The client derives `heartbeat_detection_time` from its watchdog. Thus `lint()` evaluates the rules of the client (O13, O15, O17, O21, O27) on the declaration.
- **The settings of ioredis.** The client gives ioredis each timer from the declaration. It turns off the offline queue, and it does not let ioredis send a command again. Thus a command while the client is not ready fails at once, and the command did not leave the client.
- **The retry strategy.** `retryBackoff(knobs)` gives the backoff of the tries to connect: from `retry_base`, doubling to `retry_cap`, each delay with a jitter up to the base. The tries stop at the end of `client_retry_window`.
- **Three outcomes.** `send(command, args)` gives `ok`, `error` or `indeterminate`. An error is a reply of the server, or a command that did not leave the client. An indeterminate command can have reached the server. When its connection closes, each command in flight becomes indeterminate at once, not at its timeout.
- **Idempotency for each command.** A table declares the idempotency of each common command, and a declaration can change it. The client sends an idempotent command again one time at most, in the bound of the request. It does not send again a command that is not idempotent, or that the table does not name.
- **The join.** At each `ready`, the client records `CLIENT ID` and the socket of the connection (`joins`). The prober joins its kernel records to the view of the server with it.
- **The watchdog.** A `heartbeat` of `PING` commands on the connection of the application, each interval. An error reply is an answer. After the misses of the declaration, the watchdog closes the connection, and the client connects again. The watchdog acts only on a ready connection, and it starts again a client whose retry window ended.
- **The checks.** `checks({ poll, steps })` gives a check for each step: `local-state`, `round-trip` (a `PING` on the connection of the application) and `dial` (a new connection). Each one controls readiness, liveness or nothing. `attach(svc, options)` declares the dependency, its handle and its checks.
- **The close.** At the shutdown, the client sends `QUIT`, and it disconnects at its `close_bound`. Thus a silent server cannot hold the phase past its cap.
- **The manifestations.** `meets` lists the manifestations that the client can meet, and the detectors of each, with their times from the knobs. `unwatched(meets)` lists each manifestation and situation that no detector finds.
- **The machine.** `REDIS_CLIENT_MACHINE` is the client as a `mark1russell7.machine/1` document. The tests replay the transitions of the client against it.

## Installation

```sh
pnpm add @mark1russell7/service
```

For the Redis client, the application also installs `ioredis@6`.

The package uses [`@mark1russell7/quantity`](https://www.npmjs.com/package/@mark1russell7/quantity) for each amount. No entry of the service loads `zod` at run time, thus `zod` is an optional peer dependency. An application that validates amounts with the schemas of `quantity` installs `zod`.

## Example

```ts
import { lint, service } from "@mark1russell7/service";
import type { Rule } from "@mark1russell7/service";

const s = (value: number) => ({ value, unit: "s" });
const poll = { interval: s(5), jitter: 0.2, timeout: s(4) };

const svc = service("app")
  .dependency("db", {
    system: null,
    knobs: { request_timeout: s(10) },
    operations: { SELECT: { idempotent: true }, INSERT: { idempotent: false } },
  })
  .check(
    { name: "db.round-trip", dependency: "db", step: "round-trip", ownConnection: true, gates: "readiness", poll },
    async (signal) => {
      await db.query("SELECT 1", { signal });
    },
  )
  .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
  .liveness({ type: "window", failAfter: s(45) })
  .startup(s(60))
  .couple({ from: "liveness", to: "readiness", effect: "fails" })
  .phase("fail readiness", s(2))
  .phase("drain", s(15))
  .cooperativeWindow(s(5));

const rules: Rule[] = []; // the rules of the law, as data
const scenario = {
  platform: { "termination_grace@pod": s(30), "prestop_sleep@pod": s(5) },
  probes: { readiness: s(30), liveness: s(30) },
};
const findings = lint(svc.describe(), scenario, rules);

const health = await svc.start();
const answer = health.probe("readiness"); // { status: 200, contentType, body }
```

A service that starts its whole lifecycle declares its parts and each stage of its shutdown:

```ts
const app = service("app")
  .dependency("db", { system: null, knobs: {}, operations: {} }, { connect: () => db.connect(), close: () => db.end() })
  .server("http", {}, httpTransport)
  .healthServer(probeServer)
  .check(roundTrip, roundTripFn)
  .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
  .liveness({ type: "window", failAfter: s(45) })
  .startup(s(60))
  .phase("fail readiness", s(2))
  .phase("stop intake", s(5))
  .phase("drain", s(15))
  .phase("close transports", s(2))
  .phase("stop the poller", s(1))
  .phase("tear down dependencies", s(2))
  .phase("close the health server", s(1))
  .cooperativeWindow(s(5));
app.controller("orders").requires("db").route("POST /orders", { idempotent: false });

const life = await app.run(); // the process exits after SIGTERM, with 0 or 1
const outcome = await life.request("orders", "POST /orders", (signal) => createOrder(signal));
```

## Tests

`pnpm --filter @mark1russell7/service test` starts the tests:

- **The algebra and the builder.** The timing algebra, the refusals of the builder, its partial export, and the four verdicts of the law. A test in jarvis compares this evaluator with the evaluator of the research, on 185 bindings. All decisions agree.
- **The permutations.** The permutations cross the policy, the timing, the poll interval, the jitter and the way that the step fails. For each one, a latch on a fake clock must trip inside `failSpan` and recover inside `recoverSpan`. Each permutation has eight seeds for the jitter and the phase of the fault. A failure names its permutation and its seed. Two more tests show that the bounds are reached.
- **The edges.** These tests cover a flapping signal, a check that does not answer at any time, and late parts. They also cover couplings, controllers, the force-fail list, the drain, the stop, and the loop of a slow check.
- **Real time.** The runtime on the real clock, and a check against a quiet server over TCP.
- **The lifecycle.** These tests cover the startup in its sequence, a startup that fails, and a signal during the startup. They cover the shutdown in its phases, the answers of the requests and keep-alive. They also cover a phase over its cap, a work that throws, the refusals of the declaration, and a blocked event loop (21 s).
- **The shutdown by permutation.** These 144 permutations cross when the signal comes, the cap of the drain, the work in flight and the cooperative window. Each one checks the sequence and the caps of the phases, and readiness in the hold. It also checks the cooperative abort, the teardown, the answer of each request and the exit.
- **The startup by permutation.** These 48 permutations cross the budget, the warm-up of a check, the time of a connection and a late dependency.
- **Mutations.** Five mutations of the runtime each fail between 48 and 148 tests.
- **The machines.** Each document is valid, consistent and readable by the algebra. Eight scenarios replay against the documents and reach each state. The timers of the documents give the times of the runtime. The ordering law (O16) agrees with the clamp of the cooperative abort.
- **The contract.** The contract of a sample declaration passes. The contract also finds a blind dependency, a check whose timeout is too short, and a check that names the wrong dependency.
- **The Redis client.** These tests use a fake ioredis and a fake clock. They cover the declaration, the three outcomes, and the commands that the client sends again or not. They also cover the join, the backoff, the watchdog, the close, the checks and the manifestations. Five scenarios replay against the document of the client.
- **F6 for Redis.** The fault matrix crosses each manifestation (a refusal, a frozen process, a black hole, a death without a close, and an app stall), each gating posture, two timings and two jitters. That is 60 cases on the fake. Each case holds the trip and the release of its policy to `failSpan` and `recoverSpan`. Five more cases shut the service down during each manifestation, and each one exits 0.
- **The timers.** These tests use a fake clock, and they cover the hooks of the heartbeat and its two kinds of ping. A property test holds the death of a silent peer to `detectionTime` in 300 seeded cases. Another one compares the heartbeat with a WebSocket heartbeat that sends one ping at a time, on 300 schedules of pongs. The backoff gives the delays of three earlier backoffs, number for number, and each delay is in its band.
- **The entries.** The timer entries reach no other package, no `node:` module and no zod. No entry of the service reaches zod, also through `quantity` and the replay of the algebra.
- **The options of the runner.** These tests cover the requests of a transport while the startup runs, the policy of a repeat signal, the profiles and the process triggers. They also cover the exit codes, a first Ctrl-C that aborts at once, and the flush of the output.
- **The composition.** Two components, each with a transport, a dependency and a check, share one service and one `run()`. The parts start and stop in their sequence, and the process exits one time.
- **The process port.** The port of Node, on a fake host: the signals, the end of stdin, the close of the IPC channel, the flush and the exit.
- **Against a real Redis.** `REDIS_IT=1` starts the tests of the client against Redis 7.4. `REDIS_F6=1` starts the F6 matrix in the VM of Docker. The injector of `@mark1russell7/harness` makes the network faults, and an agent in the namespaces of Redis makes the process faults. All of them use one monotonic clock.

`pnpm --filter @mark1russell7/service build` writes the package for npm into `build/`.
