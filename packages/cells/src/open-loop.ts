import type { Cell, LoadBand, LoadPlan, LoadPrediction } from "@mark1russell7/harness";
import type { Profile, ScheduleOptions } from "@mark1russell7/rigor-chaos";
import { constant } from "@mark1russell7/rigor-chaos";
import { REDIS, RUNS, ms, q, s } from "./catalog.ts";

/**
 * The open-loop cells (SYS-68). The client sends each request at its time in a schedule, and a send
 * does not wait for a reply. Thus a stall delays each arrival behind it, and each latency counts
 * from its planned time.
 *
 * The A/A cells inject nothing, and they test the client. Each send stays near its time, and the
 * latency stays near the service time of the closed-loop twin. The freeze cells are the positive
 * control of that gate. The same stall gives a large p99 to the open-loop client, and only one slow
 * reply to the closed-loop client (coordinated omission).
 */

/** This target can stop by a signal with stamps, thus its freeze ends at its instant. */
const FROZEN = { ...REDIS, program: "redis-server" };

/** This time is the longest run of an open-loop cell. The schedules take 20 s at most. */
const WINDOW = q(40);

/** This time is the longest lag of a send behind its time on a hosted runner. A later send is a finding of its run. */
const LAG = ms(50);

/** This band is the gate of an A/A cell: with no fault, the p99 of the latency is under one scheduler stall. */
const NO_FAULT: LoadBand = { quantile: 0.99, high: ms(10) };

/** This time is how long the freeze holds. It starts when the fault holds, before the `go` of the client. */
const HOLD = s(1);

/**
 * This band is the p99 of the latency under the freeze. The freeze holds for P = 1 s, and the client
 * starts δ later: approximately 0.1 s, the time of the command that starts it. An arrival at t waits
 * for P − δ − t, thus the arrival of rank 1 % of the 2,000 (t = 0.2 s) waits approximately 0.7 s.
 */
const FROZEN_P99: LoadBand = { quantile: 0.99, low: ms(550), high: ms(850) };

/** This function gives an open-loop probe. */
const scheduled = (profile: Profile, options: ScheduleOptions): Cell["probe"] => {
  const plan: LoadPlan = { profile, options };
  return { mode: "schedule", keepalive: false, plan };
};

/** This function gives the prediction of an open-loop cell. */
const measured = (why: string, bands: readonly LoadBand[]): Cell["prediction"] => {
  const load: LoadPrediction = { lag: LAG, bands };
  return { detects: null, window: WINDOW, why, load };
};

/** These fields are the same in each cell. */
const COMMON = { sysctls: {}, runs: RUNS, environments: 2, concurrency: 1 };

/** This probe is the closed-loop twin of 100 requests each second: a send follows the reply before it by 10 ms. */
const CLOSED: Cell["probe"] = { mode: "stream", keepalive: false, count: 2_000, interval: ms(10) };

/** These are the open-loop cells: three A/A cells on a schedule and their closed-loop twin, then the freeze on both clients. */
export const OPEN_LOOP_CELLS: readonly Cell[] = [
  {
    ...COMMON,
    name: "OL.aa.uniform.100, 100 requests each second for 20 s at even gaps, nothing injected",
    target: REDIS,
    fault: "none",
    probe: scheduled(constant(100, 20_000), { arrivals: "uniform" }),
    prediction: measured("an A/A run of the client: each send stays near its time", [NO_FAULT]),
  },
  {
    ...COMMON,
    name: "OL.aa.poisson.100, 100 requests each second for 20 s at random gaps, nothing injected",
    target: REDIS,
    fault: "none",
    probe: scheduled(constant(100, 20_000), { arrivals: "poisson", seed: "OL.aa.poisson.100" }),
    prediction: measured("an A/A run of the client: short gaps do not move a send", [NO_FAULT]),
  },
  {
    ...COMMON,
    name: "OL.aa.uniform.1000, 1,000 requests each second for 5 s at even gaps, nothing injected",
    target: REDIS,
    fault: "none",
    probe: scheduled(constant(1_000, 5_000), { arrivals: "uniform" }),
    prediction: measured("an A/A run at ten times the rate: this client holds the schedule at this rate", [NO_FAULT]),
  },
  {
    ...COMMON,
    name: "OL.aa.closed, a stream of 2,000 requests 10 ms apart, nothing injected",
    target: REDIS,
    fault: "none",
    probe: CLOSED,
    prediction: { detects: null, window: WINDOW, why: "the closed-loop twin of the A/A cells: its reply times are the service time" },
  },
  {
    ...COMMON,
    name: "OL.freeze.open, 100 requests each second for 20 s, the server frozen for 1 s at the start",
    target: FROZEN,
    fault: "freeze-process",
    hold: HOLD,
    probe: scheduled(constant(100, 20_000), { arrivals: "uniform" }),
    prediction: measured("the positive control: each arrival in the stall waits for the end of the stall", [FROZEN_P99]),
  },
  {
    ...COMMON,
    name: "OL.freeze.closed, a stream of 2,000 requests 10 ms apart, the server frozen for 1 s at the start",
    target: FROZEN,
    fault: "freeze-process",
    hold: HOLD,
    probe: CLOSED,
    prediction: { detects: null, window: WINDOW, why: "the same stall with a closed loop: it hides each send in the stall, thus one reply shows it and the p99 does not" },
  },
];
