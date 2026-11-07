// lease --port N --scenario JSON
//
// The target of the lease cells (SYS-73). This program starts one etcd member, and it answers HTTP
// on the port. The client of the cell sends GET / to see that the target is up. Each other path is
// the logical request: the program operates its scenario, and it answers 200 at the end.
// Node.js 24 removes the types of this file when it starts, thus the image has no build.
//
//	{ "kind": "bare", "ttl": 1, "restart": null, "low": 2000, "high": 2800 }
//	{ "kind": "hold", "ttl": 3, "hold": 0, "work": 2, "frozen": true, "contender": "plain", "write": "fenced", "low": 3000, "high": 3800 }
//	{ "kind": "waiter", "ttl": 3, "work": 5, "low": 3000, "high": 3800 }
//
// - A scenario `bare` grants a lease and writes one key on it. With `restart`, it stops the member
//   that many ms later and starts it again on the same data. Its marks are the request and the
//   response of the grant, or the stop and the health of the member.
// - A scenario `hold` starts `etcdctl lock` with a section of sh. The section prints its lock, sleeps
//   for `work` seconds, then does its write. With `frozen`, SIGSTOP stops the whole process group
//   `hold` ms after the lock, thus the keepalive and the section stop together. A contender comes
//   next. SIGCONT starts the holder again after the end of its lease and the write of the contender.
//   The marks are the start of the holder and the stop, or the stop twice if `hold` is not zero.
// - A scenario `waiter` starts a holder, then a waiter that queues and stops. The holder ends after
//   the end of the lease of the waiter, and SIGCONT then starts the waiter again.
//
// Each line has a revision less the base of its scenario, the head at its start. The line `deleted`
// is each deletion that the watcher of the prefix sees. The line `lease-end` is that deletion for
// the key of the scenario: `early` is its time after the first mark, `late` after the last mark, and
// `within` tells if the band holds. The contender and the live holder stay in their sections.
// Each scenario ends with no lease left, because the target stays up for the next run.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

/** This type is the fence of a write. */
type Write = "none" | "plain" | "fenced";

/** This type is the band of a scenario: the first time and the last time of the end of a lease, in ms after its marks. */
interface Band {
  readonly low: number;
  readonly high: number;
}

/** This type is a scenario `bare`. */
interface Bare extends Band {
  readonly kind: "bare";
  readonly ttl: number;
  readonly restart: number | null;
}

/** This type is a scenario `hold`. */
interface Hold extends Band {
  readonly kind: "hold";
  readonly ttl: number;
  readonly hold: number;
  readonly work: number;
  readonly frozen: boolean;
  readonly contender: Write;
  readonly write: Write;
}

/** This type is a scenario `waiter`. */
interface Waiter extends Band {
  readonly kind: "waiter";
  readonly ttl: number;
  readonly work: number;
}

/** This type is the scenario of the argument `--scenario`. */
type Scenario = Bare | Hold | Waiter;

/** This type is the part of a key that a scenario reads (the fields of mvccpb.KeyValue). */
interface Key {
  readonly key: string;
  readonly create_revision?: number;
  readonly mod_revision: number;
  readonly value?: string;
}

/** This type is the part of the JSON of `etcdctl watch` that a scenario reads. */
interface Printed {
  readonly Events?: readonly { readonly kv: Key }[] | null;
}

/** This type is the part of the JSON of `etcdctl get`, `put` and `txn` that a scenario reads. */
interface Response {
  readonly header: { readonly revision: number };
  readonly kvs?: readonly Key[];
  readonly succeeded?: boolean;
}

/** This type is the line of a section at its lock, or the response of its write. */
type Said = { readonly key: string; readonly rev: number } | Response;

/** This type is what the watcher of the prefix saw. A delete has no create revision (server/storage/mvcc/watchable_store_txn.go:33-35). */
interface Marks {
  readonly created: { readonly key: string; readonly rev: number }[];
  readonly deleted: { readonly key: string; readonly rev: number; readonly at: number }[];
}

/** This type is a running `etcdctl lock`. */
interface Locker {
  readonly who: string;
  readonly child: ChildProcess;
  held: { readonly key: string } | undefined;
  wrote: boolean;
  ended: { readonly code: number | null; readonly errors: string } | undefined;
}

/** This type is the start of a locker. */
interface Start {
  readonly who: string;
  readonly base: number;
  readonly ttl: number;
  readonly script: string;
  readonly token: "none" | "lock";
  /** A lock line before this time is a finding: the contender cannot come before the end of the lease. */
  readonly earliest: number;
}

/** This time is the longest wait for one step of a scenario, in ms. */
const SETTLE = 30_000;

/** This time is the sleep of a section that keeps its lock to the end of its scenario, in seconds. */
const LINGER = 60;

/** This name is the lock of each scenario, and the prefix of its keys. */
const LOCK = "l";

/** This key is the resource that the locks guard. */
const RESOURCE = "r";

/** This function writes one line, with `t` from process.hrtime: CLOCK_MONOTONIC, the clock of the prober. */
const emit = (ev: string, fields: Readonly<Record<string, unknown>> = {}): void => {
  process.stdout.write(`${JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...fields })}\n`);
};

/** This function gives the time in ms, on the clock of `emit`. */
const now = (): number => Number(process.hrtime.bigint()) / 1_000_000;

/** This function waits for a time in ms. */
const sleep = (time: number): Promise<void> => new Promise((resume) => setTimeout(resume, time));

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const port = Number(flag("--port") ?? 8080);
const scenario = JSON.parse(flag("--scenario") ?? "") as Scenario;

/** These are the waits of the scenario. A line of a client runs each of them. */
const waits = new Set<() => void>();

/** This function runs each wait after a change of the state. */
const changed = (): void => {
  for (const wait of [...waits]) wait();
};

/** This function waits for a value from the state, up to the settle time. */
const until = <Value>(what: string, read: () => Value | undefined): Promise<Value> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waits.delete(check);
      reject(new Error(`no ${what} in ${SETTLE} ms`));
    }, SETTLE);
    const check = (): void => {
      const value = read();
      if (value === undefined) return;
      clearTimeout(timer);
      waits.delete(check);
      resolve(value);
    };
    waits.add(check);
    check();
  });

/** This function parses a line of JSON. A line that is not JSON is a failed line, and the wait for it ends at the settle time. */
const parsed = <Value>(line: string): Value | undefined => {
  try {
    return JSON.parse(line) as Value;
  } catch {
    emit("failed", { message: `not JSON: ${line}` });
    return undefined;
  }
};

/** These are the process groups of the lockers that run. */
const groups = new Set<number>();

/** These are the watchers that run. */
const watchers = new Set<ChildProcess>();

/** This function starts etcdctl and waits for its end, and it gives its stdout. */
const ctl = (args: readonly string[], input?: string): Promise<string> =>
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

/** This function gives the response of a read of a key. */
const read = async (key: string): Promise<Response> => JSON.parse(await ctl(["get", key, "-w", "json"])) as Response;

/** This function gives the revision of the head of the store. */
const head = async (): Promise<number> => (await read(RESOURCE)).header.revision;

/** This function gives the text of a key or a value of the JSON of etcdctl. */
const textOf = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf8");

/** This function starts the watcher of the prefix after the base, and it gives what it saw. */
const observe = (base: number): Marks => {
  const child = spawn("etcdctl", ["watch", `${LOCK}/`, "--prefix", "-w", "json", `--rev=${base + 1}`], { stdio: ["ignore", "pipe", "inherit"] });
  watchers.add(child);
  child.on("error", (error) => emit("failed", { message: String(error) }));
  const marks: Marks = { created: [], deleted: [] };
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const at = now();
    for (const { kv } of parsed<Printed>(line)?.Events ?? []) {
      const key = textOf(kv.key);
      const rev = kv.mod_revision - base;
      if (kv.create_revision === undefined) {
        marks.deleted.push({ key, rev, at });
        emit("deleted", { rev });
      } else marks.created.push({ key, rev });
    }
    changed();
  });
  return marks;
};

/** This function starts a locker in its own process group, thus a signal reaches etcdctl and its section together. */
const lock = (start: Start): Locker => {
  const { who, base, ttl, script, token, earliest } = start;
  const child = spawn("etcdctl", ["lock", `--ttl=${ttl}`, LOCK, "--", "sh", "-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const locker: Locker = { who, child, held: undefined, wrote: false, ended: undefined };
  const pid = child.pid;
  if (pid !== undefined) groups.add(pid);
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (part: string) => {
    errors += part;
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const at = now();
    const said = parsed<Said>(line);
    if (said === undefined) return;
    if ("key" in said) {
      locker.held = { key: said.key };
      emit("locked", { who, rev: said.rev - base, after: at >= earliest });
    } else {
      locker.wrote = true;
      emit("write", { who, token, applied: token === "none" || said.succeeded === true, rev: said.header.revision - base });
    }
    changed();
  });
  child.on("error", (error) => {
    locker.ended = { code: null, errors: String(error) };
    changed();
  });
  child.on("close", (code) => {
    if (pid !== undefined) groups.delete(pid);
    locker.ended = { code, errors };
    changed();
  });
  return locker;
};

/** This function sends a signal to the process group of a locker. */
const signal = (locker: Locker, name: NodeJS.Signals): void => {
  const pid = locker.child.pid;
  if (pid === undefined) throw new Error(`the ${locker.who} has no process`);
  process.kill(-pid, name);
};

/** This line is the first line of a section: its lock key, and `ETCD_LOCK_REV`. */
const LOCK_LINE = `printf '{"key":"%s","rev":%s}\\n' "$ETCD_LOCK_KEY" "$ETCD_LOCK_REV"`;

/** This function gives the lines of a write of a section. The fence compares the create revision of the lock key with `ETCD_LOCK_REV`. */
const writeLines = (who: string, write: Write): readonly string[] => {
  if (write === "none") return [];
  if (write === "plain") return [`etcdctl put ${RESOURCE} ${who} -w json`];
  return [`printf 'c("%s") = "%s"\\n\\nput ${RESOURCE} ${who}\\n\\n\\n' "$ETCD_LOCK_KEY" "$ETCD_LOCK_REV" | etcdctl txn -w json`];
};

/** This function gives the token that a write prints. */
const tokenOf = (write: Write): "none" | "lock" => (write === "fenced" ? "lock" : "none");

/** This function waits for the end of the lease of a key, and it tells if the band holds. */
const leaseEnd = async (marks: Marks, key: string, who: string, first: number, last: number, band: Band): Promise<void> => {
  const end = await until(`end of the lease of the ${who}`, () => marks.deleted.find((each) => each.key === key));
  const early = end.at - first;
  const late = end.at - last;
  emit("lease-end", { who, rev: end.rev, early, late, within: early >= band.low && late <= band.high });
};

/** This function waits for the end of a locker, and it writes its line. A session error names `ErrSessionExpired`. */
const exited = async (locker: Locker): Promise<void> => {
  const { code, errors } = await until(`exit of the ${locker.who}`, () => locker.ended);
  emit("exit", { who: locker.who, code, expired: errors.includes("session is expired") });
};

/** This function writes the value of the resource and the head. */
const final = async (base: number): Promise<void> => {
  const response = await read(RESOURCE);
  const kv = response.kvs?.[0];
  emit("final", { head: response.header.revision - base, ...(kv === undefined ? {} : { value: textOf(kv.value ?? ""), rev: kv.mod_revision - base }) });
};

/** This is the member of etcd. */
let etcd: ChildProcess | undefined;

/** This function starts etcd on its data, and it waits for its health. Health is a linearizable read, thus the promotion is done. Its logs go to stderr. */
const startEtcd = async (): Promise<void> => {
  etcd = spawn("etcd", ["--data-dir", "/tmp/etcd", "--log-level", "error"], { stdio: ["ignore", "inherit", "inherit"] });
  for (;;) {
    try {
      await ctl(["endpoint", "health"]);
      return;
    } catch {
      await sleep(100);
    }
  }
};

/** This function stops the member at once and starts it again on the same data. */
const restartEtcd = async (): Promise<void> => {
  const member = etcd;
  if (member === undefined) throw new Error("no member runs");
  const closed = new Promise<void>((resume) => {
    member.once("close", () => resume());
  });
  member.kill("SIGKILL");
  await closed;
  await startEtcd();
};

/** This function operates a scenario `bare`. A restart comes before the watcher, because the watcher reads from the base. */
const bare = async (spec: Bare): Promise<void> => {
  const base = await head();
  const asked = now();
  // the JSON of a grant has an ID above 2^53, thus the text is the exact form
  const answer = /lease (\S+) granted with TTL\((\d+)s\)/.exec(await ctl(["lease", "grant", String(spec.ttl)]));
  const answered = now();
  if (answer === null) throw new Error("etcdctl printed no grant");
  emit("granted", { ttl: Number(answer[2]) });
  const key = `${LOCK}/bare`;
  await ctl(["put", key, "v", `--lease=${answer[1]}`]);
  let first = asked;
  let last = answered;
  if (spec.restart !== null) {
    await sleep(spec.restart);
    first = now();
    await restartEtcd();
    last = now();
  }
  await leaseEnd(observe(base), key, "bare", first, last, spec);
  await final(base);
};

/** This function writes for a contender with the true create revision of its key, read from the store. */
const fenceTruly = async (locker: Locker, base: number): Promise<void> => {
  const key = locker.held?.key;
  if (key === undefined) throw new Error(`the ${locker.who} has no lock`);
  const created = (await read(key)).kvs?.[0]?.create_revision;
  if (created === undefined) throw new Error(`the key of the ${locker.who} has no create revision`);
  const response = JSON.parse(await ctl(["txn", "-w", "json"], `c("${key}") = "${created}"\n\nput ${RESOURCE} ${locker.who}\n\n\n`)) as Response;
  emit("write", { who: locker.who, token: "create", applied: response.succeeded === true, rev: response.header.revision - base });
};

/** This function operates a scenario `hold`. */
const hold = async (spec: Hold): Promise<void> => {
  const base = await head();
  const marks = observe(base);
  const started = now();
  const work = `sleep ${spec.work}`;
  const stay = spec.frozen ? [] : [`sleep ${LINGER}`];
  const script = [LOCK_LINE, work, ...writeLines("holder", spec.write), ...stay].join("\n");
  const holder = lock({ who: "holder", base, ttl: spec.ttl, script, token: tokenOf(spec.write), earliest: 0 });
  const held = await until("lock of the holder", () => holder.held);
  if (spec.frozen) await sleep(spec.hold);
  const stopped = now();
  if (spec.frozen) signal(holder, "SIGSTOP");
  const first = spec.hold === 0 ? started : stopped;
  const rival =
    spec.contender === "none"
      ? null
      : lock({
          who: "contender",
          base,
          ttl: spec.ttl,
          script: [LOCK_LINE, ...writeLines("contender", spec.contender), `sleep ${LINGER}`].join("\n"),
          token: tokenOf(spec.contender),
          earliest: spec.frozen ? first + spec.low : 0,
        });
  if (rival !== null) {
    const queued = await until("key of the contender", () => marks.created[1]);
    emit("queued", { who: "contender", rev: queued.rev });
  }
  if (!spec.frozen) {
    if (spec.write !== "none") await until("write of the holder", () => (holder.wrote ? true : undefined));
    await final(base);
    return;
  }
  await leaseEnd(marks, held.key, "holder", first, stopped, spec);
  if (rival !== null) {
    await until("write of the contender", () => (rival.wrote ? true : undefined));
    if (spec.contender === "fenced") await fenceTruly(rival, base);
  }
  signal(holder, "SIGCONT");
  await exited(holder);
  await final(base);
};

/** This function operates a scenario `waiter`. */
const waiter = async (spec: Waiter): Promise<void> => {
  const base = await head();
  const marks = observe(base);
  const script = [LOCK_LINE, `sleep ${spec.work}`].join("\n");
  const holder = lock({ who: "holder", base, ttl: spec.ttl, script, token: "none", earliest: 0 });
  const held = await until("lock of the holder", () => holder.held);
  const started = now();
  const queue = lock({ who: "waiter", base, ttl: spec.ttl, script: LOCK_LINE, token: "none", earliest: 0 });
  const queued = await until("key of the waiter", () => marks.created[1]);
  emit("queued", { who: "waiter", rev: queued.rev });
  const stopped = now();
  signal(queue, "SIGSTOP");
  await leaseEnd(marks, queued.key, "waiter", started, stopped, spec);
  await exited(holder);
  await until("release of the holder", () => marks.deleted.find((each) => each.key === held.key));
  signal(queue, "SIGCONT");
  await exited(queue);
  await final(base);
};

/** This function stops each client and revokes each lease, thus the next run starts from a store with no writer. The watcher goes first, thus these deletions print no line. */
const clean = async (): Promise<void> => {
  for (const child of watchers) child.kill("SIGKILL");
  watchers.clear();
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // the group ended, and its close event comes next
    }
  }
  groups.clear();
  waits.clear();
  const [, ...leases] = (await ctl(["lease", "list"])).trim().split("\n");
  for (const lease of leases) await ctl(["lease", "revoke", lease.trim()]).catch(() => undefined);
};

/** This function operates the scenario, cleans up in each case, and it writes the last line. */
const operate = async (): Promise<void> => {
  try {
    if (scenario.kind === "bare") await bare(scenario);
    else if (scenario.kind === "hold") await hold(scenario);
    else await waiter(scenario);
  } finally {
    await clean();
  }
  emit("end", { reached: true });
};

await startEtcd();

const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  operate().then(
    () => res.writeHead(200, { "content-type": "text/plain" }).end("done"),
    (error: unknown) => {
      emit("failed", { message: String(error) });
      res.writeHead(500, { "content-type": "text/plain" }).end("failed");
    },
  );
});
server.listen(port, () => emit("listening", { port, scenario, node: process.version }));
