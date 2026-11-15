import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ACCEPT_QUEUE_CELLS, BACKLOG_SERVICE, SERVICE_QUEUE_CELLS, synAckFiring, synAckWait, synGiveup, synWait, wheelOf } from "./accept-queue.ts";
import { ALL } from "./all.ts";
import { HZ } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";
import { countersIn, countIn, limitIn, localOf } from "../targets/service-backlog/proc.ts";

const seconds = (band: { readonly low: { value: number; unit: string }; readonly high: { value: number; unit: string } }) => [
  valueIn(band.low, "s"),
  valueIn(band.high, "s"),
];

describe("the cells of the accept queue", () => {
  it("joins the catalog, four counted runs and one cell at a time", () => {
    expect(ACCEPT_QUEUE_CELLS).toHaveLength(7);
    for (const cell of ACCEPT_QUEUE_CELLS) {
      expect(ALL.some((each) => each.name === cell.name)).toBe(true);
      expect(cell.name).toMatch(/^AQ[.]\d /);
      expect(cell.runs).toBe(4);
      expect(cell.concurrency).toBe(1);
      expect(cell.fault).toBe("none");
      expect(cell.targetSysctls).toHaveProperty("net.core.somaxconn");
      expect(cell.targetSysctls).toHaveProperty("net.ipv4.tcp_abort_on_overflow");
    }
  });

  it("predicts the limit plus one in each cell of the count", () => {
    for (const cell of ACCEPT_QUEUE_CELLS.slice(0, 3)) {
      const { prediction } = cell;
      if (prediction.detects !== null || prediction.queue === undefined) throw new Error(`${cell.name} has no law`);
      expect(prediction.queue.held).toBe(prediction.queue.max + 1);
      expect(prediction.queue.connected).toBe(prediction.queue.max + 1);
    }
  });

  it("gives the ladder of the SYN from the document of Linux TCP", () => {
    const waits = Array.from({ length: 10 }, (_, k) => valueIn(synWait(k).low, "s"));
    expect(waits.map(Math.round)).toEqual([1, 1, 1, 1, 1, 2, 4, 8, 16, 32]);
    expect(Math.round(valueIn(synGiveup().low, "s"))).toBe(131);
  });

  it("gives the ladder of the SYN-ACK: 1 s doubled, and the expiry after six waits", () => {
    const [firstLow, firstHigh] = seconds(synAckWait(0));
    expect(firstLow).toBeLessThan(1.02);
    expect(firstHigh).toBeGreaterThan(1.02);
    const [low, high] = seconds(synAckWait(4));
    expect(low).toBeLessThan(16);
    expect(high).toBeCloseTo(16 + wheelOf(16) + 0.01, 6);
    const [earliest, latest] = seconds(synAckFiring(6));
    expect(earliest).toBeLessThan(63);
    expect(latest).toBeGreaterThan(63);
    expect(latest).toBeLessThan(HZ === 1000 ? 64.8 : 75);
  });

  it("sends the late segment after the latest expiry", () => {
    const [, latest] = seconds(synAckFiring(6));
    const cell = ACCEPT_QUEUE_CELLS.find((each) => each.name.startsWith("AQ.5"));
    const client = cell?.client;
    if (typeof client !== "object") throw new Error("AQ.5 has no client image");
    const flags = client.command;
    expect(Number(flags[flags.indexOf("--late-ms") + 1]) / 1000).toBeGreaterThan(latest!);
  });

  it("gives the laws of AQ.1 to AQ.3 to a server of the service, and a declared 0 is the 511 of Node (SYS-103)", () => {
    expect(SERVICE_QUEUE_CELLS.map((cell) => cell.name.split(" ")[0])).toEqual(["AQ.8", "AQ.9", "AQ.10"]);
    for (const [at, cell] of SERVICE_QUEUE_CELLS.entries()) {
      const native = ACCEPT_QUEUE_CELLS[at]!;
      expect(ALL.some((each) => each.name === cell.name)).toBe(true);
      expect(cell.name).toMatch(/^AQ[.]\d+ the count of service 0[.]7: /);
      expect(cell.target.subject).toMatchObject({ kind: "build", name: "service-backlog" });
      expect(cell.target.command).toEqual(["node", "/srv/server.ts", "--port", "6390"]);
      // the client, the sysctls and the backlog are those of the native cell. AQ.10 has a limit of 511, thus it makes 514 connects
      const command = (each: typeof cell): readonly string[] => (typeof each.client === "object" ? each.client.command : []);
      expect(command(cell).slice(0, -1)).toEqual(command(native).slice(0, -1));
      expect(command(cell).at(-1)).toBe(at === 2 ? "514" : command(native).at(-1));
      expect(cell.targetSysctls).toEqual(native.targetSysctls);
    }
    const zero = SERVICE_QUEUE_CELLS[2]!.prediction;
    if (zero.detects !== null || zero.queue === undefined) throw new Error("AQ.10 has no law");
    expect([zero.queue.max, zero.queue.held, zero.queue.overflows.low, zero.queue.overflows.high]).toEqual([511, 512, 2, 2]);
  });

  it("pins the target of the service: the image of Node, the version of ss, and the service in the lockfile", () => {
    const subject = SERVICE_QUEUE_CELLS[0]!.target.subject as { context: string; files: readonly string[] };
    for (const file of subject.files) expect(existsSync(join(subject.context, file)), file).toBe(true);
    const docker = readFileSync(join(subject.context, "Dockerfile"), "utf8");
    expect(docker.split(/\r?\n/)).toContain(`FROM ${NODE_IMAGE}`);
    expect(docker).toMatch(/^RUN apk add --no-cache iproute2-ss=\d+[.]\d+[.]\d+-r\d+$/m);
    const manifest = JSON.parse(readFileSync(join(subject.context, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@mark1russell7/service"]).toBe(BACKLOG_SERVICE);
    const lock = JSON.parse(readFileSync(join(subject.context, "npm-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/@mark1russell7/service"]?.version).toBe(BACKLOG_SERVICE);
  });

  it("reads the count, the limit and the counters of the target of the service from the text of the kernel", () => {
    // /proc/net/tcp: the queues are tx_queue:rx_queue, and the rx_queue of a listener is its count
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:18F7 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 101 1 0 100 0 0 10 0",
      "   1: 00000000:18F6 00000000:0000 0A 00000000:00000005 00:00000000 00000000     0        0 102 1 0 100 0 0 10 0",
      "   2: 0100007F:18F6 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 103 1 0 20 4 30 10 -1",
    ].join("\n");
    expect(localOf(6390)).toBe("00000000:18F6");
    expect(countIn(tcp, 6390)).toBe(5);
    expect(countIn(tcp, 6392)).toBeUndefined();
    // ss -Hltn: Recv-Q is the count, Send-Q is the limit
    expect(limitIn("LISTEN 5      511    0.0.0.0:6390      0.0.0.0:*\n")).toBe(511);
    expect(limitIn("")).toBeUndefined();
    const netstat = [
      "TcpExt: SyncookiesSent EmbryonicRsts TCPTimeouts ListenOverflows ListenDrops TCPReqQFullDoCookies",
      "TcpExt: 0 1 12 2 3 0",
      "IpExt: InNoRoutes InTruncatedPkts",
      "IpExt: 0 0",
    ].join("\n");
    expect(countersIn(netstat)).toEqual({ overflows: 2, drops: 3, cookies: 0, timeouts: 12, resets: 1 });
  });
});