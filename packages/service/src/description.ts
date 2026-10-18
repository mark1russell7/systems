import type { Extent, Quantity } from "@mark1russell7/quantity";
import type { Operation } from "./operation.ts";
import type { ExitSignal, ExitTrigger, MessageShape, ProcessTrigger } from "./process.ts";
import type { RoutePattern } from "./routes.ts";
import type { Poll, Timing } from "./timing.ts";

/**
 * This is the format of a service as data: what `describe()` exports, and nothing starts. The
 * timer algebra and the ordering law read it. Each timer has a unit. Each knob comes from the
 * declaration, because the runtime has no defaults. A bound that nobody gives is "no bound", not
 * zero.
 */
export const FORMAT = "mark1russell7.service/1";

/** A step is a step of a connection that a check examines. A check that skips a step cannot see a failure in it. */
export type Step =
  "dial" | "local-state" | "round-trip" | "checkout" | "progress" | "topology" | "latency";

/** A gate is the policy that the failures of a check count toward. */
export type Gate = "readiness" | "liveness";

/** A check is an active check: one signal, for one step of a connection. */
export interface Check {
  readonly name: string;
  /** This name is the dependency that it examines, or null when it reads the state of the process. */
  readonly dependency: string | null;
  readonly step: Step;
  /** This flag tells if it uses the connection of the application. A check on its own connection cannot see a failure of that connection. */
  readonly ownConnection: boolean;
  /** This gate is the policy that it controls, or null for a check that only reports. It has no default. */
  readonly gates: Gate | null;
  readonly poll: Poll;
}

/**
 * A dependency is something that the service uses, with its client. Its knobs have the names that
 * the ordering law uses: `request_timeout`, `connect_bound`, `driver_writeoff_time`,
 * `heartbeat_interval`, `client_retry_window`. Thus the law reads them without a translation.
 */
export interface Dependency {
  readonly name: string;
  /** This identifier is the component in the corpus (`systems.component.postgresql`), or null when the corpus does not have it. */
  readonly system: string | null;
  readonly knobs: Readonly<Record<string, Extent>>;
  /**
   * These are the operations that the service does with it, by name (`GET /v1/forecast`, `INCR`).
   * Each operation declares if it can go again. A dependency usually has the two kinds, thus a
   * dependency has no idempotency of its own. An operation without a declaration does not go again.
   */
  readonly operations: Readonly<Record<string, Operation>>;
}

/**
 * A transport is something that takes work in: a server, a consumer or a worker. Each is a
 * component with a state machine. The service is ready only while each transport takes work.
 */
export interface Transport {
  readonly name: string;
  readonly kind: "server" | "consumer" | "worker";
  /** These are its knobs, with the names of the law where the law has them: the `server_idle_close` of a server. */
  readonly knobs: Readonly<Record<string, Extent>>;
}

/**
 * A controller is a group of routes. It is ready only while the dependencies that it needs are
 * ready. Each route declares if its callers can send it again. When the shutdown stops a request,
 * an idempotent route answers 503, which a caller can retry. Other routes answer 500.
 */
export interface Controller {
  readonly name: string;
  readonly requires: readonly string[];
  readonly routes: Readonly<Record<string, Operation>>;
  /**
   * These patterns match the routes that `routes` does not name, in their sequence: the first
   * pattern that matches a route gives its operations. Without a declaration, the controller has
   * no patterns.
   */
  readonly patterns?: readonly RoutePattern[] | undefined;
}

/** A coupling is a declared edge between two policies. The algebra checks its margin. */
export interface Coupling {
  readonly from: Gate;
  readonly to: Gate;
  readonly effect: "fails";
}

/** A phase is one step of the shutdown sequence, with a cap. Its owner adds it. */
export interface Phase {
  readonly name: string;
  readonly cap: Quantity;
}

/**
 * A repeat signal policy tells what an exit signal does while the shutdown runs:
 * - `ignore`: the signal has no effect, and the shutdown continues.
 * - `exit`: the process exits with the code 1 at once, as a second Ctrl-C does in a terminal.
 */
export type RepeatSignal = "ignore" | "exit";

/**
 * A cooperative floor is the earliest time of the cooperative abort in the drain:
 * - `half`: half the cap of the drain. The work in flight gets half the drain at the least.
 * - `none`: no floor. A window of the whole cap or more aborts the work at the start of the drain.
 */
export type CooperativeFloor = "half" | "none";

/** These exit codes replace the code 0 of a clean shutdown, by the trigger of the shutdown. */
export type ExitCodes = Readonly<Partial<Record<ExitTrigger, number>>>;

/**
 * A message trigger is a message of the IPC channel that starts the shutdown, for the trigger
 * `ipc-message`. With `as`, the message is that exit signal: it has its exit code and the policy of a
 * repeat signal. Without `as`, the message is the trigger `ipc-message`.
 */
export interface MessageTrigger {
  /** This shape is the message that starts the shutdown, for example `"shutdown"`. */
  readonly match: MessageShape;
  /** This signal is the exit signal that the message replaces, for example `SIGTERM` on Windows. */
  readonly as?: ExitSignal | undefined;
}

/** A service description is the whole graph of a service, as data. */
export interface ServiceDescription {
  readonly format: typeof FORMAT;
  readonly name: string;
  /** This flag tells if a part joined after the start. That part starts tripped, and the export is partial. */
  readonly partial: boolean;
  readonly transports: readonly Transport[];
  readonly dependencies: readonly Dependency[];
  readonly controllers: readonly Controller[];
  readonly checks: readonly Check[];
  readonly policies: {
    readonly readiness: Timing;
    readonly liveness: Timing;
    /** This duration is how long the service can take to start. The startup probe must agree with it. */
    readonly startup: Quantity;
  };
  readonly couplings: readonly Coupling[];
  readonly shutdown: {
    readonly phases: readonly Phase[];
    /** This window is how long before the end of the drain the cooperative abort occurs, or no bound. */
    readonly cooperativeWindow: Extent;
    /** This floor is the earliest time of the cooperative abort. Without a declaration, the floor is `half`. */
    readonly cooperativeFloor?: CooperativeFloor | undefined;
    /** This policy tells what a signal does while the shutdown runs. Each declaration gives it, because the runtime has no defaults. */
    readonly onRepeatSignal: RepeatSignal;
    /** These triggers start the shutdown, in addition to the exit signals. Each one is opt-in. */
    readonly triggers?: readonly ProcessTrigger[] | undefined;
    /** These messages of the IPC channel start the shutdown. The trigger `ipc-message` needs one at the least. */
    readonly messages?: readonly MessageTrigger[] | undefined;
    /** These codes replace the exit code 0 by the trigger. Without a code, a clean shutdown exits 0. */
    readonly exitCodes?: ExitCodes | undefined;
  };
}
