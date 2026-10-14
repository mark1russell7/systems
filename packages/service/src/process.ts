/** An exit signal is a signal that asks the process to stop: each one starts the shutdown. */
export type ExitSignal = "SIGINT" | "SIGTERM" | "SIGQUIT";

/** These are the signals that the runtime handles. */
export const EXIT_SIGNALS: readonly ExitSignal[] = ["SIGINT", "SIGTERM", "SIGQUIT"];

/**
 * A process port is the part of the process that the runtime uses: its exit signals and its exit.
 * The runtime owns the handlers, because Node as PID 1 without a handler ignores SIGTERM. Only the
 * runtime ends the process, and library code does not. A test gives a fake port, sends signals,
 * and reads the exit code.
 */
export interface ProcessPort {
  /** This method adds a handler for a signal, and gives the function that removes it. */
  on(signal: ExitSignal, handler: () => void): () => void;
  /** This method ends the process with a code: 0 after a clean shutdown, and 1 after an error. */
  exit(code: number): void;
}

interface NodeProcess {
  on(signal: string, handler: () => void): unknown;
  off(signal: string, handler: () => void): unknown;
  exit(code: number): never;
}

/** This port is the process of Node. */
export const nodeProcess: ProcessPort = {
  on(signal, handler) {
    const host = (globalThis as { process?: NodeProcess }).process;
    if (host === undefined) throw new Error("no process: give the runtime a process port");
    host.on(signal, handler);
    return () => {
      host.off(signal, handler);
    };
  },
  exit(code) {
    const host = (globalThis as { process?: NodeProcess }).process;
    if (host === undefined) throw new Error("no process: give the runtime a process port");
    host.exit(code);
  },
};
