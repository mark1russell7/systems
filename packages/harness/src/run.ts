import { valueIn } from "@mark1russell7/quantity";
import type { Cell, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import type { Lab, Manifest, Probe } from "./lab.ts";
import { openLab } from "./lab.ts";
import type { Measured } from "./observe.ts";
import { measure } from "./observe.ts";
import type { Verdict } from "./verdict.ts";
import { STEPS, verdictOf } from "./verdict.ts";

/** A cell result is a cell with its manifests, its runs, their measurements and its verdict. */
export interface CellResult {
  readonly cell: Cell;
  readonly manifests: readonly Manifest[];
  readonly runs: readonly Run[];
  readonly measured: readonly Measured[];
  readonly verdict: Verdict;
  /** These times are when its first environment opened and its last environment closed, on the wall clock. */
  readonly at: { readonly started: string; readonly ended: string };
}

/**
 * This function measures and judges the raw records of a cell, with the code of the harness at
 * this time. `runCell` uses it during a cell. A holder of the raw records of a cell can use it
 * again later. Thus the records get a new analysis after a change to observe.ts or to the verdict.
 */
export const judge = (
  cell: Cell,
  runs: readonly Run[],
): { measured: Measured[]; verdict: Verdict } => {
  const measured = runs.map((run) => measure(cell, run));
  return { measured, verdict: verdictOf(cell.prediction, measured) };
};

/** This function gives the count of lost records in the latest clock line of the prober, since it began. */
const droppedSoFar = (records: readonly KernelRecord[]): number => {
  for (let at = records.length - 1; at >= 0; at -= 1)
    if (records[at]!.ev === "clock") return Number(records[at]!["lost"] ?? 0);
  return 0;
};

/** This function gives the argv of the client for a cell, with a deadline far after all that it waits for. */
const probeArgs = (cell: Cell, lab: Lab): string[] => {
  const { prediction, probe } = cell;
  const longest = prediction.detects
    ? valueIn(prediction.high, "s")
    : valueIn(prediction.window, "s");
  const args = [lab.targetIp, String(cell.target.port), "--mode", probe.mode];
  if (probe.request !== undefined) args.push("--request", probe.request);
  if (probe.driver !== undefined) {
    // a driver sets its socket options from its own options: the keepAlive of ioredis
    args.push("--keepalive-ms", String(valueIn(probe.driver.keepAlive, "ms")));
    args.push("--max-s", String(Math.ceil(longest * 2 + 10)));
    return args;
  }
  if (probe.keepalive) args.push("--keepalive");
  if (probe.userTimeout !== undefined)
    args.push("--user-timeout-ms", String(valueIn(probe.userTimeout, "ms")));
  args.push("--max-s", String(Math.ceil(longest * 2 + 10)));
  return args;
};

/**
 * This function waits for an error on the socket of the target for the connection of the
 * client. The prober records that error in the namespace of the target. A cell on the server side
 * waits for that. The promise resolves after `within` ms at the latest.
 */
const serverError = (lab: Lab, local: unknown, within: number): Promise<void> =>
  new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const seen = lab.kernel.some(
        (record) =>
          record.ev === "error" &&
          (record.err ?? 0) !== 0 &&
          record.netns === lab.netns.target &&
          record.dst === local,
      );
      if (seen || Date.now() - started > within) resolve();
      else setTimeout(look, 50);
    };
    look();
  });

/**
 * This function waits for the request that an in-flight client sends on the signal: its second
 * send, after the PING that made it ready. Its stamp is when the request first met the fault.
 */
const requestSent = (probe: Probe, within: number): Promise<ProbeEvent> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const look = () => {
      const sent = probe.events.filter((event) => event.ev === "sent")[1];
      if (sent !== undefined) resolve(sent);
      else if (Date.now() - started > within)
        reject(new Error(`the client sent no request within ${within} ms of being told to`));
      else setTimeout(look, 1);
    };
    look();
  });

/**
 * This function does one run. The client connects and gets its reply, the fault occurs, and an
 * in-flight client sends into it. The harness then waits for the observer to see the fault, or for
 * the silent window to end. The observer is the client, or the socket of the target for a cell on
 * the server side.
 *
 * A stall stops by itself, at its length after the send of the request, and the
 * run waits for the reply. Then the harness removes the fault, thus the environment can serve the
 * next run. The run keeps the records of the prober from its start to its end. The frozen process
 * is the peer of the observer: the target, or the client for the server.
 */
const once = async (lab: Lab, cell: Cell, environment: number, index: number): Promise<Run> => {
  // each run starts from kernels that keep nothing from the runs before it
  await lab.forget();
  const from = lab.kernel.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const probe = await lab.probe(probeArgs(cell, lab));
  const server = cell.observer === "server";
  const peer = server
    ? { freeze: () => probe.freeze(), thaw: () => probe.thaw() }
    : { freeze: () => lab.freeze(), thaw: () => lab.thaw() };
  // a client that stopped before the signal to send tells why in its last lines
  const go = () =>
    probe.go().catch((error: unknown) => {
      const last = probe.events.slice(-3).map((event) => JSON.stringify(event));
      throw new Error(`${(error as Error).message}; the client's last lines: ${last.join(" ")}`);
    });
  let fault: Run["fault"];
  let heal: { t0: number; t1: number } | null = null;
  try {
    await probe.until(["ready"], 15_000);
    // the in-flight data of a run on the server side is the reply of the server. The request goes
    // out first, and the fault occurs while the server holds it (the timeout of BLPOP)
    const replyInFlight = server && cell.probe.mode === "inflight";
    if (replyInFlight) {
      // the client sends one sample after the file appears. The request reaches the server well
      // in the pause, and the reply waits for the timeout of the request
      await go();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const faultAt = server ? "client" : "target";
    // a stall is a black hole that stops by itself
    const network = cell.fault === "stall" ? "blackhole" : cell.fault;
    fault = network === "freeze-process" ? null : await lab.fault(network, faultAt);
    if (network === "freeze-process") await peer.freeze();
    try {
      if (cell.probe.mode === "inflight" && !replyInFlight) await go();
      const { prediction } = cell;
      if (cell.fault === "stall") {
        if (cell.stall === undefined) throw new Error(`${cell.name} says no stall's length`);
        // the injector holds the end in the VM until the length of the stall after the send
        const sent = await requestSent(probe, 5_000);
        heal = await lab.heal(faultAt, sent.t + valueIn(cell.stall, "s") * 1e9);
        const window = valueIn(prediction.detects ? prediction.high : prediction.window, "s");
        await probe.until(["data", "error", "eof"], window * 1_000).catch(() => undefined);
      } else if (prediction.detects) {
        const within = valueIn(prediction.high, "s") * 2_000 + 10_000;
        if (server) {
          const local = probe.events.find((event) => event.ev === "connected")?.["local"];
          await serverError(lab, local, within);
        } else {
          await probe.until(["error", "eof", "deadline"], within).catch(() => undefined);
        }
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, valueIn(prediction.window, "s") * 1_000),
        );
      }
    } finally {
      if (network === "freeze-process") await peer.thaw();
      else if (heal === null) await lab.lift(network, faultAt);
    }
    // a thawed target answers the request that it held: the client sees the late reply
    if (cell.fault === "freeze-process" && !server)
      await probe.until(["data"], 5_000).catch(() => undefined);
  } finally {
    await probe.stop();
  }
  // the prober drains its ring each 20 ms. Its next clock line closes the records of the run
  const settled = await lab.settle();
  const lost = settled === null ? null : settled - lostBefore;
  return {
    environment,
    index,
    events: [...probe.events],
    fault,
    ...(cell.fault === "stall" ? { heal } : {}),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.netns.target,
    lost,
  };
};

/** This function divides a count of runs across environments, as equally as possible. */
export const spread = (runs: number, environments: number): number[] =>
  Array.from(
    { length: environments },
    (_, at) => Math.floor(runs / environments) + (at < runs % environments ? 1 : 0),
  ).filter((count) => count > 0);

/** This function does the part of the runs of a cell in one environment, and records its manifest. */
const inEnvironment = async (
  cell: Cell,
  environment: number,
  count: number,
  say: (line: string) => void,
): Promise<{ manifest: Manifest; runs: Run[] }> => {
  const lab = await openLab(cell.target, cell.probe.driver?.name ?? "tcp");
  try {
    // the settings of the target first: Redis applies tcp-keepalive to a client when it accepts it
    const settings = await lab.configure(cell.targetSettings ?? {});
    const targetSysctls = await lab.targetSysctl(cell.targetSysctls ?? {});
    const manifest = await lab.manifest(await lab.sysctl(cell.sysctls), settings, targetSysctls);
    const runs: Run[] = [];
    for (let index = 0; index < count; index += 1) {
      const run = await once(lab, cell, environment, index);
      runs.push(run);
      const read = measure(cell, run);
      say(
        `${cell.name}: env ${environment} run ${index} ${read.outcome.kind}` +
          `${read.elapsed === null ? "" : ` ${read.elapsed.value} s`}` +
          `${read.void === null ? "" : ` (void: ${read.void})`}`,
      );
    }
    return { manifest, runs };
  } finally {
    await lab.close();
  }
};

/**
 * This function does the runs of a cell. They go across new environments, and each environment records
 * its manifest. Then the verdict judges the runs. A median across the edge of the band extends
 * the cell from 11 runs to 22, and then to 44, each extension in new environments. With a
 * concurrency of more than one, that many environments operate at the same time, each with its
 * own prober. The runs then go across at least as many environments.
 */
export const runCell = async (
  cell: Cell,
  say: (line: string) => void = () => {},
): Promise<CellResult> => {
  const started = new Date().toISOString();
  const manifests: Manifest[] = [];
  const runs: Run[] = [];
  const concurrency = Math.max(1, cell.concurrency ?? 1);
  let target: number = cell.runs;
  let next = 0;
  for (;;) {
    const counts = spread(target - runs.length, Math.max(cell.environments, concurrency));
    for (let at = 0; at < counts.length; at += concurrency) {
      const batch = counts.slice(at, at + concurrency).map((count) => ({ count, env: next++ }));
      const done = await Promise.all(
        batch.map(({ count, env }) => inEnvironment(cell, env, count, say)),
      );
      for (const each of done) {
        manifests.push(each.manifest);
        runs.push(...each.runs);
      }
    }
    const { measured, verdict } = judge(cell, runs);
    const larger = STEPS.find((step) => step > runs.length);
    if (verdict.decision !== "extend" || larger === undefined) {
      const at = { started, ended: new Date().toISOString() };
      return { cell, manifests, runs, measured, verdict, at };
    }
    target = larger;
  }
};
