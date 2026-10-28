import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";

/** These options go with one command: the folder that it runs in, and the most time that it can take. */
export interface CommandOptions {
  readonly cwd?: string | undefined;
  /** This time is the most that the command can take, in milliseconds. After it, the command stops, and its code is 124. */
  readonly timeout?: number | undefined;
}

/** A command result is the exit code of a command and the text that it wrote to its output and its error output. */
export interface CommandResult {
  /** This code is the exit code. A program that is not found gives 127, and a command at its timeout gives 124. */
  readonly code: number;
  readonly out: string;
}

/**
 * A command port starts a program with a list of arguments and gives its result. It does not use a
 * shell, thus no argument needs a quote. The host uses it for `schtasks`, `systemctl` and `taskkill`.
 */
export interface CommandPort {
  run(file: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

/** A file port is the part of a file system that the host uses. Each path is a full path. */
export interface FilePort {
  /** This method gives the text of a file in UTF-8, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  /** This method writes a file. It makes the folders of the path, and it replaces the file in one step. */
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** This method makes a file only when no file has the path, and tells if it made it. It makes the folders of the path. */
  create(path: string, data: string): Promise<boolean>;
  /** This method adds data at the end of a file. It makes the file and its folders when they do not exist. */
  append(path: string, data: string | Uint8Array): Promise<void>;
  /** This method gives the size of a file in bytes, or null when the file does not exist. */
  size(path: string): Promise<number | null>;
  /** This method gives a file a new path. It replaces a file at the new path. */
  rename(from: string, to: string): Promise<void>;
  /** This method removes a file. A file that does not exist is not an error. */
  remove(path: string): Promise<void>;
}

/** These are the signals that the host sends to a process. */
export type StopSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

/** A spawn request tells the program that a child process runs, with its arguments, its folder and its environment. */
export interface SpawnRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  /** True gives the child an IPC channel. Only a child that is a Node program can use it. */
  readonly ipc: boolean;
}

/** A child handle is a child process that the host started. */
export interface ChildHandle {
  /** This number is the process ID, or null when the program did not start. */
  readonly pid: number | null;
  /** This flag tells if the child has an IPC channel. */
  readonly ipc: boolean;
  /** This method adds a handler for each part of the output and of the error output of the child. */
  onOutput(handler: (stream: "stdout" | "stderr", chunk: string | Uint8Array) => void): void;
  /**
   * This method adds a handler for the end of the child. The handler gets the exit code, or null after
   * a signal, and the signal. A program that did not start also ends, with a null code.
   */
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** This method sends a message on the IPC channel, and tells if it went. */
  send(message: unknown): boolean;
}

/**
 * A process port is the part of the processes of the system that the host uses. It finds if a
 * process is alive, it gives its start time, it sends signals and it starts a child.
 */
export interface ProcessesPort {
  /** This method tells if a process with this ID is alive. A process of a different user is alive too. */
  alive(pid: number): boolean;
  /** This method gives the start time of a process, in milliseconds after the epoch, or null when the system does not tell. */
  startOf(pid: number): Promise<number | null>;
  /** This method sends a signal to one process, and tells if the signal went. */
  signal(pid: number, signal: StopSignal): boolean;
  /** This method sends a signal to the process group whose leader is `pid`, and tells if the signal went. Windows has no process groups. */
  signalGroup(pid: number, signal: StopSignal): boolean;
  /** This method starts a child process. On Linux, the child leads a new process group. */
  spawn(request: SpawnRequest): ChildHandle;
}

/** A net port does the network part of a readiness probe. */
export interface NetPort {
  /** This method sends a GET request, and gives the status of the answer, or null when no answer came in the timeout. */
  httpStatus(url: string, timeout: number): Promise<number | null>;
  /** This method tells if a TCP connection to the host and the port opens in the timeout, in milliseconds. */
  tcpConnect(host: string, port: number, timeout: number): Promise<boolean>;
}

/** This record names a process: its ID and its start time, in milliseconds after the epoch. */
export interface ProcessMark {
  readonly pid: number;
  readonly startedAt: number;
}

/**
 * The host ports are each effect of the system that the host uses. A test gives fakes (`fakeHost` of
 * `./testing`), thus a test installs no task and starts no process. `nodeHostPorts()` gives the ports of Node.
 */
export interface HostPorts {
  /** This text is the platform, as `process.platform` gives it, for example `win32` or `linux`. */
  readonly platform: string;
  readonly commands: CommandPort;
  readonly files: FilePort;
  readonly processes: ProcessesPort;
  readonly net: NetPort;
  /** This clock gives the monotonic time and the timers. */
  readonly clock: Clock;
  /** This function gives the wall time, in milliseconds after the epoch. */
  readonly wall: () => number;
  /** This record names the process of the host itself. */
  readonly self: ProcessMark;
  /** These are the environment variables of the host. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This text is the home folder of the user. */
  readonly homeDir: string;
  /** This function gives the user that a Windows task runs as, for example `HOST\name`. */
  readonly user: () => string;
  /** This logger gets the log entries of the host. Without it, the host writes no log. */
  readonly logger?: Logger | undefined;
}

/** This function joins the parts of a path with the separator of the platform. */
export const joinPath = (platform: string, ...parts: readonly string[]): string => {
  const separator = platform === "win32" ? "\\" : "/";
  const trimmed = parts.map((part, at) => (at === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")));
  return trimmed.filter((part, at) => at === 0 || part !== "").join(separator);
};
