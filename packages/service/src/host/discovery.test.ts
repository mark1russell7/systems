import { describe, expect, it } from "vitest";
import { testLogger } from "../testing.ts";
import { discoveryOf, parseDiscovery, readDiscovery, removeDiscovery, writeDiscovery } from "./discovery.ts";
import { fakeHost } from "./fakes.ts";

const PATH = "/state/demo.json";
const WALL = 1_000_000_000_000;
const ISO = new Date(WALL).toISOString();

describe("the discovery file", () => {
  it("writes the record of the host process, and reads it as running", async () => {
    const host = fakeHost();
    const record = discoveryOf({ port: 8080, url: "http://127.0.0.1:8080/", extra: { version: "1.2.3" } }, host.ports);
    expect(record).toEqual({ pid: 100, startedAt: ISO, port: 8080, url: "http://127.0.0.1:8080/", extra: { version: "1.2.3" } });
    await writeDiscovery(PATH, record, host.ports);
    expect(host.text(PATH)).toBe(`{
  "pid": 100,
  "startedAt": "${ISO}",
  "port": 8080,
  "url": "http://127.0.0.1:8080/",
  "extra": {
    "version": "1.2.3"
  }
}
`);
    expect(await readDiscovery(PATH, host.ports)).toEqual({ kind: "running", record });
  });

  it("gives absent without a file", async () => {
    expect(await readDiscovery(PATH, fakeHost().ports)).toEqual({ kind: "absent" });
  });

  it("gives stale for a process that stopped, and removes the file only with clean", async () => {
    const logger = testLogger();
    const host = fakeHost({ files: { [PATH]: JSON.stringify({ pid: 555, startedAt: ISO, port: null, url: null }) }, logger });
    const stale = { kind: "stale", record: { pid: 555, startedAt: ISO, port: null, url: null }, why: "the process 555 stopped" };
    expect(await readDiscovery(PATH, host.ports)).toEqual(stale);
    expect(host.text(PATH)).not.toBeNull();
    expect(await readDiscovery(PATH, host.ports, { clean: true })).toEqual(stale);
    expect(host.text(PATH)).toBeNull();
    expect(logger.messages("info")).toEqual([`the host removed the stale discovery file ${PATH}`]);
  });

  it("gives stale for a new process with the same ID", async () => {
    const host = fakeHost({ files: { [PATH]: JSON.stringify({ pid: 555, startedAt: ISO }) } });
    host.processes.set(555, WALL + 60_000);
    const read = await readDiscovery(PATH, host.ports);
    expect(read.kind === "stale" && read.why).toBe("the process 555 started after the record, thus it is a different process");
  });

  it("gives malformed and not a throw for a bad file or a failed read", async () => {
    const cases: Array<[string, string]> = [
      ["{", "the file is not JSON: "],
      ["[]", "the file is not a JSON object"],
      ['{"pid":-3,"startedAt":"2026-10-28T00:00:00Z"}', "the field pid is not a process ID"],
      ['{"pid":3,"startedAt":"yesterday"}', "the field startedAt is not an ISO time"],
      ['{"pid":3,"startedAt":"2026-10-28T00:00:00Z","port":70000}', "the field port is not a port from 1 to 65535"],
      ['{"pid":3,"startedAt":"2026-10-28T00:00:00Z","url":5}', "the field url is not a text"],
      ['{"pid":3,"startedAt":"2026-10-28T00:00:00Z","extra":[]}', "the field extra is not an object"],
    ];
    for (const [text, problem] of cases) {
      const host = fakeHost({ files: { [PATH]: text } });
      const read = await readDiscovery(PATH, host.ports, { clean: true });
      expect(read.kind, text).toBe("malformed");
      expect(read.kind === "malformed" && read.problem.startsWith(problem), text).toBe(true);
      expect(host.text(PATH), text).toBeNull();
    }
    const broken = fakeHost();
    broken.failFiles = () => true;
    expect(await readDiscovery(PATH, broken.ports, { clean: true })).toEqual({ kind: "malformed", problem: `the read failed: the fake read of ${PATH} failed` });
  });

  it("reads a record leniently: a missing port and url are null", () => {
    expect(parseDiscovery('{"pid":3,"startedAt":"2026-10-28T00:00:00Z","more":1}')).toEqual({ pid: 3, startedAt: "2026-10-28T00:00:00Z", port: null, url: null });
  });

  it("removes the file only when it names the process", async () => {
    const host = fakeHost({ files: { [PATH]: JSON.stringify({ pid: 555, startedAt: ISO }) } });
    expect(await removeDiscovery(PATH, host.ports)).toBe(false);
    expect(host.text(PATH)).not.toBeNull();
    expect(await removeDiscovery(PATH, host.ports, 555)).toBe(true);
    expect(host.text(PATH)).toBeNull();
    expect(await removeDiscovery(PATH, host.ports, 555)).toBe(false);
  });
});
