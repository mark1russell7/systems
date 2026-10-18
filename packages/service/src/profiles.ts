import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertible, valueIn } from "@mark1russell7/quantity";
import type { CooperativeFloor, Coupling, ExitCodes, MessageTrigger, Phase, RepeatSignal } from "./description.ts";
import type { ProcessTrigger } from "./process.ts";
import type { Timing } from "./timing.ts";

/**
 * A profile is a part of a declaration as data: policies, phases and the rules of the shutdown.
 * `svc.profile(profile)` declares each field, as its method does. The runtime has no defaults, and
 * a profile is not a default, because the caller gives it. The caller can change each field with a
 * spread. `describe()` then shows the values of the profile.
 *
 *     svc.profile({ ...kubernetes({ grace: s(60), preStop: s(5) }), onRepeatSignal: "exit" });
 */
export interface Profile {
  readonly readiness?: Timing | undefined;
  readonly liveness?: Timing | undefined;
  readonly startup?: Quantity | undefined;
  readonly couplings?: readonly Coupling[] | undefined;
  /** These are the phases of the shutdown, in their sequence. */
  readonly phases?: readonly Phase[] | undefined;
  readonly cooperativeWindow?: Extent | undefined;
  readonly cooperativeFloor?: CooperativeFloor | undefined;
  readonly onRepeatSignal?: RepeatSignal | undefined;
  readonly triggers?: readonly ProcessTrigger[] | undefined;
  /** These messages of the IPC channel start the shutdown, as `svc.trigger("ipc-message", message)` declares each one. */
  readonly messages?: readonly MessageTrigger[] | undefined;
  readonly exitCodes?: ExitCodes | undefined;
}

const s = (value: number): Quantity => ({ value, unit: "s" });
const phase = (name: string, cap: Quantity): Phase => ({ name, cap });

/**
 * This profile is for a service on the computer of a developer. No load balancer routes to it,
 * thus it has no readiness hold. Its caps sum to 10 s, and a second signal exits at once. It
 * declares no checks, thus the caller declares readiness, liveness and the startup budget.
 */
export const localDev: Profile = {
  phases: [
    phase("stop intake", s(1)),
    phase("drain", s(4)),
    phase("close transports", s(1)),
    phase("stop the poller", s(1)),
    phase("tear down dependencies", s(1)),
    phase("close the health server", s(1)),
    phase("flush the output", s(1)),
  ],
  cooperativeWindow: s(2),
  cooperativeFloor: "half",
  onRepeatSignal: "exit",
};

/**
 * This profile is for a background host on the computer of a developer, under a supervisor or a
 * command that stops it. It has the caps of `localDev`. A repeat signal has no effect, thus the
 * host ends its drain. It has no process trigger: a background host has no parent on stdin.
 */
export const daemon: Profile = {
  phases: localDev.phases!.map((each) => ({ ...each })),
  cooperativeWindow: localDev.cooperativeWindow!,
  cooperativeFloor: "half",
  onRepeatSignal: "ignore",
};

/**
 * This profile is for a small process: a command that runs one time, or a child process on stdio.
 * It has no checks and no probes, and its policies gate nothing. The cooperative abort occurs at the
 * start of the drain, thus a first Ctrl-C stops the work at once. A second signal exits at once.
 * The exit codes tell the shell how the process stopped: 130 for SIGINT, 143 for SIGTERM and 131
 * for SIGQUIT. A stdio child also declares `triggers: ["stdin-close"]`.
 */
export const ephemeral: Profile = {
  readiness: { type: "window", failAfter: s(0) },
  liveness: { type: "window", failAfter: s(0) },
  startup: s(10),
  phases: [
    phase("stop intake", s(1)),
    phase("drain", s(2)),
    phase("close transports", s(1)),
    phase("stop the poller", s(1)),
    phase("tear down dependencies", s(2)),
    phase("flush the output", s(1)),
  ],
  // the window is the whole drain, and no floor holds the abort back
  cooperativeWindow: s(2),
  cooperativeFloor: "none",
  onRepeatSignal: "exit",
  exitCodes: { SIGINT: 130, SIGTERM: 143, SIGQUIT: 131 },
};

/** These are the parts of the budget of each stage in the profile `kubernetes`, in thirtieths. */
const KUBERNETES_SHARES: ReadonlyArray<readonly [string, number]> = [
  ["fail readiness", 2],
  ["stop intake", 5],
  ["drain", 15],
  ["close transports", 2],
  ["stop the poller", 1],
  ["tear down dependencies", 2],
  ["close the health server", 1],
];
/** This part of the budget is the cooperative window, in thirtieths. */
const KUBERNETES_WINDOW = 5;

/** These are the settings of a pod that the profile `kubernetes` derives its caps from. */
export interface PodTiming {
  /** This time is `terminationGracePeriodSeconds`: from the deletion of the pod to SIGKILL. */
  readonly grace: Quantity;
  /** This time is the preStop sleep, or 0 for no preStop hook. SIGTERM comes after it. */
  readonly preStop: Quantity;
}

/**
 * This function gives the profile of a pod in Kubernetes. The budget is the grace less the preStop
 * sleep: the time from SIGTERM to SIGKILL. Each stage gets a part of the budget, rounded down to
 * the millisecond.
 * - The parts in thirtieths are 2, 5, 15, 2, 1, 2 and 1, in the sequence of the stages. Thus 2
 *   thirtieths of the budget stay as a margin before SIGKILL.
 * - The cooperative window is 5 thirtieths of the budget.
 * - The kubelet sends SIGTERM one time, thus a repeat signal has no effect.
 *
 * At the defaults of Kubernetes (a grace of 30 s and no preStop hook), the caps are 2, 5, 15, 2, 1,
 * 2 and 1 s. Thus the sum of the caps and the preStop sleep fits in the grace (O10). The window is
 * shorter than the drain, which is shorter than the budget (O16).
 */
export const kubernetes = (pod: PodTiming): Profile => {
  const time = (amount: Quantity, what: string): number => {
    if (!convertible(amount.unit, "s")) throw new Error(`the ${what} of the pod is not a time`);
    return valueIn(amount, "ms");
  };
  const grace = time(pod.grace, "grace");
  const preStop = time(pod.preStop, "preStop sleep");
  if (preStop < 0) throw new Error("the preStop sleep of the pod is less than 0");
  const budget = grace - preStop;
  if (!(budget > 0)) throw new Error(`the grace of the pod (${grace} ms) is not longer than its preStop sleep (${preStop} ms)`);
  const part = (thirtieths: number): Quantity => s(Math.floor((budget * thirtieths) / 30) / 1000);
  return {
    phases: KUBERNETES_SHARES.map(([name, thirtieths]) => phase(name, part(thirtieths))),
    cooperativeWindow: part(KUBERNETES_WINDOW),
    cooperativeFloor: "half",
    onRepeatSignal: "ignore",
  };
};
