import type { FakeClock } from "../fakes.ts";
import { fakeClock } from "../fakes.ts";
import type { Logger } from "../logger.ts";
import type { ChildHandle, CommandOptions, CommandResult, HostPorts, ProcessMark, SpawnRequest, StopSignal } from "./ports.ts";

/** A fake child is a child process of a fake host. A test ends it, or a stop ends it. */
export interface FakeChild extends ChildHandle {
  readonly request: SpawnRequest;
  /** These are the messages that went on its IPC channel. */
  readonly sent: readonly unknown[];
  /** This flag tells if the child ended. */
  readonly ended: boolean;
  /** This method ends the child with a code, or with a signal and a null code. A second use does nothing. */
  exit(code: number | null, signal?: string | null): void;
  /** This method sends data on the output of the child. */
  output(stream: "stdout" | "stderr", chunk: string | Uint8Array): void;
}

/** A recorded command is one command that went through the fake command port. */
export interface RecordedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: CommandOptions | undefined;
}

/** A recorded signal is one signal that went through the fake process port. */
export interface RecordedSignal {
  readonly pid: number;
  readonly signal: StopSignal;
  readonly group: boolean;
}

/** These options go with a fake host. */
export interface FakeHostOptions {
  /** This text is the platform. The default is `linux`. */
  readonly platform?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The default is `/home/test`. */
  readonly homeDir?: string | undefined;
  /** The default is `test`. */
  readonly user?: string | undefined;
  /** This record names the host process. The default is the ID 100, which started at the wall time 0. */
  readonly self?: ProcessMark | undefined;
  /** This time is the wall time at the clock time 0, in milliseconds after the epoch. The default is 1 000 000 000 000. */
  readonly wallStart?: number | undefined;
  /** These files are in the fake file system at the start. */
  readonly files?: Readonly<Record<string, string | Uint8Array>> | undefined;
  /**
   * This function gives the result of a command. When it gives undefined, the fake answers. `taskkill`
   * with `/F` ends the process and gives 0. `taskkill` without `/F` gives 1, or ends a polite child. Each other command gives 0.
   */
  readonly answer?: ((command: RecordedCommand) => CommandResult | undefined) | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * A fake host is the host ports of a test, and the state behind them. It starts no process, writes no
 * file and installs no task. Each effect is a record or a change of its state.
 */
export interface FakeHost {
  readonly ports: HostPorts;
  readonly clock: FakeClock;
  /** These are the files of the fake file system. */
  readonly files: Map<string, string | Uint8Array>;
  readonly commands: RecordedCommand[];
  readonly signals: RecordedSignal[];
  readonly children: FakeChild[];
  /** This table holds each live process: its ID, and its start time or null. */
  readonly processes: Map<number, number | null>;
  /** This map gives the HTTP status of each address. An address that it does not have gives no answer. */
  readonly http: Map<string, number | null>;
  /** This set holds each `host:port` that takes a TCP connection. */
  readonly tcp: Set<string>;
  /** True makes each child end with the code 0 at a staged stop: SIGTERM, SIGINT, an IPC message or `taskkill` without `/F`. */
  polite: boolean;
  /** This function makes a file operation fail. It gets the name of the operation and the path. */
  failFiles: ((operation: string, path: string) => boolean) | null;
  /** This function makes a spawn fail, thus the child has no ID and ends. */
  failSpawn: ((request: SpawnRequest) => boolean) | null;
  /** This method gives the text of a file, or null. */
  text(path: string): string | null;
  /** This method lets the promises that are ready continue, without a move of the clock. */
  settle(): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === "string" ? encoder.encode(data) : data);

/** This function makes a fake host. Give its `ports` to the host functions in a test. */
export const fakeHost = (options: FakeHostOptions = {}): FakeHost => {
  const clock = fakeClock();
  const wallStart = options.wallStart ?? 1_000_000_000_000;
  const wall = (): number => wallStart + clock.now();
  const self = options.self ?? { pid: 100, startedAt: wallStart };
  const files = new Map<string, string | Uint8Array>(Object.entries(options.files ?? {}));
  const commands: RecordedCommand[] = [];
  const signals: RecordedSignal[] = [];
  const children: FakeChild[] = [];
  const processes = new Map<number, number | null>([[self.pid, self.startedAt]]);
  const live = new Map<number, FakeChild>();
  let nextPid = 1000;

  const check = (operation: string, path: string): void => {
    if (host.failFiles?.(operation, path) === true) throw new Error(`the fake ${operation} of ${path} failed`);
  };

  const politeStop = (pid: number): void => {
    const child = live.get(pid);
    if (host.polite && child !== undefined) queueMicrotask(() => child.exit(0));
  };
  const hardStop = (pid: number, signal: string | null): void => {
    const child = live.get(pid);
    if (child !== undefined) queueMicrotask(() => child.exit(null, signal));
    else processes.delete(pid);
  };

  const spawn = (request: SpawnRequest): FakeChild => {
    const failed = host.failSpawn?.(request) === true;
    const pid = failed ? null : nextPid++;
    const outputs: Array<(stream: "stdout" | "stderr", chunk: string | Uint8Array) => void> = [];
    const exits: Array<(code: number | null, signal: string | null) => void> = [];
    const sent: unknown[] = [];
    let end: { code: number | null; signal: string | null } | null = null;
    const child: FakeChild = {
      request,
      pid,
      ipc: request.ipc,
      sent,
      get ended() {
        return end !== null;
      },
      onOutput(handler) {
        outputs.push(handler);
      },
      onExit(handler) {
        exits.push(handler);
        if (end !== null) handler(end.code, end.signal);
      },
      send(message) {
        if (!request.ipc || end !== null) return false;
        sent.push(message);
        if (pid !== null) politeStop(pid);
        return true;
      },
      exit(code, signal = null) {
        if (end !== null) return;
        end = { code, signal };
        if (pid !== null) {
          processes.delete(pid);
          live.delete(pid);
        }
        for (const handler of exits) handler(code, signal);
      },
      output(stream, chunk) {
        for (const handler of outputs) handler(stream, chunk);
      },
    };
    children.push(child);
    if (pid === null) queueMicrotask(() => child.exit(null));
    else {
      processes.set(pid, wall());
      live.set(pid, child);
    }
    return child;
  };

  const signal = (pid: number, sig: StopSignal, group: boolean): boolean => {
    if (!processes.has(pid)) return false;
    signals.push({ pid, signal: sig, group });
    if (sig === "SIGKILL") hardStop(pid, "SIGKILL");
    else politeStop(pid);
    return true;
  };

  const defaultAnswer = (command: RecordedCommand): CommandResult => {
    if (command.file !== "taskkill") return { code: 0, out: "" };
    const at = command.args.indexOf("/PID");
    const pid = Number(command.args[at + 1]);
    if (at < 0 || !processes.has(pid)) return { code: 128, out: `ERROR: The process "${command.args[at + 1] ?? ""}" not found.` };
    if (command.args.includes("/F")) {
      hardStop(pid, null);
      return { code: 0, out: `SUCCESS: The process with PID ${pid} has been terminated.` };
    }
    if (host.polite && live.has(pid)) {
      politeStop(pid);
      return { code: 0, out: `SUCCESS: Sent termination signal to the process with PID ${pid}.` };
    }
    return { code: 1, out: `ERROR: The process with PID ${pid} could not be terminated.` };
  };

  const ports: HostPorts = {
    platform: options.platform ?? "linux",
    commands: {
      async run(file, args, commandOptions) {
        const command: RecordedCommand = { file, args: [...args], options: commandOptions };
        commands.push(command);
        return options.answer?.(command) ?? defaultAnswer(command);
      },
    },
    files: {
      async read(path) {
        check("read", path);
        const data = files.get(path);
        return data === undefined ? null : typeof data === "string" ? data : decoder.decode(data);
      },
      async write(path, data) {
        check("write", path);
        files.set(path, data);
      },
      async create(path, data) {
        check("create", path);
        if (files.has(path)) return false;
        files.set(path, data);
        return true;
      },
      async append(path, data) {
        check("append", path);
        const before = files.get(path);
        if (before === undefined) files.set(path, data);
        else if (typeof before === "string" && typeof data === "string") files.set(path, before + data);
        else {
          const head = bytesOf(before);
          const tail = bytesOf(data);
          const joined = new Uint8Array(head.length + tail.length);
          joined.set(head, 0);
          joined.set(tail, head.length);
          files.set(path, joined);
        }
      },
      async size(path) {
        check("size", path);
        const data = files.get(path);
        return data === undefined ? null : bytesOf(data).length;
      },
      async rename(from, to) {
        check("rename", from);
        const data = files.get(from);
        if (data === undefined) throw new Error(`the fake file ${from} does not exist`);
        files.delete(from);
        files.set(to, data);
      },
      async remove(path) {
        check("remove", path);
        files.delete(path);
      },
    },
    processes: {
      alive: (pid) => processes.has(pid),
      startOf: async (pid) => processes.get(pid) ?? null,
      signal: (pid, sig) => signal(pid, sig, false),
      signalGroup: (pid, sig) => ports.platform !== "win32" && live.has(pid) && signal(pid, sig, true),
      spawn,
    },
    net: {
      httpStatus: async (url) => host.http.get(url) ?? null,
      tcpConnect: async (hostName, port) => host.tcp.has(`${hostName}:${port}`),
    },
    clock,
    wall,
    self,
    env: options.env ?? {},
    homeDir: options.homeDir ?? "/home/test",
    user: () => options.user ?? "test",
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };

  const host: FakeHost = {
    ports,
    clock,
    files,
    commands,
    signals,
    children,
    processes,
    http: new Map(),
    tcp: new Set(),
    polite: false,
    failFiles: null,
    failSpawn: null,
    text(path) {
      const data = files.get(path);
      return data === undefined ? null : typeof data === "string" ? data : decoder.decode(data);
    },
    async settle() {
      for (let turn = 0; turn < 2000; turn += 1) await Promise.resolve();
    },
  };
  return host;
};
