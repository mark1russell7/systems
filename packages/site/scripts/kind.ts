// The export of the kind cells for the site: src/data/kind-<date>.json, src/data/t15-<date>.json for
// the cells of T15, or src/data/s2-<date>.json for the S2 cells.
//
//   pnpm exec tsx packages/site/scripts/kind.ts [--tag <word>] [--pool <id>,<id>...] <folder>...
//
// One run can hold the S2 cells of both incidents. Then the script writes one copy for each
// incident. The tag goes in the name of each copy, for example s2-session-check-<date>.json.
//
// T07 is the endpoint lifecycle of a Service in kind, and T18 is a fleet whose readiness needs
// Redis. T15 is gRPC through two hops of an Istio mesh in kind. The S2 cells are T07 with a replica
// that cannot serve, for four candidates in each mode: A (endpoints only), B (lame duck), C
// (GOAWAY on HTTP/2) and D (C with the session check of the client). The cells of the shared gate (E, B with the gate
// of S6) get the copy s2-gate, with no candidate of the table. The copy of S2 also has the prediction of each S2 cell of the catalog
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
import { FORMAT, FORMAT_V1, KIND_NOISE, calibrationOf, cyclesOf, judgeKind, judgeReconnects, propagationOf, referenceOf, requestBand, seconds, upgrade } from "../../kind/src/index.ts";
import { T07_CELLS } from "../../cells/src/t07.ts";
import { T18_CELLS } from "../../cells/src/t18.ts";
import { T15_GRPC } from "../../cells/src/grpc/t15.ts";
import { CALLERS_CELLS, callerFaultOf } from "../../cells/src/callers.ts";
import { GATE_CELLS } from "../../cells/src/gate.ts";
import { BACKLOG_BAND_CELLS, BACKLOG_CELLS, BACKLOG_DRAIN_CELLS, BACKLOG_TERMS_CELLS } from "../../cells/src/backlog.ts";
import { DNS_CELLS, dnsOf } from "../../cells/src/dns.ts";
import { VIP_CELLS, VIP_WORKLOAD, VIP_HOLD, vipOf } from "../../cells/src/vip.ts";
import { METALLB_CELLS, metallbOf } from "../../cells/src/metallb.ts";
import { PULSAR_CELLS } from "../../cells/src/pulsar.ts";
import type { Line } from "../../kind/src/observe.ts";
import { failuresOf, outcomesOf, slicesOf } from "../../kind/src/observe.ts";
import { OUTSIDE, SERVER } from "../../kind/src/names.ts";
import { backlogPredictionOf, backlogPredictions, callerPredictions, candidateOf } from "./callers.ts";
import type { Found } from "./records.ts";
import { dateOf, only, readFolders, runnerOf, round, stringify, time, timeAt } from "./records.ts";

/** This function writes a time of a cell of T15 to the ms: its bands are minutes long and their edges are milliseconds apart. */
const fine = timeAt(3);

// `--tag <word>` puts the word in the name of each copy, thus a later run of the same date has its own file.
// `--pool <id>,<id>...` gives the ID of the workflow run of each folder, in the order of the folders. Then a later
// folder does not replace a cell: the runs of the cell join in the order of the folders, until the counted runs
// are as many as the catalog asks. This is the re-dispatch that a pre-registered rule permits, and the first counted runs count.
const args = process.argv.slice(2);
const flagOf = (flag: string): string | null => {
  const at = args.indexOf(flag);
  return at === -1 ? null : (args[at + 1] ?? "");
};
const tag = flagOf("--tag");
const poolText = flagOf("--pool");
const pool = poolText === null ? null : poolText.split(",");
const flagged = new Set(
  ["--tag", "--pool"].flatMap((flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? [] : [at, at + 1];
  }),
);
const folders = args.filter((_, at) => !flagged.has(at));
if (
  folders.length === 0 ||
  (tag !== null && !/^[a-z0-9-]+$/.test(tag)) ||
  (pool !== null && (pool.length !== folders.length || !pool.every((id) => /^\d+$/.test(id))))
) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/kind.ts [--tag <word>] [--pool <id>,<id>...] <folder>...\n");
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

const CATALOG: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS, ...T15_GRPC, ...CALLERS_CELLS, ...GATE_CELLS, ...BACKLOG_CELLS, ...BACKLOG_BAND_CELLS, ...BACKLOG_DRAIN_CELLS, ...BACKLOG_TERMS_CELLS, ...DNS_CELLS, ...VIP_CELLS, ...METALLB_CELLS, ...PULSAR_CELLS];
// A later folder replaces the run of each cell of the same id, also when the cell has a new name.
const found = new Map<string, Found<KindRecord, Summary>>();
/** When `--pool` joins the folders, a part is the record of a cell in one folder, with its summary and its workflow run. */
interface Part {
  readonly run: string;
  readonly record: KindRecord;
  readonly summary: Summary;
}
const parts = new Map<string, Part[]>();
folders.forEach((folder, at) => {
  for (const entry of readFolders<KindRecord, Summary>([folder]).values()) {
    const before = [...found].find(([, each]) => each.record.cell.id === entry.record.cell.id);
    if (pool !== null) {
      if (before !== undefined && before[0] !== entry.record.cell.name) throw new Error(`${entry.record.cell.name}: --pool joins only the runs of one name`);
      if (before === undefined) found.set(entry.record.cell.name, entry);
      parts.set(entry.record.cell.name, [...(parts.get(entry.record.cell.name) ?? []), { run: pool[at]!, record: entry.record, summary: entry.summary }]);
      continue;
    }
    if (before !== undefined) found.delete(before[0]);
    found.set(entry.record.cell.name, { ...entry, first: before === undefined ? null : (before[1].first ?? before[1].summary.decision) });
  }
});
for (const entry of [...found.values(), ...[...parts.values()].flat()]) {
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
      if (p.backlog !== undefined)
        parts.push(
          `With n sessions on the target at the fault, the window closes n × ${time(s(p.backlog.drain.lo))} to n × ${time(s(p.backlog.drain.hi))} later. The failed requests are those of the n sessions up to the end of the window without this term, at the measured mean period of the clients, and ${p.backlog.requests.lo} to ${p.backlog.requests.hi} more for each session.${p.backlog.drains === true ? " Each session also fails a request each turn until the window closes: 0 to n × the largest drain time over its turn, rounded up." : ""}${p.backlog.slowest === undefined ? "" : ` One session can drain for up to ${time(s(p.backlog.slowest))}, thus the window closes up to (n − 1) × ${time(s(p.backlog.drain.hi))} + ${time(s(p.backlog.slowest))} later.`}${p.backlog.early === true ? " The last failed request can start up to one turn before the window closes." : ""}`,
        );
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
        text: `The algebra predicts that the Service has no ready endpoint, and that the rules of each node have no backend. The band is ${time(s(p.band.lo))} to ${time(s(p.band.hi))} after the fault.${p.window === undefined ? "" : ` ${p.window.why}.`}`,
      };
    case "leaves":
      // a false failure: the replica can serve, but its readiness fails, thus its departure is a false removal
      return {
        kind: p.kind,
        band: band(p.band.lo, p.band.hi),
        text:
          p.window === undefined
            ? `The algebra predicts that the replica leaves the EndpointSlice and the rules of each node. The band is ${time(s(p.band.lo))} to ${time(s(p.band.hi))} after the start of the stall.`
            : cell.id.includes(".shared-gate")
              ? // the shared gate in a pod that cannot serve: the removal is true, as for B
                `The algebra predicts that the replica leaves the EndpointSlice and the rules of each node. The band is ${time(s(p.band.lo))} to ${time(s(p.band.hi))} after the fault. ${p.window.why}.`
              : `The algebra predicts a false removal: the replica can serve, but it leaves the EndpointSlice and the rules of each node. The band is ${time(s(p.band.lo))} to ${time(s(p.band.hi))} after the fault. ${p.window.why}.`,
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
        text:
          p.failures === undefined
            ? "The algebra predicts that each replica stays in the Service, and that no request is refused. The requests that need Redis fail at the replica."
            : p.failures.kind === "none"
              ? "The algebra predicts that each replica stays in the Service, and that no request fails."
              : `The algebra predicts that each replica stays in the Service, and that no request is refused. Each failed request starts ${time(s(p.failures.start.band.lo))} after ${REFERENCES[p.failures.start.from]} or later${p.failures.end === null ? "" : `, and the last one starts ${s(p.failures.end.band.hi) <= 0 ? `${time(-s(p.failures.end.band.hi))} to ${time(-s(p.failures.end.band.lo))} before` : `${time(s(p.failures.end.band.lo))} to ${time(s(p.failures.end.band.hi))} after`} ${REFERENCES[p.failures.end.from]}`}.${p.failures.outcomes === undefined ? "" : ` Each failed request ends with ${listed(p.failures.outcomes.map(outcome))}.`}`,
      };
    case "reconnects":
      return {
        kind: p.kind,
        band: band(p.flip.lo, p.flip.hi),
        text: `The algebra predicts that a lookup names another owner of the topic ${time(s(p.flip.lo))} to ${time(s(p.flip.hi))} after the fault. Each producer is back at the first try of its backoff after that change, up to ${time(s(p.setup.hi))} later. Each failed send ends with ${listed(p.outcomes.map(outcome))}.`,
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
  // the reasons of a departure name the pod and the node: the page names neither
  [/^\S+ stayed ready in the EndpointSlice$/, () => "the target stayed ready in the EndpointSlice"],
  [/^\S+ left the EndpointSlice at (-?[\d.]+) s$/, (match) => `the target left the EndpointSlice ${time(Number(match[1]))} after the fault`],
  [/^\S+ left at (-?[\d.]+) s$/, (match) => `the target left ${time(Number(match[1]))} after the fault`],
  [/^the rules of \S+ kept \S+$/, () => "the rules of a node kept the target"],
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
  // the count of the backlog term (SYS-42): the band of n sessions at the mean period of the run
  [
    /^(\d+) failed requests, outside the count \[(\d+), (\d+)\] of (\d+) sessions? on the target at a mean period of ([\d.]+) ms$/,
    (match) =>
      `${of(Number(match[1]), "request")} failed, outside the count of ${Number(match[2]).toLocaleString("en-US")} to ${Number(match[3]).toLocaleString("en-US")} for ${of(Number(match[4]), "session")} on the target at the mean period of ${match[5]} ms of the run`,
  ],
  [/^the run has no measured period, thus the backlog term cannot count its failed requests$/, () => "the run has no measured period of the clients, thus the backlog band cannot count its failed requests"],
  [/^the run has no sessions on the target at the fault, thus the backlog term has no n$/, () => "the run has no count of the sessions on the target at the fault"],
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
    if (cell.id.includes(".shared-gate")) return "gate";
    if (cell.id.includes(".backlog")) return "backlog";
    if (cell.trigger.kind === "dns-blackhole") return "dns";
    if (cell.pulsar !== undefined) return "broker";
    if (cell.trigger.kind === "cannot-serve") return cell.trigger.serves === true ? "prober" : "callers";
    if (cell.trigger.kind === "zone-loss") return "zone";
    if (cell.trigger.kind === "latency") return "slow";
    if (cell.trigger.partition === true) return "partition";
    if (cell.trigger.kind === "blackhole") return cell.trigger.flaps === undefined ? "dependency" : "flapping";
    if (cell.trigger.kind === "app-stall") return "stall";
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

/**
 * This function gives the copy of a cell: kind for T07 and T18, and t15 for T15. The S2 cells of
 * cannot-serve get s2, those of a partition get s2-partition, and those of a stall get s2-stall. The
 * cells of a false failure of the prober get s2-prober, and those of a shared dependency get
 * s2-dependency. The cells of a flapping dependency get s2-flapping, and those of a lost zone get s2-zone.
 * The cells of a slow dependency get s2-slow, and the cells of the shared gate (E) get s2-gate. The
 * cells of the backlog of a stall (SYS-40) get s2-backlog, and the cells of a black hole of DNS
 * (SYS-50) get s2-dns. The cells of a VIP of kube-vip (SYS-51) get s2-vip, and those of MetalLB (SYS-53) get s2-metallb.
 * The cells of a broker of Pulsar (SYS-56) get s2-pulsar.
 */
const copyOf = (
  cell: KindCell,
): "kind" | "t15" | "s2" | "s2-partition" | "s2-stall" | "s2-prober" | "s2-dependency" | "s2-flapping" | "s2-zone" | "s2-slow" | "s2-gate" | "s2-backlog" | "s2-dns" | "s2-vip" | "s2-metallb" | "s2-pulsar" => {
  if (cell.template === "T15") return "t15";
  if (!cell.id.startsWith("S2.")) return "kind";
  if (cell.pulsar !== undefined) return "s2-pulsar";
  if (cell.id.includes(".shared-gate")) return "s2-gate";
  if (cell.id.includes(".backlog")) return "s2-backlog";
  if (cell.trigger.kind === "dns-blackhole") return "s2-dns";
  if (cell.vip?.announcer === "metallb") return "s2-metallb";
  if (cell.vip !== undefined) return "s2-vip";
  const fault = callerFaultOf(cell);
  if (fault === "lost zone") return "s2-zone";
  if (fault === "slow dependency") return "s2-slow";
  return fault === "partition"
    ? "s2-partition"
    : fault === "stall"
      ? "s2-stall"
      : fault === "false failure"
        ? "s2-prober"
        : fault === "shared dependency"
          ? "s2-dependency"
          : fault === "flapping dependency"
            ? "s2-flapping"
            : "s2";
};

/**
 * This function gives two times of each counted run of a shared dependency, in seconds. A run with no
 * such failure gives null.
 * - `knows`: from the fault to the start of the last slow failure before the heal. A slow failure
 *   took half the timeout of the client at the least.
 * - `recovers`: from the heal to the start of the last failed request.
 */
const dependencyTimesOf = (cell: KindCell, runs: readonly KindRun[]): { knows: Array<number | null>; recovers: Array<number | null> } => {
  const slow = valueIn(cell.workload.timeout, "ms") / 2;
  const counted = runs.filter((run) => !run.warmup && run.void === null);
  const times = counted.map((run) => {
    const fault = referenceOf(run, "fault");
    const heal = referenceOf(run, "heal");
    if (fault === null || heal === null) return { knows: null, recovers: null };
    const failures = failuresOf(run.lines as readonly Line[]).filter((request) => request.t >= run.start && request.t <= run.end);
    const known = failures.filter((request) => request.t >= fault && request.t < heal && request.d >= slow).at(-1);
    const last = failures.at(-1);
    return {
      knows: known === undefined ? null : round((known.t - fault) / 1000),
      recovers: last === undefined || last.t < heal ? null : round((last.t - heal) / 1000),
    };
  });
  return { knows: times.map((each) => each.knows), recovers: times.map((each) => each.recovers) };
};

/**
 * This function gives three times of each cycle of each counted run of a flapping dependency, in
 * seconds. Their sequence is that of the runs, then of the cycles. A cycle with no such time gives null.
 * - `knows`: from the fault of the cycle to the start of the last slow failure before its heal.
 * - `recovers`: from the heal of the cycle to the start of the last failed request before the next
 *   fault. It is below zero when the last failure starts before the heal.
 * - `emptied`: from the fault of the cycle to its empty Service, from the check of the judge.
 */
const flappingTimesOf = (
  cell: KindCell,
  runs: readonly KindRun[],
  verdict: KindVerdict,
): { knows: Array<number | null>; recovers: Array<number | null>; emptied: Array<number | null> } => {
  const slow = valueIn(cell.workload.timeout, "ms") / 2;
  const counted = runs.filter((run) => !run.warmup && run.void === null);
  if (counted.length !== verdict.checks.length) throw new Error(`${counted.length} counted runs and ${verdict.checks.length} checks`);
  const times = counted.flatMap((run, at) => {
    const cycles = cyclesOf(run);
    const failures = failuresOf(run.lines as readonly Line[]).filter((request) => request.t >= run.start && request.t <= run.end);
    const facts = verdict.checks[at]!.facts.cycles ?? [];
    return cycles.map((cycle, k) => {
      const next = cycles[k + 1]?.fault ?? run.end;
      const mine = failures.filter((request) => request.t >= cycle.fault && request.t < next);
      const known = mine.filter((request) => request.t < cycle.heal && request.d >= slow).at(-1);
      const last = mine.at(-1);
      const empty = facts[k]?.empty ?? null;
      return {
        knows: known === undefined ? null : round((known.t - cycle.fault) / 1000),
        recovers: last === undefined ? null : round((last.t - cycle.heal) / 1000),
        emptied: empty === null ? null : round(valueIn(empty, "s")),
      };
    });
  });
  return { knows: times.map((each) => each.knows), recovers: times.map((each) => each.recovers), emptied: times.map((each) => each.emptied) };
};

/**
 * This function gives a time for each counted run of a slow dependency, in seconds. The time goes
 * from the heal to the start of the last failed request. It is below zero when that request starts before the heal. A
 * run with no failed request gives null.
 */
const slowTimesOf = (runs: readonly KindRun[]): { recovers: Array<number | null> } => ({
  recovers: runs
    .filter((run) => !run.warmup && run.void === null)
    .map((run) => {
      const heal = referenceOf(run, "heal");
      const last = failuresOf(run.lines as readonly Line[])
        .filter((request) => request.t >= run.start && request.t <= run.end)
        .at(-1);
      return heal === null || last === undefined ? null : round((last.t - heal) / 1000);
    }),
});

/**
 * This function gives the figures of each counted run of a black hole of DNS (SYS-50). They are the
 * outcomes of the failed requests, by name, and the time of each act in the client pods, in seconds.
 * An act is one change of the drops in one pod: from its stamp to the end of its command.
 */
const dnsRunsOf = (runs: readonly KindRun[]): { outcomes: Array<Record<string, number>>; acts: number[][] } => {
  const counted = runs.filter((run) => !run.warmup && run.void === null);
  return {
    outcomes: counted.map((run) => outcomesOf(failuresOf(run.lines as readonly Line[]).filter((each) => each.t >= run.start && each.t <= run.end))),
    acts: counted.map((run) =>
      run.lines
        .filter((line) => line.ev === "act" && (line["spec"] as { readonly op?: string } | undefined)?.op === "netns")
        .map((line) => round((Number(line["t1"]) - line.t) / 1000)),
    ),
  };
};

/** These are the figures of one counted run of a VIP of kube-vip (SYS-51), in seconds from the fault. */
interface VipRun {
  /** This time is the take of the Lease by the new holder: its `acquireTime` on the clock of the lab. */
  readonly take: number | null;
  /** This time is the first change of each outside client to the MAC address of the new holder. */
  readonly arp: Array<number | null>;
  /** This time is the start of the last failed request of each outside client before the heal. */
  readonly last: Array<number | null>;
  /** These counts are the failed requests of the outside clients before the heal, those after the heal, and those of the clients in the cluster. */
  readonly failed: { readonly outside: number; readonly thaw: number; readonly inside: number };
  readonly outcomes: Record<string, number>;
  /** This time is from the heal to the last failed request after the heal, or null. */
  readonly thawLast: number | null;
}

/**
 * This function gives the figures of each counted run of a VIP of kube-vip (SYS-51). The line `vip`
 * of a run has the Lease and the wall clock of the runner with its monotonic clock. Thus the
 * `acquireTime` of the Lease goes on the clock of the lab. The new holder is the holder in the Lease.
 * The lines `arp` of each outside client give the time of its change to the MAC of that node.
 */
const vipRunsOf = (runs: readonly KindRun[]): { vip: VipRun[] } => ({
  vip: runs
    .filter((run) => !run.warmup && run.void === null)
    .map((run) => {
      const fault = referenceOf(run, "fault");
      const heal = referenceOf(run, "heal");
      if (fault === null || heal === null) throw new Error(`run ${run.env}/${run.index}: no fault or no heal`);
      const at = (t: number) => round((t - fault) / 1000);
      const record = run.lines.find((line) => line.ev === "vip");
      const lease = record?.["lease"] as { readonly holder?: string | null; readonly acquireTime?: string | null } | null | undefined;
      const macs = (record?.["macs"] ?? {}) as Record<string, string>;
      const acquired = lease?.acquireTime === undefined || lease.acquireTime === null ? Number.NaN : Date.parse(lease.acquireTime);
      const take = record === undefined || Number.isNaN(acquired) ? null : at(record.t + (acquired - Number(record["wall"])));
      const mac = lease?.holder === undefined || lease.holder === null ? undefined : macs[lease.holder];
      const failures = failuresOf(run.lines as readonly Line[]).filter((request) => request.t >= run.start && request.t <= run.end);
      const outside = failures.filter((request) => request.n === OUTSIDE);
      const clients = [...new Set(run.lines.filter((line) => line["n"] === OUTSIDE && typeof line["p"] === "string").map((line) => String(line["p"])))].sort();
      const arp = clients.map((client) => {
        const moved = run.lines.find((line) => line.ev === "arp" && line["p"] === client && line.t >= fault && mac !== undefined && line["mac"] === mac);
        return moved === undefined ? null : at(moved.t);
      });
      const last = clients.map((client) => {
        const mine = outside.filter((request) => request.p === client && request.t < heal).at(-1);
        return mine === undefined ? null : at(mine.t);
      });
      const thaw = outside.filter((request) => request.t >= heal);
      return {
        take,
        arp,
        last,
        failed: { outside: outside.length - thaw.length, thaw: thaw.length, inside: failures.length - outside.length },
        outcomes: outcomesOf(failures),
        thawLast: thaw.length === 0 ? null : round((thaw.at(-1)!.t - heal) / 1000),
      };
    }),
});

/** This function gives the bands of the cell of kube-vip from the fault, in seconds (SYS-51). They are the law, the naive law, the ARP and the thaw. */
const vipBandsOf = () => {
  const { take, naive, arp, end, thaw } = vipOf(VIP_WORKLOAD, VIP_HOLD);
  const band = (each: { lo: Quantity; hi: Quantity }) => ({ low: s(each.lo), high: s(each.hi) });
  return { take: band(take), naive: band(naive), arp: band(arp), end: band(end), thaw: band(thaw) };
};

/** These are the figures of one counted run of a VIP of MetalLB (SYS-53), in seconds from the fault. */
interface MetallbRun {
  /** This time is the mark of the lost node as dead in memberlist, in the log of the other speaker. */
  readonly dead: number | null;
  /** This time is the first suspicion of the lost node in that log: the deadline of the first failed probe. */
  readonly suspect: number | null;
  /** This time is from the heal to the withdrawal of the announce of the other speaker, or null. */
  readonly withdraw: number | null;
  /** This time is the first change of each outside client to the MAC address of the other worker. */
  readonly arp: Array<number | null>;
  /** This time is the start of the last failed request of each outside client before the heal. */
  readonly last: Array<number | null>;
  /** These counts are the failed requests of the outside clients before the heal, those after the heal, and those of the clients in the cluster. */
  readonly failed: { readonly outside: number; readonly thaw: number; readonly inside: number };
  readonly outcomes: Record<string, number>;
  /** This count is the changes of MAC address of the outside clients after the heal. */
  readonly moves: number;
}

/** This function gives the wall time in ms of a timestamp of a log line of Kubernetes. Its fraction can have 9 digits. */
const wallOf = (stamp: string): number => {
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z$/.exec(stamp);
  if (parts === null) throw new Error(`the time of a log line: ${stamp}`);
  return Date.parse(`${parts[1]}Z`) + Number(parts[2] ?? "0") * 1000;
};

/**
 * This function gives the figures of each counted run of a VIP of MetalLB (SYS-53). The line `vip` of
 * a run has the lines of memberlist of the speakers, with the time of the kubelet. The wall clock and
 * the monotonic clock of that line put each one on the clock of the lab. The lost node is the node of
 * the act of the zone. The other worker is the new owner. The lines `arp` of each outside client give
 * the time of its change to the MAC address of that node.
 */
const metallbRunsOf = (runs: readonly KindRun[]): { metallb: MetallbRun[] } => ({
  metallb: runs
    .filter((run) => !run.warmup && run.void === null)
    .map((run) => {
      const fault = referenceOf(run, "fault");
      const heal = referenceOf(run, "heal");
      if (fault === null || heal === null) throw new Error(`run ${run.env}/${run.index}: no fault or no heal`);
      const at = (t: number) => round((t - fault) / 1000);
      const record = run.lines.find((line) => line.ev === "vip");
      if (record === undefined) throw new Error(`run ${run.env}/${run.index}: no line vip`);
      const lost = run.lines.find((line) => line.ev === "act" && (line["spec"] as { op?: string; lost?: boolean } | undefined)?.lost === true)?.["node"];
      const macs = (record["macs"] ?? {}) as Record<string, string>;
      const others = Object.keys(macs).filter((name) => /-worker\d*$/.test(name) && name !== lost);
      if (typeof lost !== "string" || others.length !== 1) throw new Error(`run ${run.env}/${run.index}: no lost node, or not one other worker`);
      const mac = macs[others[0]!];
      const log = String(record["log"] ?? "")
        .split("\n")
        .flatMap((line) => {
          const parts = /^\[[^\]]+\] (\S+) (.*)$/.exec(line);
          return parts === null ? [] : [{ t: record.t + (wallOf(parts[1]!) - Number(record["wall"])), text: parts[2]! }];
        });
      const first = (from: number, to: number, text: string) => log.find((line) => line.t >= from && line.t < to && line.text.includes(text));
      const dead = first(fault, heal, `Marking ${lost} as failed`);
      const suspect = first(fault, heal, `Suspect ${lost} has failed`);
      const withdrawn = first(heal, run.end, "serviceWithdrawn");
      const failures = failuresOf(run.lines as readonly Line[]).filter((request) => request.t >= run.start && request.t <= run.end);
      const outside = failures.filter((request) => request.n === OUTSIDE);
      const clients = [...new Set(run.lines.filter((line) => line["n"] === OUTSIDE && typeof line["p"] === "string").map((line) => String(line["p"])))].sort();
      const arp = clients.map((client) => {
        const moved = run.lines.find((line) => line.ev === "arp" && line["p"] === client && line.t >= fault && line["mac"] === mac);
        return moved === undefined ? null : at(moved.t);
      });
      const last = clients.map((client) => {
        const mine = outside.filter((request) => request.p === client && request.t < heal).at(-1);
        return mine === undefined ? null : at(mine.t);
      });
      const thaw = outside.filter((request) => request.t >= heal);
      return {
        dead: dead === undefined ? null : at(dead.t),
        suspect: suspect === undefined ? null : at(suspect.t),
        withdraw: withdrawn === undefined ? null : round((withdrawn.t - heal) / 1000),
        arp,
        last,
        failed: { outside: outside.length - thaw.length, thaw: thaw.length, inside: failures.length - outside.length },
        outcomes: outcomesOf(failures),
        moves: run.lines.filter((line) => line.ev === "arp" && line["n"] === OUTSIDE && line.t >= heal).length,
      };
    }),
});

/** This function gives the bands of the cell of MetalLB from the fault, in seconds (SYS-53). They are the law, the naive law, the ARP and the thaw. */
const metallbBandsOf = () => {
  const { probe, dead, naive, arp, end, thaw } = metallbOf(VIP_WORKLOAD, VIP_HOLD);
  const band = (each: { lo: Quantity; hi: Quantity }) => ({ low: s(each.lo), high: s(each.hi) });
  return { probe: band(probe), dead: band(dead), naive: band(naive), arp: band(arp), end: band(end), thaw: band(thaw) };
};

/** These are the figures of one producer in one counted run of a broker of Pulsar (SYS-56), in seconds from the fault. */
interface PulsarReturn {
  readonly pod: string;
  /** This time is the first call of the backoff after the fault. */
  readonly disconnect: number | null;
  /** These are the delays of the backoff up to the try that succeeded, in seconds. */
  readonly delays: number[];
  /** This time is the producer on the new owner. */
  readonly back: number | null;
  /** This time is from the try that succeeded to the producer on the new owner. */
  readonly setup: number | null;
  readonly tries: number;
}

/** These are the figures of one counted run of a broker of Pulsar (SYS-56), in seconds from the fault. */
interface PulsarRun {
  /** This time is the first lookup that names another owner. */
  readonly flip: number | null;
  /** This time is from the last lookup before that change to it. */
  readonly gap: number | null;
  readonly returns: PulsarReturn[];
  /** These counts are the failed sends of the producers by outcome, and the failed requests of the control. */
  readonly failed: { readonly sends: Record<string, number>; readonly control: number };
  readonly ok: boolean;
  readonly why: string;
}

/** This function gives the figures of each counted run of a broker of Pulsar (SYS-56), from the judge of the reconnects. */
const pulsarRunsOf = (cell: KindCell, runs: readonly KindRun[]): { pulsar: PulsarRun[] } => {
  const prediction = cell.prediction;
  if (prediction.kind !== "reconnects") throw new Error(`${cell.name}: the prediction is not reconnects`);
  const sends = { timeout: valueIn(cell.workload.timeout, "ms"), every: valueIn(cell.workload.every, "ms") };
  return {
    pulsar: runs
      .filter((run) => !run.warmup && run.void === null)
      .map((run) => {
        const fault = referenceOf(run, "fault");
        if (fault === null || run.broker === undefined) throw new Error(`run ${run.env}/${run.index}: no fault or no broker`);
        const judged = judgeReconnects(prediction, { fault, broker: run.broker, lines: run.lines as readonly Line[] }, sends, valueIn(KIND_NOISE, "ms"));
        const sec = (value: number | null) => (value === null ? null : round(value / 1000));
        const control = failuresOf(run.lines as readonly Line[]).filter((request) => request.t >= run.start && request.t <= run.end).length;
        return {
          flip: sec(judged.flip),
          gap: sec(judged.gap),
          returns: judged.returns.map((each) => ({
            pod: each.pod,
            disconnect: sec(each.disconnect),
            delays: each.schedules.map((schedule) => round(schedule.delay / 1000)),
            back: sec(each.back),
            setup: sec(each.setup),
            tries: each.tries,
          })),
          failed: { sends: { ...judged.failures }, control },
          ok: judged.ok,
          why: judged.why,
        };
      }),
  };
};

/** This function gives the bands of the cell of Pulsar from the fault, in seconds (SYS-56). They are the change of the owner, the first call and the setup. */
const pulsarBandsOf = () => {
  const prediction = PULSAR_CELLS[0]!.prediction;
  if (prediction.kind !== "reconnects") throw new Error("the cell of Pulsar does not predict reconnects");
  const band = (each: { lo: Quantity; hi: Quantity }) => ({ low: s(each.lo), high: s(each.hi) });
  return { flip: band(prediction.flip), disconnect: band(prediction.disconnect), setup: band(prediction.setup), probe: s(prediction.probe) };
};

/**
 * This function gives the band of the last failure of the black hole of DNS, from the heal (SYS-50).
 * The band is true if the threads of each client stay in phase with the fault. The judge does not use it.
 */
const dnsPhaseOf = (): { low: number; high: number } => {
  const cell = DNS_CELLS[0]!;
  if (cell.trigger.hold === undefined) throw new Error(`${cell.name}: no hold`);
  const { phase } = dnsOf(cell.workload, cell.trigger.hold);
  return { low: s(phase.lo), high: s(phase.hi) };
};

/**
 * This function gives a time for each counted run of a lost zone, in seconds. It starts at the heal,
 * and it ends when the target is ready again in its EndpointSlice. A run with no such slice line gives null.
 */
const returnsOf = (runs: readonly KindRun[]): { returns: Array<number | null> } => ({
  returns: runs
    .filter((run) => !run.warmup && run.void === null)
    .map((run) => {
      const heal = referenceOf(run, "heal");
      const ip = run.target?.ip;
      if (heal === null || ip === undefined) return null;
      const at = slicesOf(run.lines as readonly Line[], SERVER).find((slice) => slice.t >= heal && slice.eps.some((endpoint) => endpoint.ip === ip && endpoint.r === true))?.t;
      return at === undefined ? null : round((at - heal) / 1000);
    }),
});

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

/**
 * This function gives the PINGs of the session checks of the clients in each counted run. It also
 * gives the ACKs and the length of the run in seconds. Each client writes one line of its count each
 * second (`pings`). A run with no such line gives null, and a record with none gives no field.
 */
const pingsOf = (runs: readonly KindRun[]): { pings: Array<number | null>; acks: Array<number | null>; seconds: number[] } | Record<string, never> => {
  const counted = runs.filter((run) => !run.warmup && run.void === null);
  const lines = counted.map((run) => (run.lines as readonly Line[]).filter((line) => line.ev === "pings" && line.t >= run.start && line.t <= run.end));
  if (lines.every((each) => each.length === 0)) return {};
  const sum = (each: readonly Line[], field: string): number | null => (each.length === 0 ? null : each.reduce((total, line) => total + Number(line[field]), 0));
  return {
    pings: lines.map((each) => sum(each, "sent")),
    acks: lines.map((each) => sum(each, "acked")),
    seconds: counted.map((run) => round((run.end - run.start) / 1000)),
  };
};

/**
 * This function gives the figures of each counted run of a cell of the backlog (SYS-40). They are the
 * failed requests and the sessions on the target at the fault. They also are the start of the stall
 * after the fault and how long it held, in seconds. The overshoot is from the band end without the term to the start
 * of the last failed request, in seconds. A run with no such figure gives null.
 */
const backlogRunsOf = (cell: KindCell, verdict: KindVerdict) => {
  const predicted = backlogPredictionOf(cell);
  if (predicted === null) throw new Error(`${cell.name}: a cell of the backlog has a placement`);
  const bandEnd = s(predicted.bandEnd);
  // a cell of the backlog band (SYS-42) also gives the measured mean period of each run, and the count band at it
  const window = cell.prediction.kind === "window" ? cell.prediction : null;
  const term = window?.backlog;
  const band = (check: KindVerdict["checks"][number]) => {
    const mean = check.facts.period?.mean;
    const n = check.facts.sessions?.onTarget;
    if (window === null || term === undefined || window.end === null || mean === undefined || n === undefined) return null;
    const count = requestBand(term, seconds(s(window.end.band.hi) - s(window.start.band.lo)), mean, cell.workload.connections ?? 1, n);
    return { low: count.lo, high: count.hi };
  };
  return {
    failures: verdict.checks.map((check) => check.facts.failures),
    sessions: verdict.checks.map((check) => check.facts.sessions?.onTarget ?? null),
    stallStarts: verdict.checks.map((check) => (check.facts.stall?.start === null || check.facts.stall?.start === undefined ? null : round(s(check.facts.stall.start)))),
    helds: verdict.checks.map((check) => (check.facts.stall?.held === null || check.facts.stall?.held === undefined ? null : round(s(check.facts.stall.held)))),
    bandEnd,
    ...(term === undefined
      ? {}
      : {
          periods: verdict.checks.map((check) => (check.facts.period === undefined ? null : s(check.facts.period.mean))),
          counts: verdict.checks.map(band),
        }),
  };
};

/** This function stops when the verdict of the catalog disagrees with the summary of the run. */
const agree = (cell: KindCell, verdict: KindVerdict, summary: Summary): void => {
  const summed = summary.median === null || typeof summary.median === "number" ? summary.median : summary.median.value;
  if (
    verdict.decision !== summary.decision ||
    verdict.counted !== summary.counted ||
    verdict.voided !== summary.voided ||
    (verdict.median?.value ?? null) !== summed
  )
    throw new Error(`${cell.name}: the catalog now gives ${verdict.decision} (${verdict.why}), and summary.ndjson gives ${summary.decision}`);
};

/** A dispatch is one workflow run of a pooled cell: what its summary gives, and how many of its counted runs the copy takes. */
interface Dispatch {
  readonly run: string;
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
  readonly taken: number;
}

/**
 * This function joins the parts of a cell. Each part must agree with its own summary. The runs join in the order of the
 * folders and of their start. The join stops when the counted runs are as many as the catalog asks. A later
 * counted run is extra, and the copy ignores it.
 */
const joinOf = (cell: KindCell, pieces: readonly Part[]) => {
  const runs: KindRun[] = [];
  const dispatches: Dispatch[] = [];
  let counted = 0;
  for (const piece of pieces) {
    const record = upgrade(piece.record);
    agree(cell, judgeKind(cell, record.runs), piece.summary);
    let taken = 0;
    for (const run of [...record.runs].sort((a, b) => a.start - b.start)) {
      if (counted === cell.runs) break;
      runs.push(run);
      if (!run.warmup && run.void === null) {
        counted += 1;
        taken += 1;
      }
    }
    dispatches.push({ run: piece.run, decision: piece.summary.decision, counted: piece.summary.counted, voided: piece.summary.voided, taken });
  }
  return { record: { ...upgrade(pieces[0]!.record), runs }, dispatches };
};

const propagation: Record<string, unknown> = {};
const cells = CATALOG.flatMap((cell) => {
  const entry = found.get(cell.name);
  if (entry === undefined) return [];
  const pieces = parts.get(cell.name) ?? [];
  const joined = pieces.length > 1 ? joinOf(cell, pieces) : null;
  const record = joined?.record ?? upgrade(entry.record);
  const verdict = judgeKind(cell, record.runs);
  if (joined === null) agree(cell, verdict, entry.summary);
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
      // a pooled cell: the workflow run of each dispatch, its counts and the counted runs that the copy takes
      ...(joined === null ? {} : { dispatches: joined.dispatches }),
      // the shared gate (E) is not a candidate of the table of S2, thus its cells have no candidate
      ...(copyOf(cell).startsWith("s2") ? { ...(copyOf(cell) === "s2-gate" || copyOf(cell) === "s2-dns" || copyOf(cell) === "s2-vip" || copyOf(cell) === "s2-metallb" || copyOf(cell) === "s2-pulsar" ? {} : { candidate: candidateOf(cell) }), lasts: lastsOf(record.runs, verdict) } : {}),
      // the main value of a false failure is the time of its removal, thus the copy keeps the failed requests of each counted run apart
      ...(copyOf(cell) === "s2-prober" || copyOf(cell) === "s2-dependency" || copyOf(cell) === "s2-flapping" || copyOf(cell) === "s2-zone" || copyOf(cell) === "s2-gate"
        ? { failures: verdict.checks.map((check) => check.facts.failures) }
        : {}),
      // a lost zone: when the target is ready again after the heal
      ...(copyOf(cell) === "s2-zone" ? returnsOf(record.runs) : {}),
      // a shared dependency: when the callers know, and when they recover after the heal
      ...(copyOf(cell) === "s2-dependency" || (copyOf(cell) === "s2-gate" && callerFaultOf(cell) === "shared dependency") ? dependencyTimesOf(cell, record.runs) : {}),
      // a flapping dependency: the same times, and the empty Service, for each fault
      ...(copyOf(cell) === "s2-flapping" || (copyOf(cell) === "s2-gate" && callerFaultOf(cell) === "flapping dependency") ? flappingTimesOf(cell, record.runs, verdict) : {}),
      // a slow dependency: the main value is the failed requests, and the last one comes near the heal
      ...(copyOf(cell) === "s2-slow" ? slowTimesOf(record.runs) : {}),
      // a black hole of DNS: the last failure from the heal, the outcomes, and the time of each act in the client pods
      ...(copyOf(cell) === "s2-dns" ? { ...slowTimesOf(record.runs), ...dnsRunsOf(record.runs) } : {}),
      // a VIP of kube-vip: the take of the Lease, the ARP of each outside client, and its last failure
      ...(copyOf(cell) === "s2-vip" ? vipRunsOf(record.runs) : {}),
      // a VIP of MetalLB: the death in memberlist, the ARP of each outside client, its last failure, and the withdrawal after the heal
      ...(copyOf(cell) === "s2-metallb" ? metallbRunsOf(record.runs) : {}),
      // a broker of Pulsar: the change of the owner, and the tries and the return of each producer
      ...(copyOf(cell) === "s2-pulsar" ? pulsarRunsOf(cell, record.runs) : {}),
      // the backlog of a stall: the sessions on the target and the stall of each counted run
      ...(copyOf(cell) === "s2-backlog" ? backlogRunsOf(cell, verdict) : {}),
      // the PINGs of the clients, when their image counts them
      ...(copyOf(cell).startsWith("s2") ? pingsOf(record.runs) : {}),
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !CATALOG.some((cell) => cell.name === name));
if (unknown.length > 0) throw new Error(`no catalog has the cells ${unknown.join(", ")}`);

// a pooled cell gives the record of each dispatch: the date is of the last, and the versions must agree
const records = [...found.values()].map((entry) => entry.record).concat([...parts.values()].flatMap((pieces) => pieces.slice(1).map((piece) => piece.record)));
const runner = runnerOf(folders);
const date = dateOf(records.map((record) => record.at));
// the control of the DNS cells has fewer runs than the black hole: thus that copy gives the most, and each cell gives its counted runs
const dnsOnly = records.every((record) => DNS_CELLS.some((cell) => cell.name === record.cell.name));
const copy = {
  source: "the raw records of the runners of GitHub, judged again with the catalog after the calibration of the propagation",
  ranAt: date,
  units: "s",
  runs: dnsOnly ? Math.max(...records.map((record) => record.cell.runs)) : Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  kubernetes: only("the version of Kubernetes", records.flatMap((record) => record.manifests.map((manifest) => manifest.cluster.server))),
  kind: only("the version of kind", records.flatMap((record) => record.manifests.map((manifest) => /^kind (v[\d.]+)/.exec(manifest.cluster.kind)?.[1] ?? ""))),
  /** This record is the propagation of a deletion in each mode. It is the time from the deletion to the first poll of the rules of each node without the pod. */
  propagation,
  cells,
};
// the S2 cells of the two incidents can come from one run: each incident gets its own copy
const names = [...new Set(cells.map((cell) => cell.copy))];
if (names.length > 1 && names.some((name) => !name.startsWith("s2")))
  throw new Error(`the cells of one export have one copy, or each copy is of S2: ${names.join(", ")}`);
for (const name of names) {
  const mine = cells.filter((cell) => cell.copy === name);
  const out = fileURLToPath(new URL(`../src/data/${name}${tag === null ? "" : `-${tag}`}-${date}.json`, import.meta.url));
  // a copy of S2 has the prediction of each S2 cell of its incident in the catalog, with a run or not
  const predictions =
    name === "s2"
      ? { predictions: callerPredictions() }
      : name === "s2-partition"
        ? { predictions: callerPredictions("partition") }
        : name === "s2-stall"
          ? { predictions: callerPredictions("stall") }
          : name === "s2-prober"
            ? { predictions: callerPredictions("false failure") }
            : name === "s2-dependency"
              ? { predictions: callerPredictions("shared dependency") }
              : name === "s2-flapping"
                ? { predictions: callerPredictions("flapping dependency") }
                : name === "s2-zone"
                  ? { predictions: callerPredictions("lost zone") }
                  : name === "s2-slow"
                    ? { predictions: callerPredictions("slow dependency") }
                    : name === "s2-backlog"
                      ? {
                          predictions: backlogPredictions(
                            mine.some((cell) => cell.id.includes(".backlog-terms."))
                              ? BACKLOG_TERMS_CELLS
                              : mine.some((cell) => cell.id.includes(".backlog-drain."))
                                ? BACKLOG_DRAIN_CELLS
                                : mine.some((cell) => cell.id.includes(".backlog-band."))
                                  ? BACKLOG_BAND_CELLS
                                  : BACKLOG_CELLS,
                          ),
                        }
                      : name === "s2-dns"
                        ? { phase: dnsPhaseOf() }
                        : name === "s2-vip"
                          ? { bands: vipBandsOf() }
                          : name === "s2-metallb"
                            ? { bands: metallbBandsOf() }
                            : name === "s2-pulsar"
                              ? { bands: pulsarBandsOf() }
                              : {};
  writeFileSync(out, stringify({ ...copy, cells: mine.map(({ copy: _copy, ...cell }) => cell), ...predictions }));
  process.stdout.write(`${mine.length} cells, ${mine.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
}
