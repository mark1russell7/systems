# @mark1russell7/service

A service that you declare as data before it starts. You compose it with plain calls: its dependencies, its checks, its policies and its shutdown. `describe()` gives the whole graph as data, and it starts nothing. `lint()` then applies the timer-ordering law to that graph. `start()` gives the graph to the health runtime, and `run()` starts the whole lifecycle.

This release has the declaration, its export, the law, the health runtime, the lifecycle and the edge of a service in Node (`@mark1russell7/service/http`). The wrappers of the clients come in a later release.

## What the package does

- **The builder.** `service(name)` gives a builder. You add each part with a call: `svc.dependency(…)`, `svc.server(…)`, `svc.controller("checkout").requires(…).route(…)`, `svc.check(check, run)`, the policies, the couplings and the shutdown phases.
- **No defaults.** The runtime has no defaults of its own. Thus `describe()` refuses a service that does not declare its readiness, its liveness, its startup budget, its shutdown phases or its cooperative window. It also refuses a service that does not declare what a repeat signal does. The error tells which. `start()` also refuses a check without its function.
- **One timing shape.** Each policy has a `Timing`: a debounce of polls, or a window of time. Each converts to the other (`asWindow`, `asDebounce`). `failSpan` and `recoverSpan` give the earliest and the latest time to detect a change. At 3 polls of 5 s ± 20 %, a latch fails in 8–18 s on an error, and in 12–22 s on a 4 s timeout.
- **Checks.** A check names the step of the connection that it examines (`dial`, `round-trip`, `checkout` and others). It also tells if it uses the connection of the application, and which policy it controls. The policy has no default.
- **The catalog of a client.** The checks of each client name the steps that they gate: `steps: { "round-trip": "readiness" }`. With `catalog: true`, the client also gives a check for each other step that it has. These checks gate nothing and poll each 30 s. A nominated step that the client does not have then fails the attach. The name of each check is the pair of the component and the step (`db.round-trip`).
- **Idempotency for each operation.** One dependency has the two kinds of operation. A Redis GET is safe to send again. An INCR that goes again after a timeout counts two times. Thus each operation of a dependency, and each route of a controller, declares if it can go again: `true`, `false`, or keyed.
- **Keyed operations.** A keyed operation has the window that the server keeps its key for. `mayReissue` answers from the declaration of an operation. An operation without a declaration does not go again.
- **The law.** `evaluate` and `verdictOf` decide one rule of the timer-ordering law on one binding. A rule is data: linear inequalities over `symbol@hop`, with a margin. A verdict is `holds`, `violated`, `unbounded` (it holds only because a timer is absent) or `depends` (nothing is bound).
- **The linter.** `lint(description, scenario, rules)` applies the service rules (`SERVICE_RULES`) to a declaration. The declaration binds the symbols of the service: the polls of its checks, the windows of its policies, its drain. The scenario binds the symbols of the platform and of each dependency. A `depends` finding names the symbols that have no bound.
- **The claims of a scenario.** A default is true only for a version: the keep-alive of Node is 5 s, but 65 s on main. Thus a value of the scenario can be a claim that names its epoch: `{ epoch: "node@22", value }`. Each finding then gives the epoch of each value that its rule reads (`epochs`).
- **A measured value.** A claim can give a distribution by its statistics: `{ epoch, distribution: { p50, p99 } }`. The law binds the p99. A distribution without a p99 binds nothing, thus each rule that reads it depends.
- **The four ways that a pod stops.** `STOPS` gives the steps of each way. A deletion and a liveness restart have the preStop hook and the drain. A crash and an OOM stop have neither. `lintStop(description, scenario, rules, way)` applies only the rules of the drain that guard that way: O04 for a deletion, O09 for a liveness restart. For a crash or an OOM stop, a finding of `STOP_RULE` depends on the time until the kubelet finds the exit.
- **The scopes of a rule.** A rule about a client applies one time for each dependency. A rule about a consumer, for example O20, applies one time for each consumer and each worker.
- **The scope of a server.** A rule with a symbol at `@server`, for example O19, also applies one time for each server transport. The knobs of the transport bind at `@server`, for example `server_idle_close@server`. `scenario.transports[name]` gives the client side, for example `request_timeout@client`. Without it, the finding is `depends`. In the scope of a dependency, `@server` is the server of the dependency. Thus the knobs of a server of the service do not bind there.
- **The loops of a progress check.** A check of the step `progress` can name the loops that mark it, with its stall time: `marks: { loops, stall }`. Each loop is a check or a worker of the service.
- **The stall time.** `lint()` compares the stall time with the longest gap between two marks of the slowest loop (`PROGRESS_RULE`). A loop marks at the end of each turn, also a turn that fails. The gap of a check is `interval × (1 + jitter) + timeout`. The gap of a worker is its sleep or its longest backoff, the longer one, plus `unit_processing_time`. At 300 s ± 20 % and a timeout of 10 s, a poll gives 370 s.
- **The marks of the timers.** A harness that runs a service k times faster scales its timers. Each timer has a mark: `scalable`, `fixed`, `stepped` (only multiples of a step) or `floored` (a peer sets a floor).
- **The compression of a service.** `compressionOf(description, scenario, rules, k, marks)` gives each rule and scope whose verdict the compression changes. It also names the symbols that have no mark. `PLATFORM_MARKS` marks the timers of Kubernetes. For example, the propagation of the endpoints is `fixed`, thus a compression of the hold of O04 can break O04.
- **A name that is not a loop.** A name that is not a check or a worker gets a `depends` finding. Without `marks`, a check gets no finding of this rule.
- **Keyed limiters.** `svc.limiter(name, spec)` declares a rate limit for each key, as data. `keyedLimiter` makes its runtime on a store ([The keyed limiter](#the-keyed-limiter)).
- **The hold.** The cap of the `fail readiness` phase binds `readiness_hold@process`, and a service without that phase holds for zero. The hold keeps the listener open after the signal, as a preStop sleep does. Thus O04 can compare the sum of the two with the propagation of the endpoints.

The format of a description is `mark1russell7.service/1`.

## The health runtime

`await svc.start()` closes the composition and gives a `Health`. The runtime reads each timing, poll and coupling from the description.

- **Checks on their own loops.** Each check polls on a fixed delay from the start of each poll, with its jitter. Each poll has a timeout, and the runtime aborts the signal of the check at that timeout. An answer is `"ok"`, `"error"` or `"indeterminate"`. A throw is an error with a flag. An indeterminate poll measured nothing, thus it moves no streak.
- **A pending use is not started again.** While a use of a check is pending, each later poll fails at once with the same cause. Thus a check that hangs fails a debounce of two polls or more as fast as an error does (`failSpan(timing, poll, "hang")`).
- **The metrics.** `health.metrics()` gives the counts of the runtime, and starts no check. For each check, it counts each outcome, each throw and each forced failure. Its histogram counts the durations of the polls. The bounds are fractions of the timeout of the poll, and a poll that timed out goes into `timedOut`. Its last 8 episodes of failure each go from the first error to the next pass. The cause of an episode has no user, password or token (`redact`). It also counts each transition of the machines of the runtime.
- **A latch for each check that gates a policy.** A debounce counts polls in sequence. A window measures time on the monotonic clock from the first failure of a sequence. A readiness latch starts tripped, thus readiness is earned. A liveness latch starts released.
- **The start.** `start()` makes one warm-up sweep of each check, bounded by each timeout, and then starts the loops. The startup probe fails until the sweep ends. `svc.health` gives the runtime from the start of `start()`, thus the probes can answer during the sweep. The verdict says when the sweep outlasts the startup budget.
- **The verdicts.** `health.verdict()` gives started, draining, ready, alive, each controller, each dependency and each check. The service is ready when it started, it does not drain, and each readiness latch is released. A controller is ready when its own dependencies are ready. Thus a failed dependency fails only the controllers that need it.
- **Couplings.** A declared coupling fails a policy when the other one fails, for example `{ from: "liveness", to: "readiness", effect: "fails" }`. Without a declaration, no coupling applies.
- **Late parts.** A check that joins after the start polls at once, and its readiness latch starts tripped until its first pass. A dependency that joins after the start is tripped until a check on it passes.
- **Probes from the cache.** `health.probe("startup" | "readiness" | "liveness" | "report", controller?)` gives a status (200 or 503) and an `application/health+json` body, for any HTTP framework. A probe starts no check. The report always answers 200, with the whole verdict.
- **Seams for tests.** `health.forceFail(name, true)` makes the polls of a check or a dependency fail at once. `health.drain()` fails readiness for good. `health.stop()` stops each loop and each timer, and the timers of the real clock do not keep a Node process alive.

## The lifecycle

`await svc.run()` starts the whole life of the service, and gives a `Lifecycle` when the startup ends. It refuses a declaration that it cannot start: a transport without its implementation, or a stage with work and no declared phase.

- **The parts.** `svc.server(name, knobs, impl)`, `svc.consumer(…)` and `svc.worker(…)` give a transport its implementation. Each transport has one contract: `start(signal, life)`, `stopIntake`, `drain(deadline, signal)`, `inFlight` and `close`. `workerLoop` and `queueDrain` give the implementation of a worker and of a consumer ([Workers and queues](#workers-and-queues)). `svc.dependency(name, spec, handle)` gives a dependency a handle that connects and closes. `svc.healthServer(server)` gives the server of the probes.
- **The startup.** The health server starts first, thus the probes answer while the dependencies connect. Then each dependency connects, in its declared sequence. Then each transport starts, and the startup gate opens last, after one warm-up sweep of each check. A part that does not start fails the startup. Then only the parts that started stop, and the exit code is 1.
- **The startup budget.** When the gate is not open at the end of its budget, the gate says so. The runtime does not stop itself, because the startup probe of the platform acts on it.
- **The signals.** The runtime owns the handlers of SIGINT, SIGTERM and SIGQUIT. The first signal starts the shutdown. A signal during the startup gets its shutdown after the startup ends.
- **A repeat signal.** Each declaration tells what a signal during the shutdown does (`svc.onRepeatSignal`). With `"exit"`, the signal ends the process at once, with the code 1. With `"ignore"`, the signal has no effect, as in 0.4. A second `shutdown()` and a second process trigger do not end the process.
- **A declaration without the policy.** `describe()` refuses a declaration that does not declare `onRepeatSignal`. A description from another source can lack it, for example the JSON of 0.4. Then `lint()` gives a `depends` finding of the rule `declaration`, and `unbound` names the field.
- **Process triggers.** `svc.trigger("stdin-close")` starts the shutdown when the standard input ends, as when the parent of a stdio child stops. `"ipc-close"` starts it when the IPC channel to the parent closes. Each trigger is opt-in. The process must read its input, as a stdio transport does, or Node does not see the end.
- **A message of the IPC channel.** Windows cannot give a child a SIGTERM that the child can catch, thus a parent sends a message. `svc.trigger("ipc-message", { match: "shutdown", as: "SIGTERM" })` starts the shutdown at that message.
- **The shape of a message.** `match` is a value of JSON. A string, a number, a boolean or null matches an equal message. An object matches a message that has each of its fields, and an array matches item by item.
- **A message as a signal.** With `as`, the message is that exit signal: it gets its exit code and the policy of a repeat signal. Without `as`, the message is the trigger `ipc-message`, with its own exit code (`svc.exitCode("ipc-message", code)`).
- **The shutdown.** Readiness fails first. Then the declared phases occur in their sequence, and each phase races its cap. `svc.onPhase(name, work)` adds the work of an owner to a phase.
- **The stages.** A declared phase with the name of a stage gets the work of that stage. The stages are `fail readiness`, `stop intake`, `drain`, `close transports`, `stop the poller`, `tear down dependencies`, `close the health server` and `flush the output`. The phase `fail readiness` holds for its cap while the endpoints update. The signal of the service aborts after the poller stops. `describe()` refuses the stages out of their sequence.
- **The cooperative abort.** During the drain, the requests and the transports get a signal that aborts at the cap less the cooperative window. With the floor `half`, that time is half the cap at the least, and a window without a bound gives half the cap. With `svc.cooperativeFloor("none")`, a window of the whole cap aborts the work at the start of the drain.
- **Requests.** `life.request(controller, route, work, { detail })` does one request on a declared route or route pattern. While the service cannot take new work, it refuses the request with a retryable 503. That occurs before the start, after the intake stops, or while the controller is not ready. A route that no route and no pattern declares throws, because it has no idempotency.
- **Each request is a stream.** The request gives a `RequestStream`: each item of the work, and then one end. A work that gives an async iterable is a stream, also through a promise. Each other value is a stream of one item. `stream.collect()` reads the items and the end.
- **The reader controls the work.** The stream asks the work for an item only when its reader asks for the next event. The request stays in flight until the iterator of the work ends. Thus the drain waits for an open stream. When the reader stops before the end, the work gets its abort and the `return()` of its iterator.
- **The end.** The end is `done`, `failed`, `refused` or `cut`, with the count of the delivered items. Before the first item, `refused` and `cut` have a status. After the first item, the end is in-band: the transport sent its answer, thus it writes the end as the last line of the stream.
- **Requests while the transports start.** Each transport gets the lifecycle at its start, and `svc.lifecycle` gives it from the start of `run()`. Thus a transport tracks its requests from its start. A request before the end of the startup gets a retryable 503, and `keepAlive()` is false.
- **Cut requests.** When the drain cuts a request, an idempotent route answers 503, retryable. Each other route answers 500, because the work can have had its effect. A keyed route is retryable only while the server keeps its key. After the first item, a cut has no status, and `retryable` tells the caller if it can send the request again.
- **The cooperative abort of a stream.** At the cooperative abort, the work gets its abort, and its iterator gets `return()`. A stream that ends after the abort ends as a cut. At the deadline of the drain, each request that is left gets a cut at once.
- **Route patterns.** `controller.pattern(pattern, operations, operationOf)` matches the routes that the exact routes do not name, in the sequence of the patterns. In a pattern, `*` matches each text, and `:name` matches one part without `/`. The declaration names each operation that a request of the pattern can be, with its idempotency.
- **The idempotency of each request.** The function `operationOf` gets the route, the parts of the pattern and the `detail` of the request. It gives the name of the operation, thus the retry rule and the answer of a cut. A pattern with one operation needs no function. `describe()` exports each pattern and its operations as data, and it checks them as it checks a route.
- **Keep-alive.** `life.keepAlive()` is false while the service is not ready. Thus each response then closes its connection.
- **The exit.** Only the lifecycle ends the process, through its `ProcessPort`. The exit code is 0 after a clean shutdown. It is 1 after an error: a startup that failed, a phase whose work did not end in its cap, or a work that threw. A phase over its cap does not stop the sequence.
- **A phase fails only for its own work.** At the cap of the drain, a transport that waits only for the bytes of its answers did its work. Then the cap is not a failure, and the exit code stays 0.
- **The answers that did not go.** The event of that cap (`phase.cap`) gives the cause and the count, for example `answers not flushed: 2`. The close of the transports then destroys those sockets.
- **Work that did not end.** A call whose end did not come, a transport that did not end its drain, or a step of an owner still fails the phase. The exit code is then 1, as before.
- **Only the work of the drain.** The drain waits only for the streams that `life.request` of its lifecycle made, because only its cut ends them. A stream of another lifecycle, or of none, does not hold the drain. The record of the drain gives their count, for example `streams outside the lifecycle: 1`. Thus each exit code is the exit code of 0.5.4.
- **Exit codes.** `life.shutdown(cause, { code })` gives the exit code of the work, a whole number from 0 to 255. The first request with a code sets it. `svc.exitCode(trigger, code)` gives the code of a shutdown that a trigger starts, for example 130 for SIGINT. A code that is not 0 stays after an error. A code of 0, or no code, becomes 1 after an error.
- **The output.** The stage `flush the output` comes last. The owners of the phase write their last output first, for example a log or a trace exporter. Then the `ProcessPort` writes the buffered output of stdout and stderr, in the cap of the stage. Without this phase, the process exits without a wait, as in 0.4.
- **The hold.** The lifecycle holds its process from its start to its exit, through `ProcessPort.hold`, as a listening socket does. The hold is one timer of the event loop, and the exit releases it. The other timers of the runtime still do not keep the process alive (A14).
- **Why the hold lasts to the exit.** A drain can wait on a timer that does not keep the process alive. Without the hold, Node then ends the process with the code 0 in the drain. The teardown and the declared exit code are then lost. Thus the hold does not end at the stop of the intake, and it is not a knob.
- **The watchdog.** `svc.watchdog(spec)` declares a check on the event loop. A blocked loop delays each timer, thus a tick that comes late by more than the threshold fails the check. A liveness window then reads the wedge of the process.
- **The logger.** `run({ logger })` and `start({ logger })` give each transition of the machines to a logger, as an entry with a level and fields. The logger is one sink of the same stream as `record` (`logEvents`).
- **The levels.** Each step of the startup, each phase with its cap, its outcome and its duration, and the exit code are `info`. A phase at its cap is `warn`, and an error of the lifecycle is `error`. The polls are `debug`.
- **The logger port.** A `Logger` has one method, `log(level, message, fields)`, thus an adapter to another logger is a few lines. `consoleLogger({ level })` writes to the console at `info` and above by default.
- **No logger.** Without a logger, the runtime writes no log, as before. `testLogger()` of `@mark1russell7/service/testing` keeps each entry, thus a test can examine the log.

## The machines

The machines of the runtime are `mark1russell7.machine/1` documents, which `@mark1russell7/algebra` reads. They are the gate, the latch (a debounce), the window, the poller, the exit manager and the watchdog. `drainMachine(description)` gives the drain of a declaration, with one state for each phase. The keyed limiter has its own documents.

Each machine gives its transitions to `run({ record })` or `start({ record })`. `replay(doc, events)` gives each transition that the document does not permit. It is the replay of `@mark1russell7/algebra`, which reads a machine of any name.

The tests replay the real runtime against each document. They also compare each timer of the documents, from the algebra, with the time that the runtime keeps.

## Composition

A process has one service, and one entry that uses `run()`. A component gives parts to that service, and it does not start them. For example, a component is the procedures host of another repository, or one of the HTTP hosts of a process.

- **The parts.** A component gives a `TransportImpl` for each source of work, a `DependencyHandle` for each dependency that it owns, and each check with its `CheckFn`. It can also give work for a declared phase (`onPhase`).
- **The entry.** The entry declares one service: the parts of each component, the policies, the startup budget, the phases and the cooperative window. Only the entry uses `run()`. Thus the process has one set of signal handlers, one staged shutdown and one exit.
- **What a component does not do.** A component does not use `start()` or `run()`. It installs no signal handler, and it does not end the process. A service has one health server, thus the entry chooses it.
- **An entry in a process that another part owns.** A script, a test of an application or a library entry can start a service in a process that it does not own. It gives `run()` the port `embeddedProcess()`. That port adds no signal handler, it does not hold the process, and its `exit` only records the code. The caller stops the service with `life.shutdown()` and reads the code from `life.done`.
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
  .cooperativeWindow(s(5))
  .onRepeatSignal("ignore");

const life = await svc.run(); // only the entry calls run(), and the process exits after the shutdown
```

The requirements that the lifecycle follows are in [the requirements of S6](https://github.com/mark1russell7/systems/blob/main/docs/S6.md).

## Workers and queues

`workerLoop(knobs, options)` makes a worker from a loop, and `queueDrain(knobs, options)` makes a consumer from a queue. Each one is a `TransportImpl`, with no defaults. Give `loop.knobs` to `svc.worker(name, knobs, impl)`, and `drain.knobs` to `svc.consumer(…)`. Thus the declaration and the law read the same knobs.

- **The worker loop (S6 A10).** A worker has a setup, an iteration and a teardown. The start does the setup, and each iteration gets its state. Each lane does its iterations one at a time, thus two iterations of a lane do not overlap. `concurrency` is the number of lanes.
- **The sleep.** `worker_sleep` is the time from the end of one iteration to the start of the next. An iteration that gives `"more"` starts the next one after a zero sleep. A sleep without a bound waits for `wake()`.
- **The first iteration.** The first iteration of each lane comes after the startup ends, because the service refuses a request before that end.
- **The failures.** A throw is a failure, and the lane then waits its backoff. The first delay is `retry_base`, and each delay is two times longer, up to `retry_cap`, with a jitter up to the base. A success ends the sequence. `onError` gets each failure, and the loop does not end the process (A5).
- **`wake()`.** It ends each sleep at once, also a sleep that comes after the iteration in flight. It does not end a backoff. After the stop of the intake, it gives false.
- **The queue drain (S6 A11).** One taker takes a job from the source while a slot is free. `concurrency` is the number of slots, and a count without a bound takes each job that comes. The source is a function that takes the next job, or an async iterable.
- **An empty source.** A take with no job waits `queue_poll_interval`, or until `wake()`. A failed take waits the backoff.
- **The end of a source.** The end of an async iterable stops the takes. While the intake is open, `onError` gets that end, because the drain then takes no more jobs. An async generator that throws gives its throw and then its end.
- **The end of each job.** A success gets `settle.ack`. A failure gets the action of the redelivery policy: `requeue`, `reject` or `ack`. The queue declares its policy, because the drain has no default.
- **The policy of A11.** `redeliverOnce(then, poison)` gives `ack` to a poison message. Each other job goes back one time after its first failure, and `then` decides each later failure.
- **The deliveries.** The policy gets the count of deliveries of the job, 1 at the first. `settle.delivery` gives that count from the queue, for example `x-delivery-count` of RabbitMQ or `ApproximateReceiveCount` of SQS. It is necessary, because a broker gives a new object at each delivery. A queue in memory counts for itself.
- **The bound of a unit.** `unit_processing_time` is the most time of one iteration or one job. At it, the signal of the unit aborts, and a throw after it is a failure. The law reads it as `unit_processing_time@consumer`.
- **The stop of the intake.** No new iteration starts, and the drain takes no new job. Each sleep and each backoff ends. The drain ends an async iterable through `return()`. A take that gives a job after the stop gives it back (`settle.requeue(job, "unstarted")`).
- **The drain.** `drain(deadline, signal)` waits for each unit in flight until the deadline, and gives each one the cooperative abort. A throw after that abort is a cut, not a failure.
- **A cut job.** A cut job goes back (`"cut"`) only when its route can go again (A12). Each other cut job gets `settle.reject`.
- **The close.** `close` aborts each unit, waits for its end, and then does the teardown or `options.close`, all in `close_bound`. The teardown occurs each time that the setup started, also after a failed setup. The close rejects a job that does not end in the bound.
- **The request tracking.** With `request: { controller, route }`, each unit goes through `life.request`. The service then admits, counts, drains and cuts each unit as it does each request. A route function and `detail` can give each job a route of a pattern.
- **The refusals.** While the service refuses its units, the loop and the taker wait their backoff, and each refused job goes back (`"unstarted"`). Thus a worker stops while a dependency of its controller is not ready.
- **The clock.** The sleeps, the backoffs and the bounds use the clock of the options. Give the clock of the lifecycle. With the real clock, the timers do not keep a Node process alive (A14). The lifecycle holds the process until its exit, thus a process whose only parts are workers does not end while it waits.
- **The law.** `lint()` applies O20 one time for each consumer and each worker. A knob of the transport binds at the hop `consumer`, and a knob with a hop in its name binds at that hop. The scenario gives the lease of each source, for example the visibility timeout of SQS.
- **The bounds.** `lint()` compares the bounds of each consumer and each worker with the caps of two phases (`BOUND_RULES`). `unit_processing_time` is less than the cap of `drain`, or the drain can cut a unit (`unit-bound`). `close_bound` is less than the cap of `close transports` (`close-bound`). A unit without a bound violates `unit-bound`.
- **The problems.** `problems(description)` gives each phase that the loop needs and that the declaration does not give: `drain` and `close transports`.

```ts
import { kubernetes, lint, queueDrain, redeliverOnce, service, workerLoop } from "@mark1russell7/service";

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });

// a heartbeat each 6 h, in one lane: a bound of 10 s for each beat, in the drain of 15 s, and a backoff from 10 s to 5 min
const heartbeat = workerLoop(
  { worker_sleep: s(6 * 3600), unit_processing_time: s(10), retry_base: s(10), retry_cap: s(300), close_bound: s(1), concurrency: count(1) },
  {
    setup: () => openClient(),
    iteration: ({ state, signal }) => state.beat(signal),
    teardown: (state) => state?.close(),
    onError: (error, failures) => log.warn({ error, failures }, "the heartbeat failed"),
  },
);

// the jobs of a table, 4 at a time: a poll each 2 s, and the policy of A11
const jobs = queueDrain(
  { queue_poll_interval: s(2), unit_processing_time: s(10), retry_base: s(1), retry_cap: s(30), close_bound: s(1), concurrency: count(4) },
  {
    source: (signal) => db.claimNextJob(signal), // a job, or null
    handle: (job, { signal, delivery }) => runPipeline(job, { signal, delivery }),
    settle: {
      ack: (job) => db.markDone(job),
      delivery: (job) => job.attempts, // the count of the table, 1 at the first take
      requeue: (job) => db.markQueued(job),
      reject: (job, error) => db.markFailed(job, error),
    },
    redelivery: redeliverOnce("reject", (error) => error instanceof InvalidJobError),
    request: { controller: "jobs", route: "RUN" },
  },
);

const app = service("app")
  .dependency("db", { system: null, knobs: {}, operations: {} }, { connect: () => db.connect(), close: () => db.end() })
  .worker("heartbeat", heartbeat.knobs, heartbeat)
  .consumer("jobs", jobs.knobs, jobs)
  .profile(kubernetes({ grace: s(30), preStop: s(0) }))
  .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
  .liveness({ type: "window", failAfter: s(45) })
  .startup(s(60));
// a job that the shutdown cuts goes back on the queue, because its route can go again
app.controller("jobs").requires("db").route("RUN", { idempotent: true });

// O20: the lease of the queue, 30 s, against a job of 10 s
const scenario = { platform: {}, probes: { readiness: s(30), liveness: s(30) }, transports: { jobs: { "lease_duration@broker": s(30) } } };
// the findings also compare each bound with the cap of its phase (BOUND_RULES)
const findings = lint(app.describe(), scenario, rules);
const problems = [...heartbeat.problems(app.describe()), ...jobs.problems(app.describe())];
const life = await app.run();
```

## Profiles

A profile is a part of a declaration as data: the phases, the cooperative window, the policies and the rules of the shutdown. `svc.profile(profile)` declares each field of a profile, as the method of that field does. The runtime still has no defaults, because the caller gives the profile. The caller changes a field with a spread, and `describe()` shows the values.

| Profile | For | What it declares |
| --- | --- | --- |
| `localDev` | A service on the computer of a developer | No readiness hold, caps that sum to 10 s, a flush of the output, and an exit on a second signal |
| `daemon` | A background host on the computer of a developer | The caps of `localDev`, no effect for a repeat signal, and no process trigger |
| `kubernetes({ grace, preStop })` | A pod | Caps from the grace less the preStop sleep, and no effect for a repeat signal |
| `ephemeral` | A command that runs one time, or a stdio child | No gating checks, an abort at the start of the drain, a flush of the output, and the exit codes 130, 143 and 131 |

- **Kubernetes.** The budget is the grace less the preStop sleep: the time from SIGTERM to SIGKILL. The stages get 2, 5, 15, 2, 1, 2 and 1 thirtieths of the budget, rounded down to the millisecond. The cooperative window is 5 thirtieths. Thus 2 thirtieths stay as a margin, and O10 and O16 hold.
- **The defaults of Kubernetes.** At a grace of 30 s and no preStop hook, the caps are 2, 5, 15, 2, 1, 2 and 1 s, with a window of 5 s. These are the caps of jarvis and of the kind lab.
- **Local development.** No load balancer routes to a computer of a developer, thus the profile has no readiness hold. A second Ctrl-C exits at once.
- **A background host.** A supervisor or a command stops the host with a signal. A repeat signal has no effect, thus the host ends its drain. The host has no parent on stdin, thus the profile declares no process trigger.
- **The repeat signal.** Each profile declares `onRepeatSignal`: `"exit"` for `localDev` and `ephemeral`, and `"ignore"` for `daemon` and `kubernetes`.
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
const { items, end } = await life.request("command", "RUN", (signal) => main(signal)).collect();
await life.shutdown("the command ended", { code: end.kind === "done" ? items[0] : 1 });
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

## The keyed limiter

A keyed limiter gives each key its own limit, for example each tenant or each principal. `@mark1russell7/service/limiter` has it. The entry loads only the quantity package: no `node:` module and no zod. Thus a client in a browser can use it. The root of the package also gives each function.

| Export | Function |
| --- | --- |
| `svc.limiter(name, spec)` | The declaration of a limiter, as data. `describe()` shows it in `limiters`. |
| `keyedLimiter(name, spec, store)` | The runtime of a limiter: `take(key)` gives a `Decision` |
| `memoryStore(clock)` | The store of one replica, on the injected monotonic clock |
| `decide(rule, state, now)`, `limitRule(policy)`, `freeAt(rule, state)` | The arithmetic of each store, for a store of your own |
| `idleSpan(policy)`, `longestRetryAfter(policy)`, `retryAfterSeconds(retryAfter)` | The times of a policy, and `Retry-After` in whole seconds |
| `limiterProblems(name, spec)` | The problems of a spec that `describe()` and `keyedLimiter` refuse |
| `LIMITER_RULES` | The rules O29 and O30 of the law, as data. Their identifiers are provisional. |
| `TOKEN_BUCKET_MACHINE`, `SLIDING_WINDOW_MACHINE`, `limiterMachine(policy)` | The machine of one key of each policy, as a `mark1russell7.machine/1` document |
| `limiterStateOf(rule, state, now)` | The state of a key of a store, as its document names it: `new`, `open` or `limited` |

- **No defaults.** A spec has a key, a policy, a store and a bound on its keys. `describe()` refuses a spec without its rate, its burst, its limit, its window, its store, the failure policy of a shared store or its bound. The error names the part.
- **The key.** `key` tells what the key of each take is, for example `tenant`. The caller gives each key to `take(key)`.
- **A token bucket.** `{ type: "token-bucket", rate, burst }` gives a key `burst` takes at once, and then `rate` takes in each unit of time. The rate is a count for each unit of time, for example `count/s` or `count/min`.
- **A sliding window.** `{ type: "sliding-window", limit, window }` gives a key at most `limit` takes in each window. Each take counts for one window from its time. Graph limits its writes with this policy.
- **The decision.** `take(key)` gives `{ allowed: true, remaining }` or `{ allowed: false, retryAfter, cause }`. `retryAfter` is a `Quantity` above zero: the time until the limiter lets the same take in. The cause is `limit`, `cap` or `store`.
- **The clock.** `memoryStore(clock)` reads time only through its clock. Thus a step of the wall clock moves no count, and a fake clock gives exact decisions in a test.
- **The store.** A `LimiterStore` decides each take in one atomic step, on its own clock. A store in another process does the arithmetic of `decide` in one step of its own. `redisLimiterStore` of `@mark1russell7/service/redis` is one script of Redis that reads `TIME`.
- **No shared store.** With `{ kind: "local" }`, each replica keeps its own counts. For a limit L over N replicas, declare L / N on each replica.
- **Only on average.** The sum of L / N holds only when the balancer spreads the takes of each key evenly. A balancer that sends each take of a key to one replica gives that key only L / N.
- **A shared store.** With `{ kind: "shared", dependency, onStoreFailure }`, the counts are in a dependency of the service. `describe()` refuses a dependency that the service does not declare, and `keyedLimiter` refuses a store of the wrong kind.
- **A failure of the store.** A shared store declares what a take does when the store fails (`onStoreFailure`). The field has no default, and `describe()` refuses a shared store without it.
- **Open or closed.** With `"open"`, the limiter lets the take in, with `remaining` 0. With `"closed"`, it refuses the take with the cause `store` and the longest `retryAfter` of the policy. Each decision gives the failure as text (`failure`).
- **A local store.** A local store does not fail, thus it needs no `onStoreFailure`, and the limiter ignores one. A failure of a local store of your own rejects the take.
- **Exact eviction.** A store removes a key only when its state is equal to the state of a new key. A bucket is new again after `burst / rate` idle, and a window after one window idle (`idleSpan`). Thus an eviction changes no decision.
- **A bound on the keys.** `evict.maxKeys` is the most keys that the store holds for the limiter. `describe()` refuses a count without a bound.
- **The cost of a new key at the cap.** At the cap, the store refuses a new key with the cause `cap`. Its `retryAfter` is at most the time until the earliest held key is free. That time is at most `idleSpan`, and a held key keeps its count.
- **The cost of the bound.** A sweep at the cap reads each key one time. It occurs only when a held key can be free. A token bucket keeps one number for each key, thus at most `maxKeys` numbers. A sliding window keeps the time of each take in its window: at most `maxKeys × limit` times.
- **The HTTP edge.** `retryAfterSeconds(retryAfter)` gives whole seconds, rounded up, for `Retry-After` (RFC 9110). `limitedResponse(refused)` of `@mark1russell7/service/http` gives 429 with that header (RFC 6585).
- **The law.** `lint()` applies O29 and O30 (`LIMITER_RULES`) one time for each limiter. The scenario gives the values of the callers of each limiter (`scenario.limiters`).
- **Provisional identifiers.** The corpus of the law has the rules O01 to O28. It does not have these two rules yet, thus O29 and O30 are provisional identifiers.
- **O29.** The longest `Retry-After` of a limiter (`retry_after@limiter`) is at most the retry window of its caller (`client_retry_window@caller`). Its second inequality applies the same bound to a new key at the cap (`retry_after_at_cap@limiter`). Otherwise the caller stops before the limit lets its call in.
- **O30.** The least delay of a caller before a retry (`retry_delay@caller`) is at least the longest `Retry-After` of the policy. Otherwise a caller that does not read the header sends again too early.
- **A closed failure.** The `retryAfter` of the cause `store` is the longest `retryAfter` of the policy. Thus O29 and O30 apply to it too.
- **The symbols.** `retry_after@limiter` is the longest `Retry-After` of the policy in whole seconds: one interval of the bucket, or one window. `retry_after_at_cap@limiter` is the longest at the cap, `idleSpan` in whole seconds.
- **The machine of a key.** Each policy has a document of one key, which `@mark1russell7/algebra` reads. A key is `new` (the store holds no count, or a count equal to a new key), `open` (its next take is permitted) or `limited` (its next take is refused).
- **The timers of a token bucket.** `token` fires at most `1 / rate` after the take that used the last token. That time is the longest `Retry-After`. `full` fires from one to `burst` intervals after a permitted take: the bucket is full, and the key is new again.
- **The timers of a sliding window.** `oldest` fires at most one window after the take that filled the window. `last` fires one window after the last permitted take, and the key is new again.
- **The other transitions.** A refused take leaves a limited key limited. A new key at the cap stays new, with the cause `cap`. A failure of a shared store leaves each state as it is.
- **The replay.** The tests drive the runtime on a fake clock and replay each take and each change of state against the document. The scenarios reach each transition. The times of the runtime are inside the bounds of the timers that the algebra gives.

```ts
import { keyedLimiter, memoryStore, realClock } from "@mark1russell7/service";
import type { LimiterSpec } from "@mark1russell7/service";
import { limitedResponse } from "@mark1russell7/service/http";

const count = (value: number) => ({ value, unit: "count" });
// the writes of each tenant: 120 in each sliding minute, for at most 10 000 tenants on this replica
const writes: LimiterSpec = {
  key: "tenant",
  policy: { type: "sliding-window", limit: count(120), window: { value: 60, unit: "s" } },
  store: { kind: "local" },
  evict: { maxKeys: count(10_000) },
};
svc.limiter("writes", writes); // describe() shows it, and lint() applies O29 and O30 to it
const limiter = keyedLimiter("writes", writes, memoryStore(realClock));

const decision = await limiter.take(tenantOf(req));
if (!decision.allowed) return limitedResponse(decision); // 429, with Retry-After from 1 to 60
```

## The HTTP edge

`@mark1russell7/service/http` is the edge of a service in Node. Of the modules of Node, it imports only `node:http` and `node:net`. The root of the package does not import it. It is not a framework: it has no routing language, no body parser and no middleware.

| Export | Function |
| --- | --- |
| `httpTransport(server, knobs, options)` | A server of `node:http` as a transport of the lifecycle, with a list of mounts |
| `probeServer({ port, host, server_retry_after, kinds })` | A health server on a port of its own |
| `probeHandler(health, { prefix, kinds })` | The probes as a request handler on the port of the application |
| `PROBE_KINDS` | The four probe kinds, the default of the option `kinds` |
| `handle(controller, route, work, options)` | A request handler that does each request of a route through `life.request` |
| `writeOutcome(res, stream, options)` | The stream of a request as a response of `node:http`, unary or a stream |
| `ndjson`, `sse` | The formats of a stream: NDJSON, and server-sent events |
| `outcomeResponse`, `endRecord`, `probeResponse`, `pathOf` | The same answers as data, for any HTTP framework or none |
| `limitedResponse(refused)` | The answer to a take that a keyed limiter refused: 429, with `Retry-After` in whole seconds |

- **The transport.** `httpTransport(server, knobs, options)` makes a server of `node:http` or `node:http2` (`EdgeServer`) a transport of the lifecycle. Give `transport.knobs` to `svc.server(name, knobs, impl)`. Thus the declaration and the law read the same knobs.
- **The knobs.** The transport has no defaults. `server_idle_sweep_interval` is the interval of the sweep of idle connections. `server_retry_after` goes in the `Retry-After` of each 503 of the transport.
- **The idle close.** `server_idle_close` is the real idle close of the server, which O01 compares with the idle time of a client. Node closes an idle connection at `keepAliveTimeout` plus `keepAliveTimeoutBuffer`. Thus the transport sets `keepAliveTimeout` to `server_idle_close` less the buffer of the server.
- **The hint.** The buffer stays, thus the hint of each response (`Keep-Alive: timeout=…`) is less than the real close. A Node without a buffer gives 0. The transport refuses a `server_idle_close` at or below the buffer. A time without a bound stops the timer.
- **The three times.** `transport.knobs` adds `server_idle_close_hint` and `server_idle_close_buffer` to the knobs of the caller. Thus the declaration shows the hint, the buffer and the real close.
- **The count.** The count of the work in flight comes from events. Each response counts until its `close` event, and each upgraded connection counts until it closes. The transport polls nothing.
- **The stop of the intake.** `stopIntake()` closes the listener, thus each new connection gets a refusal. It closes the idle connections at once, and again at each `server_idle_sweep_interval`. Each later response gets `Connection: close`, and each later request gets a retryable 503. A connection is not idle while the bytes of its answer go, thus a slow client gets the whole body (SYS-33).
- **The drain and the close.** `drain(deadline, signal)` ends when no work is in flight, or at the deadline. It gives the cooperative abort to the handlers. `close()` destroys each connection, the upgraded connections too. A second close gives the same promise.
- **The answers at the deadline.** At its deadline, the drain also waits for each answer that is to come or to go out. That is a response that `writeOutcome` writes, or an ended response whose bytes did not go.
- **The streams of the lifecycle.** A response of `writeOutcome` holds the drain only when `life.request` of the lifecycle of the transport made its stream. `handle` gives such a stream. Another stream does not hold the drain, and the drain counts it.
- **Why the drain waits.** The cut of the requests and the deadline of the transport come at the same time, in either sequence. Thus each cut call gets its 503, its 500 or its in-band end before the close.
- **The bound of that wait.** The cap of the phase bounds the wait. A client that does not read its answer holds the drain to the cap. That cap is not a failure: its event gives `answers not flushed` and the count. A response that is open for another reason does not hold the drain.
- **The lifecycle.** The transport gets the lifecycle at its start (`start(signal, life)`), before the warm-up. Each handler gets it in its context (`context.life`), with `server_retry_after` (`context.retryAfter`).
- **Keep-alive.** The transport reads `life.keepAlive()` when the headers of each response go, or the option `keepAlive` in its place. While it gives false, each response gets `Connection: close`. That occurs during the warm-up too. An upgrade does not get it.
- **HTTP/2.** `httpTransport` also takes a server of `node:http2` without TLS (h2c, `http2.createServer()`). HTTP/2 has no `Connection` header (RFC 9113, section 8.2.2), thus each close of a connection is a GOAWAY on its session:
  - While the transport cannot keep a connection, each response sends GOAWAY on its session. A `Connection: close` of a handler does the same, and the header does not go.
  - The GOAWAY names the last stream that the server took. Each stream up to it ends as usual. The client sends each later stream again on a new connection. Thus a caller behind kube-proxy goes through the rules again: the lame duck of HTTP/2.
  - `stopIntake()` sends GOAWAY on each session, a busy one too, and the drain waits for their streams. `close()` destroys each session.
  - `server_idle_close` is the timeout of a session with no frame (`server.setTimeout`). The hint is a time without a bound, and the buffer is 0 ms. A server of HTTP/2 has no upgrade, thus `transport.upgrade()` refuses a handler.
  - Each handler gets the request and the response of the compatibility API of `node:http2`. They have the parts of the API that `handle()` and `writeOutcome()` use. The tests on real sockets are `src/http/http2-it.test.ts` (HTTP_IT=1, in CI).
- **Keep-alive of a handled route.** From 0.5.18, the mount context gives the decision of the transport (`keepAlive`), and `handle()` reads it. Before, `handle()` read `life.keepAlive()` and ignored the option. Thus a refusal of a service that was not ready closed its connection when the option kept it (kind run 40335614261).
- **The clock.** Give the transport the clock of the lifecycle (`options.clock`). The deadline of the drain and the sweep use it.
- **The mounts.** `transport.mount(handler)` adds a request handler at the end of the list. The first handler that gives true answers the request. A handler that gives false lets the next handler try, and a request that no handler takes gets 404.
- **The upgrades.** `transport.upgrade(path, handler)` gives an upgrade to its handler, by its path or by a function. An upgrade that no handler takes gets 404. Thus several faces and the routes of the application share one port.
- **One owner of the listener.** The transport refuses a server that has a request or upgrade listener of its own. Mount that listener as a handler: `transport.mount((req, res) => (app(req, res), true))`.
- **The signals of a handler.** `context.intake` aborts when the intake stops, and `context.signal` aborts at the cooperative abort or at the close. A long stream ends in its own protocol at them.
- **A mount through the drain.** A mount with `{ until: "close transports" }` answers until the close. While it is mounted, the listener stays open through the drain, and each other request gets a retryable 503.
- **The probes on their own port.** `probeServer({ port, host, server_retry_after })` is a health server. It starts first and closes last, thus its probes answer through the whole shutdown. It has no defaults, thus `server_retry_after` is necessary, and each 503 of a probe gets its `Retry-After`.
- **The probes on the port of the application.** `probeHandler(health, { prefix })` answers the same probes. Its mount answers until `close transports`, thus it answers through the drain. After the close of the transports, only a probe server answers.
- **The probe paths.** The paths are `/startup`, `/readiness`, `/readiness/<controller>`, `/liveness` and `/report`, after the prefix. Each answer comes from the cache, as `application/health+json` with 200 or 503. A controller that the service does not have gets 404.
- **The safe answers.** Each JSON body escapes `<`, `>` and `&`, thus a part of the path in a body is not markup. Each answer gets `X-Content-Type-Options: nosniff` (SYS-34).
- **The probe kinds.** The option `kinds` names the probes that answer, for example `["startup", "readiness", "liveness"]`. The default is all four of `PROBE_KINDS`.
- **A kind that the list does not name.** Its path is not a probe. `probeHandler` gives it to the next handler, and `probeServer` answers it with 404. Thus a probe server can keep the report off its port.
- **A bad list of kinds.** `probeHandler` and `probeServer` refuse an empty list, an unknown kind and a kind two times. The error names the bad part.
- **A route through the request tracking.** `handle(controller, route, work, options)` gives a request handler. Each request that it takes goes through `life.request`, thus the service admits it, counts it and can cut it.
- **The route of a handler.** A route name takes a request whose method and path are that name, for example `POST /orders`. A function gives the name of a route or of a pattern (`controller.pattern`), or null for a request of another handler. `options.detail` gives the detail of a request for the function of a pattern.
- **The work.** The work gets the request and a signal. The signal aborts when the shutdown cuts the request, at the cooperative abort, or when the client goes away.
- **A unary response.** Without `options.stream`, the response waits for the end of the work. A value gets 200, and no value gets 204. A work that gives more than one value gets 500.
- **A stream response.** With `options.stream` (`ndjson` or `sse`), the status 200 goes with the first item. Then each item goes as it comes, and the next item waits while the client reads slowly.
- **The end of a stream.** An end after the first item goes in the body, as the last record (`endRecord`), with no status of its own. The cooperative abort and a cut end a stream in this way. When the client goes away, the work stops through `return()`.
- **An end before the first byte.** A refusal gets 503: the service did not start, it stopped its intake, or a controller is not ready. A cut gets 503 for an idempotent route (A12), and 500 for each other route. A failure of the route gets 500 with no detail, and not 503.
- **Each 503 gets `Retry-After`.** Each 503 gets the `Retry-After` of `server_retry_after` (RFC 9110), and a 500 gets none. The transport applies the rule when the headers of each response go, whatever wrote them. Thus the rule applies to a probe, to a refusal of the transport and to a handler that writes its own status.
- **The rule for a handler.** A 503 without `Retry-After` gets it, and a 503 with its own `Retry-After` keeps it. A 500 loses each `Retry-After`, from `setHeader` and from `writeHead`. The other statuses keep their headers.
- **Another framework.** `writeOutcome(res, stream, options)` writes the stream of any `life.request` to a response of `node:http`. `outcomeResponse(items, end, options)` gives a unary response as data.
- **Tracing in an ESM service.** An ESM service that uses OpenTelemetry starts with a preload, for example `node --import ./instrumentation.js app.js`. The preload must register `@opentelemetry/instrumentation/hook.mjs` before the application loads. Without that hook, the instrumentation does not see the ESM imports, and the spans of express are lost. The telemetry check of Graph found this when its server moved to ESM.

```js
// instrumentation.js, the preload: node --import ./instrumentation.js app.js
import { register } from "node:module";
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
// then start the SDK of OpenTelemetry, before the application loads
```

```ts
import { createServer } from "node:http";
import { service } from "@mark1russell7/service";
import { handle, httpTransport, ndjson, probeServer } from "@mark1russell7/service/http";

const s = (value: number) => ({ value, unit: "s" });
const http = httpTransport(
  createServer(),
  { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) },
  { listen: { port: 8080 } },
);
// a unary route: one status and one value
http.mount(handle("orders", "POST /orders", (req, signal) => createOrder(req, signal)));
// a stream: each row as it comes, and the end as the last line
http.mount(handle("orders", "GET /orders/export", (_req, signal) => exportRows(signal), { stream: ndjson }));
// a WebSocket server in its noServer mode shares the port
http.upgrade("/ws", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));

const app = service("app")
  .dependency("db", { system: null, knobs: {}, operations: {} }, { connect: () => db.connect(), close: () => db.end() })
  .server("http", http.knobs, http)
  .healthServer(probeServer({ port: 9090, server_retry_after: s(1) }))
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
  .cooperativeWindow(s(5))
  .onRepeatSignal("ignore");
app.controller("orders").requires("db").route("POST /orders", { idempotent: false }).route("GET /orders/export", { idempotent: true });

const life = await app.run(); // the process exits after SIGTERM, with 0 or 1
```

## The testing subpath

`@mark1russell7/service/testing` has the seams that a test of a service needs:

- `fakeClock()` gives a clock that moves only on `advance(ms)`. Pass it to `start({ clock })`, and the timing of the runtime is exact and repeatable. `block(ms)` moves the clock and starts no timer, as a blocked event loop does.
- `fakeProcess({ flush, clock })` gives a process port that takes signals and process triggers from a test (`signal(name)`, `trigger(name)`). It keeps each exit code in place of an exit. `flush` is its flush of the output, and `log` gives the time of each flush and each exit. `holds` is the count of holds of the process, and `heldAtExit` gives that count at each exit. `message(value)` sends a message of the IPC channel.
- `seeded(seed)` gives a seeded random number generator for the jitter (`start({ random })`).
- `scriptedCheck(behavior)` gives a check whose behavior a test sets: `"ok"`, `"error"`, `"indeterminate"`, `"throw"`, `"timeout"` or `"hang"`.
- `quietServer()` starts a TCP echo server that can go quiet. Its connections stay open while it is quiet, as with a frozen peer.
- `detachedLifecycle()` gives a lifecycle with no service, for the start of a transport in a test.
- `transportConformance(make, options)` generates the conformance test of a transport. `make` gives a subject: the transport, a way to offer new work and a way to hold work in flight. The cases check that `stopIntake` refuses new work, and that the count is correct and comes from events. They also check that `drain` holds to its deadline and gives the cooperative abort, and that `close` is idempotent and bounded. The fake clock makes the cases fast, and the real clock measures them.
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
- **The store of a keyed limiter.** `redisLimiterStore(client, { prefix })` keeps the counts of a [keyed limiter](#the-keyed-limiter) in Redis 7, for each replica of a service. Give it to `keyedLimiter` with `{ kind: "shared", dependency, onStoreFailure }`.
- **One atomic step.** Each take is one `EVAL` of `LIMITER_SCRIPT`, which does the arithmetic of `decide`. The script reads `TIME` of the server, thus each replica gets the one clock of the store.
- **No second send.** `EVAL` is not idempotent, thus the client does not send a take again. An error or an outcome that is not certain rejects the take of the store. `keyedLimiter` then applies `onStoreFailure`, as for each shared store.
- **The clock of the store.** `TIME` is the wall clock of the Redis host, not a monotonic clock. Thus a step of that clock moves the counts of each key. The replicas still share one clock.
- **Exact eviction in Redis.** The state of each key expires at the time that the key is free. A sorted set of each limiter bounds its busy keys to `maxKeys`, and it gives the exact `retryAfter` of a key at the cap.
- **Redis Cluster.** The names of the keys put the limiter in braces, a hash tag. Thus the state and the index of a limiter are in one slot. The prefix has no braces.
- **The test clock.** With `{ clock }`, the script uses the time of that clock in place of `TIME`. The tests use it to compare each decision of Redis with `decide`.

## The PostgreSQL client

`@mark1russell7/service/pg` is the PostgreSQL client of the service, over a pool of node-postgres 8. This entry is a prototype of S6. pg is an optional peer dependency. The client loads it only when it connects.

- **The declaration.** `pgClient(name, spec)` declares `connect_bound`, `request_timeout`, `statement_timeout`, `pool_idle_expiry`, `keepalive_idle`, `max_connection_age`, `close_bound` and `retrans_giveup_time`. Each knob is necessary, and a bound that nobody gives is "infinite". `specProblems` refuses a knob that pg cannot use, for example a zero, which pg reads as no timer.
- **The starting knobs.** `PG_STARTING_KNOBS` and `PG_STARTING_POLL` are a declaration from the cells of S1. Each value has its measured reason in its doc comment.
- **Three outcomes.** `query(operation, text, values)` gives `ok`, `error` or `indeterminate`. An ERROR of the server is certain. A FATAL, a reset or a query timeout is not certain. The client then gives the connection back with an error, thus the pool ends the orphaned query.
- **Idempotency for each operation.** SQL text does not tell if a statement changes a state. Thus the client sends again only an idempotent operation that its table names, one time at most, in the bound of the request.
- **The join.** At each connect, the client records the process id of the backend and the socket (`joins`).
- **No unheard error.** The client listens to the errors of the pool and of each client that it holds. In Node, an error with no listener ends the process.
- **The checks.** `checks({ poll, steps })` gives `local-state`, `checkout`, `round-trip` (a `SELECT 1` through the pool) and `dial` (an SSLRequest on a new connection).
- **The close.** At the shutdown, the client ends the pool, and it destroys each socket that stays at its `close_bound`.
- **The manifestations and the machine.** `meets` lists the manifestations and their detectors. `PG_CLIENT_MACHINE` is the client as a `mark1russell7.machine/1` document, and the tests replay the client against it.

## The MongoDB client

`@mark1russell7/service/mongodb` is the MongoDB client of the service, over a `MongoClient` of the driver 7. This entry is a part of S6. mongodb is an optional peer dependency. The client loads it only when it connects.

- **The declaration.** `mongoClient(name, spec)` declares `connect_bound`, `request_timeout`, `statement_timeout`, `heartbeat_interval`, `client_retry_window`, `checkout_timeout`, `pool_idle_expiry`, `keepalive_idle`, `max_connection_age`, `close_bound` and `retrans_giveup_time`. The client derives `driver_writeoff_time` from the connect bound and the heartbeat.
- **The problems of a spec.** `specProblems` refuses a knob that the driver cannot use. Examples are a zero, which the driver reads as no timer, a heartbeat below 500 ms, and a finite connection age.
- **The starting knobs.** `MONGO_STARTING_KNOBS` and `MONGO_STARTING_POLL` are a declaration from the cells of S1. Each value has its measured reason in its doc comment.
- **The settings of the driver.** The client turns off the retries of the driver, thus the core decides each second send. The client also writes `maxTimeMS` in each command, because `db.command` does not add it.
- **Three outcomes.** `command(operation, document)` gives `ok`, `error` or `indeterminate`. A server error is certain, except an interruption and a write concern error. A failed selection or a closed pool did not send the command.
- **Idempotency for each operation.** A command document does not tell if it changes a state. Thus the client sends again only an idempotent operation that its table names. The second send waits for a writable server in `client_retry_window`.
- **The join.** At each new connection, the client records the connection id of the server (`joins`). The driver gives no local socket, thus the local end is null.
- **No unheard error.** The client listens to the error event of the driver. In Node, an error with no listener ends the process.
- **The checks.** `checks({ poll, steps })` gives `local-state` (the view of the topology), `round-trip` (a `ping` on the connection of the application) and `dial` (a hello on a new connection).
- **The close.** At the shutdown, the client closes the driver, and it records `close.bound` at its `close_bound`. The driver gives no socket to destroy, thus its close goes on in the background.
- **The manifestations and the machine.** `meets` lists the manifestations and their detectors. `MONGO_CLIENT_MACHINE` is the client as a `mark1russell7.machine/1` document, and the tests replay the client against it.

## The RabbitMQ client

`@mark1russell7/service/rabbitmq` is the RabbitMQ client of the service, over amqplib 2. This entry is a part of S6. The peer dependency amqplib is optional. The client loads it only when it connects.

- **The declaration.** `rabbitClient(name, spec)` declares `connect_bound`, `request_timeout`, `heartbeat_interval`, `retry_base`, `retry_cap`, `keepalive_idle`, `max_connection_age`, `close_bound` and `retrans_giveup_time`. The client derives `heartbeat_detection_time` (3 heartbeats) and `idle_refresh_interval` (a half heartbeat).
- **The problems of a spec.** `specProblems` refuses a knob that amqplib cannot use. Examples are a zero, which amqplib reads as no timer, a heartbeat that is not a whole number of seconds, and a finite connection age.
- **The starting knobs.** `RABBIT_STARTING_KNOBS` and `RABBIT_STARTING_POLL` are a declaration from the cells of R3. Each value has its measured reason in its doc comment.
- **A call.** A call is a publish on a confirm channel until its confirm, or an RPC until its reply, for example `basic.get`. The client ends each call at `request_timeout`, because amqplib has no timer for them.
- **Three outcomes.** `publish(operation, message)` and `get(operation, queue)` give `ok`, `error` or `indeterminate`. An ack is `ok`. A reply code of the broker is certain. A nack, a timeout and the end of the channel before the confirm are not certain. A call while the client is not ready, or while a resource alarm blocks it, did not leave the client.
- **Idempotency for each operation.** A message does not tell if its consumers remove duplicates. Thus the client sends again only an idempotent operation that its table names. The second send waits for a ready client, in the bound of the call.
- **One generation.** The client has one connection and one confirm channel. The end of either one ends the generation. The client then connects again by itself, to the next node, after a backoff from `retry_base` to `retry_cap`. The built-in recovery of amqplib stays off.
- **The join.** At each generation, the client records the node and the name of the connection, `local:port -> remote:port` (`joins`).
- **The jobs of a queue drain.** `jobs(operation, queue)` gives the source and the settle of `queueDrain`. The count of deliveries comes from `x-delivery-count`. A message that arrives after its call ended goes back to its queue at once.
- **No unheard error.** The client listens to the error events of the connection and of the channel. In Node, an error with no listener ends the process.
- **The checks.** `checks({ poll, steps })` gives `local-state`, `round-trip` (a passive declare of `amq.direct` on the channel of the application) and `dial` (the protocol header on a new connection, with no login).
- **The close.** At the shutdown, the client sends `connection.close`, and it destroys the socket at its `close_bound`.
- **The manifestations and the machine.** `meets` lists the manifestations and their detectors. `RABBIT_CLIENT_MACHINE` is the client as a `mark1russell7.machine/1` document, and the tests replay the client against it.

## The HTTP client

`@mark1russell7/service/http-client` is the HTTP client of the service, over an `http.Agent` of Node with keep-alive. This entry is a part of S6. The entry `./http` is the server edge of a service, thus the client has its own name. `node:http` is a built-in, thus the entry has no peer dependency. The client loads `node:http` only when it connects.

- **The declaration.** `httpClient(name, spec)` declares `connect_bound`, `request_timeout`, `pool_idle_expiry`, `hint_buffer`, `keepalive_idle`, `max_connection_age`, `close_bound` and `retrans_giveup_time`. Keepalive is also the `idle_refresh_interval`, because the agent sends nothing on a free socket.
- **The idle close of the server.** The knob `server_idle_close` is not in the declaration, because the scenario binds the close of the server. `problems` compares it with `pool_idle_expiry` (O01).
- **The problems of a spec.** `specProblems` refuses a knob that the agent cannot use. An example is a free socket timer of 0, which the agent reads as no timer. Others are a keepalive that is not a whole number of seconds, and a finite connection age.
- **The options of the agent.** `agentOptions(spec)` gives `timeout`, `agentKeepAliveTimeoutBuffer`, `keepAliveMsecs`, `maxSockets` and `maxFreeSockets` from the declaration, and `scheduling: "lifo"`.
- **The starting knobs.** `HTTP_CLIENT_STARTING_KNOBS` and `HTTP_CLIENT_STARTING_POLL` are a declaration from the HTTP cells. Each value has its measured reason in its doc comment.
- **A call.** A call is one request until the end of the body of its response. The client ends each call at `request_timeout`, and each connect of a new socket at `connect_bound`, because the agent has no timer for them.
- **Three outcomes.** `request(call)` gives `ok`, `error` or `indeterminate`. Each whole response is `ok`, with its status: RFC 9110 does not say that a 5xx did not apply. A request that did not get a connected socket did not leave the client. A failure after that is not certain.
- **Idempotency for each method.** The table names each method by RFC 9110. GET, HEAD, OPTIONS, TRACE, PUT and DELETE are idempotent, and POST and PATCH are not. A spec can name a keyed operation, for example a POST with an `Idempotency-Key`.
- **The keep-alive race.** A server can close a free socket while a request goes on it. The client then sends again only an idempotent operation, one time, on a new socket. It records `reuse.failed`.
- **The join.** At each new socket, the client records the ends of the socket (`joins`). HTTP gives no id of a connection.
- **The checks.** `checks({ poll, steps })` gives `local-state`, `round-trip` (the check request through the pool, which fails at a status of 500 or more) and `dial` (`OPTIONS *` on a new connection). The check request is `OPTIONS *`, or the `check` of the spec.
- **The close.** At the shutdown, the client waits for its calls in flight. At its `close_bound`, it destroys each socket of the agent, and each call that stays is indeterminate.
- **The manifestations and the machine.** `meets` lists the manifestations and their detectors. `HTTP_CLIENT_MACHINE` is the client as a `mark1russell7.machine/1` document, and the tests replay the client against it.

## The WebSocket client

`@mark1russell7/service/websocket` is the WebSocket client of the service, over ws 8. This entry is a part of S6. The peer dependency ws is optional. The client loads it only when it connects.

- **The declaration.** `wsClient(name, spec)` declares `connect_bound`, `request_timeout`, `heartbeat_interval`, `heartbeat_timeout`, `retry_base`, `retry_cap`, `keepalive_idle`, `max_connection_age`, `close_bound` and `retrans_giveup_time`. The client derives `heartbeat_detection_time` and `idle_refresh_interval` (the heartbeat).
- **The problems of a spec.** `specProblems` refuses a knob that ws cannot use. Examples are a zero heartbeat, a keepalive that is not a whole number of seconds, and a finite connection age. It also refuses a password: give the credentials in `headers`.
- **The starting knobs.** `WS_CLIENT_STARTING_KNOBS`, `WS_CLIENT_STARTING_MISSES` and `WS_CLIENT_STARTING_POLL` are a declaration from the WS cells. Each value has its measured reason in its doc comment.
- **A call.** A call is a request message until its reply, or a ping frame until its pong. WebSocket has no reply of its own, thus `replies` of the spec reads the id of a reply in a message. The client ends each call at `request_timeout`.
- **Three outcomes.** `request(operation, { id, data })` and `ping()` give `ok`, `error` or `indeterminate`. A reply that carries an error is certain. A failed write, a timeout and the end of the generation are not certain. A call while the client is not ready did not leave the client.
- **Messages with no reply.** `send(data)` writes a message, and it is not a call. `onMessage(listener)` gets each message that answers no request.
- **Idempotency for each operation.** A message does not tell its idempotency. Thus the client sends again only an idempotent operation that its table names. `WS_OPERATIONS` names `ping`. The second send waits for a ready client.
- **The heartbeat.** The client sends a ping frame at each `heartbeat_interval`, one at a time. After `heartbeatMisses` pings with no pong in `heartbeat_timeout`, `terminate()` destroys the socket.
- **One generation.** The generation is one connection after its upgrade. At its end, the client connects again by itself, after a backoff from `retry_base` to `retry_cap`.
- **The join.** At each generation, the client records the URL, the subprotocol and the ends of the socket (`joins`). WebSocket gives no id of a connection.
- **The checks.** `checks({ poll, steps })` gives `local-state`, `round-trip` (a ping on the connection of the application) and `dial` (the upgrade GET on a new connection, which must get 101).
- **The close.** At the shutdown, the client waits for its calls in flight, then it sends a close frame. At its `close_bound`, `terminate()` destroys the socket, and each call that stays is indeterminate.
- **The manifestations and the machine.** `meets` lists the manifestations and their detectors. `WS_CLIENT_MACHINE` is the client as a `mark1russell7.machine/1` document, and the tests replay the client against it.

## The gRPC client

`@mark1russell7/service/grpc` is the gRPC client of the service, over grpc-js 1.14. This entry is a part of S6. The peer dependency `@grpc/grpc-js` is optional. The client loads it only when it connects.

- **The declaration.** `grpcClient(name, spec)` declares `connect_bound`, `request_timeout`, `keepalive_time`, `keepalive_timeout`, `client_idle_timeout`, `retry_base`, `retry_cap`, `keepalive_idle`, `max_connection_age`, `close_bound` and `retrans_giveup_time`. The client derives `heartbeat_detection_time` (the PING) and `idle_refresh_interval`.
- **The facts of the server.** The knobs `server_keepalive_min_time` and `server_idle_close` are not in the declaration. `problems` compares them with `keepalive_time` (O26) and `client_idle_timeout` (O01).
- **The problems of a spec.** `specProblems` refuses a knob that grpc-js cannot use. Examples are a zero keepalive, a timer that is not a whole number of milliseconds, and an idle timeout below 1 s. A timer above the longest timer of Node is a problem too. It also refuses a TCP keepalive and a password: give the credentials in `metadata`.
- **The options of the channel.** `grpcOptions(spec)` gives the target and each timer of grpc-js from the declaration. It also turns the retries of grpc-js off, and the service config of the resolver.
- **The starting knobs.** `GRPC_CLIENT_STARTING_KNOBS`, `GRPC_CLIENT_STARTING_WITHOUT_CALLS` and `GRPC_CLIENT_STARTING_POLL` are a declaration from the gRPC cells. Each value has its measured reason in its doc comment.
- **A call.** A call is one unary call until its status. `request` and the response are the bytes of the messages, thus the caller encodes them. A stream is not a call. The deadline of a call is the time that is left in `request_timeout`, and grpc-js sends it as `grpc-timeout`.
- **Three outcomes.** `call(method, request)` gives `ok`, `error` or `indeterminate` from the status code (`grpcOutcome`). A code that tells a refusal is certain. A status that tells that the call did not leave the client is not sent. Each other status is not certain.
- **Idempotency for each method.** `grpcOperations` makes the table from the `idempotency_level` of each method in its proto. The client sends again only an idempotent method, one time, after it is ready again. `GRPC_OPERATIONS` names the Check of the health service.
- **One channel.** The client has one channel for its life, and each READY is one generation. The grpc-js driver connects again by itself after its backoff. The client connects an IDLE channel again at once.
- **The join.** At each generation, the client records the target (`joins`). The grpc-js driver gives no socket, thus the ends of the socket are null.
- **The checks.** `checks({ poll, steps })` gives `local-state`, `round-trip` (a Check of the health service on the channel of the application, which passes only for SERVING) and `dial` (the HTTP/2 preface on a new connection, which must get a SETTINGS frame).
- **The close.** At the shutdown, the client waits for its calls in flight. At its `close_bound`, it cancels each call that stays, which is then indeterminate. Then it closes the channel.
- **The manifestations and the machine.** `meets` lists the manifestations and their detectors. `GRPC_CLIENT_MACHINE` is the client as a `mark1russell7.machine/1` document, and the tests replay the client against it.

## Installation

```sh
pnpm add @mark1russell7/service
```

For the Redis client, the application also installs `ioredis@6`. For the PostgreSQL client, it installs `pg@8`. For the MongoDB client, it installs `mongodb@7`. For the RabbitMQ client, it installs `amqplib@2`. For the WebSocket client, it installs `ws@8`.

For the gRPC client, it installs `@grpc/grpc-js@1`. The HTTP client needs no other package.

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
  .cooperativeWindow(s(5))
  .onRepeatSignal("ignore");

const rules: Rule[] = []; // the rules of the law, as data
const scenario = {
  platform: { "termination_grace@pod": s(30), "prestop_sleep@pod": s(5) },
  probes: { readiness: s(30), liveness: s(30) },
};
const findings = lint(svc.describe(), scenario, rules);

const health = await svc.start();
const answer = health.probe("readiness"); // { status: 200, contentType, body }
```

A service that starts its whole lifecycle declares its parts and each stage of its shutdown. [The HTTP edge](#the-http-edge) has a whole example, with the mounts and the probes.

```ts
const http = httpTransport(
  createServer(),
  { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) },
  { listen: { port: 8080 } },
);
const app = service("app")
  .dependency("db", { system: null, knobs: {}, operations: {} }, { connect: () => db.connect(), close: () => db.end() })
  .server("http", http.knobs, http)
  .healthServer(probeServer({ port: 9090, server_retry_after: s(1) }))
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
  .cooperativeWindow(s(5))
  .onRepeatSignal("ignore");
app.controller("orders").requires("db").route("POST /orders", { idempotent: false });

const life = await app.run(); // the process exits after SIGTERM, with 0 or 1
const { items, end } = await life.request("orders", "POST /orders", (signal) => createOrder(signal)).collect();
```

A registry that changes while the service runs declares a pattern, and each request a stream:

```ts
app
  .controller("procedures")
  .requires("db")
  .pattern(
    "POST /rpc/:procedure",
    { read: { idempotent: true }, write: { idempotent: false } },
    ({ detail }) => ((detail as Procedure).readOnly ? "read" : "write"),
  );

const stream = life.request("procedures", "POST /rpc/logs.tail", (signal) => tail(signal), { detail: procedure });
for await (const event of stream) {
  if (event.kind === "item") write(JSON.stringify(event.value));
  else if (event.delivered > 0) write(JSON.stringify({ end: event.kind, delivered: event.delivered })); // in-band
  else respond(event); // a status: 503, 500 or the error of the route
}
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
- **The HTTP client.** These tests use a fake agent and a fake clock. They cover the declaration, the three outcomes, the methods that the client sends again or not, and the keep-alive race. They also cover the free socket timer, the close, the checks and the manifestations. Five scenarios replay against the document of the client. One test sends requests through the agent of Node to a server of the loopback.
- **The gRPC client.** These tests use a fake channel and a fake clock. They cover the declaration, the outcome of each status code, the methods that the client sends again or not, the keepalive and the IDLE channel. They also cover a GOAWAY, the close, the checks and the manifestations. Seven scenarios replay against the document of the client. One test sends calls through grpc-js to a server of the loopback.
- **F6 for Redis.** The fault matrix crosses each manifestation (a refusal, a frozen process, a black hole, a death without a close, and an app stall), each gating posture, two timings and two jitters. That is 60 cases on the fake. Each case holds the trip and the release of its policy to `failSpan` and `recoverSpan`. Five more cases shut the service down during each manifestation, and each one exits 0.
- **The timers.** These tests use a fake clock, and they cover the hooks of the heartbeat and its two kinds of ping. A property test holds the death of a silent peer to `detectionTime` in 300 seeded cases. Another one compares the heartbeat with a WebSocket heartbeat that sends one ping at a time, on 300 schedules of pongs. The backoff gives the delays of three earlier backoffs, number for number, and each delay is in its band.
- **The entries.** The timer entries reach no other package, no `node:` module and no zod. No entry of the service reaches zod, also through `quantity` and the replay of the algebra. The root reaches no `node:` module. The HTTP edge reaches only `node:http`, `node:net` and `quantity`. The worker loop and the queue drain reach only `quantity`.
- **The requests.** A unary work is a stream of one item, and a stream gives each item when its reader asks. The drain waits for an open stream. The cooperative abort ends a stream through `return()`, and a cut or a failure after the first item ends in-band. A reader that stops early stops the work. The function of a route pattern decides the answer of each cut request.
- **The options of the runner.** These tests cover the requests of a transport while the startup runs, the policy of a repeat signal, the profiles and the process triggers. They also cover the exit codes, a first Ctrl-C that aborts at once, and the flush of the output.
- **The composition.** Two components, each with a transport, a dependency and a check, share one service and one `run()`. The parts start and stop in their sequence, and the process exits one time.
- **The process port.** The port of Node, on a fake host: the signals, the end of stdin and the close of the IPC channel. The tests also cover the messages, the hold, the flush and the exit. The lifecycle holds its fake process from its start to its exit.
- **The HTTP edge.** The transport, the mounts, the upgrades, the probes and `handle` run on fake servers and the fake clock, with no socket. A service under `run()` drains a held request, and its probes answer through the drain. A request during the warm-up gets 503, and a stream ends in-band after its first item.
- **The drain of the HTTP edge (SYS-29).** Each call that the deadline cuts gets its answer before its socket closes, with the cut first and with the transport first. Answers that do not go out by the cap give exit 0, and work that did not end by the cap gives exit 1. A stream outside the lifecycle does not hold the drain, and the record of the drain counts it.
- **The idle close of a slow answer (SYS-33).** A client that does not read gets each byte of a body of 64 MB. The stop of the intake and a sweep after it come before the client reads. These tests use real sockets of the loopback, but not on Windows.
- **The headers of the outcomes.** Each path of the request tracker gets its status. Each 503 gets `Retry-After`: the refusals, the retryable cut and the cut of a unary stream. No 500 gets it.
- **The headers on the port.** The transport adds `Retry-After` to each 503 of a probe and of a handler that writes its own status, in each form of `writeHead`. It takes `Retry-After` from each 500. The probe server gives its 503s the time of its knob.
- **The conformance of a transport.** A reference transport passes each case, and each of nine mutations of it fails the case of its part. The HTTP transport passes each case on a fake server, for its requests and its upgrades.
- **The worker loop.** These tests use the fake clock. They cover the sleep, `"more"`, the backoff and its jitter, `wake()`, the stop of the intake and the drain with its cooperative abort. They also cover the bound of an iteration, the lanes, the setup, the teardown, the close bound and the law (O20).
- **The queue drain.** These tests cover the slots, the poll, the policy of A11 and the count of deliveries. They also cover a job that goes back at the stop, an async iterable and a failed take. A cut job of each kind of route, the close bound and the refusals of the service have tests too.
- **The conformance of the helpers.** The worker loop passes each case of the kit with three lanes, and the queue drain with three slots. Each one passes with the request tracking and without it. With one lane, the loop passes each case that holds one work.
- **The IPC message.** A message that matches a declared shape starts the staged shutdown on the fake process, with the exit code of its signal. A second message obeys the policy of a repeat signal.
- **On real sockets.** `HTTP_IT=1` starts the tests of the HTTP edge on the loopback. They cover the conformance on the fake clock and on the real clock, keep-alive and the stop of the intake. They also cover the upgrades, the probe server and a service after SIGTERM. They measure time, thus only CI starts them (`http.yml`), on Node 22.19, 24 and 26. CI keeps the raw records of each job as an artifact.
- **On the real clock.** `WORKERS_IT=1` starts the kit of the worker loop and of the queue drain on the real clock, in the jobs of `http.yml`.
- **A real child process.** `PROCESS_IT=1` starts a child under `run()` with an IPC channel, on Linux and on Windows (`process.yml`). The message `shutdown` stops it in stages, with the code 143. A control shows that a SIGTERM of the parent does that only on Linux. A child whose only part is a worker on the real clock stays alive through the hold, and on Linux a SIGTERM gives its teardown.
- **Against a real Redis.** `REDIS_IT=1` starts the tests of the client against Redis 7.4. `REDIS_F6=1` starts the F6 matrix in the VM of Docker. The injector of `@mark1russell7/harness` makes the network faults, and an agent in the namespaces of Redis makes the process faults. All of them use one monotonic clock.

`pnpm --filter @mark1russell7/service build` writes the package for npm into `build/`.
