/**
 * The lens of the program: its deadline, its retries, and the time that the call ends. Below the program
 * is TCP, thus the lens reads the model of the TCP lens for the same settings.
 */
import { firings, recovery, stackedDetection, timerOf } from "@mark1russell7/automata";
import { DEADLINE_CALL, LINUX_TCP } from "@mark1russell7/machines";
import { add, convert, format, type Quantity } from "@mark1russell7/quantity";
import { bandOf, finite, say, sayBand, type Fact, type Lens, type Mark } from "../lens.ts";
import { ZERO, atLeast, callValues, count, manifestationOf, tcpValues, type LayerId, type LayerResult, type Settings } from "../path.ts";
import { TCP_NAMES, tcpModel } from "./tcp.ts";

/** This function gives the time of the send of each try of the call, from the first send, for the retries of the settings. */
const attemptStarts = (settings: Settings): Quantity[] => [
  ZERO,
  ...firings(DEADLINE_CALL, "retry", callValues(settings), { count: settings.retries }).map((firing) => firing.at),
];

/** This function gives what the program does: its deadline, its retries, and the time that the call ends. */
export const programLane = (settings: Settings): LayerResult => {
  const tcp = tcpModel(settings);
  const values = callValues(settings);
  const deadline = timerOf(DEADLINE_CALL, "deadline", values).duration;
  const facts: Fact[] = [{ label: "Deadline", value: finite(deadline) ? say(deadline) : "none" }];
  const marks: Mark[] = [{ t: ZERO, label: "The program sends the request", kind: "send" }];
  if (!settings.inFlight) {
    const stacked = stackedDetection(DEADLINE_CALL, LINUX_TCP, { state: "POOLED", inFlight: false }, manifestationOf(settings.fault), values, tcpValues(settings));
    const below = stacked.first;
    return {
      id: "process",
      verdict: below === null ? "silent" : "detects",
      band: tcp.layer.verdict === "detects" ? tcp.layer.band : null,
      summary:
        below === null
          ? "No call is open, thus no deadline runs. The program learns of the fault at its next request."
          : `No call is open. The program learns of the fault when the socket ends: ${TCP_NAMES[below.timer] ?? below.timer} closes it.`,
      facts,
      marks: [],
      measured: [],
      warning: null,
    };
  }
  const starts = finite(deadline) ? attemptStarts(settings) : [ZERO];
  const tcpBand = tcp.layer.verdict === "detects" ? tcp.layer.band : null;
  const tcpBack = tcp.layer.verdict === "recovers" ? tcp.layer.band : null;
  if (!finite(deadline)) {
    // without a deadline, only the socket below can end the call
    const band = tcpBand ?? tcpBack;
    return {
      id: "process",
      verdict: tcpBand !== null ? "detects" : tcpBack !== null ? "recovers" : "silent",
      band,
      summary:
        tcpBand !== null
          ? `The call has no deadline. It waits for TCP, and it fails at ${sayBand(tcpBand)}.`
          : tcpBack !== null
            ? `The call has no deadline. TCP carries the request through the partition, and the reply comes at ${sayBand(tcpBack)}.`
            : "The call has no deadline, and no layer below ends it. The call waits forever.",
      facts,
      marks,
      measured: [],
      warning: tcpBand === null && tcpBack === null ? "Set a deadline: no other layer ends this call." : null,
    };
  }
  const deadlineS = convert(deadline, "s");
  // a reply through TCP before the first deadline: the program sees only a slow reply
  if (tcpBack !== null && !atLeast(tcpBack.high, deadlineS)) {
    return {
      id: "process",
      verdict: "recovers",
      band: tcpBack,
      summary: `The reply comes at ${sayBand(tcpBack)}, before the deadline of ${say(deadline)}. The program sees a slow reply, not a fault.`,
      facts,
      marks,
      measured: [],
      warning: null,
    };
  }
  starts.forEach((start, n) => {
    if (n > 0) marks.push({ t: start, label: `Retry ${n}`, kind: "fire" });
    marks.push({ t: add(start, deadlineS), label: `Deadline of try ${n + 1}`, kind: n === 0 ? "detect" : "fire" });
  });
  const giveUp = add(starts.at(-1)!, deadlineS);
  facts.push({ label: "Tries", value: format(count(starts.length)) });
  facts.push({ label: "The call gives up at", value: say(giveUp) });
  if (settings.fault === "partition") {
    const heal = convert(settings.heal, "s");
    const after = starts.find((start) => atLeast(start, heal));
    if (after !== undefined) {
      const back = recovery(DEADLINE_CALL, "retry", values, settings.heal);
      const band = "unknown" in back ? bandOf(after) : bandOf(back.low, back.high);
      marks.push({ t: band.low, label: "The first try after the heal gets through", kind: "recover" });
      return {
        id: "process",
        verdict: "recovers",
        band,
        summary: `The deadline finds the fault at ${say(deadline)}. The first try after the heal starts at ${sayBand(band)}, and it gets the reply.`,
        facts,
        marks,
        measured: [],
        warning: null,
      };
    }
  }
  return {
    id: "process",
    verdict: "detects",
    band: bandOf(deadlineS),
    summary:
      starts.length === 1
        ? `The deadline finds the fault at ${say(deadline)}, and the call fails.`
        : `The deadline finds the fault at ${say(deadline)}. ${starts.length - 1} ${starts.length === 2 ? "retry" : "retries"} also wait, and the call fails at ${say(giveUp)}.`,
    facts,
    marks,
    measured: [],
    warning: null,
  };
};

export const PROGRAM: Lens<Settings, LayerId> = {
  id: "process",
  names: { title: "The program", label: "Program", short: "Program", term: null },
  knobs: ["timeout", "retries", "backoff"],
  lanes: (settings) => [programLane(settings)],
};
