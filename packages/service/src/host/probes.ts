import type { HostPorts } from "./ports.ts";

/**
 * A ready probe tells when a program is ready.
 * - `http`: a GET request to the address gives the status, 200 by default.
 * - `tcp`: a TCP connection to the port opens. The default host is `127.0.0.1`.
 * - `command`: a command gives the exit code 0.
 */
export type ReadyProbe =
  | { readonly kind: "http"; readonly url: string; readonly status?: number | undefined }
  | { readonly kind: "tcp"; readonly port: number; readonly host?: string | undefined }
  | { readonly kind: "command"; readonly program: string; readonly args: readonly string[]; readonly cwd?: string | undefined };

/** A probe result is the result of one use of a probe. A failure tells why. */
export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** This function gives the problems of a probe: each value that a probe cannot use. */
export const probeProblems = (probe: ReadyProbe): string[] => {
  if (probe.kind === "http") {
    const problems: string[] = [];
    if (!/^https?:\/\//.test(probe.url)) problems.push(`the address ${JSON.stringify(probe.url)} is not an http or https address`);
    if (probe.status !== undefined && !(Number.isInteger(probe.status) && probe.status >= 100 && probe.status <= 599))
      problems.push(`the status ${probe.status} is not an HTTP status`);
    return problems;
  }
  if (probe.kind === "tcp")
    return Number.isInteger(probe.port) && probe.port >= 1 && probe.port <= 65_535 ? [] : [`the port ${probe.port} is not a port from 1 to 65535`];
  if (probe.kind === "command") return probe.program === "" ? ["the program of the command probe is empty"] : [];
  return [`the probe kind ${JSON.stringify((probe as { kind: unknown }).kind)} is not http, tcp or command`];
};

/** This function uses a probe one time, in a timeout of milliseconds. It does not throw. */
export const probeOnce = async (probe: ReadyProbe, timeout: number, ports: HostPorts): Promise<ProbeResult> => {
  try {
    if (probe.kind === "http") {
      const want = probe.status ?? 200;
      const status = await ports.net.httpStatus(probe.url, timeout);
      if (status === want) return { ok: true };
      return { ok: false, why: status === null ? `${probe.url} gave no answer in ${timeout} ms` : `${probe.url} gave ${status}, not ${want}` };
    }
    if (probe.kind === "tcp") {
      const host = probe.host ?? "127.0.0.1";
      if (await ports.net.tcpConnect(host, probe.port, timeout)) return { ok: true };
      return { ok: false, why: `no TCP connection to ${host}:${probe.port} in ${timeout} ms` };
    }
    const result = await ports.commands.run(probe.program, probe.args, { cwd: probe.cwd, timeout });
    return result.code === 0 ? { ok: true } : { ok: false, why: `${probe.program} gave the code ${result.code}` };
  } catch (error) {
    return { ok: false, why: `the probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};
