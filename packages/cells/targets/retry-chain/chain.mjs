// chain --port N --chain JSON
//
// The target of the retry count (SYS-67): a chain of listeners in one process, on loopback. The
// client of the cell calls listener 0. Each hop of the chain is a listener that calls the next one
// with a real retry client. The last listener is the deepest one, and it fails each request.
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
import { retry } from "@mark1russell7/service";
import service from "@mark1russell7/service/package.json" with { type: "json" };
import { Client, RetryAgent } from "undici";

/** This function writes one line, with `t` from process.hrtime: CLOCK_MONOTONIC, the clock of the prober. */
const emit = (ev, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...fields })}\n`);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const port = Number(flag("--port") ?? 8080);
const chain = JSON.parse(flag("--chain"));
const undici = JSON.parse(readFileSync(new URL("./node_modules/undici/package.json", import.meta.url), "utf8"));

/** This map holds the last arrival number of each listener for each trail above it. */
const seen = new Map();

/** This function numbers an arrival at a listener, writes its line, and gives its trail. */
const arrive = (hop, req) => {
  const above = String(req.headers["x-trail"] ?? "");
  const key = `${hop}/${above}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  const trail = above === "" ? String(n) : `${above}.${n}`;
  emit("arrive", { hop, trail, n, method: req.method });
  return trail;
};

/** This function gives the outcome of one call of a hop: the status of a reply, or null for a socket that closed. */
const statusOf = (error) => error.statusCode ?? null;

/** This function answers the caller of a hop that gave up. */
const giveUp = (hop, spec, trail, res, status, error) => {
  const answer = spec.answer ?? status ?? 502;
  emit("gave-up", { hop, trail, status, answer, code: error?.code ?? null, count: error?.data?.count ?? null });
  res.writeHead(answer, { "content-type": "text/plain" }).end("gave up");
};

/** This function gives the request of a hop to the next listener. */
const onward = (req, text, trail) => ({
  path: req.url,
  method: req.method,
  headers: { "x-trail": trail },
  body: req.method === "POST" ? text : undefined,
});

/** These functions give the call of a hop to the next listener, one for each kind. */
const hops = {
  undici: (hop, spec, next) => {
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
  },
  service: (hop, spec, next) => {
    const client = new Client(next);
    const once = async (req, text, trail) => {
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
  },
};

/** This function gives the failure of the deepest listener. */
const fail = (req, res) => {
  if (chain.failure === "close") req.socket.destroy();
  else res.writeHead(chain.failure, { "content-type": "text/plain" }).end("outage");
};

/** This function reads the body of a request to its end. */
const bodyOf = async (req) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  return Buffer.concat(parts);
};

/** This function starts one listener. */
const listen = (hop, call) =>
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
    server.listen(port + hop, resolve);
  });

const depth = chain.hops.length;
await listen(depth, fail);
for (let hop = depth - 1; hop >= 0; hop -= 1) {
  const spec = chain.hops[hop];
  await listen(hop, hops[spec.kind](hop, spec, `http://127.0.0.1:${port + hop + 1}`));
}
emit("listening", { port, chain, undici: undici.version, service: service.version, node: process.version });
