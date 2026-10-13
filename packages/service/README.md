# @mark1russell7/service

A service that you declare as data before it starts. You compose it with plain calls: its dependencies, its checks, its policies and its shutdown. `describe()` gives the whole graph as data, and it starts nothing. `lint()` then applies the timer-ordering law to that graph.

This release has the declaration, its export and the law. The runtime that `start()` gives the graph to comes in a later release.

## What the package does

- **The builder.** `service(name)` gives a builder. You add each part with a call: `svc.dependency(…)`, `svc.server(…)`, `svc.controller("checkout").requires(…).route(…)`, `svc.check(…)`, the policies, the couplings and the shutdown phases.
- **The start.** `await svc.start()` closes the composition. A dependency or a check that joins later starts tripped, and the export is partial.
- **No defaults.** The runtime has no defaults of its own. Thus `describe()` refuses a service that does not declare its readiness, its liveness, its startup budget, its shutdown phases or its cooperative window. The error tells which.
- **One timing shape.** Each policy has a `Timing`: a debounce of polls, or a window of time. Each converts to the other (`asWindow`, `asDebounce`). `failSpan` and `recoverSpan` give the earliest and the latest time to detect a change. At 3 polls of 5 s ± 20 %, a latch fails in 8–18 s on an error, and in 12–22 s on a 4 s timeout.
- **Checks.** A check names the step of the connection that it examines (`dial`, `round-trip`, `checkout` and others). It also tells if it uses the connection of the application, and which policy it controls. The policy has no default.
- **Idempotency for each operation.** One dependency has the two kinds of operation. A Redis GET is safe to send again. An INCR that goes again after a timeout counts two times. Thus each operation of a dependency, and each route of a controller, declares if it can go again: `true`, `false`, or keyed.
- **Keyed operations.** A keyed operation has the window that the server keeps its key for. `mayReissue` answers from the declaration of an operation. An operation without a declaration does not go again.
- **The law.** `evaluate` and `verdictOf` decide one rule of the timer-ordering law on one binding. A rule is data: linear inequalities over `symbol@hop`, with a margin. A verdict is `holds`, `violated`, `unbounded` (it holds only because a timer is absent) or `depends` (nothing is bound).
- **The linter.** `lint(description, scenario, rules)` applies the service rules (`SERVICE_RULES`) to a declaration. The declaration binds the symbols of the service: the polls of its checks, the windows of its policies, its drain. The scenario binds the symbols of the platform and of each dependency. A rule about a client applies one time for each dependency. A `depends` finding names the symbols that have no bound.

The format of a description is `mark1russell7.service/1`.

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
  .check({
    name: "db.round-trip",
    dependency: "db",
    step: "round-trip",
    ownConnection: true,
    gates: "readiness",
    poll,
  })
  .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
  .liveness({ type: "window", failAfter: s(45) })
  .startup(s(60))
  .phase("fail readiness", s(2))
  .phase("drain", s(15))
  .cooperativeWindow(s(5));

const rules: Rule[] = []; // the rules of the law, as data
const scenario = {
  platform: { "termination_grace@pod": s(30), "prestop_sleep@pod": s(5) },
  probes: { readiness: s(30), liveness: s(30) },
};
const findings = lint(svc.describe(), scenario, rules);
```

## Tests

`pnpm --filter @mark1russell7/service test` starts the tests: the timing algebra, the refusals of the builder, its partial export, and the four verdicts of the law. A test in jarvis compares this evaluator with the evaluator of the research, on 185 bindings. All decisions agree.

`pnpm --filter @mark1russell7/service build` writes the package for npm into `build/`.
