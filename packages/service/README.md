# @mark1russell7/service

A service that you declare as data before it starts. You compose it with plain calls: its dependencies, its checks, its policies and its shutdown. `describe()` gives the whole graph as data, and it starts nothing. `lint()` then applies the timer-ordering law to that graph. `start()` gives the graph to the health runtime.

This release has the declaration, its export, the law and the health runtime. The lifecycle and the drain come in a later release.

## What the package does

- **The builder.** `service(name)` gives a builder. You add each part with a call: `svc.dependency(…)`, `svc.server(…)`, `svc.controller("checkout").requires(…).route(…)`, `svc.check(check, run)`, the policies, the couplings and the shutdown phases.
- **No defaults.** The runtime has no defaults of its own. Thus `describe()` refuses a service that does not declare its readiness, its liveness, its startup budget, its shutdown phases or its cooperative window. The error tells which. `start()` also refuses a check without its function.
- **One timing shape.** Each policy has a `Timing`: a debounce of polls, or a window of time. Each converts to the other (`asWindow`, `asDebounce`). `failSpan` and `recoverSpan` give the earliest and the latest time to detect a change. At 3 polls of 5 s ± 20 %, a latch fails in 8–18 s on an error, and in 12–22 s on a 4 s timeout.
- **Checks.** A check names the step of the connection that it examines (`dial`, `round-trip`, `checkout` and others). It also tells if it uses the connection of the application, and which policy it controls. The policy has no default.
- **Idempotency for each operation.** One dependency has the two kinds of operation. A Redis GET is safe to send again. An INCR that goes again after a timeout counts two times. Thus each operation of a dependency, and each route of a controller, declares if it can go again: `true`, `false`, or keyed.
- **Keyed operations.** A keyed operation has the window that the server keeps its key for. `mayReissue` answers from the declaration of an operation. An operation without a declaration does not go again.
- **The law.** `evaluate` and `verdictOf` decide one rule of the timer-ordering law on one binding. A rule is data: linear inequalities over `symbol@hop`, with a margin. A verdict is `holds`, `violated`, `unbounded` (it holds only because a timer is absent) or `depends` (nothing is bound).
- **The linter.** `lint(description, scenario, rules)` applies the service rules (`SERVICE_RULES`) to a declaration. The declaration binds the symbols of the service: the polls of its checks, the windows of its policies, its drain. The scenario binds the symbols of the platform and of each dependency. A `depends` finding names the symbols that have no bound.

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

## The testing subpath

`@mark1russell7/service/testing` has the seams that a test of a service needs:

- `fakeClock()` gives a clock that moves only on `advance(ms)`. Pass it to `start({ clock })`, and the timing of the runtime is exact and repeatable.
- `seeded(seed)` gives a seeded random number generator for the jitter (`start({ random })`).
- `scriptedCheck(behavior)` gives a check whose behavior a test sets: `"ok"`, `"error"`, `"indeterminate"`, `"throw"`, `"timeout"` or `"hang"`.
- `quietServer()` starts a TCP echo server that can go quiet. Its connections stay open while it is quiet, as with a frozen peer.

## Installation

```sh
pnpm add @mark1russell7/service zod
```

The package uses [`@mark1russell7/quantity`](https://www.npmjs.com/package/@mark1russell7/quantity) for each amount, and `quantity` uses `zod` as a peer dependency. Thus the application installs `zod`.

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

## Tests

`pnpm --filter @mark1russell7/service test` starts the tests:

- **The algebra and the builder.** The timing algebra, the refusals of the builder, its partial export, and the four verdicts of the law. A test in jarvis compares this evaluator with the evaluator of the research, on 185 bindings. All decisions agree.
- **The permutations.** The permutations cross the policy, the timing, the poll interval, the jitter and the way that the step fails. For each one, a latch on a fake clock must trip inside `failSpan` and recover inside `recoverSpan`. Each permutation has eight seeds for the jitter and the phase of the fault. A failure names its permutation and its seed. Two more tests show that the bounds are reached.
- **The edges.** These tests cover a flapping signal, a check that does not answer at any time, and late parts. They also cover couplings, controllers, the force-fail list, the drain, the stop, and the loop of a slow check.
- **Real time.** The runtime on the real clock, and a check against a quiet server over TCP.

`pnpm --filter @mark1russell7/service build` writes the package for npm into `build/`.
