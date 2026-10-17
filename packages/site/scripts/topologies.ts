// The export of the topology cells of step 3 for the site: src/data/topologies-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/topologies.ts <folder>...
//
// Each folder is the output of the runner of @systems/cells: one raw record for each cell, and
// rejudged.ndjson, the verdict of each record from the final `observe.ts`. A folder of a run at a
// later harness has summary.ndjson only, and its verdicts are of that harness. A full run of the
// catalogs holds each catalog: the export takes T03, T02, Toxiproxy and its slice of T01. A cell in a later folder
// is the re-run of the same cell of an earlier folder, thus the folder of the re-runs goes last.
// The page shows the first run and the re-run. The script reads each record again with the code of
// the harness (`judge`). It stops when that verdict disagrees with rejudged.ndjson, or when a
// prediction disagrees with the catalog. The copy keeps only what the page shows. It keeps no boot
// id, image digest, container, namespace inode, user or path.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cell, Hop, Manifest, Measured, ProxyHop, Run, Verdict } from "../../harness/src/index.ts";
import { judge, measure, NOISE } from "../../harness/src/index.ts";
import { duration } from "../src/lib/format.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/topologies.ts <folder>...\n");
  process.exit(2);
}

/** A record is the raw record of one cell, as the runner of @systems/cells writes it. */
interface CellRecord {
  readonly cell: Cell;
  readonly manifests: readonly Manifest[];
  readonly runs: readonly Run[];
  readonly warmups?: readonly Run[];
  readonly at: { readonly started: string; readonly ended: string };
}
/** A judgement is one line of rejudged.ndjson: the verdict of a cell from the final `observe.ts`. */
interface Judgement {
  readonly name: string;
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
  readonly median: { readonly value: number } | null;
  readonly warmups: readonly (number | string)[];
}
interface Found {
  readonly record: CellRecord;
  readonly judgement: Judgement;
}

/** These are the records of each cell by its name: the first run, then a re-run if a later folder has one. */
const found = new Map<string, Found[]>();
for (const folder of folders) {
  const judgements = new Map<string, Judgement>();
  // the verdicts from the final measure, or else the run's own
  const verdicts = existsSync(join(folder, "rejudged.ndjson")) ? "rejudged.ndjson" : "summary.ndjson";
  for (const line of readFileSync(join(folder, verdicts), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const judgement = JSON.parse(line) as Judgement;
    judgements.set(judgement.name, judgement);
  }
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".json")).sort()) {
    const record = JSON.parse(readFileSync(join(folder, file), "utf8")) as CellRecord;
    const judgement = judgements.get(record.cell.name);
    if (judgement === undefined) throw new Error(`${file}: ${verdicts} has no line for ${record.cell.name}`);
    found.set(record.cell.name, [...(found.get(record.cell.name) ?? []), { record, judgement }]);
  }
}

// the catalogs read the HZ of the kernel when they load, thus they load after the HZ of the records is known
const hzs = [...new Set([...found.values()].flat().flatMap((entry) => entry.record.manifests.flatMap((manifest) => (manifest.hz ? [manifest.hz] : []))))];
if (hzs.length !== 1) throw new Error(`the records disagree on HZ: ${hzs.join(", ")}`);
process.env["CELLS_HZ"] = hzs[0]!;
const { ALL } = await import("../../cells/src/all.ts");
const { T03_CELLS, T03_FAULT_SPECS, T03_SPECS, o03Of } = await import("../../cells/src/t03.ts");
const { T02_CELLS } = await import("../../cells/src/t02.ts");
const { TOX_CELLS } = await import("../../cells/src/toxiproxy.ts");

/** These T01 cells are the slice of step 3: one cell of each family of manifestations, the two observers, the stall, the MTU black hole and one netem distribution. */
const SLICE = [
  "client idle, blackhole",
  "client idle, fin",
  "client in flight, blackhole, tcp_retries2 = 3",
  "client in flight, unreachable-host, tcp_retries2 = 3",
  "client in flight, freeze-process",
  "client in flight, a 1 s stall",
  "server idle, blackhole",
  "server, a reply in flight, simplex-to-client, tcp_retries2 = 3",
  "server, a long reply, mtu-blackhole, tcp_retries2 = 3",
  "client stream, netem loss 5%",
].map((name) => `T01 ${name}`);
// a full run of the catalogs holds the cells of each catalog: this export takes its own
const own = new Set([...T03_CELLS, ...T02_CELLS, ...TOX_CELLS].map((cell) => cell.name).concat(SLICE));
const every = new Set(ALL.map((cell) => cell.name));
const strange = [...found.keys()].filter((name) => !every.has(name));
if (strange.length > 0) throw new Error(`no catalog has the cells ${strange.join(", ")}`);
for (const name of [...found.keys()]) if (!own.has(name)) found.delete(name);

/** These are the Linux 6.6 values of the sysctls that a cell sets. The page shows only the sysctls that differ. */
const LINUX_66: Readonly<Record<string, string>> = {
  "net.ipv4.tcp_syn_retries": "6",
  "net.ipv4.tcp_syn_linear_timeouts": "4",
  "net.ipv4.tcp_retries2": "15",
  "net.ipv4.tcp_keepalive_time": "7200",
  "net.ipv4.tcp_keepalive_intvl": "75",
  "net.ipv4.tcp_keepalive_probes": "9",
  "net.ipv4.tcp_fin_timeout": "60",
};
const changed = (sysctls: Readonly<Record<string, string>> | undefined) =>
  Object.entries(sysctls ?? {})
    .filter(([name, value]) => LINUX_66[name] !== value)
    .map(([name, value]) => ({ name, value }));
const entries = (settings: Readonly<Record<string, string | number>> | undefined) =>
  Object.entries(settings ?? {}).map(([name, value]) => ({ name, value: String(value) }));

/** This function rounds a time in seconds to 0.1 µs, so that no binary fraction reaches the copy. */
const round = (seconds: number): number => Number(seconds.toFixed(7));
const secondsOf = (quantity: { readonly value: number; readonly unit: string } | null | undefined): number | null => {
  if (quantity === undefined || quantity === null) return null;
  const scale: Readonly<Record<string, number>> = { s: 1, ms: 1e-3 };
  const factor = scale[quantity.unit];
  if (factor === undefined) throw new Error(`no scale for the unit ${quantity.unit}`);
  return round(quantity.value * factor);
};
/** This function writes a time in seconds for the text of the page. */
const time = (seconds: number): string => duration(seconds * 1000);

/** These are the products of the proxy images, by the repository and the tag of the image. The catalog pins each digest. */
const PRODUCTS: Readonly<Record<string, string>> = {
  "haproxy:3.2": "HAProxy 3.2.25",
  "ghcr.io/shopify/toxiproxy:2.12.0": "Toxiproxy 2.12.0",
};

/** This function gives a hop of a topology for the page: a router with its form, or a proxy with its mode and its settings. */
const hopOf = (hop: Hop) => {
  if (hop.kind === "router")
    return { name: hop.name, kind: hop.kind, form: hop.form, idle: secondsOf(hop.idle), product: null, mode: null, settings: [], sysctls: [] };
  const image = hop.image.replace(/@.*$/, "");
  const product = PRODUCTS[image];
  if (product === undefined) throw new Error(`no product for the image ${image}`);
  // the mode of an HAProxy, from its configuration file
  const mode = Object.values(hop.files ?? {}).map((text) => /^\s*mode (\w+)$/m.exec(text)?.[1]).find((each) => each !== undefined) ?? null;
  return { name: hop.name, kind: hop.kind, form: null, idle: null, product, mode, settings: entries(hop.settings), sysctls: changed(hop.sysctls) };
};

type Place = "client" | "target" | { readonly hop: string; readonly toward: "client" | "target" | null };

/** This function gives the place of the fault of a cell: an end, a hop, or one side of a hop. */
const placeOf = (cell: Cell): Place => {
  const hops = cell.topology?.hops ?? [];
  const server = cell.observer === "server";
  switch (cell.fault) {
    case "middlebox-forget": {
      const router = hops.find((hop) => hop.kind === "router");
      if (router === undefined) throw new Error(`${cell.name}: a forget needs a router`);
      return { hop: router.name, toward: null };
    }
    case "proxy-idle": {
      // the side of the shorter idle timeout of the proxy
      const proxy = hops.find((hop): hop is ProxyHop => hop.kind === "proxy");
      const client = Number.parseFloat(proxy?.settings?.["timeout client"] ?? "");
      const target = Number.parseFloat(proxy?.settings?.["timeout server"] ?? "");
      if (proxy === undefined || Number.isNaN(client) || Number.isNaN(target)) throw new Error(`${cell.name}: no idle timeout`);
      return { hop: proxy.name, toward: client < target ? "client" : "target" };
    }
    case "toxic": {
      const proxy = hops.find((hop) => hop.kind === "proxy");
      if (proxy === undefined || cell.toxic === undefined) throw new Error(`${cell.name}: a toxic needs Toxiproxy`);
      return { hop: proxy.name, toward: cell.toxic.stream === "downstream" ? "client" : "target" };
    }
    case "server-close":
    case "netem":
      return "target";
    case "mtu-blackhole":
      return "client";
    case "freeze-process":
    case "fin":
      return server ? "client" : "target";
    default:
      return cell.faultAt ?? (server ? "client" : "target");
  }
};

/** This function gives the mode of the client of a cell: idle, a request in flight, or a stream. */
const modeOf = (cell: Cell): string => cell.probe.mode;

/**
 * These are the reasons of the measurement-only cells for the page, by the reason that the catalog
 * gives. The text of the catalog is for the code, thus the page gets shorter sentences.
 */
const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^HAProxy has no machine document\. .*: the client side times out at 5 s/,
    "HAProxy has no machine document yet. Its documentation gives an idle timeout to each side, and a keepalive probe carries no data. Thus the client side closes at 5 s, with or without the keepalive probes of the client.",
  ],
  [
    /^HAProxy has no machine document\. .*: the server side times out at 5 s/,
    "HAProxy has no machine document yet. Its documentation gives an idle timeout to each side, and a keepalive probe carries no data. Thus the server side closes at 5 s, with or without the keepalive probes of Redis.",
  ],
  [
    /^HAProxy has no machine document for what it does on one side when the other side fails/,
    "HAProxy has no machine document yet, and its documentation does not tell what it does on one side when the other side fails. The client gets what HAProxy sends when its own keepalive gives up on the server.",
  ],
  [
    /^Toxiproxy documents its toxics, but not what it sends to the client when its upstream connection fails$/,
    "Toxiproxy has no machine document yet. Its documentation tells what each toxic does, but not what Toxiproxy sends to the client when its upstream connection fails.",
  ],
  [
    /^Toxiproxy documents a rate, not when the last byte arrives/,
    "Toxiproxy has no machine document yet. Its documentation gives the rate of the toxic, not the time of the last byte. The harness measures the time to the last data.",
  ],
  [
    /^Toxiproxy documents slices and a delay between them, not how its reads cut the reply/,
    "Toxiproxy has no machine document yet. Its documentation gives the slices and the delay between them, not how its reads cut the reply. The harness measures the time to the last data.",
  ],
];
/** This text is the start of the reason of each distribution cell of T01, as the catalog writes it. */
const DISTRIBUTION = /^its reply times are a distribution: (.+)\. A simulator predicts it, and the algebra does not$/;

/** This function gives the prediction of a cell in one shape: a detection, silence, a reply in a band, a recovery, or a measurement only. */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const none = { timer: null, errno: null, from: null, low: null, high: null, window: null, why: null };
  if (p.detects === null) {
    if (p.from === undefined) {
      const why = DISTRIBUTION.exec(p.why)?.[1];
      if (why === undefined) throw new Error(`${cell.name}: the reason "${p.why}" has an unknown form`);
      return { kind: "measured", ...none, window: secondsOf(p.window), why };
    }
    const why = REASONS.find(([form]) => form.test(p.why))?.[1];
    if (why === undefined) throw new Error(`${cell.name}: the reason "${p.why}" has no text for the page`);
    return { kind: "measured", ...none, from: p.from, window: secondsOf(p.window), why };
  }
  if (p.detects)
    return { kind: "detects", ...none, timer: p.timer, errno: p.errno, from: p.from, low: secondsOf(p.low), high: secondsOf(p.high) };
  if (p.recovers !== undefined)
    return { kind: "recovers", ...none, low: secondsOf(p.recovers.low), high: secondsOf(p.recovers.high), window: secondsOf(p.window) };
  if (p.replies !== undefined)
    return { kind: "replies", ...none, from: "request-sent", low: secondsOf(p.replies.low), high: secondsOf(p.replies.high), window: secondsOf(p.window) };
  return { kind: "silent", ...none, window: secondsOf(p.window) };
};

const outcomeOf = (run: Measured): string =>
  run.outcome.kind === "error" ? run.outcome.errno : run.outcome.kind === "eof" ? "EOF" : run.outcome.kind;

/** These phrases name the reference of a measurement-only cell, in a sentence. */
const FROM: Readonly<Record<string, string>> = {
  "last-received": "the last segment that the observer received",
  "request-sent": "the send of the request",
};

/** This function writes the verdict of a cell as the page shows it: what the counted runs measured, against the prediction. */
const whyOf = (cell: Cell, verdict: Verdict, measured: readonly Measured[]): string => {
  const p = cell.prediction;
  const counted = measured.filter((run) => run.void === null);
  const median = secondsOf(verdict.median);
  if (p.detects === null) {
    if (p.from === undefined) {
      const samples = counted.flatMap((run) => run.samples ?? []).map((sample) => secondsOf(sample)!).sort((a, b) => a - b);
      const ended = counted.filter((run) => run.outcome.kind === "error" || run.outcome.kind === "eof").length;
      return `The ${counted.length} counted runs got ${samples.length} replies. The median reply took ${time(median ?? 0)}, and the slowest took ${time(samples.at(-1) ?? 0)}. ${ended === 0 ? "No connection ended" : `${ended} connections ended`}.`;
    }
    const times = counted.flatMap((run) => (run.elapsed === null ? [] : [secondsOf(run.elapsed)!])).sort((a, b) => a - b);
    return `The median is ${time(median ?? 0)} from ${FROM[p.from] ?? p.from}, and the counted runs measured ${time(times[0] ?? 0)} to ${time(times.at(-1) ?? 0)}.`;
  }
  if (verdict.band === null) {
    const detected = verdict.outside.length;
    return detected === 0
      ? `Nothing detected the fault in the ${counted.length} counted runs, each of ${time(secondsOf(p.window)!)}.`
      : `${detected} of the ${counted.length} counted runs detected the fault.`;
  }
  const low = secondsOf(verdict.band.low)!;
  const high = secondsOf(verdict.band.high)!;
  const off = new Set(
    verdict.outside.filter((each) => each.why.includes(" is outside [")).map((each) => each.run),
  ).size;
  const interval = verdict.medianInterval;
  const parts = [
    `${counted.length - off} of the ${counted.length} counted runs are in the band of ${time(low)} to ${time(high)}.`,
    `The median is ${time(median ?? 0)}, and its interval is ${time(secondsOf(interval?.low) ?? 0)} to ${time(secondsOf(interval?.high) ?? 0)}.`,
  ];
  // a run that ended with an errno other than the prediction is a finding, whatever its time
  const wrong = p.detects ? counted.filter((run) => outcomeOf(run) !== p.errno) : [];
  if (p.detects && wrong.length > 0)
    parts.push(`${wrong.length} of the ${counted.length} counted runs ended with ${[...new Set(wrong.map(outcomeOf))].join(" or ")}, not ${p.errno}.`);
  const timed = p.detects ? p : (p.recovers ?? p.replies)!;
  const wide = { low: secondsOf(timed.low)! * 0.95, high: secondsOf(timed.high)! * 1.05 };
  if (interval !== null && (secondsOf(interval.high)! < wide.low || secondsOf(interval.low)! > wide.high))
    parts.push(`That interval is outside the prediction with a margin of 5 %, ${time(round(wide.low))} to ${time(round(wide.high))}. Thus the cell fails on its median.`);
  return parts.join(" ");
};

/** This function gives the verdict of a cell for the page. */
const verdictOf = (cell: Cell, verdict: Verdict, measured: readonly Measured[], warmups: number) => ({
  decision: verdict.decision,
  counted: verdict.counted,
  voided: verdict.voided,
  warmups,
  band: verdict.band === null ? null : { low: secondsOf(verdict.band.low), high: secondsOf(verdict.band.high) },
  median: secondsOf(verdict.median),
  why: whyOf(cell, verdict, measured),
});

/** This function gives the fastest, the median and the slowest reply of a run of a distribution cell. */
const repliesOf = (run: Measured) => {
  const sorted = (run.samples ?? []).map((sample) => secondsOf(sample)!).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, fastest: null, median: null, slowest: null };
  const half = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
  return { count: sorted.length, fastest: sorted[0]!, median: round(median), slowest: sorted.at(-1)! };
};

/** This function gives one run for the page. A run of T03 also gives when the router forgot the flow. */
const runOf = (cell: Cell, verdict: Verdict) => (run: Measured) => {
  const name = `env ${run.environment} run ${run.index}`;
  const findings = verdict.outside.filter((each) => each.run === name).map((each) => each.why);
  return {
    environment: run.environment,
    outcome: outcomeOf(run),
    elapsed: secondsOf(run.elapsed),
    void: run.void,
    finding: findings.length === 0 ? null : findings.join(". "),
    // each run has each key, so that the copy has one type of run: null where the cell has no router or no stream
    forgot: secondsOf(run.forgot),
    replies: cell.probe.mode === "stream" ? repliesOf(run) : null,
  };
};

/** This function gives a warm-up run: its outcome and its time, which the verdict does not count. */
const warmupOf = (run: Measured) => ({ environment: run.environment, outcome: outcomeOf(run), elapsed: secondsOf(run.elapsed) });

/** This function reads one record with the harness, and stops when the harness disagrees with rejudged.ndjson. */
const judged = (entry: Found) => {
  const { record, judgement } = entry;
  const { cell } = record;
  const { measured, verdict } = judge(cell, record.runs);
  if (
    verdict.decision !== judgement.decision ||
    verdict.counted !== judgement.counted ||
    verdict.voided !== judgement.voided ||
    (verdict.median?.value ?? null) !== (judgement.median?.value ?? null)
  )
    throw new Error(`${cell.name}: the harness now gives ${verdict.decision} (${verdict.why}), and rejudged.ndjson gives ${judgement.decision}`);
  const warmups = (record.warmups ?? []).map((run) => measure(cell, run));
  const again = warmups.map((run) => run.elapsed?.value ?? run.outcome.kind);
  if (JSON.stringify(again) !== JSON.stringify(judgement.warmups))
    throw new Error(`${cell.name}: the warm-ups now read ${JSON.stringify(again)}, and rejudged.ndjson gives ${JSON.stringify(judgement.warmups)}`);
  return {
    verdict: verdictOf(cell, verdict, measured, warmups.length),
    warmups: warmups.map(warmupOf),
    runs: measured.map(runOf(cell, verdict)),
  };
};

/** This function gives the group of a cell on the page: a section of its catalog. */
const groupOf = (catalog: string, cell: Cell): string => {
  if (catalog === "T03") return `${cell.observer === "server" ? "server" : "client"} ${modeOf(cell)}`;
  if (catalog === "T02") return cell.fault;
  if (catalog === "TOX") return cell.topology === undefined ? "direct" : cell.fault === "rst" || cell.fault === "blackhole" ? "close" : "toxic";
  return "slice";
};

/** This function gives the bytes of the value that the setup of a cell puts in Redis, or null. */
const bytesOf = (cell: Cell): number | null => {
  const command = (cell.targetSetup ?? []).flat().join(" ");
  const bytes = /head -c (\d+) /.exec(command)?.[1];
  return bytes === undefined ? null : Number(bytes);
};

/** These are the figures of the T01 cells on the page of the network failures, by name. */
const faults = JSON.parse(readFileSync(fileURLToPath(new URL("../src/data/faults-2026-10-14.json", import.meta.url)), "utf8")) as {
  readonly ranAt: string;
  readonly cells: ReadonlyArray<{ readonly name: string; readonly verdict: { readonly decision: string; readonly median: number | null } }>;
};

const CATALOG = /^(T03|T02|TOX|T01) /;
const cells = ALL.flatMap((catalog) => {
  const runsOf = found.get(catalog.name);
  if (runsOf === undefined) return [];
  if (runsOf.length > 2) throw new Error(`${catalog.name}: more than one re-run`);
  const [first, again] = runsOf as [Found, Found | undefined];
  const { cell } = first.record;
  for (const entry of runsOf)
    if (JSON.stringify(entry.record.cell.prediction) !== JSON.stringify(catalog.prediction))
      throw new Error(`${cell.name}: the prediction of the record is not the prediction of the catalog`);
  const id = CATALOG.exec(cell.name)?.[1];
  if (id === undefined) throw new Error(`${cell.name}: no catalog`);
  const name = cell.name.slice(id.length + 1);
  const spec = id === "T03" ? T03_SPECS.find((each) => each.name === name) : undefined;
  // a cell of a fault at the router has no forget of its own to order: O03 does not hold for it
  const atRouter = id === "T03" && spec === undefined && T03_FAULT_SPECS.some((each) => each.name === name);
  if (id === "T03" && spec === undefined && !atRouter) throw new Error(`${cell.name}: no spec of T03`);
  const o03 = spec === undefined ? null : o03Of(spec);
  const earlier = id === "T01" ? faults.cells.find((each) => each.name === name) : undefined;
  if (id === "T01" && earlier === undefined) throw new Error(`${cell.name}: not on the page of the network failures`);
  const server = cell.observer === "server";
  return [
    {
      catalog: id,
      name,
      group: atRouter ? `router ${modeOf(cell)}` : groupOf(id, cell),
      topology: { hops: (cell.topology?.hops ?? []).map(hopOf) },
      fault: {
        kind: cell.fault,
        at: placeOf(cell),
        toxic: cell.toxic === undefined ? null : { type: cell.toxic.type, stream: cell.toxic.stream, attributes: entries(cell.toxic.attributes) },
        icmp: cell.icmp ?? null,
        drops: cell.drops ?? null,
      },
      observer: cell.observer ?? "client",
      mode: modeOf(cell),
      settings: {
        client: changed(cell.sysctls),
        target: changed(cell.targetSysctls),
        redis: entries(cell.targetSettings),
        keepalive: cell.probe.keepalive,
        request: cell.probe.request ?? null,
        bytes: bytesOf(cell),
        idleBefore: secondsOf(cell.idleBefore),
        latency: secondsOf(cell.latency),
        stall: secondsOf(cell.stall),
        mtu: cell.mtu ?? null,
        netem: cell.netem ?? null,
        server,
      },
      // a client without SO_KEEPALIVE refreshes nothing, whatever the keepalive sysctls of its namespace
      o03:
        o03 === null
          ? null
          : {
              holds: o03.holds,
              refresh: o03.refresh === "inf" || (!server && !cell.probe.keepalive) ? null : round(o03.refresh),
              forget: round(o03.forget),
            },
      prediction: predictionOf(cell),
      ...judged(first),
      rerun: again === undefined ? null : judged(again),
      faults: earlier === undefined ? null : { decision: earlier.verdict.decision, median: earlier.verdict.median },
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !ALL.some((catalog) => catalog.name === name));
if (unknown.length > 0) throw new Error(`no catalog has the cells ${unknown.join(", ")}`);

/** This function gives the one value that each manifest of each cell has, or it stops. */
const only = (what: string, values: readonly string[]): string => {
  const set = [...new Set(values)];
  if (set.length !== 1) throw new Error(`the records disagree on ${what}: ${set.join(", ")}`);
  return set[0]!;
};

const records = [...found.values()].flat().map((entry) => entry.record);
const manifests = records.flatMap((record) => record.manifests);
// the date of the copy is the day that the last of its records ended
const date = records.map((record) => record.at.ended.slice(0, 10)).sort().at(-1)!;
const copy = {
  source: "the prober's eBPF records, judged again by the final measure of the harness. A re-run follows the first run of its cell",
  ranAt: date,
  units: "s",
  noise: Number(only("the noise", records.map((record) => String(secondsOf(record.cell.noise ?? NOISE))))),
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: only("the kernel", manifests.map((manifest) => /^\d+(\.\d+)+/.exec(manifest.kernel)?.[0] ?? "")),
  hz: Number(only("HZ", manifests.map((manifest) => manifest.hz ?? ""))),
  target: only("the target", records.map((record) => record.cell.target.image.replace(/@.*$/, ""))),
  /** This date is the day of the copy of the network failures that the T01 slice compares with. */
  faultsRanAt: faults.ranAt,
  cells,
};
const out = fileURLToPath(new URL(`../src/data/topologies-${date}.json`, import.meta.url));
writeFileSync(out, `${JSON.stringify(copy, null, 2)}\n`);
process.stdout.write(
  `${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.runs.length + (cell.rerun?.runs.length ?? 0), 0)} runs: ${out}\n`,
);
