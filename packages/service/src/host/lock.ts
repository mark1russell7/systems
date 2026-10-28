import type { HostPorts, ProcessMark } from "./ports.ts";
import { sameProcess } from "./processes.ts";

/**
 * A lock owner is the record in a lock file: the process that holds the lock. The record can also
 * have the child process that it holds the lock for. The lock is held while one of the two is alive.
 */
export interface LockOwner extends ProcessMark {
  readonly child?: ProcessMark | undefined;
}

/** An instance lock is a lock that this process holds. */
export interface InstanceLock {
  readonly path: string;
  readonly owner: LockOwner;
  /** This method writes a new child process in the record, or no child with null. */
  update(child: ProcessMark | null): Promise<void>;
  /** This method removes the lock file, when it still has the record of this lock. A second use does nothing. */
  release(): Promise<void>;
}

/**
 * A lock result tells what a try to take the lock found.
 * - `acquired`: this process holds the lock. `recovered` tells why a stale lock went first, or it is null.
 * - `held`: a live process holds the lock. Its owner is in the result.
 * - `failed`: the lock did not come free, or the file system failed. The problem tells why.
 */
export type LockResult =
  | { readonly kind: "acquired"; readonly lock: InstanceLock; readonly recovered: string | null }
  | { readonly kind: "held"; readonly owner: LockOwner }
  | { readonly kind: "failed"; readonly problem: string };

/**
 * A lock state is what an examination of a lock file found. An examination does not throw.
 * - `free`: no file.
 * - `held`: the record names a live process.
 * - `stale`: the record names processes that stopped. The next take removes the file.
 * - `malformed`: the file is not a record, or the read failed.
 */
export type LockState =
  | { readonly kind: "free" }
  | { readonly kind: "held"; readonly owner: LockOwner }
  | { readonly kind: "stale"; readonly owner: LockOwner; readonly why: string }
  | { readonly kind: "malformed"; readonly problem: string };

/** These options go with a take of the lock. */
export interface LockOptions {
  /** This count is the number of reads of a malformed file before the take removes it. The default is 3. */
  readonly tries?: number | undefined;
  /** This time is the pause between two reads of a malformed file, in milliseconds. The default is 100. */
  readonly pause?: number | undefined;
  /** This child process goes in the record at the take. */
  readonly child?: ProcessMark | undefined;
}

const isMark = (value: unknown): value is ProcessMark => {
  if (typeof value !== "object" || value === null) return false;
  const { pid, startedAt } = value as { pid?: unknown; startedAt?: unknown };
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof startedAt === "number" && Number.isFinite(startedAt);
};

/** This function reads a lock owner from the text of a lock file, or gives null for a text that is not a record. */
export const parseLockOwner = (text: string): LockOwner | null => {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isMark(value)) return null;
    const child = (value as { child?: unknown }).child;
    if (child !== undefined && child !== null && !isMark(child)) return null;
    return { pid: value.pid, startedAt: value.startedAt, ...(isMark(child) ? { child: { pid: child.pid, startedAt: child.startedAt } } : {}) };
  } catch {
    return null;
  }
};

/** This function gives the text of a lock file for an owner. */
export const lockText = (owner: LockOwner): string => `${JSON.stringify(owner)}\n`;

/** This function tells if the owner of a lock is alive: its process, or its child. */
const ownerAlive = async (owner: LockOwner, ports: HostPorts): Promise<boolean> =>
  (await sameProcess(owner, ports)) || (owner.child !== undefined && (await sameProcess(owner.child, ports)));

const sleep = (ports: HostPorts, ms: number): Promise<void> => new Promise((resolve) => ports.clock.after(ms, resolve));

/**
 * This function removes a lock file only when it has this text. The removal holds the removal lock
 * `<path>.rm` for its read and its delete. Thus two processes that find the same stale lock do not
 * remove each other's new lock. A removal lock whose owner stopped goes first.
 */
const removeIfSame = async (path: string, text: string, ports: HostPorts): Promise<boolean> => {
  const removal = `${path}.rm`;
  const mine = lockText({ pid: ports.self.pid, startedAt: ports.self.startedAt });
  if (!(await ports.files.create(removal, mine))) {
    const other = parseLockOwner((await ports.files.read(removal)) ?? "");
    if (other !== null && (await ownerAlive(other, ports))) return false;
    await ports.files.remove(removal);
    if (!(await ports.files.create(removal, mine))) return false;
  }
  try {
    if ((await ports.files.read(path)) !== text) return false;
    await ports.files.remove(path);
    return true;
  } finally {
    if ((await ports.files.read(removal)) === mine) await ports.files.remove(removal);
  }
};

/** This function examines a lock file. It does not throw. */
export const inspectInstanceLock = async (path: string, ports: HostPorts): Promise<LockState> => {
  try {
    const text = await ports.files.read(path);
    if (text === null) return { kind: "free" };
    const owner = parseLockOwner(text);
    if (owner === null) return { kind: "malformed", problem: "the lock file is not a lock record" };
    if (await ownerAlive(owner, ports)) return { kind: "held", owner };
    return { kind: "stale", owner, why: `the owner process ${owner.pid} stopped` };
  } catch (error) {
    return { kind: "malformed", problem: `the read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/**
 * This function takes the lock of one instance: a lock file with the record of this process. Thus a
 * second instance does not start. It does not throw.
 * - A file whose owner and child stopped is stale: it goes, and the take tries again.
 * - A malformed file can be the file of a take that writes at this time. The take reads it again after
 *   a pause, and after `tries` reads, it removes it.
 * - A file whose owner or child is alive gives `held`.
 */
export const acquireInstanceLock = async (path: string, ports: HostPorts, options: LockOptions = {}): Promise<LockResult> => {
  const tries = options.tries ?? 3;
  const pause = options.pause ?? 100;
  const owner: LockOwner = { pid: ports.self.pid, startedAt: ports.self.startedAt, ...(options.child === undefined ? {} : { child: options.child }) };
  let recovered: string | null = null;
  let malformed = 0;
  try {
    for (let attempt = 0; attempt < tries + 3; attempt += 1) {
      const text = lockText(owner);
      if (await ports.files.create(path, text)) {
        ports.logger?.log("info", `the host took the lock ${path}`, { path, pid: owner.pid, ...(recovered === null ? {} : { recovered }) });
        return { kind: "acquired", lock: held(path, owner, text, ports), recovered };
      }
      const found = await ports.files.read(path);
      if (found === null) continue;
      const other = parseLockOwner(found);
      if (other === null) {
        malformed += 1;
        if (malformed < tries) {
          await sleep(ports, pause);
          continue;
        }
        if (await removeIfSame(path, found, ports)) recovered = "the lock file was not a lock record";
        continue;
      }
      if (await ownerAlive(other, ports)) return { kind: "held", owner: other };
      if (await removeIfSame(path, found, ports)) {
        recovered = `the owner process ${other.pid} stopped`;
        ports.logger?.log("warn", `the host removed the stale lock ${path}: ${recovered}`, { path, owner: other });
      }
    }
    return { kind: "failed", problem: `the lock ${path} did not come free after ${tries + 3} tries` };
  } catch (error) {
    return { kind: "failed", problem: `the file system failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/** This function gives the handle of a lock that this process holds. */
const held = (path: string, first: LockOwner, firstText: string, ports: HostPorts): InstanceLock => {
  let owner = first;
  let text = firstText;
  let released = false;
  // the updates and the release occur in sequence, thus a late write does not make the file again after the release
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  return {
    path,
    get owner() {
      return owner;
    },
    update: (child) =>
      enqueue(async () => {
        if (released) return;
        const next: LockOwner = { pid: owner.pid, startedAt: owner.startedAt, ...(child === null ? {} : { child }) };
        const nextText = lockText(next);
        await ports.files.write(path, nextText);
        owner = next;
        text = nextText;
      }),
    release: () =>
      enqueue(async () => {
        if (released) return;
        released = true;
        try {
          await removeIfSame(path, text, ports);
        } catch {
          // a lock file that stays is stale after the exit of this process
        }
      }),
  };
};
