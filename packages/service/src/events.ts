/**
 * A machine name names one machine of the runtime. Each machine has a document in `machines.ts`,
 * which names the same states and events.
 */
export type MachineName = "gate" | "latch" | "window" | "poller" | "drain" | "exit" | "watchdog";

/**
 * A lifecycle event is one transition of one machine of the runtime, on the monotonic clock. The
 * runtime stamps each planned event: the gate, each phase of the drain, and the exit. Thus a
 * window that a measurement times starts at the event.
 */
export interface LifecycleEvent {
  /** This time is when the transition occurred, in milliseconds on the monotonic clock. */
  readonly at: number;
  readonly machine: MachineName;
  /** This name identifies one machine among others of its kind: a check, or the service. */
  readonly instance: string;
  readonly from: string;
  readonly to: string;
  readonly on: string;
  /** This text gives more about the event, for example the cause of a failure. */
  readonly detail?: string | undefined;
}

/** A recorder receives each lifecycle event. */
export type Recorder = (event: LifecycleEvent) => void;
