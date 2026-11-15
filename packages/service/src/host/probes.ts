import type { Quantity } from "@mark1russell7/quantity";
import { convertible, formatDuration, isQuantity, valueIn } from "@mark1russell7/quantity";
import type { HostPorts } from "./ports.ts";

/**
 * A freshness bound reads one time in the JSON answer of an http probe. The time is epoch
 * milliseconds or an ISO 8601 text. The probe fails when the time is older than `within`, or when
 * the answer does not have it.
 */
export interface FreshnessBound {
  /** This JSON Pointer (RFC 6901) names the time in the answer, for example `/delivery/lastTestSendAt`. */
  readonly pointer: string;
  /** This time is the largest age that passes. */
  readonly within: Quantity;
}

/**
 * A ready probe tells when a program is ready.
 * - `http`: a GET request to the address gives the status, 200 by default. With `fresh`, the answer
 *   is also JSON, and each bound of `fresh` passes. The age of a time is measured from `now`: a
 *   JSON Pointer to the time of the target in the answer. Without `now`, the wall clock of the host
 *   gives the time.
 * - `tcp`: a TCP connection to the port opens. The default host is `127.0.0.1`.
 * - `command`: a command gives the exit code 0.
 */
export type ReadyProbe =
  | {
      readonly kind: "http";
      readonly url: string;
      readonly status?: number | undefined;
      readonly fresh?: readonly FreshnessBound[] | undefined;
      readonly now?: string | undefined;
    }
  | { readonly kind: "tcp"; readonly port: number; readonly host?: string | undefined }
  | { readonly kind: "command"; readonly program: string; readonly args: readonly string[]; readonly cwd?: string | undefined };

/** A probe result is the result of one use of a probe. A failure tells why. */
export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** This size is the largest answer that a probe with freshness bounds reads: 1 MiB. */
export const PROBE_BODY_LIMIT = 1_048_576;

const isPointer = (pointer: unknown): pointer is string =>
  typeof pointer === "string" && (pointer === "" || (pointer.startsWith("/") && !/~[^01]|~$/.test(pointer)));

/** This function gives the problems of a probe: each value that a probe cannot use. */
export const probeProblems = (probe: ReadyProbe): string[] => {
  if (probe.kind === "http") {
    const problems: string[] = [];
    if (!/^https?:\/\//.test(probe.url)) problems.push(`the address ${JSON.stringify(probe.url)} is not an http or https address`);
    if (probe.status !== undefined && !(Number.isInteger(probe.status) && probe.status >= 100 && probe.status <= 599))
      problems.push(`the status ${probe.status} is not an HTTP status`);
    if (probe.now !== undefined && !isPointer(probe.now)) problems.push(`the now ${JSON.stringify(probe.now)} is not a JSON Pointer`);
    if (probe.now !== undefined && probe.fresh === undefined) problems.push("the probe has a now, but no fresh list");
    if (probe.fresh !== undefined && probe.fresh.length === 0) problems.push("the fresh list is empty");
    for (const bound of probe.fresh ?? []) {
      if (!isPointer(bound.pointer)) problems.push(`the freshness pointer ${JSON.stringify(bound.pointer)} is not a JSON Pointer`);
      if (!(isQuantity(bound.within) && convertible(bound.within.unit, "ms") && valueIn(bound.within, "ms") >= 0))
        problems.push(`the freshness bound of ${JSON.stringify(bound.pointer)} is not a time of zero or more`);
    }
    return problems;
  }
  if (probe.kind === "tcp")
    return Number.isInteger(probe.port) && probe.port >= 1 && probe.port <= 65_535 ? [] : [`the port ${probe.port} is not a port from 1 to 65535`];
  if (probe.kind === "command") return probe.program === "" ? ["the program of the command probe is empty"] : [];
  return [`the probe kind ${JSON.stringify((probe as { kind: unknown }).kind)} is not http, tcp or command`];
};

/** This function gives the value at a JSON Pointer (RFC 6901), or undefined when the document does not have it. */
const pointAt = (document: unknown, pointer: string): unknown => {
  if (pointer === "") return document;
  let at = document;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(at)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= at.length) return undefined;
      at = at[Number(key)];
    } else if (at !== null && typeof at === "object" && Object.hasOwn(at, key)) {
      at = (at as Record<string, unknown>)[key];
    } else return undefined;
  }
  return at;
};

/** This function gives the time of a value in epoch milliseconds: a finite number, or an ISO 8601 text. */
const timeOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
};

/** This function examines the JSON answer of an http probe against its freshness bounds. */
const freshness = (url: string, body: string, bounds: readonly FreshnessBound[], nowPointer: string | undefined, wall: number): ProbeResult => {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return { ok: false, why: `${url} did not give JSON` };
  }
  const now = nowPointer === undefined ? wall : timeOf(pointAt(document, nowPointer));
  if (now === null) return { ok: false, why: `${url} has no time at ${nowPointer}` };
  const stale: string[] = [];
  for (const bound of bounds) {
    const time = timeOf(pointAt(document, bound.pointer));
    if (time === null) {
      stale.push(`${bound.pointer} has no time`);
      continue;
    }
    const age = Math.max(0, now - time);
    if (age > valueIn(bound.within, "ms"))
      stale.push(`${bound.pointer} is ${formatDuration({ value: age, unit: "ms" })} old, above ${formatDuration(bound.within)}`);
  }
  return stale.length === 0 ? { ok: true } : { ok: false, why: `${url}: ${stale.join("; ")}` };
};

/** This function uses a probe one time, in a timeout of milliseconds. It does not throw. */
export const probeOnce = async (probe: ReadyProbe, timeout: number, ports: HostPorts): Promise<ProbeResult> => {
  try {
    if (probe.kind === "http") {
      const want = probe.status ?? 200;
      if (probe.fresh !== undefined) {
        if (ports.net.httpText === undefined) return { ok: false, why: "the net port cannot read an answer, thus it cannot examine freshness" };
        const answer = await ports.net.httpText(probe.url, timeout, PROBE_BODY_LIMIT);
        if (answer === null) return { ok: false, why: `${probe.url} gave no answer in ${timeout} ms` };
        if (answer.status !== want) return { ok: false, why: `${probe.url} gave ${answer.status}, not ${want}` };
        if (!answer.complete) return { ok: false, why: `the answer of ${probe.url} is above ${PROBE_BODY_LIMIT} bytes` };
        return freshness(probe.url, answer.body, probe.fresh, probe.now, ports.wall());
      }
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
