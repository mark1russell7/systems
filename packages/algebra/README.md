# @mark1russell7/algebra

State machines as data, and the timer algebra over them. A machine document gives the states, transitions, timers and knobs of one machine, for example Linux TCP. The algebra then gives how long each timer operates, in exact rationals, from the values of the knobs. It also gives which timer finds a failure first, and when a connection moves again after a stall. `runMachine` operates a live instance of a document on a clock.

## The machine document

A machine document has the format `mark1russell7.machine/1`, and `machineSchema` accepts it. The schema is in the entry `@mark1russell7/algebra/schema`.

- **States and transitions.** A transition goes from one or more states to a state, on one or more events. The state `"*"` is each state that is not final.
- **Timers.** A timer has a duration, the events that arm it, the events that cancel it, and the event that it fires. It can also have a lateness and an early bound.
- **Durations.** A duration is a constant, a knob, arithmetic over knobs (`+ - * /`, `min`, `max`, `floor`, `ceil`, `pow`), or a named model. `pow` takes a whole exponent, for example the `fired` of a backoff with a multiplier of 1.5.
- **Knobs.** Each knob has its key in its system, its scope, its unit and its default. A switch or a choice has the unit `null`.
  - A knob can give the value that turns its timers off (`off`). Redis's `timeout` 0 closes no client, and `TCP_USER_TIMEOUT` 0 is no timeout. A time that reads the knob at that value has no bound, in each expression. Thus a caller gives the value of the system, and the algebra reads its meaning.
- **Backoff timers.** A backoff timer starts again after it fires, and each wait is longer than the last. Its waits read `fired`: the number of times that it fired after a reset.
- **Layers.** A machine can operate on another machine (`over`): a driver on its kernel socket. Each state of the upper machine is on a state of the lower machine. Some knobs of the upper machine set knobs of the lower machine. The end of the lower machine arrives as an event of the upper machine.
- **Realizations.** A machine can give the time of a mechanism (`realizes`): one of its timers, or a time of its own over its knobs.

`machineProblems` finds the problems of consistency in a document. For example, a transition names a state, an event or a timer that does not exist.

The documents of the systems program are in [`@mark1russell7/machines`](https://www.npmjs.com/package/@mark1russell7/machines). They include Linux TCP, conntrack, Redis, ioredis, the Valkey Sentinel, HTTP and WebSocket clients and servers, and MongoDB. That package uses this package, and this package does not use it.

## The algebra

- **Exact values.** `evaluate` and `timerOf` give a duration in the unit of its document, with exact rational arithmetic. Thus 0.2 s × 1023 is 204.6 s. A knob without a value gives an unknown result that names the knob. A knob that nothing sets gives a duration without an end.
- **No bound has a sign.** A step of the arithmetic can be no bound below. For example, a cap less a timer that nothing sets is −∞. Thus `max(cap − ∞, cap / 2)` is cap / 2, and `min` keeps −∞.
- **Results without a value.** A finite time over no bound is 0. A result that is no bound below is unknown, because a duration is not negative. No bound less no bound is unknown too.
- **Models.** A model is the formula of an implementation. The package has these models:
  - `linux.retrans-budget`: the retransmission give-up of the kernel (`tcp_model_timeout`). At the defaults it is 924.6 s.
  - `linux.retrans-step`: how late the give-up comes after its budget, at the real RTO of the path.
  - `linux.rto-wait` and `linux.rto-wait-lateness`: one wait of the retransmission timer, from the tail loss probe, and its rounding.
  - `linux.keepalive-lateness`, `linux.wheel` and `linux.jiffy`: the rounding of the timer wheel at the HZ of the kernel.
  - `linux.time-wait-lateness`: the rounding of the 60 s of TIME_WAIT (`TCP_TIMEWAIT_LEN`) on the wheel. At HZ 1000 a port in TIME_WAIT can stay held up to 4.096 s more.
  - `linux.delack` and `linux.delack-lateness`: the longest wait of the delayed ACK, and its rounding. The wait is the smoothed round trip in whole jiffies, from `TCP_DELACK_MIN` (HZ/25, 40 ms) to `TCP_DELACK_MAX` (HZ/5, 200 ms).
  - `linux.syn-giveup` and `linux.syn-giveup-lateness`: the SYN give-up of 6.5 and later, with linear timeouts, and the rounding of each of its waits on the wheel. At the defaults the give-up is 131 s, up to 6.08 s late at HZ 1000.
  - `linux.syn-wait` and `linux.syn-wait-lateness`: one wait of the SYN timer, after `fired` firings, and its rounding. At the defaults the waits 0 to 4 are 1 s, up to 64 ms late at HZ 1000.
  - `linux.synack-wait` and `linux.synack-wait-lateness`: one wait of the SYN-ACK timer of a request in `SYN_RECV`, after `fired` firings, and its rounding. The wait doubles from 1 s up to 120 s.
  - `linux.synack-giveup`, `linux.synack-giveup-lateness` and `linux.synack-giveup-early`: the expiry of a request after `tcp_synack_retries` + 1 waits, and its bounds. At the default 5 the expiry is 63 s, up to 1.728 s late at HZ 1000.
  - `ioredis.retry-base`: the reconnect delay of ioredis 6, min(2^(times − 1) × 50, 5000) ms.
  - `linux.rto-wait-reverted` and `linux.retrans-step-reverted`: the retransmissions when each one gets an ICMP host or net unreachable. The revert of RFC 6069 (`tcp_ld_RTO_revert`) takes back each doubling, thus each wait is one RTO.
- **The accept queue.** `acceptQueueLimit` gives the limit of the accept queue of a listener: the backlog of listen(2), with `somaxconn` as its cap. A negative backlog gives `somaxconn`. `acceptQueueHeld` gives the count of connections that the queue holds. This count is the limit plus one, because the kernel finds the queue full only above its limit.
- **The memory limit of a cgroup.** These functions follow `mm/memcontrol.c` and `mm/oom_kill.c` of Linux 7.0. A usage or a limit is in pages.
  - `memcgHighDelay` gives the delay of a task that charges memory above `memory.high`, in jiffies. The delay grows with the square of the largest overage of the cgroup and its ancestors. For a high of 100 MiB at HZ 1000, the delay at 110 MiB is 639 ms.
  - `memcgHighSleep` gives the sleep from that delay. The sleep has a cap of 2 s. A delay of HZ / 100 jiffies or less gives no sleep.
  - `memcgSleepBounds` gives the first usage that sleeps, and the first usage at the cap. For a high of 100 MiB at HZ 1000, these usages are 1.3% and 17.7% above the high.
  - `memcgThrottle` adds the sleeps of a task that charges one batch of 64 pages at a time. It also counts the events `high` of the cgroup. Each charge above the high reclaims one time, and each charge that sleeps reclaims 17 times.
  - `oomBadness` gives the points of a task for the OOM killer of a cgroup. `oomVictim` gives the task that it takes. The OOM killer does not take a task at an `oom_score_adj` of −1000.
- **The search for a local port.** `portSearchSpan` gives the size that the search of a connect reads: the size of `ip_local_port_range`, rounded down to an even number. `portSearchShares` gives the share of each count of connects to one destination before `EADDRNOTAVAIL`. An even range gives its size in each round. An odd range gives its size or one less, from the exact chain of `portSearchChain`, up to 16 ports. The sources are `__inet_hash_connect` of Linux v7.0.
- **Detection.** `detection` gives the minimum over the timers that are live in the situation of the connection. With no live timer, the failure is silent at this level. `stackedDetection` adds the timers of the machine below.
- **Manifestations.** A manifestation tells which incoming events a failure lets through. A black hole lets nothing through. The kernel of a frozen process continues to send ACKs, which stop keepalive before it fires. A manifestation can also tell:
  - the events that the failure sends one time (`delivers`), for example the FIN of a process that stopped with SIGKILL. Such an event detects the failure at once (`Detection.delivered`).
  - the errno that replaces ETIMEDOUT at a timeout (`errno`). An ICMP error on an established socket is a soft error, and the timeout gives it (`errnoOf`).
  - the durations that the failure changes, by timer (`replaces`). `timerUnder` gives the bounds of a timer under the failure.
- **Recovery.** `recovery` tells when a backoff timer moves a connection again after a stall. The connection moves at the first firing at the end of the stall or after it. A stall of 3.5 s on Linux TCP holds a request for approximately 6.5 s.
- **The times on a timeline.** These functions give exact times, in seconds:
  - `timerBand` gives the band of a timer: its duration less its early bound, to its duration plus its lateness.
  - `firings` gives the firings of a backoff timer as the sums of its waits. Examples are the retransmissions of Linux TCP, or the tries of a call with a deadline. It stops at a count, at a time (`until`), or at the first firing at a time or after it (`reach`).
  - `probeTrain` gives a train of probes: the first probe, then one probe each interval. An example is the probes of keepalive.

## The replay

`replay(doc, trace, options)` replays a trace against a machine document, and gives each disagreement. A trace is a list of transitions. Each transition has an instance, the state that it leaves, an event and the state that it enters.

- **Each instance on its own.** Each instance starts in the state that its first transition leaves. Each transition must leave the state where the replay of its instance is.
- **The document permits each transition.** The document must have a transition from that state, on that event, to that state. The state `"*"` is each state that is not final.
- **Open names.** Each program names its own machines, states and events. `options.machine` selects the transitions of one machine in a trace of many machines.
- **A small entry.** `@mark1russell7/algebra/replay` gives only the replay, in less than 0.5 kB of gzip. It does not import zod, thus a client in a browser can replay its own transitions.

```ts
import { replay } from "@mark1russell7/algebra/replay";

const problems = replay(CONNECTION_MACHINE, recorded, { machine: CONNECTION_MACHINE.id });
// for example ["c1: app.machine.connection has no transition from OPEN on open to OPEN"]
```

## The run

`runMachine(doc, options)` starts a live instance of a machine document on a clock. It gives the run: `state`, `send(event)` and `stop()`. The run follows these rules:

- **Transitions.** `send(event)` takes the transition of the document from the state on the event, and gives it. It gives undefined when the state has no transition on the event. An event that the document does not name is an error.
- **Timers.** In sequence, these events operate the timers: the event, each event that the transition emits, and `enter:<to>`. A transition to the state that it leaves also enters that state again. An event without a transition also operates the timers.
- **Arms and cancels.** An event of `cancels` stops a timer. An event of `arms` starts it again from its full duration. An event in the two lists stops the timer, as in `detection`.
- **Durations.** The run reads each duration from `timerOf`, with the knob values of the options or the defaults of the knobs. It converts the duration to milliseconds exactly. A duration with no bound, for example a knob at its `off` value, starts no timer.
- **Backoff timers.** A backoff timer starts again after it fires, with its next wait. An event of its `resets` sets its count to 0.
- **The start and the end.** At the start, the instance enters its start state, thus `enter:<state>` can arm a timer. The entry to a final state stops each timer. `stop()` stops each timer, and after it each send does nothing.
- **A record for the replay.** `onTransition` gets each transition in the form that `replay` reads. Thus a recorded run replays against its document with no problem.

The example is the lock of an app. The lock arms after 2000 ms with no load of a page. Each stop of a load starts that time again.

```ts
import type { Machine, Transition } from "@mark1russell7/algebra";
import { fakeClock } from "@mark1russell7/algebra/clock";
import { replay } from "@mark1russell7/algebra/replay";
import { runMachine } from "@mark1russell7/algebra/run";

const LOCK: Machine = {
  format: "mark1russell7.machine/1",
  id: "app.machine.lock",
  title: "A lock that arms after a quiet time",
  layer: "self",
  version: "1.0.0",
  sources: [{ ref: "the app", rung: "implemented" }],
  states: { loading: { initial: true }, armed: {} },
  events: { start: { kind: "app" }, stop: { kind: "app" }, press: { kind: "app" }, settled: { kind: "timer" }, reload: { kind: "app" } },
  knobs: { settle: { key: "settle", scope: "lock", unit: "ms", default: 2000 } },
  timers: {
    settle: { duration: { knob: "settle", unit: "ms" }, arms: ["stop"], cancels: ["start", "press", "reload"], fires: "settled" },
  },
  transitions: [
    { id: "lock.arm", from: "loading", to: "armed", on: ["press", "settled"] },
    { id: "lock.reload", from: "armed", to: "loading", on: "reload" },
  ],
};

const clock = fakeClock();
const trace: Transition[] = [];
const lock = runMachine(LOCK, { clock, onTransition: (transition) => trace.push(transition) });
lock.send("start");
lock.send("stop"); // a load, at 0 ms
await clock.advance(1500);
lock.send("start");
lock.send("stop"); // a second load, 1500 ms later: the time starts again
await clock.advance(1999);
lock.state; // "loading"
await clock.advance(1);
lock.state; // "armed", 2000 ms after the last load
replay(LOCK, trace); // []
```

An app gives `realClock` of `@mark1russell7/algebra/clock` in place of the fake clock. The entry `@mark1russell7/algebra/run` does not import zod, thus a client in a browser can operate its own machines.

## The clock

`@mark1russell7/algebra/clock` gives the clock of a runtime and a fake clock for tests. The entry imports nothing: no `node:` module, no zod and no other package. Thus a client in a browser can use it. The service and collections read time through it.

| Export | What it does |
| --- | --- |
| `Clock` | `now()` gives the monotonic time in milliseconds. `after(ms, run)` starts `run` after `ms` and gives its `Cancel`. |
| `platformClock({ unref, speed, start })` | A clock on `performance.now()` and `setTimeout`. With `unref: true`, its timers do not keep a Node process alive. With a speed or a start, the clock is scaled. |
| `realClock` | `platformClock()`: its timers keep a Node process alive, as `setTimeout` does. |
| `unrefClock(clock)` | A clock with the time of `clock`, whose timers do not keep a Node process alive. A wall clock stays a wall clock. |
| `wallClock({ unref, speed, start })` | A `WallClock`: `now()` gives the instant of `Date.now()`, and its timers are the timers of `platformClock`. With a speed or a start, the clock is scaled. |
| `fakeClock(start)` | A clock that moves only on `advance(ms)`. `block(ms)` moves it and starts no timer, as a blocked event loop does. `pending` counts the live timers. |
| `fakeWallClock(start, monotonic?)` | A fake `WallClock`. `set(instant)` steps its instant forward or back, and no timer moves. With a `fakeClock` as `monotonic`, the two clocks share one queue of timers. |
| `delay(clock, ms, signal?)` | A promise that resolves after `ms` on a `Clock` or a `WallClock`. An abort of the signal stops the timer and rejects with the reason of the signal. |

```ts
import { delay, fakeClock, realClock } from "@mark1russell7/algebra/clock";

const clock = fakeClock();
clock.after(30_000, () => cache.sweep());
await clock.advance(30_000); // the sweep runs, at 30 s exactly

// a wait before the next try, which the drain stops
await delay(realClock, retryAfter, controller.signal);
```

### The rule of `unref`

Each timer of `realClock` keeps a Node process alive, as `setTimeout` does. Thus a process does not end in a wait that a caller awaits, for example the wait of a retry.

- The owner of a timer uses the `unref` of its cancel only when a socket, a child process or another hold keeps the process alive. Examples are the heartbeat of a connection and the health checks of a service.
- Each other timer stays referenced, a ticker too. Its caller stops it.
- `unrefClock(clock)` gives a part a clock whose timers do not keep the process alive. The owner of the part gives it only when another hold keeps the process alive.
- `platformClock({ unref: true })` makes each timer of a new clock an exception, with the same condition.
- A hang shows. A silent exit with the code 0 and lost work does not. Before algebra 0.9.0, the timers of `realClock` did not keep the process alive, and a command-line tool ended in the wait of a retry.

### A scaled clock

A scaled clock runs a long schedule in a short real time, on the real timers. A fake clock moves only on `advance`. Thus it cannot drive a server, a proxy or a socket that waits on real time.

- `speed` is the milliseconds of the clock in one real millisecond: a finite number above 0. At the speed 60, `now()` moves 60 ms in each real millisecond, and a timer of 60 s ends after 1 real second.
- `start` is the time of `now()` when the clock is made. The default is the time of the platform.
- `now()` counts from the start on the monotonic time. Thus a step of the wall clock of the platform does not move it. A wall clock gives whole milliseconds, as `Date.now()` does.
- When the platform starts a timer before its due time on the clock, the timer waits again for the rest. Thus `run` reads its due time or a later time.
- A bad speed or a bad start throws a `RangeError`.

```ts
import { wallClock } from "@mark1russell7/algebra/clock";

// 80 minutes of a source in 80 s of real time
const clock = wallClock({ speed: 60, start: Date.now(), unref: true });
clock.after(10 * 60_000, () => console.log("10 minutes on the clock, 10 s of real time"));
```

The clock reads `performance.now()` at each timer. Thus the fake timers of a test also fake `performance`, for example `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })`.

### Civil time

The entry also gives civil time: the time on the wall of a time zone at an instant, and windows of local time. An instant is in milliseconds from 1970, as `Date.now()` gives. Civil time uses only `Intl.DateTimeFormat`.

| Export | What it does |
| --- | --- |
| `localTime(instant, zone)` | It gives the year, the month, the day, the hour, the minute, the second, the day of the week and the offset of the zone, or `undefined` for a bad zone. |
| `instantsOf(wall, zone)` | The inverse of `localTime`: the instants at which the clock of the zone shows the wall-clock time `wall`, in order. A gap gives none, and an hour that occurs two times gives two. The caller chooses the rule for these two cases. |
| `offsetChanges(from, to, zone)` | It gives the instants in `(from, to]` at which the offset of the zone changes, exact to the millisecond. |
| `TimeWindow` | A window as data: `{ zone, start, end, days? }`. The start and the end are local times `HH:MM`. |
| `inWindow(instant, window)` | It tells if the instant is in the window. A bad window gives `false`. |
| `nextBoundary(instant, window)` | It gives the next instant at which the window opens or closes, as `{ at, opens }`. A timer can wait for it. It looks 9 days ahead at most. It gives `undefined` for a window with no change in that time. |
| `windowProblems(window)` | It gives the problems of a window: a bad zone, a bad local time or a bad day. |

These rules apply to a window:

- The start is in the window, and the end is not. An end before the start crosses midnight. An end equal to the start gives the full day.
- `days` are the days of the week on which the window starts, from 0 (Sunday) to 6. A window across midnight continues into the next day.
- The window follows the time on the wall when the clock changes. A start or an end in a gap moves to the end of the gap. A local time that occurs two times is in the window two times.
- An example: on 2026-10-25 in Berlin, a window from 22:00 to 02:30 closes at 00:30Z. It opens again at 01:00Z and closes at 01:30Z.

A wall-clock time for `instantsOf` is in milliseconds with the arithmetic of UTC: the UTC fields of `new Date(wall)` are the fields of the clock. Thus `Date.UTC(2026, 9, 25, 2, 30)` is 02:30 on the wall.

```ts
import { instantsOf, offsetChanges } from "@mark1russell7/algebra/clock";

instantsOf(Date.UTC(2026, 9, 25, 2, 30), "Europe/Berlin"); // two instants: 00:30Z and 01:30Z
instantsOf(Date.UTC(2026, 2, 29, 2, 30), "Europe/Berlin"); // []: the clock goes from 02:00 to 03:00
offsetChanges(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), "Europe/Berlin"); // 2026-03-29T01:00Z and 2026-10-25T01:00Z
```

```ts
import { inWindow, nextBoundary, realClock } from "@mark1russell7/algebra/clock";

const night = { zone: "Europe/Berlin", start: "22:00", end: "07:00" };
inWindow(Date.now(), night); // true from 22:00 to 06:59 in Berlin, in summer time and in winter time
const next = nextBoundary(Date.now(), night); // { at, opens }: the next change of the window
if (next !== undefined) realClock.after(next.at - Date.now(), () => console.log(next.opens ? "quiet" : "loud"));
```

## Installation

```sh
pnpm add @mark1russell7/algebra zod
```

The package uses [`@mark1russell7/quantity`](https://www.npmjs.com/package/@mark1russell7/quantity) for each amount.

The root entry has the machine types, the consistency checks and the algebra. It does not import `zod`.

| Entry | What it has | `zod` |
| --- | --- | --- |
| `@mark1russell7/algebra` | The machine types, the consistency checks, the algebra, `replay` and `runMachine` | No |
| `@mark1russell7/algebra/clock` | The clock of a runtime, a fake clock for tests, and civil time | No |
| `@mark1russell7/algebra/replay` | The replay of a trace against a machine document | No |
| `@mark1russell7/algebra/run` | The run of a live instance of a machine document | No |
| `@mark1russell7/algebra/schema` | `machineSchema`, the schema of a machine document | Yes |

The schema is in the entry `@mark1russell7/algebra/schema`. That entry uses `zod` as an optional peer dependency, as `@mark1russell7/quantity/schema` does. An application that does not parse documents can install the package without `zod`.

**From 0.7 to 0.8.** The root entry does not give `machineSchema`. Import it from `@mark1russell7/algebra/schema`.

## Example

```ts
import { detection, timerOf } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

const tcp = machineSchema.parse(linuxTcpDocument);
const values = (name: string) =>
  ({
    keepidle: { value: 7200, unit: "s" },
    keepintvl: { value: 75, unit: "s" },
    keepcnt: { value: 9, unit: "count" },
  })[name];

timerOf(tcp, "keepalive", values).duration; // { value: 7875, unit: "s" }

const idle = { state: "ESTABLISHED", inFlight: false };
detection(tcp, idle, { name: "blackhole", passes: [] }, values).first?.timer; // "keepalive"
```

## Tests

`pnpm --filter @mark1russell7/algebra test` starts the tests. Each test writes its own small machines. The machines are a socket with the timers of a kernel's TCP, a server over the socket, and a driver with a backoff. The tests compute each model at the defaults of Linux 6.6, and the rounding of the timer wheel. They also compute the backoff waits, recovery after a stall, and detection for each fault.

The replay tests use a machine with its own names, and they hold the entry of the replay without zod. The tests of the run use a lock, a call with a backoff and a connection with a keepalive, on the fake clock. Each run of the lock with 4 steps or fewer replays against its document with no problem. A test of the root entry fails if the root imports zod.

The tests of the algebra on the real documents are in `@mark1russell7/machines`.

`pnpm --filter @mark1russell7/algebra build` writes the package for npm into `build/`.
