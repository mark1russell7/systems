/**
 * The lenses of the port range: the search for a local port at each connect, and the time that a
 * closed connection holds its port. A connect fails with EADDRNOTAVAIL when each port that the search
 * reaches for its destination is held. The law of the search is `portSearchSpan` and
 * `portSearchShares` of the algebra. The time of a held port comes from the timers of the document of
 * Linux TCP. The cells PR.1 to PR.8 of the harness measure each term.
 *
 * The story of the page starts at the first connect. The client makes one connect each `connectGap`,
 * to its destinations in turn, and it closes each connection at once in the way of `close`. A
 * connection that stays open holds its port until the end of the story.
 */
import { PORT_SEARCH_CHAIN_LARGEST, portSearchShares, portSearchSpan, timerOf } from "@mark1russell7/algebra";
import { LINUX_TCP } from "@mark1russell7/machines";
import { format, quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { median } from "@mark1russell7/rigor-statistics";
import { bandOf, memo, say, sayBand, type Band, type Fact, type Lens, type Lane, type Mark, type Measured, type Verdict } from "../lens.ts";
import { ZERO, bandOfTimer, count, linuxTcpValues, ms, s } from "../path.ts";

/** A close is how the client ends each connection: it keeps it open, it closes first, the target closes first, or a reset. */
export type Close = "open" | "client" | "target" | "reset";

export interface PortSettings {
  /** the count of ports in `ip_local_port_range` */
  readonly portRange: number;
  /** the count of destinations, each one an address and a port, that the client connects to in turn */
  readonly destinations: number;
  /** the time between two connects of the client */
  readonly connectGap: Quantity;
  readonly close: Close;
  /** This flag is `tcp_tw_reuse` 1. Else the default 2 applies, which reuses a port in TIME_WAIT on loopback only. */
  readonly twReuse: boolean;
  /** `tcp_tw_reuse_delay`: the age of a TIME_WAIT that a new connect can take, with `tcp_tw_reuse` 1 */
  readonly reuseDelay: Quantity;
  /** This flag drops the first ACK of each FIN of the client. It acts when the target closes first. */
  readonly finAckLoss: boolean;
  readonly rtt: Quantity;
  readonly hz: number;
}

/** These are the defaults of Linux: the range 32768 to 60999, one connect each millisecond to one destination, and a client that closes first. */
export const PORT_DEFAULTS: PortSettings = {
  portRange: 28232,
  destinations: 1,
  connectGap: ms(1),
  close: "client",
  twReuse: false,
  reuseDelay: ms(1000),
  finAckLoss: false,
  rtt: ms(1),
  hz: 1000,
};

/** The lanes of the port range. */
export type PortLaneId = "search" | "hold";

// ---------------------------------------------------------------------------------------------
// the copy of the cells
// ---------------------------------------------------------------------------------------------

/** One counted run of a cell of the copy. It has the count of searches for each count of connects, and the times of the held ports in seconds. */
export interface PortCopyRun {
  readonly searches: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly firstFreed: number | null;
  readonly retransmissions: number;
}

/** One cell of the copy that `scripts/port-range.ts` writes. A cell with no record has the result null. */
export interface PortCopyCell {
  readonly plan: string;
  readonly name: string;
  readonly settings: {
    readonly size: number;
    readonly close: "reset" | "client" | "target";
    readonly destinations: number;
    readonly reuse: 1 | 2;
    readonly fault: "fin-ack" | null;
  };
  readonly result: null | { readonly decision: string; readonly counted: number; readonly runs: readonly PortCopyRun[] };
}

export interface PortCopy {
  readonly ranAt: string;
  readonly hz: number;
  readonly cells: readonly PortCopyCell[];
}

// ---------------------------------------------------------------------------------------------
// the law
// ---------------------------------------------------------------------------------------------

/** The search for a port of one destination: the ports that it reads, and the counts of connects before EADDRNOTAVAIL. */
export interface PortSearch {
  readonly span: number;
  /** each count of connects to one destination before the error, in rising order */
  readonly counts: readonly number[];
  /** the share of the largest count, when the range is odd and the exact chain takes it, else null */
  readonly share: number | null;
}

const shares = new Map<number, ReadonlyMap<number, number>>();

/** This function gives the law of the search for a range of `size` ports, from the algebra. The exact chain of an odd range is kept for each size. */
export const portSearch = (size: number): PortSearch => {
  const span = portSearchSpan(size);
  if (size === 1 || size % 2 === 0) return { span, counts: [size], share: null };
  if (size > PORT_SEARCH_CHAIN_LARGEST) return { span, counts: [size - 1, size], share: null };
  let law = shares.get(size);
  if (law === undefined) {
    law = portSearchShares(size);
    shares.set(size, law);
  }
  const counts = [...law.keys()].sort((a, b) => a - b);
  const top = counts.at(-1);
  return { span, counts, share: counts.length > 1 && top !== undefined ? (law.get(top) ?? 0) : null };
};

/** The hold of a closed port. It has the side in TIME_WAIT, the band from the close to the free port, and the retransmissions of each close. */
export interface PortHold {
  /** the band of the hold, or null when the connection stays open */
  readonly band: Band | null;
  readonly timeWait: "client" | "target" | "neither";
  /** the retransmissions of the FIN of the client, for each closed connection */
  readonly retransmissions: number;
}

/** This function gives the values of the knobs of Linux TCP for the port range: its round trip and its HZ. */
const values = (settings: PortSettings) => linuxTcpValues({ rtt: settings.rtt, hz: quantity(settings.hz, "Hz") });

/** This function gives the band of TIME_WAIT, from the timer `time_wait` of the document of Linux TCP. */
const timeWaitBand = (settings: PortSettings): Band | null => bandOfTimer(timerOf(LINUX_TCP, "time_wait", values(settings)));

/** This function gives the hold of a port for the close of the settings. */
export const portHold = (settings: PortSettings): PortHold => {
  switch (settings.close) {
    case "open":
      return { band: null, timeWait: "neither", retransmissions: 0 };
    case "reset":
      return { band: bandOf(ZERO), timeWait: "neither", retransmissions: 0 };
    case "client": {
      const wait = timeWaitBand(settings);
      // a new connect takes the port at the first millisecond after the delay, if the delay ends before TIME_WAIT
      const reuse = settings.twReuse && (wait === null || valueIn(settings.reuseDelay, "s") < valueIn(wait.low, "s"));
      return { band: reuse ? bandOf(settings.reuseDelay, s(valueIn(settings.reuseDelay, "s") + 0.001)) : wait, timeWait: "client", retransmissions: 0 };
    }
    case "target":
      // the client holds its port in LAST_ACK until the ACK of its FIN: one round trip, or the FIN again at the loss probe
      return settings.finAckLoss
        ? { band: bandOfTimer(timerOf(LINUX_TCP, "retransmit", values(settings), 0)), timeWait: "target", retransmissions: 1 }
        : { band: bandOf(settings.rtt), timeWait: "target", retransmissions: 0 };
  }
};

/** What the port range does with the settings: the law of the search, the hold, and the first EADDRNOTAVAIL. */
export interface PortModel {
  readonly search: PortSearch;
  readonly hold: PortHold;
  /** the time between two connects to one destination */
  readonly gap: Quantity;
  /** the band of the first EADDRNOTAVAIL, or null when each connect finds a port */
  readonly error: Band | null;
  /** This flag tells if the error comes in each round. Else it comes in some rounds only. */
  readonly sure: boolean;
  /** the largest count of held ports of one destination at one time, or null when no port comes back */
  readonly held: number | null;
  /** the smallest gap between two connects of the client that holds no error, or null when no gap does */
  readonly safeGap: Quantity | null;
}

/**
 * This function gives the law of the port range. A destination gets a connect each `gap`. The connect
 * `m` of a destination finds `min(m, ⌈H / gap⌉ - 1)` held ports, for a hold of `H`. Thus it fails when
 * `H` is more than `cap · gap`, and the first one to fail is the connect `cap`, at `cap · gap`.
 */
export const portModel = memo((settings: PortSettings): PortModel => {
  const search = portSearch(settings.portRange);
  const hold = portHold(settings);
  const gap = s(valueIn(settings.connectGap, "s") * settings.destinations);
  const per = valueIn(gap, "s");
  const low = search.counts[0] ?? 0;
  const high = search.counts.at(-1) ?? low;
  const holdLow = hold.band === null ? Infinity : valueIn(hold.band.low, "s");
  const holdHigh = hold.band === null ? Infinity : valueIn(hold.band.high, "s");
  const possible = holdHigh > low * per;
  return {
    search,
    hold,
    gap,
    error: possible ? bandOf(s(low * per), s(high * per)) : null,
    sure: holdLow > high * per,
    held: hold.band === null ? null : Math.min(high, Math.max(0, Math.ceil(holdHigh / per) - 1)),
    safeGap: hold.band === null ? null : s(holdHigh / (low * settings.destinations)),
  };
});

// ---------------------------------------------------------------------------------------------
// the measured values
// ---------------------------------------------------------------------------------------------

const CELLS_PAGE = "results/port-range/";

/** This function gives the cell of the copy whose settings are these, or undefined. */
const cellFor = (copy: PortCopy | null, match: (cell: PortCopyCell["settings"]) => boolean): PortCopyCell | undefined =>
  copy?.cells.find((cell) => cell.result !== null && match(cell.settings));

/** This function prints the counts of the searches of a cell: "16 in each of 200 searches", or the share of each count. */
const countsOf = (cell: PortCopyCell): string => {
  const runs = cell.result?.runs ?? [];
  const searches = runs.reduce((sum, run) => sum + run.searches, 0);
  const total = new Map<string, number>();
  for (const run of runs) for (const [connects, n] of Object.entries(run.counts)) total.set(connects, (total.get(connects) ?? 0) + n);
  const each = [...total].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (each.length === 1 && each[0] !== undefined) return `${format(count(Number(each[0][0])))} in each of ${format(count(searches))} searches`;
  return `${each.map(([connects, n]) => `${connects} in ${format(quantity((100 * n) / Math.max(1, searches), "%"), { digits: 1 })}`).join(", ")} of ${format(count(searches))} searches`;
};

/** This function gives the measured values of the search: the cells PR.1 to PR.4, when the size of the range and the destinations are theirs. */
const searchMeasured = (copy: PortCopy | null, settings: PortSettings, model: PortModel): Measured[] => {
  // the count is the law of the search, with each port held: a cell measures it with a reset after each round
  const cell = cellFor(copy, (cell) => cell.close === "reset" && cell.size === settings.portRange && cell.destinations === settings.destinations);
  if (cell === undefined) return [];
  const { counts, share } = model.search;
  const top = share === null ? "" : `, ${counts.at(-1)} in ${format(quantity(100 * share, "%"), { digits: 1 })} of the rounds`;
  return [{ cell: `${cell.plan} ${cell.name}`, measured: countsOf(cell), computed: `${counts.join(" or ")} connects to each destination${top}`, href: CELLS_PAGE, at: null }];
};

/**
 * This function gives the measured values of the hold, from the cells PR.5 to PR.8. A cell applies when
 * the settings are its settings and the HZ is the HZ of the runners. The hold of a port does not change with the size of the
 * range, thus the size of the cell is not a condition.
 */
const holdMeasured = (copy: PortCopy | null, settings: PortSettings, model: PortModel): Measured[] => {
  if (copy === null || settings.hz !== copy.hz) return [];
  const cell = cellFor(copy, (cell) => {
    if (settings.close === "client") return cell.close === "client" && cell.reuse === (settings.twReuse ? 1 : 2) && (!settings.twReuse || valueIn(settings.reuseDelay, "ms") === 1000);
    if (settings.close === "target") return cell.close === "target" && (cell.fault === "fin-ack") === settings.finAckLoss && (!settings.finAckLoss || valueIn(settings.rtt, "ms") === 1);
    return false;
  });
  if (cell === undefined || cell.result === null) return [];
  const runs = cell.result.runs;
  const freed = runs.flatMap((run) => (run.firstFreed === null ? [] : [run.firstFreed]));
  const name = `${cell.plan} ${cell.name}`;
  if (freed.length === 0) {
    const sent = runs.reduce((sum, run) => sum + run.retransmissions, 0);
    return [{ cell: name, measured: `${format(count(sent))} retransmissions in ${format(count(runs.length))} runs`, computed: `${format(count(model.hold.retransmissions))} for each port`, href: CELLS_PAGE, at: null }];
  }
  const middle = median(freed);
  return [
    {
      cell: name,
      measured: `${say(s(middle))} (median of ${format(count(freed.length))} runs)`,
      computed: model.hold.band === null ? "no port comes back" : sayBand(model.hold.band),
      href: CELLS_PAGE,
      at: s(middle),
    },
  ];
};

// ---------------------------------------------------------------------------------------------
// the lanes
// ---------------------------------------------------------------------------------------------

/** This function gives the lane of the search for the settings. */
const searchLane = (copy: PortCopy | null, settings: PortSettings): Lane<PortLaneId> => {
  const model = portModel(settings);
  const { search, hold, error, gap } = model;
  const per = valueIn(gap, "s");
  const low = search.counts[0] ?? 0;
  const marks: Mark[] = [{ t: ZERO, label: "Connect 1", kind: "send" }];
  // the first half of the span of each destination gets the ports of the parity of the low port, if no port comes back before
  const half = search.span / 2;
  if (search.span >= 2 && (hold.band === null || valueIn(hold.band.low, "s") > half * per)) {
    marks.push({ t: s(half * per), label: "The search moves to the ports of the other parity", kind: "probe" });
  }
  const facts: Fact[] = [
    { label: "Ports in the range", value: format(count(settings.portRange)) },
    { label: "Ports that the search reads", value: format(count(search.span)) },
    { label: "Connects to one destination, before the error", value: search.counts.map((n) => format(count(n))).join(" or ") },
  ];
  if (search.share !== null) facts.push({ label: `Rounds with ${search.counts.at(-1)} connects`, value: format(quantity(100 * search.share, "%"), { digits: 1 }) });
  facts.push({ label: "Held ports of one destination, at most", value: model.held === null ? "each port, until its close" : format(count(model.held)) });
  facts.push({ label: "The smallest gap with no error", value: model.safeGap === null ? "none: each connection keeps its port" : say(model.safeGap) });
  let verdict: Verdict = "silent";
  let summary: string;
  if (error !== null) {
    verdict = "detects";
    marks.push({ t: error.low, label: `Connect ${format(count(low * settings.destinations + 1))} gets EADDRNOTAVAIL`, kind: "detect" });
    summary = `Each port that the search reaches is held. Thus a connect at ${sayBand(error)} gets EADDRNOTAVAIL at once, and no SYN leaves.`;
  } else {
    summary = `Each connect finds a free port: one destination holds ${format(count(model.held ?? 0))} ports at most, and the search reaches ${format(count(low))}.`;
  }
  const warnings: string[] = [];
  if (settings.portRange % 2 === 1 && settings.portRange > PORT_SEARCH_CHAIN_LARGEST) {
    warnings.push(`The exact chain of the search takes ${PORT_SEARCH_CHAIN_LARGEST} ports at most. Thus the page gives the two counts with no share.`);
  }
  if (error !== null && !model.sure) warnings.push("The hold ends near the time of the last free port. Thus the error comes in some rounds only.");
  return {
    id: "search",
    verdict,
    band: error,
    summary,
    facts,
    marks,
    measured: searchMeasured(copy, settings, model),
    warning: warnings.length === 0 ? null : warnings.join(" "),
  };
};

/** The summary of the hold for each close. */
const holdSummary = (settings: PortSettings, band: Band | null): string => {
  switch (settings.close) {
    case "open":
      return "Each connection stays open, thus it holds its port until the program closes it.";
    case "reset":
      return "A reset closes the connection with no TIME_WAIT at either side. Thus the port is free at once.";
    case "client":
      return settings.twReuse && band !== null && valueIn(band.low, "s") === valueIn(settings.reuseDelay, "s")
        ? `With tcp_tw_reuse 1, a new connect takes a port in TIME_WAIT ${say(settings.reuseDelay)} after the FIN of the target, before the timer ends.`
        : `The client closes first, thus its socket waits in TIME_WAIT. The port is free again at ${band === null ? "an unknown time" : sayBand(band)}.`;
    case "target":
      return settings.finAckLoss
        ? `The first ACK of the FIN of the client drops. The client holds its port in LAST_ACK until its FIN goes again, at ${band === null ? "an unknown time" : sayBand(band)}.`
        : "The target closes first, thus TIME_WAIT is at the target. The client holds its port in LAST_ACK for one round trip, until the ACK of its FIN.";
  }
};

const SIDE: Readonly<Record<PortHold["timeWait"], string>> = { client: "the client", target: "the target", neither: "neither side" };

/** This function gives the lane of the hold for the settings. */
const holdLane = (copy: PortCopy | null, settings: PortSettings): Lane<PortLaneId> => {
  const model = portModel(settings);
  const { band, timeWait, retransmissions } = model.hold;
  // a reset frees its port at once: the lane recovers at 0
  const back = band !== null;
  const marks: Mark[] = [];
  if (back && settings.close === "target" && settings.finAckLoss) marks.push({ t: band.low, label: "The FIN of the client goes again", kind: "fire" });
  if (back) marks.push({ t: band.low, label: settings.close === "reset" ? "The reset frees each port at once" : "The first port is free again", kind: "recover" });
  const wait = timerOf(LINUX_TCP, "time_wait", values(settings)).duration;
  const facts: Fact[] = [
    { label: "The side in TIME_WAIT", value: SIDE[timeWait] },
    { label: "TIME_WAIT", value: say(wait) },
    { label: "tcp_tw_reuse", value: settings.twReuse ? "1" : "2, on loopback only" },
    { label: "Retransmissions of each close", value: format(count(retransmissions)) },
  ];
  const warnings: string[] = [];
  if (settings.finAckLoss && settings.close !== "target") warnings.push("The loss of the ACK of a FIN acts only when the target closes first.");
  if (settings.twReuse && settings.close !== "client") warnings.push("tcp_tw_reuse acts only on a port in TIME_WAIT at the client.");
  return {
    id: "hold",
    verdict: back ? "recovers" : "silent",
    band: back ? band : null,
    summary: holdSummary(settings, band),
    facts,
    marks,
    measured: holdMeasured(copy, settings, model),
    warning: warnings.length === 0 ? null : warnings.join(" "),
  };
};

/** This function gives the two lenses of the port range, with the measured values of a copy of the cells, or of no copy. */
export const portLenses = (copy: PortCopy | null): { readonly search: Lens<PortSettings, PortLaneId>; readonly hold: Lens<PortSettings, PortLaneId> } => ({
  search: {
    id: "search",
    names: { title: "The search for a local port", label: "Search", short: "Search", term: "ip_local_port_range" },
    knobs: ["portRange", "destinations", "connectGap"],
    lanes: (settings) => [searchLane(copy, settings)],
  },
  hold: {
    id: "hold",
    names: { title: "The held port", label: "Hold", short: "Hold", term: "TIME_WAIT" },
    knobs: ["close", "twReuse", "reuseDelay", "finAckLoss", "rtt", "hz"],
    lanes: (settings) => [holdLane(copy, settings)],
  },
});
