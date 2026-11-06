// watch --port N --scenario JSON
//
// The target of the watch cells (SYS-74). This program starts one etcd member, and it answers HTTP
// on the port. The client of the cell sends GET / to see that the target is up. Each other path is
// the logical request: the program operates its scenario, and it answers 200 at the end.
// Node.js 24 removes the types of this file when it starts, thus the image has no build.
//
//	{ "kind": "resume", "before": 5, "after": 5, "at": -1 }
//	{ "kind": "stall", "writes": 300, "bytes": 262144, "stopped": true, "compact": true }
//
// - A scenario `resume` writes `before` revisions, and it compacts at the last one, revision R.
//   It writes `after` revisions, then it starts a watcher at R + `at`.
// - A scenario `stall` starts a watcher at the head, and it sees one first event, thus the watcher
//   is synced. With `stopped`, SIGSTOP stops the watcher. The program then writes `writes` values of
//   `bytes` bytes. With `compact`, it compacts at the last revision. SIGCONT starts the watcher again.
//
// Each event that the watcher prints is a line `event`, with its revision less the base of the
// scenario. A cancel is a line `canceled`, with `offset`, the compact revision less R, and
// `compacted`, which tells if etcdctl named the compaction error. It comes when the watcher ends,
// because etcdctl prints the error on stderr and the response on stdout, and the two pipes can race.
// The line `end` closes a scenario.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

/** This type is the scenario of the argument `--scenario`. */
type Scenario =
  | { readonly kind: "resume"; readonly before: number; readonly after: number; readonly at: number }
  | { readonly kind: "stall"; readonly writes: number; readonly bytes: number; readonly stopped: boolean; readonly compact: boolean };

/** This type is the part of the JSON of `etcdctl watch` that a scenario reads (the fields of clientv3.WatchResponse). */
interface Printed {
  readonly Events?: readonly { readonly kv: { readonly mod_revision: number } }[] | null;
  readonly CompactRevision?: number;
  readonly Canceled?: boolean;
}

/** These are the revisions that a watcher reads when it prints. A scenario sets them as it goes. */
interface Marks {
  /** Each event at this revision or below it prints no line. */
  base: number;
  /** This revision is R, the compact revision of the scenario. */
  compaction: number;
}

/** This type is a running `etcdctl watch`. */
interface Watcher {
  readonly child: ChildProcess;
  /** This promise resolves when the process ends. */
  readonly closed: Promise<void>;
  /** This function gives a promise that resolves at the first event at this revision or above it. */
  readonly reached: (revision: number) => Promise<void>;
}

/** This time is the longest wait for a watcher after the end of its scenario, in ms. */
const SETTLE = 30_000;

/** This function writes one line, with `t` from process.hrtime: CLOCK_MONOTONIC, the clock of the prober. */
const emit = (ev: string, fields: Readonly<Record<string, unknown>> = {}): void => {
  process.stdout.write(`${JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...fields })}\n`);
};

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const port = Number(flag("--port") ?? 8080);
const scenario = JSON.parse(flag("--scenario") ?? "") as Scenario;

/** This function starts etcdctl and waits for its end, and it gives its stdout. A value goes on stdin, because a long one does not fit in an argument. */
const ctl = (args: readonly string[], input?: Buffer): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("etcdctl", [...args], { stdio: ["pipe", "pipe", "inherit"] });
    const parts: Buffer[] = [];
    child.stdout.on("data", (part: Buffer) => parts.push(part));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(parts).toString("utf8"));
      else reject(new Error(`etcdctl ${args[0]} ended with ${code}`));
    });
    child.stdin.end(input);
  });

/** This function gives the revision of the head of the store. */
const head = async (): Promise<number> => (JSON.parse(await ctl(["get", "k", "-w", "json"])) as { header: { revision: number } }).header.revision;

/** This function writes one value of the key, and it gives nothing: the revision of the head moves by one. */
const write = async (value: Buffer): Promise<void> => {
  await ctl(["put", "k"], value);
};

/** This function starts a watcher of the key at a revision, or at the head. */
const watch = (from: number | null, marks: Marks): Watcher => {
  const child = spawn("etcdctl", ["watch", "k", "-w", "json", ...(from === null ? [] : [`--rev=${from}`])], { stdio: ["ignore", "pipe", "pipe"] });
  const waits: { readonly revision: number; readonly resume: () => void }[] = [];
  let last = 0;
  let errors = "";
  let canceled: number | null = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (part: string) => {
    errors += part;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const printed = JSON.parse(line) as Printed;
    for (const event of printed.Events ?? []) {
      last = event.kv.mod_revision;
      if (last > marks.base) emit("event", { rev: last - marks.base });
    }
    for (const wait of waits.filter((each) => each.revision <= last)) wait.resume();
    if (printed.Canceled === true) canceled = printed.CompactRevision ?? 0;
  });
  const closed = new Promise<void>((resume) => {
    child.on("close", () => {
      if (canceled !== null) emit("canceled", { offset: canceled - marks.compaction, compacted: errors.includes("required revision has been compacted") });
      resume();
    });
  });
  const reached = (revision: number): Promise<void> =>
    last >= revision
      ? Promise.resolve()
      : new Promise((resume) => {
          waits.push({ revision, resume });
        });
  return { child, closed, reached };
};

/** This function waits for a promise, up to the settle time, and it tells if the promise came first. */
const settled = async (promise: Promise<void>): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resume) => {
    timer = setTimeout(() => resume(false), SETTLE);
  });
  const done = await Promise.race([promise.then(() => true), late]);
  clearTimeout(timer);
  return done;
};

/** This function stops a watcher, and it writes the last line of its scenario. */
const finish = async (watcher: Watcher, reached: boolean): Promise<void> => {
  watcher.child.kill("SIGKILL");
  await watcher.closed;
  emit("end", { reached });
};

/** This function operates a scenario `resume`. */
const resume = async (spec: Extract<Scenario, { kind: "resume" }>): Promise<void> => {
  const base = await head();
  const small = Buffer.from("v");
  for (let n = 0; n < spec.before; n += 1) await write(small);
  const compaction = base + spec.before;
  await ctl(["compaction", String(compaction)]);
  for (let n = 0; n < spec.after; n += 1) await write(small);
  const watcher = watch(compaction + spec.at, { base, compaction });
  // a canceled watcher ends by itself, and a live one reaches the head
  const reached = await settled(Promise.race([watcher.reached(compaction + spec.after), watcher.closed]));
  await finish(watcher, reached);
};

/** This function operates a scenario `stall`. */
const stall = async (spec: Extract<Scenario, { kind: "stall" }>): Promise<void> => {
  const marks: Marks = { base: Infinity, compaction: 0 };
  const watcher = watch(null, marks);
  // etcdctl prints nothing at its start, thus a loop of writes finds the moment that the watcher is synced
  let at = await head();
  for (;;) {
    await write(Buffer.from("v"));
    at += 1;
    if (await Promise.race([watcher.reached(at).then(() => true), new Promise<boolean>((resume) => setTimeout(() => resume(false), 500))])) break;
  }
  marks.base = at;
  if (spec.stopped) watcher.child.kill("SIGSTOP");
  const value = Buffer.alloc(spec.bytes, "v");
  for (let n = 0; n < spec.writes; n += 1) await write(value);
  const last = at + spec.writes;
  marks.compaction = last;
  // a live watcher sees each write first: the compaction then has nothing to overtake
  if (!spec.stopped) await settled(watcher.reached(last));
  if (spec.compact) await ctl(["compaction", String(last)]);
  emit("written", { writes: spec.writes });
  if (spec.stopped) watcher.child.kill("SIGCONT");
  const reached = await settled(Promise.race([watcher.reached(last), watcher.closed]));
  await finish(watcher, reached);
};

/** This function starts etcd, and it waits for its health. Its logs go to stderr. */
const startEtcd = async (): Promise<void> => {
  spawn("etcd", ["--data-dir", "/tmp/etcd", "--log-level", "error"], { stdio: ["ignore", "inherit", "inherit"] });
  for (;;) {
    try {
      await ctl(["endpoint", "health"]);
      return;
    } catch {
      await new Promise((resume) => setTimeout(resume, 100));
    }
  }
};

await startEtcd();
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const run = scenario.kind === "resume" ? resume(scenario) : stall(scenario);
  run.then(
    () => res.writeHead(200, { "content-type": "text/plain" }).end("done"),
    (error: unknown) => {
      emit("failed", { message: String(error) });
      res.writeHead(500, { "content-type": "text/plain" }).end("failed");
    },
  );
});
server.listen(port, () => emit("listening", { port, scenario, node: process.version }));
