import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import faults from "./faults-2026-10-14.json";

const cell = (name: string) => {
  const found = faults.cells.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (name: string) => {
  const { verdict } = cell(name);
  return verdict.band === null ? null : [verdict.band.low, verdict.band.high];
};
const predicted = (name: string) => {
  const { prediction } = cell(name);
  return [prediction.low, prediction.high];
};
const median = (name: string) => cell(name).verdict.median;
const outcomes = (name: string) => [...new Set(cell(name).runs.map((run) => run.outcome))];

describe("the copy of the network-fault cells holds the figures of their runs", () => {
  it("has the 45 cells of T01: 39 hold, 6 are measurements, and none fails", () => {
    expect(faults.topology).toBe("T01");
    expect(faults.cells).toHaveLength(45);
    expect(faults.cells.filter((each) => each.verdict.decision === "holds")).toHaveLength(39);
    expect(faults.cells.filter((each) => each.verdict.decision === "measured")).toHaveLength(6);
    expect(faults.cells.filter((each) => each.prediction.kind === "measured")).toHaveLength(6);
    expect(faults.cells.filter((each) => !["holds", "measured"].includes(each.verdict.decision))).toEqual([]);
  });

  it("has 11 runs for each cell, and each run counted", () => {
    expect(faults.cells.every((each) => each.runs.length === 11)).toBe(true);
    expect(faults.cells.reduce((sum, each) => sum + each.verdict.counted, 0)).toBe(495);
    expect(faults.cells.filter((each) => each.verdict.voided > 0 || each.runs.some((run) => run.void !== null))).toEqual([]);
  });

  it("groups the cells by their manifestation and their position", () => {
    const count = (key: "manifestation" | "position", value: string) =>
      faults.cells.filter((each) => each[key] === value).length;
    expect(count("manifestation", "blackhole")).toBe(7);
    expect(count("manifestation", "unreachable-host")).toBe(7);
    expect(count("manifestation", "netem")).toBe(6);
    expect(count("manifestation", "stall")).toBe(5);
    expect(count("position", "client idle")).toBe(8);
    expect(count("position", "server reply in flight")).toBe(5);
  });

  it("gives up on a host unreachable in 3.07 s, where a black hole takes 6.32 s (RFC 6069)", () => {
    expect(band("client in flight, unreachable-host, tcp_retries2 = 3")).toEqual([2.996, 3.272]);
    expect(predicted("client in flight, unreachable-host, tcp_retries2 = 3")).toEqual([3, 3.268]);
    expect(median("client in flight, unreachable-host, tcp_retries2 = 3")).toBe(3.067951);
    expect(median("client in flight, unreachable-net, tcp_retries2 = 3")).toBe(3.067951);
    expect(band("client in flight, blackhole, tcp_retries2 = 3")).toEqual([2.996, 6.62]);
    expect(predicted("client in flight, blackhole, tcp_retries2 = 3")).toEqual([3, 6.616]);
    expect(median("client in flight, blackhole, tcp_retries2 = 3")).toBe(6.320082);
    expect(median("client in flight, unreachable-host, tcp_retries2 = 5")).toBe(12.671953);
    expect(median("client in flight, blackhole, tcp_retries2 = 5")).toBe(12.920006);
  });

  it("ends each give-up with the errno of its ICMP, and an idle connection with ETIMEDOUT", () => {
    expect(outcomes("client in flight, unreachable-host, tcp_retries2 = 3")).toEqual(["EHOSTUNREACH"]);
    expect(outcomes("client in flight, unreachable-net, tcp_retries2 = 3")).toEqual(["ENETUNREACH"]);
    expect(outcomes("client in flight, unreachable-port, tcp_retries2 = 3")).toEqual(["ECONNREFUSED"]);
    expect(outcomes("client in flight, unreachable-admin, tcp_retries2 = 3")).toEqual(["EHOSTUNREACH"]);
    expect(median("client in flight, unreachable-port, tcp_retries2 = 3")).toBe(6.320128);
    for (const code of ["host", "net", "port", "admin"])
      expect(outcomes(`client idle, unreachable-${code}`)).toEqual(["ETIMEDOUT"]);
    expect(median("client idle, unreachable-host")).toBe(11.114431);
  });

  it("detects a FIN in 65 µs, and the latency moves the give-up", () => {
    expect(median("client idle, fin")).toBe(0.000065);
    expect(outcomes("client idle, fin")).toEqual(["EOF"]);
    expect(median("client in flight, blackhole, tcp_retries2 = 3, 20 ms latency")).toBe(3.224214);
    expect(median("client in flight, blackhole, tcp_retries2 = 3, 100 ms latency")).toBe(4.416115);
    expect(band("client in flight, blackhole, tcp_retries2 = 3, 100 ms latency")).toEqual([2.996, 8.444]);
  });

  it("gives the measurement-only cells no band, and keeps the replies of each run", () => {
    const measured = faults.cells.filter((each) => each.prediction.kind === "measured");
    expect(measured.map((each) => each.manifestation)).toEqual(Array(6).fill("netem"));
    expect(measured.every((each) => each.verdict.band === null && each.prediction.low === null)).toBe(true);
    expect(measured.every((each) => each.runs.every((run) => run.replies?.count === 100))).toBe(true);
    expect(median("client stream, netem loss 5%")).toBe(0.000226);
  });

  it("marks the 8 cells of the rerun, and the 2 whose first run failed", () => {
    expect(faults.cells.filter((each) => each.firstRun !== null)).toHaveLength(8);
    expect(faults.cells.filter((each) => each.firstRun === "fails").map((each) => each.name)).toEqual([
      "client in flight, a 1 s stall, 20 ms latency",
      "server, a long reply, mtu-blackhole, tcp_retries2 = 3",
    ]);
  });

  it("names no machine: no boot id, image digest, container, namespace inode, user or path", () => {
    const text = readFileSync(new URL("./faults-2026-10-14.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|cookie|container|docker|[0-9a-f]{12,}/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt)\/|AppData|WSL|microsoft/i);
  });
});
