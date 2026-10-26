// The export of the kind cells for the site: src/data/kind-<date>.json, src/data/t15-<date>.json for
// the cells of T15, or src/data/s2-<date>.json for the S2 cells.
//
//   pnpm exec tsx packages/site/scripts/kind.ts <folder>...
//
// T07 is the endpoint lifecycle of a Service in kind, and T18 is a fleet whose readiness needs
// Redis. T15 is gRPC through two hops of an Istio mesh in kind. The S2 cells are T07 with a replica
// that cannot serve, for three candidates in each mode: A (endpoints only), B (lame duck) and C
// (GOAWAY on HTTP/2). The copy of S2 also has the prediction of each S2 cell of the catalog
// (`predictions`), thus the page shows a candidate with no run. Each folder is the output of one shard of the workflow Kind on a runner of GitHub: the raw
// record of each cell, summary.ndjson and runner.txt. A record of the format /1 is read through
// `upgrade`. The script judges each record again with the cell of the catalog of the same name
// (`judgeKind`), as KIND_JUDGE does. The calibration of the
// propagation changes the windows of the catalog after a run, thus the count of runs that disagree
// can change. The script stops when the decision, the counts or the median disagree with
// summary.ndjson. A later folder can run a cell again, perhaps under a new name. Then the copy keeps
// the last run of each id, with the decision of its first run. The copy keeps only what the page shows. It keeps no image digest, address, pod,
// load of the runner, user or path.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Quantity } from "../../quantity/src/index.ts";
import { valueIn } from "../../quantity/src/index.ts";
import type { KindCell, KindCellRecord, KindCellRecordV1, KindRun, KindVerdict, Prediction, Reference, TimeSpread } from "../../kind/src/index.ts";
import { FORMAT, FORMAT_V1, calibrationOf, judgeKind, propagationOf, referenceOf, upgrade } from "../../kind/src/index.ts";
import { T07_CELLS } from "../../cells/src/t07.ts";
import { T18_CELLS } from "../../cells/src/t18.ts";
import { T15_GRPC } from "../../cells/src/grpc/t15.ts";
import { CALLERS_CELLS, callerFaultOf } from "../../cells/src/callers.ts";
import { callerPredictions, candidateOf } from "./callers.ts";
import type { Found } from "./records.ts";
import { dateOf, only, readFolders, runnerOf, round, stringify, time, timeAt } from "./records.ts";

/** This function writes a time of a cell of T15 to the ms: its bands are minutes long and their edges are milliseconds apart. */
const fine = timeAt(3);

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/kind.ts <folder>...\n");
  process.exit(2);
}

/** A record is the raw record of one kind cell, as the runner of @mark1russell7/kind writes it: the format /1 or /2. */
type KindRecord = KindCellRecord | KindCellRecordV1;
/** A summary is one line of summary.ndjson: the verdict of a kind cell at the time of its run. The format /2 gives the median as a quantity. */
interface Summary {
  readonly name: string;
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
  readonly failed: number;
  readonly median: number | Quantity | null;
}

const CATALOG: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS, ...T15_GRPC, ...CALLERS_CELLS];
// A later folder replaces the run of each cell of the same id, also when the cell has a new name.
const found = new Map<string, Found<KindRecord, Summary>>();
for (const folder of folders)
  for (const entry of readFolders<KindRecord, Summary>([folder]).values()) {
    const before = [...found].find(([, each]) => each.record.cell.id === entry.record.cell.id);
    if (before !== undefined) found.delete(before[0]);
    found.set(entry.record.cell.name, { ...entry, first: before === undefined ? null : (before[1].first ?? before[1].summary.decision) });
  }
for (const entry of found.values()) {
  // the file can hold another format than its type says
  const { format, cell } = entry.record as { readonly format: string; readonly cell: { readonly name: string } };
  if (format !== FORMAT && format !== FORMAT_V1) throw new Error(`${cell.name}: the format ${format}`);
}

/** This function gives an amount in seconds, the unit of the copy. */
const s = (amount: Quantity): number => valueIn(amount, "s");

/** These phrases name the reference events of a run, in a sentence. */
const REFERENCES: Readonly<Record<Reference, string>> = {
  deletion: "the deletion of the pod",
  intake: "the stop of the intake",
  fault: "the fault",
  resume: "the resume of kube-proxy",
  heal: "the end of the fault",
  restart: "the deletion of the ztunnel pods",
};
/** These phrases name the outcomes of a failed request, in a sentence. */
const OUTCOMES: Readonly<Record<string, string>> = {
  refused: "a refusal",
  reset: "a reset",
  timeout: "a timeout",
  unreachable: "an unreachable error",
  error: "another error",
  denied: "a denial of the policy",
  "503": "an answer of 503",
};
const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
const outcome = (name: string): string => {
  const text = OUTCOMES[name];
  if (text === undefined) throw new Error(`no text for the outcome ${name}`);
  return text;
};

/** These sentences tell why a cell is a measurement only, by the reason that the catalog gives. */
const MEASURED: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^no document bounds the time from the exit of a container to the removal of its endpoint: the kubelet finds the exit at its own relist, which is not a setting$/,
    "No document gives the time from the exit of a container to the removal of its endpoint. The kubelet finds the exit at its own relist, and the relist is not a setting.",
  ],
  [
    /^the quota bounds the stall in each period \(0\.999 s\), not the CPU that the replica needs: a probe meets its 1 s deadline or not by that need$/,
    "The quota gives the stall in each period, 0.999 s, but not the CPU time that the replica needs. A probe meets its deadline of 1 s or not by that need.",
  ],
];

/** This function gives the prediction of a cell for the page: its kind, its band and its text. */
const predictionOf = (cell: KindCell) => {
  const p: Prediction = cell.prediction;
  const band = (lo: Quantity, hi: Quantity) => ({ low: s(lo), high: s(hi) });
  if (cell.calibrates && cell.template === "T15")
    return {
      kind: "calibration",
      band: null,
      text:
        cell.trigger.kind === "authorization-policy"
          ? "This cell is a calibration. The policy denies only an account that no client has, thus no call fails. Each server sidecar gives its propagation: the time from the apply of the policy to its first update of its listeners."
          : "This cell is a calibration. A preStop sleep of 10 s keeps the pod open while the deletion propagates, thus no call fails. Each client sidecar gives its propagation: the time from the deletion to the first poll of its endpoints without the pod.",
    };
  if (cell.calibrates)
    return {
      kind: "calibration",
      band: null,
      text: "This cell is a calibration. A preStop sleep of 10 s keeps the pod open while the deletion propagates, thus no request fails. Each node gives its propagation: the time from the deletion to the first poll of its rules without the pod.",
    };
  switch (p.kind) {
    case "none":
      return {
        kind: p.kind,
        band: null,
        text:
          p.outcomes === undefined
            ? "The algebra predicts that no request fails."
            : `The algebra predicts that no request ends with ${listed(p.outcomes.map(outcome))}. An answer of 503 from a replica is not one of them.`,
      };
    case "window": {
      const opens = s(p.start.band.lo) === 0 ? `at ${REFERENCES[p.start.from]}` : `${time(s(p.start.band.lo))} after ${REFERENCES[p.start.from]}`;
      const closes = p.end === null ? "" : `, and it closes ${time(s(p.end.band.lo))} to ${time(s(p.end.band.hi))} after ${REFERENCES[p.end.from]}`;
      const parts = [`The algebra predicts that each failed request starts in a window. The window opens ${opens}${closes}.`];
      if (p.nodes === "paused") parts.push("Only the clients of the paused node fail.");
      if (p.certain) parts.push("At least one request fails.");
      if (p.outcomes !== undefined) parts.push(`Each failed request ends with ${listed(p.outcomes.map(outcome))}.`);
      if (p.afterReset !== undefined)
        parts.push(
          `A request after the window can also fail with a ${p.afterReset.outcome}, on a port that a reset of the same client closed up to ${time(s(p.afterReset.life))} before it: the CLOSE entry of that reset keeps its NAT to the pod.`,
        );
      return { kind: p.kind, band: null, text: parts.join(" ") };
    }
    case "removal":
      return {
        kind: p.kind,
        band: band(p.band.lo, p.band.hi),
        text: `The algebra predicts that the Service has no ready endpoint, and that the rules of each node have no backend. The band is ${time(s(p.band.lo))} to ${time(s(p.band.hi))} after the fault.`,
      };
    case "leaves":
      return {
        kind: p.kind,
        band: band(p.band.lo, p.band.hi),
        text: `The algebra predicts that the replica leaves the EndpointSlice and the rules of each node. The band is ${time(s(p.band.lo))} to ${time(s(p.band.hi))} after the start of the stall.`,
      };
    case "restarts":
      return p.band === null
        ? { kind: p.kind, band: null, text: "The algebra predicts that no replica receives SIGTERM, thus no replica restarts." }
        : {
            kind: p.kind,
            band: band(p.band.lo, p.band.hi),
            text: `The algebra predicts that each replica receives SIGTERM. The band is ${time(s(p.band.lo))} to ${time(s(p.band.hi))} after the fault.`,
          };
    case "stays":
      return {
        kind: p.kind,
        band: null,
        text: "The algebra predicts that each replica stays in the Service, and that no request is refused. The requests that need Redis fail at the replica.",
      };
    case "stalls":
      return {
        kind: p.kind,
        band: null,
        text: "The algebra predicts that the rollout stops while Redis is down, and that it continues after Redis is back. The harness measures the time from the return of Redis to the first new pod that is ready.",
      };
    case "ends": {
      if (p.band === null) return { kind: p.kind, band: null, text: "The algebra predicts that no socket of a client ends, and that each client calls again on its socket." };
      const what = p.of === "tunnel" ? "the ztunnel of each client closes its tunnel to the replica" : "the socket of each client ends";
      const at = cell.template === "T15" ? fine : time;
      const parts = [`The algebra predicts that ${what}. The band is ${at(s(p.band.lo))} to ${at(s(p.band.hi))} after ${REFERENCES[p.from]}.`];
      if (p.answer !== undefined) parts.push(`A close of the replica first also agrees, as an answer to that close, up to ${at(s(p.answer.hi))} after ${REFERENCES[p.from]}.`);
      if (p.window !== undefined) {
        const w = p.window;
        const start = `${at(s(w.start.band.lo))}`;
        const span =
          w.end === null
            ? `${start} after ${REFERENCES[w.start.from]} or later`
            : w.end.from === w.start.from
              ? `${start} to ${at(s(w.end.band.hi))} after ${REFERENCES[w.start.from]}`
              : `${start} after ${REFERENCES[w.start.from]} to ${at(s(w.end.band.hi))} after ${REFERENCES[w.end.from]}`;
        parts.push(`A failed call starts ${span}, or no call fails.`);
      }
      return { kind: p.kind, band: band(p.band.lo, p.band.hi), text: parts.join(" ") };
    }
    case "measured": {
      const why = MEASURED.find(([form]) => form.test(p.why))?.[1];
      if (why === undefined) throw new Error(`${cell.name}: the reason "${p.why}" has no text for the page`);
      return { kind: p.kind, band: null, text: `This cell has no band. ${why}` };
    }
  }
};

/** These are the predictions whose main value is the count of failed requests in a run. The others give a time. */
const COUNTED: ReadonlySet<string> = new Set(["none", "window", "stays", "measured"]);

/** This function gives the count of a noun in a sentence: "1 request", "2 requests", "8,507 requests". */
const of = (n: number, noun: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? noun : `${noun}s`}`;

/** These texts are the reasons that a run disagrees, as the judge gives them, and as the page tells them. */
const DISAGREE: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [
    /^(\d+) failed requests outside \[(-?[\d.]+), (-?[\d.]+)\] s after (\w+)$/,
    (match) =>
      `${of(Number(match[1]), "request")} failed outside the window of ${time(Number(match[2]))} to ${time(Number(match[3]))} after ${REFERENCES[match[4] as Reference] ?? match[4]}`,
  ],
  [
    /^(\d+) failed requests on nodes whose kube-proxy did not pause$/,
    (match) => `${of(Number(match[1]), "request")} failed on ${Number(match[1]) === 1 ? "a node" : "nodes"} whose kube-proxy did not pause`,
  ],
  [/^no request failed in a window that the law opens$/, () => "no request failed in a window that the law opens"],
  [
    /^the last failed request started (-?[\d.]+) s before the window can end$/,
    (match) => `the last failed request started ${time(Number(match[1]))} before the window can end`,
  ],
  [
    /^(\d+) requests failed: (\{.*\})$/,
    (match) => {
      const total = Number(match[1]);
      const outcomes = Object.entries(JSON.parse(match[2]!) as Record<string, number>);
      if (outcomes.length === 1) return total === 1 ? `1 request failed with ${outcome(outcomes[0]![0])}` : `${total} requests failed, each with ${outcome(outcomes[0]![0])}`;
      return `${total} requests failed: ${listed(outcomes.map(([name, n]) => `${n} with ${outcome(name)}`))}`;
    },
  ],
];
const disagreeOf = (why: string): string =>
  `${why
    .split("; ")
    .map((part) => {
      for (const [form, text] of DISAGREE) {
        const match = form.exec(part);
        if (match !== null) return text(match);
      }
      throw new Error(`the reason "${part}" has no text for the page`);
    })
    .join(". ")}.`;

/** This function gives the unit of the main value of a cell: failed requests, replicas that restart, sockets that end, or seconds. */
const unitOf = (cell: KindCell): string => {
  const p = cell.prediction;
  if (COUNTED.has(p.kind)) return "requests";
  if (p.kind === "restarts" && p.band === null) return "replicas";
  return p.kind === "ends" && p.band === null ? "sockets" : "s";
};

/** This function writes the verdict of a cell as the page shows it. */
const whyOf = (cell: KindCell, verdict: KindVerdict, values: readonly number[], measured = ""): string => {
  const counted = verdict.counted;
  const unit = unitOf(cell);
  const lower = (text: string): string => text.replace(/^./, (c) => c.toLowerCase());
  const at = cell.template === "T15" ? fine : time;
  const first = verdict.checks.find((check) => !check.ok);
  const [low, high] = [Math.min(...values), Math.max(...values)];
  const median =
    verdict.median === null ? "" : unit === "requests" ? ` The median run had ${of(verdict.median.value, "failed request")}.` : unit === "s" ? ` The median is ${at(s(verdict.median))}.` : "";
  const range =
    values.length === 0 || high === 0 ? "" : unit === "requests" ? ` The counted runs had ${low.toLocaleString("en-US")} to ${high.toLocaleString("en-US")} failed requests.` : unit === "s" ? ` The counted runs measured ${at(low)} to ${at(high)}.` : "";
  if (cell.calibrates) {
    const failed = first === undefined ? "" : ` In ${of(verdict.failed, "counted run")}, ${lower(disagreeOf(first.why))}`;
    return `The calibration measured the propagation in each of the ${counted} counted runs.${measured}${failed}`;
  }
  if (verdict.decision === "measured") return `The harness measured ${counted} counted runs.${median}${range}`;
  if (verdict.decision === "holds") {
    const none = unit === "replicas" && high === 0 ? " No replica received SIGTERM." : unit === "sockets" && high === 0 ? " No socket of a client ended." : "";
    return `Each of the ${counted} counted runs agrees with the prediction.${none}${median}${range}`;
  }
  if (verdict.decision === "fails" && first !== undefined) {
    const which = verdict.failed === 1 ? `1 of the ${counted} counted runs disagrees with the prediction. In that run` : `${verdict.failed} of the ${counted} counted runs disagree with the prediction. In the first of them`;
    return `${which}, ${lower(disagreeOf(first.why))}${median}`;
  }
  throw new Error(`${cell.name}: the decision ${verdict.decision} has no text for the page`);
};

/** This function gives the group of a cell on the page: a section of its catalog. */
const groupOf = (cell: KindCell): string => {
  if (cell.template === "T15") {
    if (cell.trigger.kind === "ztunnel-restart") return "restart";
    if (cell.mesh?.mode === "sidecar") return "sidecar";
    return cell.id.startsWith("T15.defaults.") ? "hbone" : "borders";
  }
  if (cell.template === "T07") {
    if (cell.trigger.kind === "cannot-serve") return "callers";
    if (cell.trigger.partition === true) return "partition";
    if (cell.calibrates) return "calibration";
    if (cell.trigger.kind === "pod-deletion") return "deletion";
    if (cell.trigger.kind === "freeze-process") return "pause";
    return "triggers";
  }
  if (cell.prediction.kind === "removal" || cell.prediction.kind === "stays") return "redis";
  if (cell.prediction.kind === "restarts") return "liveness";
  return "other";
};

/** This function gives the propagation of a calibration over the counted runs: each value of each node, in seconds. */
const propagationValues = (runs: readonly KindRun[]): number[] =>
  runs
    .filter((run) => !run.warmup && run.void === null)
    .flatMap((run) => Object.values(propagationOf(run, referenceOf(run, "deletion"))).flatMap((drop) => (drop === null ? [] : [s(drop.by)])))
    .sort((a, b) => a - b);

const spread = (value: TimeSpread | null) =>
  value === null ? null : { count: value.count, min: s(value.min), median: s(value.median), p99: s(value.p99), max: s(value.max) };

/** This function gives the copy of a cell: kind for T07 and T18, and t15 for T15. The S2 cells of cannot-serve get s2, and those of a partition get s2-partition. */
const copyOf = (cell: KindCell): "kind" | "t15" | "s2" | "s2-partition" => {
  if (cell.template === "T15") return "t15";
  if (!cell.id.startsWith("S2.")) return "kind";
  return callerFaultOf(cell) === "partition" ? "s2-partition" : "s2";
};

/**
 * This function gives the time from the fault to the start of the last failed request of each counted run, in seconds. A run with no
 * failed request gives null. The scores of S6 read it as the time until the callers know.
 */
const lastsOf = (runs: readonly KindRun[], verdict: KindVerdict): Array<number | null> => {
  const counted = runs.filter((run) => !run.warmup && run.void === null);
  if (counted.length !== verdict.checks.length) throw new Error(`${counted.length} counted runs and ${verdict.checks.length} checks`);
  return verdict.checks.map((check, at) => {
    const fault = referenceOf(counted[at]!, "fault");
    return check.facts.last === null || fault === null ? null : round((check.facts.last - fault) / 1000);
  });
};

const propagation: Record<string, unknown> = {};
const cells = CATALOG.flatMap((cell) => {
  const entry = found.get(cell.name);
  if (entry === undefined) return [];
  const { summary } = entry;
  const record = upgrade(entry.record);
  const verdict = judgeKind(cell, record.runs);
  const summed = summary.median === null || typeof summary.median === "number" ? summary.median : summary.median.value;
  if (
    verdict.decision !== summary.decision ||
    verdict.counted !== summary.counted ||
    verdict.voided !== summary.voided ||
    (verdict.median?.value ?? null) !== summed
  )
    throw new Error(`${cell.name}: the catalog now gives ${verdict.decision} (${verdict.why}), and summary.ndjson gives ${summary.decision}`);
  const values = verdict.checks.flatMap((check) => (check.value === null ? [] : [check.value.value]));
  let measured = "";
  if (cell.calibrates && cell.template === "T15") {
    // The two calibrations of T15 share a mode of kube-proxy, thus the copy keys them by their id.
    const { all, heal } = calibrationOf({ cell, runs: record.runs, verdict });
    propagation[cell.id] = { all: spread(all), heal: spread(heal ?? null) };
    if (all !== null) {
      const range = `${time(s(all.min))} to ${time(s(all.max))}`;
      measured =
        cell.trigger.kind === "authorization-policy"
          ? ` The policy reached each server sidecar ${range} after its apply, with a median of ${time(s(all.median))} in ${all.count} updates.`
          : ` Each client sidecar dropped the pod ${range} after the deletion, with a median of ${time(s(all.median))} in ${all.count} drops.`;
    }
  } else if (cell.calibrates) {
    const calibration = calibrationOf({ cell, runs: record.runs, verdict });
    propagation[cell.mode] = {
      all: spread(calibration.all),
      slice: spread(calibration.slice),
      intake: spread(calibration.intake),
      values: propagationValues(record.runs),
    };
  }
  const id = cell.id;
  return [
    {
      id,
      copy: copyOf(cell),
      template: cell.template,
      name: cell.name.slice(cell.template.length + 1),
      mode: cell.mode,
      trigger: cell.trigger.kind,
      group: groupOf(cell),
      prediction: predictionOf(cell),
      decision: verdict.decision,
      counted: verdict.counted,
      voided: verdict.voided,
      failed: verdict.failed,
      unit: unitOf(cell),
      median: verdict.median === null ? null : round(verdict.median.value),
      values,
      why: whyOf(cell, verdict, values, measured),
      first: entry.first,
      ...(copyOf(cell).startsWith("s2") ? { candidate: candidateOf(cell), lasts: lastsOf(record.runs, verdict) } : {}),
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !CATALOG.some((cell) => cell.name === name));
if (unknown.length > 0) throw new Error(`no catalog has the cells ${unknown.join(", ")}`);

const records = [...found.values()].map((entry) => entry.record);
const runner = runnerOf(folders);
const date = dateOf(records.map((record) => record.at));
const copy = {
  source: "the raw records of the runners of GitHub, judged again with the catalog after the calibration of the propagation",
  ranAt: date,
  units: "s",
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  kubernetes: only("the version of Kubernetes", records.flatMap((record) => record.manifests.map((manifest) => manifest.cluster.server))),
  kind: only("the version of kind", records.flatMap((record) => record.manifests.map((manifest) => /^kind (v[\d.]+)/.exec(manifest.cluster.kind)?.[1] ?? ""))),
  /** This record is the propagation of a deletion in each mode. It is the time from the deletion to the first poll of the rules of each node without the pod. */
  propagation,
  cells,
};
const name = only("the copy of their cells (the cells of T15 and of S2 each have their own copy)", cells.map((cell) => cell.copy));
const out = fileURLToPath(new URL(`../src/data/${name}-${date}.json`, import.meta.url));
// a copy of S2 has the prediction of each S2 cell of its incident in the catalog, with a run or not
const predictions = name === "s2" ? { predictions: callerPredictions() } : name === "s2-partition" ? { predictions: callerPredictions("partition") } : {};
writeFileSync(out, stringify({ ...copy, cells: cells.map(({ copy: _copy, ...cell }) => cell), ...predictions }));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
