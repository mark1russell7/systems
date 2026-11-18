/**
 * The lens of TCP: the first live timer of Linux TCP for the fault, its firings, and the recovery after
 * a partition. The measured values are the cells Q1 to Q4 of the harness, when the settings are theirs.
 */
import { detection, errnoOf, probeTrain, recovery, timerOf, type Detection } from "@mark1russell7/automata";
import { LINUX_TCP } from "@mark1russell7/machines";
import { add, format, valueIn, type Quantity } from "@mark1russell7/quantity";
import harness from "../../data/harness-2026-10-13.json";
import { bandOf, memo, say, sayBand, type Band, type Fact, type Lens, type Mark, type Measured, type Verdict } from "../lens.ts";
import {
  ZERO,
  atLeast,
  bandOfTimer,
  capital,
  count,
  firstRetransmission,
  manifestationOf,
  rtoFirings,
  s,
  tcpValues,
  type LayerId,
  type LayerResult,
  type Settings,
} from "../path.ts";

/** The names of the timers of TCP for a reader. */
export const TCP_NAMES: Readonly<Record<string, string>> = {
  keepalive: "keepalive",
  retrans_giveup: "the retransmission give-up",
  user_timeout: "TCP_USER_TIMEOUT",
};

/** The S1 cells of the harness, by the settings that each one has. Each cell operates on Linux 6.6 at HZ 250, with no deadline of a program. */
const HARNESS = harness.cells;
const cellOf = (name: string) => HARNESS.find((cell) => cell.name === name);
const measuredOf = (name: string): string => {
  const cell = cellOf(name);
  const median = cell?.verdict.median ?? null;
  return median === null ? `silent in ${cell?.verdict.counted ?? 0} runs` : `${say(s(median))} (median of ${cell?.verdict.counted ?? 0} runs)`;
};

const scaledKeepalive = (settings: Settings): boolean =>
  settings.keepaliveOn && valueIn(settings.keepidle, "s") === 5 && valueIn(settings.keepintvl, "s") === 2 && settings.keepcnt === 3 && settings.hz === 250;

/** A cell counts its time from one of these events. The band of the page is in the same frame. */
const FROM: Readonly<Record<string, string>> = {
  "last-received": "from the last segment that the client got",
  "first-retransmission": "from the first retransmission",
};

const CELLS_PAGE = "results/cells/#the-kernel-of-the-client";
const RECOVERY_PAGE = "results/cells/#recovery-from-a-stall-q4";

/** This function gives the measured values of the TCP lane for the settings: the cells Q1 to Q4, when the settings are theirs. */
const tcpMeasured = (settings: Settings, computed: { band: Band | null; recovery: Band | null }): Measured[] => {
  const out: Measured[] = [];
  const show = (name: string, href: string, band: Band | null): void => {
    const cell = cellOf(name);
    if (cell === undefined) return;
    const frame = "from" in cell.prediction ? String(cell.prediction.from) : "";
    const from = FROM[frame];
    const computedText = band === null ? "no TCP timer fires" : `${sayBand(band)}${from === undefined ? "" : `, ${from}`}`;
    const median = cell.verdict.median;
    const at = median === null ? null : add(s(median), frame === "first-retransmission" ? firstRetransmission(settings) : ZERO);
    out.push({ cell: name, measured: measuredOf(name), computed: computedText, href, at });
  };
  if (settings.fault === "blackhole" && !settings.inFlight && scaledKeepalive(settings)) show("Q1 idle, black hole", CELLS_PAGE, computed.band);
  if (settings.fault === "blackhole" && settings.inFlight && settings.hz === 250 && (settings.retries2 === 3 || settings.retries2 === 5)) {
    show(`Q2 in flight, black hole, tcp_retries2 = ${settings.retries2}`, CELLS_PAGE, computed.band);
  }
  if (settings.fault === "stall" && settings.inFlight && settings.hz === 250 && scaledKeepalive(settings) && settings.retries2 === 3) show("Q3 in flight, frozen process", CELLS_PAGE, null);
  const length = valueIn(settings.heal, "s");
  if (settings.fault === "partition" && settings.inFlight && settings.hz === 250 && (length === 1 || length === 3.5)) {
    show(`Q4 in flight, a ${length} s stall`, RECOVERY_PAGE, computed.recovery);
  }
  return out;
};

/** What TCP does with the fault: its lane, the detection of the algebra, and the band of its give-up. */
export interface TcpModel {
  readonly layer: LayerResult;
  readonly found: Detection;
  readonly giveUp: Band | null;
}

/** This function gives what TCP does with the fault: the first live timer, its firings, and the recovery after a partition. */
export const tcpModel = memo((settings: Settings): TcpModel => {
  const manifestation = manifestationOf(settings.fault);
  const values = tcpValues(settings);
  const found = detection(LINUX_TCP, { state: "ESTABLISHED", inFlight: settings.inFlight }, manifestation, values);
  const first = found.first;
  const offset: Quantity = first?.timer === "retrans_giveup" || first?.timer === "user_timeout" ? firstRetransmission(settings) : ZERO;
  const own = first === null ? null : bandOfTimer(timerOf(LINUX_TCP, first.timer, values));
  const band = own === null ? null : bandOf(add(own.low, offset), add(own.high, offset));
  const marks: Mark[] = [];
  const facts: Fact[] = [];
  let recovered: Band | null = null;
  let verdict: Verdict = band === null ? "silent" : "detects";
  if (settings.fault === "partition" && settings.inFlight) {
    const back = recovery(LINUX_TCP, "retransmit", values, settings.heal);
    if (!("unknown" in back)) {
      recovered = bandOf(back.low, back.high);
      if (band === null || !atLeast(recovered.low, band.low)) verdict = "recovers";
    }
  }
  // the firings up to the end of the story of this lane: its recovery, or its give-up
  const horizon = verdict === "recovers" && recovered !== null ? recovered.low : (band?.low ?? s(3600));
  if (settings.inFlight && settings.fault !== "stall") {
    const sent = rtoFirings(settings, horizon);
    sent.forEach((t, n) => marks.push({ t, label: n === 0 ? "Tail loss probe" : `Retransmission ${n}`, kind: "fire" }));
    facts.push({ label: "First RTO", value: say(timerOf(LINUX_TCP, "retransmit", values, 1).duration) });
    facts.push({ label: "Retransmissions", value: format(count(Math.max(sent.length - 1, 0))) });
  }
  if (!settings.inFlight && settings.fault !== "stall" && settings.keepaliveOn) {
    probeTrain(settings.keepidle, settings.keepintvl, settings.keepcnt).forEach((t, n) => marks.push({ t, label: `Keepalive probe ${n + 1}`, kind: "probe" }));
  }
  const delack = timerOf(LINUX_TCP, "delayed_ack", values).duration;
  facts.push({ label: "Delayed ACK, at most", value: say(delack) });
  let summary: string;
  if (verdict === "recovers" && recovered !== null) {
    marks.push({ t: recovered.low, label: "The first retransmission after the heal gets through", kind: "recover" });
    summary = `TCP does not report the partition. A retransmission after the heal gets through at ${sayBand(recovered)}, and the request continues.`;
  } else if (first !== null && band !== null) {
    const errno = errnoOf(LINUX_TCP, "ESTABLISHED", first, manifestation) ?? "an error";
    summary = `${capital(TCP_NAMES[first.timer] ?? first.timer)} finds the fault at ${sayBand(band)}, and the socket gets ${errno}.`;
    marks.push({ t: band.low, label: `${TCP_NAMES[first.timer] ?? first.timer}: ${errno}`, kind: "detect" });
  } else if (settings.fault === "stall") {
    summary = "No TCP timer fires. The kernel of the stalled peer acknowledges each segment, and it answers each keepalive probe.";
  } else {
    summary = "No TCP timer is armed on an idle socket without SO_KEEPALIVE. TCP finds the fault only at the next send.";
  }
  for (const held of found.held) facts.push({ label: TCP_NAMES[held.timer] ?? held.timer, value: `held: ${held.why}` });
  const layer: LayerResult = {
    id: "tcp",
    verdict,
    band: verdict === "recovers" ? recovered : band,
    summary,
    facts,
    marks,
    measured: tcpMeasured(settings, { band: own, recovery: recovered }),
    warning: null,
  };
  return { layer, found, giveUp: band };
});

export const TCP: Lens<Settings, LayerId> = {
  id: "tcp",
  names: { title: "TCP", label: "TCP", short: "TCP", term: "RTO" },
  knobs: ["keepaliveOn", "keepidle", "keepintvl", "keepcnt", "retries2", "userTimeout", "rtt", "hz"],
  lanes: (settings) => [tcpModel(settings).layer],
};
