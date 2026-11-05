// chain --port N --chain JSON
//
// The target of the retry count (SYS-67): a chain of listeners in one process, on loopback. The
// client of the cell calls listener 0. Each hop of the chain is a listener that calls the next one
// with a real retry client. The last listener is the deepest one, and it fails each request.
// Node.js 24 removes the types of this file when it starts, thus the image has no build.
//
//	{ "hops": [{ "kind": "undici", "options": { "minTimeout": 1 }, "answer": 501 }], "failure": 503 }
//
// - A hop of kind `undici` calls through a RetryAgent of undici 8.12.2 with its options over the
//   defaults. A hop of kind `service` calls through retry() of @mark1russell7/service with
//   `tries` and `base`, and it retries a status of 500 or more and each error of the socket.
// - The failure is the status of the deepest listener, or "close": a close of the socket with no reply.
// - A hop that gives up answers with `answer`, else the status that it got, else 502.
//
// Each arrival is a line `arrive` with its listener (`hop`) and its `trail`: the arrival numbers of
// each listener above it, then its own number. The numbers restart for each trail, thus the
// trails of a run are the tree of its tries. The tries of a caller are the children of one trail.
// A RetryAgent sends each try with the same headers, thus the listener that gets the try numbers it.
//
// The request GET / is the first request of the client of the cell. Listener 0 answers it with 200
// and restarts the numbers, thus each run has its own numbers. Each other path is the logical request.

import { readFileSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { retry } from "@mark1russell7/service";
import { Client, RetryAgent } from "undici";
import type { Dispatcher } from "undici";

/** This type is a hop of the argument `--chain`. */
type Hop =
  | { readonly kind: "undici"; readonly options?: ConstructorParameters<typeof RetryAgent>[1]; readonly answer?: number }
  | { readonly kind: "service"; readonly tries: number; readonly base: number; readonly answer?: number };

/** This type is the argument `--chain`. */
interface Chain {
  readonly hops: readonly Hop[];
  readonly failure: number | "close";
}

/** This type is the part of a failed call that a hop reads: the status of a reply, and the error of undici. */
interface Failed {
  readonly statusCode?: number;
  readonly code?: string;
  readonly data?: { readonly count?: number };
}

/** This type is the call of a hop to the next listener. */
type Call = (req: IncomingMessage, res: ServerResponse, text: Buffer, trail: string) => Promise<void>;

/** This function writes one line, with `t` from process.hrtime: CLOCK_MONOTONIC, the clock of the prober. */
const emit = (ev: string, fields: Readonly<Record<string, unknown>> = {}): void => {
  process.stdout.write(`${JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...fields })}\n`);
};

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const port = Number(flag("--port") ?? 8080);
const chain = JSON.parse(flag("--chain") ?? "") as Chain;

/** This function gives the version of a package in the folder of this file. */
const versionOf = (name: string): string =>
  (JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string }).version;

/** This map holds the last arrival number of each listener for each trail above it. */
const seen = new Map<string, number>();

/** This function numbers an arrival at a listener, writes its line, and gives its trail. */
const arrive = (hop: number, req: IncomingMessage): string => {
  const above = String(req.headers["x-trail"] ?? "");
  const key = `${hop}/${above}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  const trail = above === "" ? String(n) : `${above}.${n}`;
  emit("arrive", { hop, trail, n, method: req.method });
  return trail;
};

/** This function gives the outcome of one call of a hop: the status of a reply, or null for a socket that closed. */
const statusOf = (error: unknown): number | null => (error as Failed).statusCode ?? null;

/** This function answers the caller of a hop that gave up. */
const giveUp = (hop: number, spec: Hop, trail: string, res: ServerResponse, status: number | null, error: unknown): void => {
  const answer = spec.answer ?? status ?? 502;
  const failed = error as Failed | null;
  emit("gave-up", { hop, trail, status, answer, code: failed?.code ?? null, count: failed?.data?.count ?? null });
  res.writeHead(answer, { "content-type": "text/plain" }).end("gave up");
};

/** This function gives the request of a hop to the next listener. */
const onward = (req: IncomingMessage, text: Buffer, trail: string): Dispatcher.RequestOptions => ({
  path: req.url ?? "/",
  method: req.method ?? "GET",
  headers: { "x-trail": trail },
  body: req.method === "POST" ? text : null,
});

/** This function gives the call of a hop through a RetryAgent of undici. */
const undiciCall = (hop: number, spec: Extract<Hop, { kind: "undici" }>, next: string): Call => {
  const agent = new RetryAgent(new Client(next), spec.options ?? {});
  return async (req, res, text, trail) => {
    try {
      const { statusCode, body } = await agent.request(onward(req, text, trail));
      await body.dump();
      giveUp(hop, spec, trail, res, statusCode, null);
    } catch (error) {
      giveUp(hop, spec, trail, res, statusOf(error), error);
    }
  };
};

/** This function gives the call of a hop through retry() of the service package. */
const serviceCall = (hop: number, spec: Extract<Hop, { kind: "service" }>, next: string): Call => {
  const client = new Client(next);
  const once = async (req: IncomingMessage, text: Buffer, trail: string): Promise<number> => {
    const { statusCode, body } = await client.request(onward(req, text, trail));
    await body.dump();
    if (statusCode >= 500) throw Object.assign(new Error(`status ${statusCode}`), { statusCode });
    return statusCode;
  };
  return async (req, res, text, trail) => {
    try {
      giveUp(hop, spec, trail, res, await retry(() => once(req, text, trail), { tries: spec.tries, base: spec.base }), null);
    } catch (error) {
      giveUp(hop, spec, trail, res, statusOf(error), error);
    }
  };
};

/** This function gives the failure of the deepest listener. */
const fail: Call = async (req, res) => {
  if (chain.failure === "close") req.socket.destroy();
  else res.writeHead(chain.failure, { "content-type": "text/plain" }).end("outage");
};

/** This function reads the body of a request to its end. */
const bodyOf = async (req: IncomingMessage): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts);
};

/** This function starts one listener. */
const listen = (hop: number, call: Call): Promise<void> =>
  new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const text = await bodyOf(req);
      if (req.url === "/") {
        seen.clear();
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      await call(req, res, text, arrive(hop, req));
    });
    server.listen(port + hop, () => resolve());
  });

await listen(chain.hops.length, fail);
for (const [hop, spec] of [...chain.hops.entries()].reverse()) {
  const next = `http://127.0.0.1:${port + hop + 1}`;
  await listen(hop, spec.kind === "undici" ? undiciCall(hop, spec, next) : serviceCall(hop, spec, next));
}
emit("listening", { port, chain, undici: versionOf("undici"), service: versionOf("@mark1russell7/service"), node: process.version });
