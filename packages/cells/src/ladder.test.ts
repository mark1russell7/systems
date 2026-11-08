import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templated } from "@mark1russell7/harness";
import { RUNS } from "./catalog.ts";
import {
  LADDER_CELLS,
  REFERENCE_BUILD,
  REFERENCE_FILES,
  RUNGS,
  activeOf,
  decidingCount,
  durationOf,
  ladderStreams,
  procedureRequest,
  referenceHop,
  tenantName,
  tenantRequests,
  tokenOf,
} from "./ladder.ts";

describe("the rungs of the ladder", () => {
  it("gives the Wilson count of each rung of SYS-93", () => {
    expect(RUNGS.map((rung) => decidingCount(1 - rung.availability))).toEqual([381, 765, 3_838, 3_838]);
  });

  it("makes ten percent of the tenants active, and at least one", () => {
    expect(RUNGS.map(activeOf)).toEqual([1, 1, 10, 100]);
  });

  it("gives each rung enough arrivals in its counted runs to decide, and runs of 5 s at least", () => {
    for (const rung of RUNGS) {
      const arrivals = RUNS * activeOf(rung) * 10 * (durationOf(rung) / 1000);
      expect(arrivals).toBeGreaterThanOrEqual(decidingCount(1 - rung.availability));
      expect(durationOf(rung)).toBeGreaterThanOrEqual(5_000);
    }
    expect(RUNGS.map(durationOf)).toEqual([5_000, 7_000, 5_000, 5_000]);
  });

  it("gives one stream for each active tenant, each with its own seed, at 10 requests each second", () => {
    const streams = ladderStreams(RUNGS[2]!);
    expect(streams.map((stream) => stream.key)).toEqual(Array.from({ length: 10 }, (_, index) => tenantName(index)));
    expect(new Set(streams.map((stream) => JSON.stringify(stream.plan.options))).size).toBe(10);
    expect(streams[0]!.plan).toMatchObject({ profile: [{ ms: 5_000, from: 10, to: 10 }], options: { arrivals: "poisson" } });
  });

  it("has a cell for each rung, with the limit of its availability on the failed arrivals", () => {
    expect(LADDER_CELLS.map((cell) => cell.name.split(",")[0])).toEqual(["LADDER.1", "LADDER.10", "LADDER.100", "LADDER.1000"]);
    expect(LADDER_CELLS.map((cell) => (cell.prediction.detects === null ? cell.prediction.load?.failures : undefined))).toEqual([0.01, 0.005, 0.001, 0.001]);
    for (const cell of LADDER_CELLS) expect(cell).toMatchObject({ client: "load", probe: { mode: "schedule" }, fault: "none", targetSetup: [expect.any(Array)] });
  });
});

describe("the hop of the reference service", () => {
  it("builds from the reference package, with a lockfile beside the manifest", () => {
    expect(REFERENCE_BUILD).toMatchObject({ kind: "build", dockerfile: "image/Dockerfile" });
    expect(REFERENCE_BUILD.files).toEqual(expect.arrayContaining(["image/package.json", "image/npm-lock.json", "src/main.ts"]));
  });

  // the image copies named files: the cells of SYS-93 needed service.ts, which the first list did not have
  it("copies each source that main.ts imports, and the Dockerfile copies the same sources", () => {
    const sources = new Set<string>();
    const visit = (file: string) => {
      if (sources.has(file)) return;
      sources.add(file);
      const text = readFileSync(fileURLToPath(new URL(`../../reference/${file}`, import.meta.url)), "utf8");
      for (const match of text.matchAll(/from "\.\/([\w-]+\.ts)"/g)) visit(`src/${match[1]}`);
    };
    visit("src/main.ts");
    expect(REFERENCE_FILES.filter((file) => file.startsWith("src/")).sort()).toEqual([...sources].sort());
    const dockerfile = readFileSync(fileURLToPath(new URL("../../reference/image/Dockerfile", import.meta.url)), "utf8");
    const copied = /^COPY (src\/.+) \.\/src\/$/m.exec(dockerfile)?.[1]?.split(" ") ?? [];
    expect(copied.sort()).toEqual([...sources].sort());
  });

  it("writes the address of the replica set and each tenant of the rung into its files", () => {
    const hop = referenceHop(RUNGS[1]!);
    expect(templated(hop.files!["/srv/mongo.env"]!, "10.0.3.2:27017")).toBe("MONGO_HOST=10.0.3.2\nMONGO_PORT=27017\n");
    const tenants = JSON.parse(hop.files!["/srv/tenants.json"]!) as Record<string, string>;
    expect(Object.keys(tenants)).toHaveLength(10);
    expect(tenants[tokenOf("t0001")]).toBe("t0001");
  });

  it("frames each request with the length of its body in bytes", () => {
    const request = procedureRequest("doc/put", "token-t0001", { id: "d0", body: { name: "é" } });
    const [head, body] = request.split("\r\n\r\n");
    expect(head).toContain(`Content-Length: ${Buffer.byteLength(body!)}`);
    expect(Buffer.byteLength(body!)).toBe(body!.length + 1);
  });
});

/** This function gives a port that no process listens on. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** This function reads the responses of one socket: the status and the body of each, in order, after it writes the requests. */
const exchange = (port: number, requests: readonly string[]): Promise<Array<{ status: number; body: unknown }>> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let bytes = Buffer.alloc(0);
    const responses: Array<{ status: number; body: unknown }> = [];
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      for (;;) {
        const end = bytes.indexOf("\r\n\r\n");
        if (end < 0) break;
        const head = bytes.subarray(0, end).toString("latin1");
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? Number.NaN);
        if (!Number.isFinite(length)) return reject(new Error(`a response with no Content-Length: ${head}`));
        if (bytes.length < end + 4 + length) break;
        responses.push({ status: Number(head.split(" ")[1]), body: JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString("utf8")) });
        bytes = bytes.subarray(end + 4 + length);
      }
      if (responses.length === requests.length) {
        socket.end();
        resolve(responses);
      }
    });
    // the driver can send the next request before the reply of the last one, thus the test sends both at once
    socket.write(requests.join(""));
  });

describe("the requests of a tenant against the reference service", () => {
  const folder = mkdtempSync(join(tmpdir(), "ladder-"));
  let server: ChildProcess | undefined;
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    const tenants = join(folder, "tenants.json");
    writeFileSync(tenants, JSON.stringify({ [tokenOf("t0001")]: "t0001" }));
    // the image starts the same file in the same way: Node strips the types, and no build step occurs
    const main = fileURLToPath(new URL("../../reference/src/main.ts", import.meta.url));
    server = spawn(process.execPath, [main], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TENANTS: tenants }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    await new Promise<void>((resolve, reject) => {
      const seen = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(referenceHop(RUNGS[0]!).ready!)) resolve();
      };
      server!.stdout!.on("data", seen);
      server!.stderr!.on("data", seen);
      server!.once("exit", (code) => reject(new Error(`the service stopped with ${String(code)}: ${output}`)));
    });
    // the line of the WebSocket server comes before the listener accepts, thus the test waits for a connection
    for (let attempt = 0; ; attempt += 1) {
      const open = await new Promise<boolean>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => resolve(socket.end() !== undefined));
        socket.once("error", () => resolve(false));
      });
      if (open) break;
      if (attempt === 100) throw new Error(`the service did not accept in 10 s: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  afterAll(() => {
    server?.kill();
    rmSync(folder, { recursive: true, force: true });
  });

  // the listener refuses a Host that is not a loopback name on a loopback socket (DNS rebinding), thus this test names 127.0.0.1
  it("answers the put and the get of a tenant on one connection, in order", async () => {
    expect(await exchange(port, tenantRequests("t0001", "127.0.0.1"))).toEqual([
      { status: 200, body: { version: 1 } },
      { status: 200, body: { doc: { id: "d0", body: { tenant: "t0001" }, version: 1 } } },
    ]);
  });

  it("refuses an unknown token with a status that the harness counts as a failure", async () => {
    const [refused] = await exchange(port, [tenantRequests("t9999", "127.0.0.1")[1]!]);
    expect(refused).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
  });
});
