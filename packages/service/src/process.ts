/** An exit signal is a signal that asks the process to stop: each one starts the shutdown. */
export type ExitSignal = "SIGINT" | "SIGTERM" | "SIGQUIT";

/** These are the signals that the runtime handles. */
export const EXIT_SIGNALS: readonly ExitSignal[] = ["SIGINT", "SIGTERM", "SIGQUIT"];

/**
 * A process trigger is an event of the process, other than a signal, that starts the shutdown. A
 * declaration opts in to each one (`svc.trigger`):
 * - `stdin-close`: the standard input ends or closes, as when the parent of a stdio child goes away.
 *   The process must read its input, as a stdio transport does, or Node does not see the end.
 * - `ipc-close`: the IPC channel to the parent process closes.
 * - `ipc-message`: a message on the IPC channel matches a declared shape. Windows cannot give a
 *   child a SIGTERM that the child can catch, thus a parent sends a message.
 */
export type ProcessTrigger = "stdin-close" | "ipc-close" | "ipc-message";

/** These are the process triggers that a declaration can opt in to. */
export const PROCESS_TRIGGERS: readonly ProcessTrigger[] = ["stdin-close", "ipc-close", "ipc-message"];

/** An exit trigger is an event that starts the shutdown: an exit signal, or a declared process trigger. */
export type ExitTrigger = ExitSignal | ProcessTrigger;

/** This function tells if a number is an exit code of a process: a whole number from 0 to 255. */
export const isExitCode = (code: number): boolean => Number.isInteger(code) && code >= 0 && code <= 255;

/** This function tells if a trigger is an exit signal. A repeat signal obeys `onRepeatSignal`. */
export const isExitSignal = (trigger: string): trigger is ExitSignal =>
  (EXIT_SIGNALS as readonly string[]).includes(trigger);

/**
 * A message shape is a value of JSON that a message of the IPC channel can match. A string, a
 * number, a boolean or null matches an equal message. An object matches a message that has each of
 * its fields, and each value of the field matches. An array matches an array of the same length, item by item.
 */
export type MessageShape = string | number | boolean | null | readonly MessageShape[] | { readonly [field: string]: MessageShape };

/** This function tells if a value is a message shape: a value of JSON, with no function and no undefined. */
export const isMessageShape = (value: unknown): value is MessageShape => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isMessageShape);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isMessageShape);
};

/** This function tells if a message of the IPC channel matches a shape. */
export const matchesMessage = (shape: MessageShape, message: unknown): boolean => {
  if (shape === null || typeof shape !== "object") return Object.is(shape, message);
  if (Array.isArray(shape)) {
    const items: readonly MessageShape[] = shape;
    return Array.isArray(message) && message.length === items.length && items.every((item, at) => matchesMessage(item, message[at]));
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const fields = message as Readonly<Record<string, unknown>>;
  return Object.entries(shape).every(([field, value]) => Object.hasOwn(fields, field) && matchesMessage(value, fields[field]));
};

/**
 * A process port is the part of the process that the runtime uses: its exit triggers, its output
 * and its exit. The runtime owns the handlers, because Node as PID 1 without a handler ignores
 * SIGTERM. Only the runtime ends the process, and library code does not. A test gives a fake port,
 * sends triggers, and reads the exit code.
 */
export interface ProcessPort {
  /**
   * This method adds a handler for a trigger, and gives the function that removes it. The runtime
   * asks for a process trigger only when the declaration opts in to it. For `ipc-message`, the
   * handler gets each message of the IPC channel, and the runtime matches it.
   */
  on(trigger: ExitTrigger, handler: (message?: unknown) => void): () => void;
  /**
   * This method writes each buffered line of the output, and its promise ends when the output is
   * written. The stage `flush the output` uses it, in the cap of that stage.
   */
  flush?(): Promise<void> | void;
  /** This method ends the process with a code: the code of the exit request, 1 after an error, or 0. */
  exit(code: number): void;
}

/** A host stream is the part of a stream of Node that the port uses. */
export interface HostStream {
  readonly writable?: boolean;
  readonly destroyed?: boolean;
  readonly readableEnded?: boolean;
  write(chunk: string, done: (error?: unknown) => void): boolean;
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
}

/** A process host is the part of the process of Node that the port uses. Its event `message` gives the message of the IPC channel. */
export interface ProcessHost {
  on(signal: string, handler: (message?: unknown) => void): unknown;
  off(signal: string, handler: (message?: unknown) => void): unknown;
  exit(code: number): unknown;
  readonly stdin?: HostStream | undefined;
  readonly stdout?: HostStream | undefined;
  readonly stderr?: HostStream | undefined;
}

/** This function adds a handler to some events of an emitter. The handler operates one time at most. */
const once = (emitter: HostStream | ProcessHost, events: readonly string[], handler: () => void): (() => void) => {
  let called = false;
  const fire = (): void => {
    if (called) return;
    called = true;
    handler();
  };
  for (const event of events) emitter.on(event, fire);
  return () => {
    for (const event of events) emitter.off(event, fire);
  };
};

/** This function gives a promise that ends when the data before it in a stream is written. */
const written = (stream: HostStream | undefined): Promise<void> =>
  new Promise<void>((resolve) => {
    if (stream === undefined || stream.destroyed === true || stream.writable === false) {
      resolve();
      return;
    }
    try {
      // the callback of an empty write comes after each write before it
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });

/**
 * This function makes a process port on a host. `find` gives the host at each use, or undefined
 * when the platform has no process. Then the use throws.
 */
export const processPortOf = (find: () => ProcessHost | undefined): ProcessPort => {
  const hostProcess = (): ProcessHost => {
    const host = find();
    if (host === undefined) throw new Error("no process: give the runtime a process port");
    return host;
  };
  return {
    on(trigger, handler) {
      const host = hostProcess();
      if (trigger === "stdin-close") {
        const input = host.stdin;
        if (input === undefined) return () => {};
        // an input that ended before the handler was added still starts the shutdown
        if (input.readableEnded === true) {
          let live = true;
          queueMicrotask(() => {
            if (live) handler();
          });
          return () => {
            live = false;
          };
        }
        return once(input, ["end", "close"], handler);
      }
      if (trigger === "ipc-close") return once(host, ["disconnect"], handler);
      if (trigger === "ipc-message") {
        // each message goes to the runtime, which matches it with the declared shapes
        const receive = (message?: unknown): void => handler(message);
        host.on("message", receive);
        return () => {
          host.off("message", receive);
        };
      }
      host.on(trigger, handler);
      return () => {
        host.off(trigger, handler);
      };
    },
    async flush() {
      const host = hostProcess();
      await Promise.all([written(host.stdout), written(host.stderr)]);
    },
    exit(code) {
      hostProcess().exit(code);
    },
  };
};

/** This port is the process of Node. */
export const nodeProcess: ProcessPort = processPortOf(() => (globalThis as { process?: ProcessHost }).process);
