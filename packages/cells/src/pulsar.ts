import type { KindCell, Workload } from "@mark1russell7/kind";
import { PING, PRODUCER_BACKOFF, SESSION, TICK, triesOf } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { DESIGN, WORKERS, kubeDefaults, ms, s, say } from "./kind.ts";

/**
 * This module holds the cell of Pulsar in S2 (SYS-56). Pulsar 5.0.0 runs from its chart 4.8.0 with one
 * ZooKeeper, one bookie and two brokers. One broker owns the bundle of the topic. A producer of the
 * Python client 3.13.0 on each worker sends to the topic. A probe in the same pod asks the HTTP
 * lookup for the owner. A crash stops the JVM of the owner with SIGKILL. The question: when does each
 * producer send again?
 *
 * Each term comes from the pinned sources:
 * - The owner holds the bundle through its session in ZooKeeper. The session expires 30 s after the
 *   last packet from the broker, rounded up to the tick of 2 s. The client of the broker pings after
 *   9 s with no other packet. Thus the expiry is 21 s to 32 s after the crash.
 * - Up to the expiry, each lookup gives the dead owner from the cache, with no check of its life.
 *   After it, one broker takes the bundle. That broker can be the other one, or the owner, because
 *   the kubelet starts its container again (the first run of this cell: 2 of 6 runs).
 * - The producer tries again on a backoff from 100 ms that doubles up to 60 s. The mandatory stop
 *   cuts one delay to end 29.9 s after the first call. Each delay can be up to 9 % less. Thus the
 *   tries are 0.1 s, 0.3 s, …, 12.7 s, 25.5 s, 29.9 s and 81.1 s after the first call.
 * - The first try after the change of the owner succeeds. Each earlier try fails, and the producer
 *   is back after the setup of that try.
 */

/** This count is the producers: one on each worker. */
export const PRODUCERS = WORKERS;

/**
 * The producers send each 200 ms. The client keeps up to 1000 pending messages, and 30 s at this
 * rate is 150. A send that takes more than 1 s is `late`, and one with no answer in 30 s is `timeout`.
 */
export const PULSAR_WORKLOAD: Workload = { every: ms(200), timeout: s(1) };

/** The probe asks for the owner each 250 ms. A lookup waits up to 1 s. Thus the gap between two lookups is at most 1.25 s. */
export const PULSAR_PROBE: Quantity = ms(250);
const LOOKUP_WAIT = 1;

/** This band is the setup of the try that succeeds: a lookup, a connection, the load of the topic and the answer to the producer. */
const SETUP = { lo: s(0), hi: s(3) };

const time = (value: number): Quantity => s(Math.round(value * 1e6) / 1e6);

/** This function gives the band of the change of the owner, from the crash. It is the expiry of the session, and up to 1 s for the new owner. */
export const flipOf = (): { readonly lo: Quantity; readonly hi: Quantity } => {
  const session = valueIn(SESSION, "s");
  const tick = valueIn(TICK, "s");
  const ping = valueIn(PING, "s");
  // the server expires a session in the first tick at or after the last packet and the timeout
  const lo = session - ping;
  const hi = Math.ceil(session / tick) * tick + tick;
  return { lo: time(lo - 0.5), hi: time(hi + 1) };
};

/** This function gives the cell of the crash of the broker that owns the topic. */
const pulsarCellOf = (): KindCell => {
  const flip = flipOf();
  // the tries with no jitter and no time to fail
  const tries = triesOf({ ...PRODUCER_BACKOFF, jitter: 0 }, 90_000).map((each) => say(time(each.lo / 1000)));
  return {
    id: "S2.T07.iptables.pulsar.broker-crash",
    name: "T07 iptables, Pulsar loses the broker that owns the topic: a producer on each worker",
    template: "T07",
    substitutes: null,
    mode: "iptables",
    workers: WORKERS,
    pod: kubeDefaults(2),
    declaration: DESIGN,
    workload: PULSAR_WORKLOAD,
    trigger: { kind: "crash" },
    pulsar: { clients: PRODUCERS, probe: PULSAR_PROBE },
    calibrates: false,
    runs: 4,
    prediction: {
      kind: "reconnects",
      flip,
      owner: "either",
      probe: time(valueIn(PULSAR_PROBE, "s") + LOOKUP_WAIT),
      disconnect: { lo: s(0), hi: s(1) },
      backoff: PRODUCER_BACKOFF,
      setup: SETUP,
      outcomes: ["late", "timeout"],
      why: `${PRODUCERS} producers send to one topic each ${say(PULSAR_WORKLOAD.every)}. A crash stops the broker that owns its bundle. The session of that broker in ZooKeeper expires ${say(time(valueIn(SESSION, "s") - valueIn(PING, "s")))} to ${say(time(Math.ceil(valueIn(SESSION, "s") / valueIn(TICK, "s")) * valueIn(TICK, "s") + valueIn(TICK, "s")))} after the crash: the timeout of ${say(SESSION)}, the ping after ${say(PING)} and the tick of ${say(TICK)}. Then one broker takes the bundle, ${say(flip.lo)}–${say(flip.hi)} after the crash: the other broker, or the owner after its restart. Each producer tries again at ${tries.join(", ")} after its first call, with up to 9 % less in each delay. The first try after the change of the owner succeeds, up to ${say(SETUP.hi)} later. The naive law puts each return at the expiry, 28–32 s after the crash`,
    },
  };
};

/** These are the cells of Pulsar: the crash of the owner of the topic. */
export const PULSAR_CELLS: readonly KindCell[] = [pulsarCellOf()];
