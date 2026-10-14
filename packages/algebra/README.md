# @mark1russell7/algebra

State machines as data, and the timer algebra over them. A machine document gives the states, transitions, timers and knobs of one machine, for example Linux TCP. The algebra then gives how long each timer operates, in exact rationals, from the values of the knobs. It also gives which timer finds a failure first, and when a connection moves again after a stall.

## The machine document

A machine document has the format `mark1russell7.machine/1`, and `machineSchema` accepts it.

- **States and transitions.** A transition goes from one or more states to a state, on one or more events. The state `"*"` is each state that is not final.
- **Timers.** A timer has a duration, the events that arm it, the events that cancel it, and the event that it fires. It can also have a lateness and an early bound.
- **Durations.** A duration is a constant, a knob, arithmetic over knobs (`+ - * /`, `min`, `max`, `floor`, `ceil`), or a named model.
- **Knobs.** Each knob has its key in its system, its scope, its unit and its default. A switch or a choice has the unit `null`.
- **Backoff timers.** A backoff timer starts again after it fires, and each wait is longer than the last. Its waits read `fired`: the number of times that it fired after a reset.
- **Layers.** A machine can operate on another machine (`over`): a driver on its kernel socket. Each state of the upper machine is on a state of the lower machine. Some knobs of the upper machine set knobs of the lower machine. The end of the lower machine arrives as an event of the upper machine.
- **Realizations.** A machine can give the time of a mechanism (`realizes`): one of its timers, or a time of its own over its knobs.

`machineProblems` finds the problems of consistency in a document. For example, a transition names a state, an event or a timer that does not exist.

## The algebra

- **Exact values.** `evaluate` and `timerOf` give a duration in the unit of its document, with exact rational arithmetic. Thus 0.2 s × 1023 is 204.6 s. A knob without a value gives an unknown result that names the knob. A knob that nothing sets gives a duration without an end.
- **Models.** A model is the formula of an implementation. The package has these models:
  - `linux.retrans-budget`: the retransmission give-up of the kernel (`tcp_model_timeout`). At the defaults it is 924.6 s.
  - `linux.retrans-step`: how late the give-up comes after its budget, at the real RTO of the path.
  - `linux.rto-wait` and `linux.rto-wait-lateness`: one wait of the retransmission timer, from the tail loss probe, and its rounding.
  - `linux.keepalive-lateness`, `linux.wheel` and `linux.jiffy`: the rounding of the timer wheel at the HZ of the kernel.
  - `linux.syn-giveup`: the SYN give-up of 6.5 and later, with linear timeouts. At the defaults it is 131 s.
  - `ioredis.retry-base`: the reconnect delay of ioredis 6, min(2^(times − 1) × 50, 5000) ms.
  - `linux.rto-wait-reverted` and `linux.retrans-step-reverted`: the retransmissions when each one gets an ICMP host or net unreachable. The revert of RFC 6069 (`tcp_ld_RTO_revert`) takes back each doubling, thus each wait is one RTO.
- **Detection.** `detection` gives the minimum over the timers that are live in the situation of the connection. With no live timer, the failure is silent at this level. `stackedDetection` adds the timers of the machine below.
- **Manifestations.** A manifestation tells which incoming events a failure lets through. A black hole lets nothing through. The kernel of a frozen process continues to send ACKs, which stop keepalive before it fires. A manifestation can also tell:
  - the events that the failure sends one time (`delivers`), for example the FIN of a process that stopped with SIGKILL. Such an event detects the failure at once (`Detection.delivered`).
  - the errno that replaces ETIMEDOUT at a timeout (`errno`). An ICMP error on an established socket is a soft error, and the timeout gives it (`errnoOf`).
  - the durations that the failure changes, by timer (`replaces`). `timerUnder` gives the bounds of a timer under the failure.
- **Recovery.** `recovery` tells when a backoff timer moves a connection again after a stall. The connection moves at the first firing at the end of the stall or after it. A stall of 3.5 s on Linux TCP holds a request for approximately 6.5 s.

## Installation

```sh
pnpm add @mark1russell7/algebra zod
```

The package uses [`@mark1russell7/quantity`](https://www.npmjs.com/package/@mark1russell7/quantity) for each amount, and both packages use `zod` as a peer dependency.

## Example

```ts
import { detection, machineSchema, timerOf } from "@mark1russell7/algebra";

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

`pnpm --filter @mark1russell7/algebra test` starts the tests. Four machine documents are their fixtures: Linux TCP, conntrack TCP, the Redis server and ioredis. The tests compute the defaults of Linux 6.6 and the rounding of the timer wheel. They also compute the scaled cells of the harness, the backoff waits, recovery after a stall, and detection for each fault.

`pnpm --filter @mark1russell7/algebra build` writes the package for npm into `build/`.
