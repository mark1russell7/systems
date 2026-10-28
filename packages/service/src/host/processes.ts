import type { HostPorts, ProcessMark } from "./ports.ts";

/**
 * This margin is the time after a recorded start in which a process can start and still be the same
 * process, in milliseconds. A start time on Linux comes in ticks of 10 ms, and a step of the wall clock moves a time.
 */
export const START_MARGIN_MS = 1000;

/**
 * This function tells if the process of a mark is alive and is the same process. Windows and Linux
 * use a process ID again after a process stops. Thus a live process that started after the mark is a
 * different process. A start time that the system does not give proves nothing, and the process counts as the same.
 */
export const sameProcess = async (mark: ProcessMark, ports: HostPorts): Promise<boolean> => {
  if (!Number.isInteger(mark.pid) || mark.pid <= 0) return false;
  if (mark.pid === ports.self.pid) return Math.abs(mark.startedAt - ports.self.startedAt) <= START_MARGIN_MS;
  if (!ports.processes.alive(mark.pid)) return false;
  let started: number | null;
  try {
    started = await ports.processes.startOf(mark.pid);
  } catch {
    started = null;
  }
  return started === null || started <= mark.startedAt + START_MARGIN_MS;
};

/**
 * A tree stop outcome tells what a tree stop did.
 * - `stopped`: the stop went to the process and to each process under it.
 * - `absent`: no process with the ID was alive.
 * - `failed`: the process is alive and the stop did not go. The problem tells why.
 */
export type TreeStopOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly problem: string };

/**
 * This function stops a process and each process under it, by its ID only. It does not find a process by
 * its name or its command line. On Windows, it starts `taskkill /T /F /PID <pid>`. On Linux, it sends
 * SIGKILL to the process group of the ID, or to the process when it leads no group. It does not throw.
 */
export const stopTree = async (pid: number, ports: HostPorts): Promise<TreeStopOutcome> => {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "failed", problem: `${pid} is not a process ID` };
  if (pid === ports.self.pid) return { kind: "failed", problem: "the host does not stop its own process" };
  if (!ports.processes.alive(pid)) return { kind: "absent" };
  if (ports.platform === "win32") {
    const result = await ports.commands
      .run("taskkill", ["/T", "/F", "/PID", String(pid)])
      .catch((error: unknown) => ({ code: 127, out: error instanceof Error ? error.message : String(error) }));
    if (result.code === 0 || !ports.processes.alive(pid)) return { kind: "stopped" };
    return { kind: "failed", problem: `taskkill gave the code ${result.code}: ${result.out}` };
  }
  if (ports.processes.signalGroup(pid, "SIGKILL") || ports.processes.signal(pid, "SIGKILL")) return { kind: "stopped" };
  return ports.processes.alive(pid) ? { kind: "failed", problem: `the signal SIGKILL did not go to the process ${pid}` } : { kind: "absent" };
};
