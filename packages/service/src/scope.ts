// @mark1russell7/service/scope: one scope for each process, service, phase, request, job, loop round and procedure.
// A scope holds the signal, the deadline, the clock, the trace, the identity and the values of keys of its work,
// and the resources that close at its end. A child gets each value of its parent, and it can only make the
// deadline earlier. This entry loads only the clock of the algebra: no `node:` module and no zod. Thus a client
// in a browser can use it.

import { type Cancel, type Clock, realClock } from "./clock.ts";
import type { IncomingHeaders } from "./call-context.ts";


/** The kinds of a scope, from the widest to the narrowest. */
export type ScopeKind = "process" | "service" | "phase" | "request" | "job" | "round" | "call";

/** The kinds of an entry: the scopes of an incoming request, of a message from a queue and of a loop round. */
export type EntryKind = "request" | "job" | "round";

/** This table gives the rank of each kind. A child has a higher rank than its parent, and a `call` can also be the child of a `call`. */
export const SCOPE_RANK: Readonly<Record<ScopeKind, number>> = { process: 0, service: 1, phase: 2, request: 3, job: 3, round: 3, call: 4 };

/** This name is the header that holds the remaining time of the sender, in whole milliseconds. */
export const TIMEOUT_HEADER = "timeout-ms";

/**
 * The principal of a scope: who sent the request of the entry. The shape is the shape of the principal of
 * `@procedures/client`, and a type test in the client holds the two shapes equal.
 */
export interface Principal {
  /** The id of the principal. */
  readonly id: string;
  /** How the server authenticated it: "token", or the name of an authenticate function. */
  readonly via: string;
  /** More facts about the principal, from an authenticate function. */
  readonly claims?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The key of a value of a scope. A key with a meet narrows: the value of a child is the meet of its own value
 * and the value of its parent. A key without a meet gives the value of the parent to each child, until a child
 * binds a new value. The meet is idempotent, commutative and associative: the laws of the package test it.
 */
export interface ScopeKey<T> {
  /** The name of the key, for an error and for a debug view. */
  readonly name: string;
  /** This function gives the narrower of two values. */
  readonly meet?: ((a: T, b: T) => T) | undefined;
}

/** This function makes a key. Each key is a separate key, also when two keys have the same name. */
export const scopeKey = <T>(name: string, meet?: (a: T, b: T) => T): ScopeKey<T> => (meet === undefined ? { name } : { name, meet });

/** This key holds the deadline of a scope, on the monotonic clock. Its meet is `Math.min`. */
export const DEADLINE: ScopeKey<number> = { name: "deadline", meet: (a, b) => Math.min(a, b) };

/** A value for a key, for the option `bind`. The function `bind` makes it with the right types. */
export interface ScopeBinding {
  readonly key: ScopeKey<unknown>;
  readonly value: unknown;
}

/** This function binds a value to a key, for the option `bind` of a child. */
export const bind = <T>(key: ScopeKey<T>, value: T): ScopeBinding => ({ key: key as ScopeKey<unknown>, value });

/** The options of a child. */
export interface ChildOptions {
  /** This time is in milliseconds from the start of the child. The deadline of the child is not later than the start plus this time. */
  readonly timeout?: number | undefined;
  /** These values bind keys in the child. A value for `DEADLINE` is a time on the clock of the scope. */
  readonly bind?: readonly ScopeBinding[] | undefined;
}

/** The options of an entry. The trace and the identity have no default: an entry states both, also when they are `undefined`. */
export interface EntryOptions extends ChildOptions {
  /** This value is the trace of the entry, for example the context that the entry `/otel` reads from the headers. */
  readonly trace: unknown;
  /** This principal sent the request. `undefined` is a request without authentication: the entry does not keep the identity of its parent. */
  readonly identity: Principal | undefined;
  /** These headers of the request can hold `timeout-ms`, the remaining time of the sender. */
  readonly headers?: IncomingHeaders | undefined;
}

/** The options of a root scope. */
export interface RootOptions extends ChildOptions {
  /** The name of the scope. */
  readonly name: string;
  /** The kind of the root. The default is `process`. */
  readonly kind?: "process" | "service" | undefined;
  /** The clock of the tree. Each scope of the tree has this clock. The default is `realClock`. */
  readonly clock?: Clock | undefined;
  /** The trace of the root. */
  readonly trace?: unknown;
  /** The identity of the root, for example the principal of the service itself. */
  readonly identity?: Principal | undefined;
}

/**
 * The scope of a part of the work. Its signal aborts with its parent, at its deadline, or at `abort()`. Its
 * resources close once, in the reverse order of their open, at `close()`.
 */
export interface Scope {
  readonly kind: ScopeKind;
  readonly name: string;
  readonly parent: Scope | null;
  /** This signal aborts with the parent, at the deadline, or at `abort()`. At the deadline, its reason is a `TimeoutError`. */
  readonly signal: AbortSignal;
  /** This time is the value of `DEADLINE`, in milliseconds on the monotonic clock of `clock`. `Infinity` is no deadline. */
  readonly deadline: number;
  /** This clock is the clock of the tree. */
  readonly clock: Clock;
  /** This value is the trace of the scope. The entry `/otel` keeps the context of OpenTelemetry in it. */
  readonly trace: unknown;
  /** This principal sent the request of the entry above the scope. */
  readonly identity: Principal | undefined;
  /** This flag is true after the start of `close()`. */
  readonly closed: boolean;
  /** This function gives the value of a key, or `undefined` when no scope of the chain binds the key. */
  get<T>(key: ScopeKey<T>): T | undefined;
  /** This function gives the time to the deadline, in milliseconds: zero or more, and `Infinity` for no deadline. */
  remaining(): number;
  /** This function gives the open children, in the order of their start. */
  children(): readonly Scope[];
  /** This function makes a child with the trace and the identity of this scope. It throws a `ScopeError` for a kind of a lower or equal rank. */
  child(kind: ScopeKind, name: string, options?: ChildOptions): Scope;
  /** This function makes an entry: a child with the trace and the identity of an incoming request. */
  entry(kind: EntryKind, name: string, options: EntryOptions): Scope;
  /** This function adds a close to the scope. A closed scope takes no resource: the function then throws a `ScopeError`. */
  defer(close: () => void | PromiseLike<void>): void;
  /** This function opens a resource and adds its close. A resource whose open throws does not close. */
  use<T>(open: () => T | PromiseLike<T>, close: (value: T) => void | PromiseLike<void>): Promise<T>;
  /** This function aborts the scope and each child, with one reason. A second abort changes nothing. */
  abort(reason?: unknown): void;
  /**
   * This function aborts and closes each open child, the last child first. Then it closes the resources of the
   * scope, the last first, and aborts its signal. Each close starts, also after a throw. The promise rejects
   * with a `ScopeCloseError` that holds each error. A second `close()` gives the same promise.
   */
  close(): Promise<void>;
}

/** The error of a wrong use of a scope: a child of a wrong rank, or a resource for a closed scope. */
export class ScopeError extends Error {
  override readonly name = "ScopeError";
  constructor(
    readonly code: "rank" | "closed",
    message: string,
  ) {
    super(message);
  }
}

/** The error of a close that threw: it holds each error of each close of the scope and of its children. */
export class ScopeCloseError extends AggregateError {
  override readonly name = "ScopeCloseError";
}

/** This function makes the reason of an abort at the deadline. */
const timeoutReason = (scope: Scope): DOMException => new DOMException(`The deadline of the scope "${scope.name}" passed.`, "TimeoutError");

/** This function makes the reason of an abort at the close. */
const closedReason = (scope: Scope): DOMException => new DOMException(`The scope "${scope.name}" closed.`, "AbortError");

/** This function makes the reason of an abort without a reason. */
const abortReason = (scope: Scope): DOMException => new DOMException(`The scope "${scope.name}" was aborted.`, "AbortError");

/** This pattern is a whole number of milliseconds: at most 15 digits, thus the value is exact. */
const MILLISECONDS = /^\d{1,15}$/;

/** This function reads the header `timeout-ms`: the time in milliseconds, or `undefined` when it is absent or not a whole number. */
export const readTimeout = (headers: IncomingHeaders | undefined): number | undefined => {
  const raw = headers?.[TIMEOUT_HEADER];
  const value = typeof raw === "string" ? raw : raw?.[0];
  return value !== undefined && MILLISECONDS.test(value.trim()) ? Number(value.trim()) : undefined;
};

/**
 * This function gives the headers of an outgoing request: the remaining time of the scope, rounded down to a
 * whole millisecond. The time is not an instant, thus a skew of the clocks of two hosts cannot make the
 * deadline later. A scope without a deadline gives no header.
 */
export const timeoutHeaders = (scope: Pick<Scope, "deadline" | "remaining">): Record<string, string> =>
  Number.isFinite(scope.deadline) ? { [TIMEOUT_HEADER]: String(Math.floor(scope.remaining())) } : {};

/** This function checks the rank of a child. */
const rankOk = (parent: ScopeKind, child: ScopeKind): boolean => SCOPE_RANK[child] > SCOPE_RANK[parent] || (child === "call" && parent === "call");

/** The facts that a node takes at its start. */
interface Start {
  readonly kind: ScopeKind;
  readonly name: string;
  readonly parent: ScopeNode | null;
  readonly clock: Clock;
  readonly trace: unknown;
  readonly identity: Principal | undefined;
  /** This time is the own deadline of the node, before the meet with the deadline of the parent. */
  readonly own: number;
  readonly bind: readonly ScopeBinding[];
}

/** The scope of the package. */
class ScopeNode implements Scope {
  readonly kind: ScopeKind;
  readonly name: string;
  readonly parent: ScopeNode | null;
  readonly clock: Clock;
  readonly trace: unknown;
  readonly identity: Principal | undefined;
  readonly deadline: number;
  readonly #controller = new AbortController();
  readonly #values = new Map<ScopeKey<unknown>, unknown>();
  /** The open children, in the order of their start. A child leaves the set at the end of its close. */
  readonly #open = new Set<ScopeNode>();
  readonly #closes: Array<() => void | PromiseLike<void>> = [];
  #timer: Cancel | undefined;
  #closed: Promise<void> | undefined;

  constructor(start: Start) {
    this.kind = start.kind;
    this.name = start.name;
    this.parent = start.parent;
    this.clock = start.clock;
    this.trace = start.trace;
    this.identity = start.identity;
    const parent = start.parent;
    const meet = DEADLINE.meet!;
    this.deadline = parent === null ? start.own : meet(parent.deadline, start.own);
    for (const { key, value } of start.bind) {
      if (key === (DEADLINE as ScopeKey<unknown>)) continue;
      const above = parent?.get(key);
      this.#values.set(key, key.meet !== undefined && above !== undefined ? key.meet(above, value) : value);
    }
    // a child of an aborted or closed parent starts aborted, and the parent does not keep it
    if (parent?.signal.aborted === true) this.#controller.abort(parent.signal.reason);
    else if (parent?.closed === true) this.#controller.abort(closedReason(parent));
    else this.#start(parent);
  }

  /** This function adds a live child to its parent, and starts the timer of its deadline. */
  #start(parent: ScopeNode | null): void {
    if (parent !== null) parent.#open.add(this);
    // only a deadline earlier than the deadline of the parent needs a timer: the timer of the parent covers an equal one
    if (Number.isFinite(this.deadline) && (parent === null || this.deadline < parent.deadline)) {
      const wait = this.deadline - this.clock.now();
      if (wait <= 0) this.abort(timeoutReason(this));
      else {
        this.#timer = this.clock.after(wait, () => this.abort(timeoutReason(this)));
        // the work holds the process, not its deadline
        this.#timer.unref?.();
      }
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  get<T>(key: ScopeKey<T>): T | undefined {
    if (key === (DEADLINE as ScopeKey<unknown>)) return this.deadline as T;
    for (let scope: ScopeNode | null = this; scope !== null; scope = scope.parent)
      if (scope.#values.has(key as ScopeKey<unknown>)) return scope.#values.get(key as ScopeKey<unknown>) as T;
    return undefined;
  }

  remaining(): number {
    return Number.isFinite(this.deadline) ? Math.max(0, this.deadline - this.clock.now()) : Infinity;
  }

  children(): readonly Scope[] {
    return [...this.#open];
  }

  child(kind: ScopeKind, name: string, options: ChildOptions = {}): Scope {
    this.#rank(kind, name);
    return new ScopeNode({ kind, name, parent: this, clock: this.clock, trace: this.trace, identity: this.identity, own: this.#own(options, undefined), bind: options.bind ?? [] });
  }

  entry(kind: EntryKind, name: string, options: EntryOptions): Scope {
    if (kind !== "request" && kind !== "job" && kind !== "round") throw new ScopeError("rank", `An entry is a request, a job or a round, not a ${String(kind)}.`);
    this.#rank(kind, name);
    return new ScopeNode({
      kind,
      name,
      parent: this,
      clock: this.clock,
      trace: options.trace,
      identity: options.identity,
      own: this.#own(options, readTimeout(options.headers)),
      bind: options.bind ?? [],
    });
  }

  defer(close: () => void | PromiseLike<void>): void {
    if (this.closed) throw new ScopeError("closed", `The scope "${this.name}" is closed, thus it takes no resource.`);
    this.#closes.push(close);
  }

  async use<T>(open: () => T | PromiseLike<T>, close: (value: T) => void | PromiseLike<void>): Promise<T> {
    if (this.closed) throw new ScopeError("closed", `The scope "${this.name}" is closed, thus it takes no resource.`);
    const value = await open();
    // the scope closed during the open: the resource closes at once, and the caller gets the error
    if (this.closed) {
      await close(value);
      throw new ScopeError("closed", `The scope "${this.name}" closed during the open of a resource.`);
    }
    this.#closes.push(() => close(value));
    return value;
  }

  abort(reason: unknown = abortReason(this)): void {
    if (this.signal.aborted) return;
    this.#timer?.();
    this.#timer = undefined;
    this.#controller.abort(reason);
    for (const child of [...this.#open]) child.abort(reason);
  }

  close(): Promise<void> {
    this.#closed ??= this.#close();
    return this.#closed;
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    const children = [...this.#open].reverse();
    const reason = closedReason(this);
    for (const child of children) child.abort(reason);
    for (const child of children) await child.close().catch((error: unknown) => void errors.push(...(error instanceof ScopeCloseError ? error.errors : [error])));
    for (let at = this.#closes.length - 1; at >= 0; at -= 1) {
      try {
        await this.#closes[at]!();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#closes.length = 0;
    this.#timer?.();
    this.#timer = undefined;
    if (!this.signal.aborted) this.#controller.abort(reason);
    if (this.parent !== null) this.parent.#open.delete(this);
    if (errors.length > 0) throw new ScopeCloseError(errors, `${errors.length} close(s) of the scope "${this.name}" threw.`);
  }

  /** This function throws for a child of a wrong rank. */
  #rank(kind: ScopeKind, name: string): void {
    if (!rankOk(this.kind, kind)) throw new ScopeError("rank", `A ${kind} ("${name}") cannot be a child of a ${this.kind} ("${this.name}").`);
  }

  /** This function gives the own deadline of a child: the earliest of its timeout, the time of its header and its bound deadline. */
  #own(options: ChildOptions, header: number | undefined): number {
    const now = this.clock.now();
    let own = Infinity;
    if (options.timeout !== undefined) own = Math.min(own, now + Math.max(0, options.timeout));
    if (header !== undefined) own = Math.min(own, now + header);
    for (const { key, value } of options.bind ?? []) if (key === (DEADLINE as ScopeKey<unknown>)) own = Math.min(own, value as number);
    return own;
  }
}

/** This function makes the root of a tree of scopes: a `process` scope, or a `service` scope. */
export const rootScope = (options: RootOptions): Scope => {
  const clock = options.clock ?? realClock;
  const now = clock.now();
  let own = options.timeout === undefined ? Infinity : now + Math.max(0, options.timeout);
  for (const { key, value } of options.bind ?? []) if (key === (DEADLINE as ScopeKey<unknown>)) own = Math.min(own, value as number);
  return new ScopeNode({ kind: options.kind ?? "process", name: options.name, parent: null, clock, trace: options.trace, identity: options.identity, own, bind: options.bind ?? [] });
};
