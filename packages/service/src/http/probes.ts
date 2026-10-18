import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { ListenOptions, Socket } from "node:net";
import type { Health, ProbeKind } from "../health.ts";
import type { HealthServer } from "../lifecycle.ts";
import type { Quantity } from "@mark1russell7/quantity";
import type { MountContext, RequestHandler } from "./transport.ts";
import { pathOf, retryAfterOf } from "./transport.ts";

/** A probe response is the status, the headers and the body of one probe, for any HTTP framework or none. */
export interface ProbeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A health source is the health runtime, or a function that gives it when it exists. */
export type HealthSource = Health | (() => Health | null | undefined);

const KINDS: readonly ProbeKind[] = ["startup", "readiness", "liveness", "report"];

const prefixProblem = (prefix: string): string | null =>
  prefix === "" || (prefix.startsWith("/") && !prefix.endsWith("/"))
    ? null
    : `the probe prefix "${prefix}" does not start with "/", or it ends with "/"`;

const json = (status: number, body: unknown): ProbeResponse => ({
  status,
  headers: { "content-type": "application/health+json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/**
 * This function gives the response of a probe path from the cache of the health runtime. For a path
 * that is not a probe, it gives null. The paths are `/startup`, `/readiness`, `/liveness` and
 * `/report` after the prefix. `/readiness/<controller>` gives the readiness of one controller.
 */
export const probeResponse = (
  health: Health | null | undefined,
  method: string | undefined,
  path: string,
  prefix = "",
): ProbeResponse | null => {
  if (!path.startsWith(`${prefix}/`)) return null;
  const parts = path.slice(prefix.length + 1).split("/");
  const kind = KINDS.find((each) => each === parts[0]);
  if (kind === undefined) return null;
  const controller = parts[1];
  if (parts.length > 2 || (controller !== undefined && (kind !== "readiness" || controller === ""))) return null;
  if (method !== "GET" && method !== "HEAD")
    return { status: 405, headers: { allow: "GET, HEAD", "content-length": "0" }, body: "" };
  // before the runtime exists, each probe fails: the service has not started
  if (health === null || health === undefined) return json(503, { status: "fail", probe: kind });
  try {
    const answer = health.probe(kind, controller === undefined ? undefined : decodeURIComponent(controller));
    return { ...json(answer.status, answer.body), headers: { "content-type": answer.contentType, "cache-control": "no-store" } };
  } catch {
    // a controller that the service does not have
    return json(404, { status: "fail", probe: kind, controller });
  }
};

/** This function writes a probe response. A 503 gets `Retry-After`, when the writer has the time of a retry. */
const write = (req: IncomingMessage, res: ServerResponse, response: ProbeResponse, retryAfter: string | undefined): void => {
  const retry = response.status === 503 && retryAfter !== undefined ? { "retry-after": retryAfter } : {};
  res.writeHead(response.status, { ...response.headers, ...retry, "content-length": String(Buffer.byteLength(response.body)) });
  res.end(req.method === "HEAD" ? undefined : response.body);
};

/** These options mount the probes on the port of the application. */
export interface ProbeHandlerOptions {
  /** This path goes before each probe path, for example `/health`. It starts with `/`, or it is empty. */
  readonly prefix: string;
}

/**
 * This function gives a request handler that answers the probes on the port of the application. It
 * answers until `close transports`, thus its mount keeps the listener open through the drain. A path
 * that is not a probe goes to the next handler. Each 503 gets the `Retry-After` of the context.
 */
export const probeHandler = (health: HealthSource, options: ProbeHandlerOptions): RequestHandler => {
  const problem = prefixProblem(options.prefix);
  if (problem !== null) throw new Error(problem);
  const handler = (req: IncomingMessage, res: ServerResponse, context?: MountContext): boolean => {
    const runtime = typeof health === "function" ? health() : health;
    const response = probeResponse(runtime, req.method, pathOf(req.url), options.prefix);
    if (response === null) return false;
    // the transport gives server_retry_after through the context, and it adds the header to each 503 too
    const retryAfter = context?.retryAfter === undefined ? undefined : retryAfterOf({ server_retry_after: context.retryAfter }, "probeHandler");
    write(req, res, response, retryAfter);
    return true;
  };
  return Object.assign(handler, { until: "close transports" as const });
};

/** These options make a probe server: the listen options of its port, the prefix of its paths, and the time of a retry. */
export interface ProbeServerOptions extends ListenOptions {
  /**
   * This time goes in the `Retry-After` of each 503 of a probe, as on the port of the application.
   * The probe server has no defaults, thus the knob is necessary.
   */
  readonly server_retry_after: Quantity;
  /** This path goes before each probe path. The default is no prefix, because the port has only the probes. */
  readonly prefix?: string | undefined;
  /** This server answers the probes. Without it, the probe server makes a server of `node:http`. */
  readonly server?: Server | undefined;
}

/** A probe server is a health server on its own port. Its server is visible for the address of the port. */
export interface ProbeServer extends HealthServer {
  readonly server: Server;
}

/**
 * This function makes a health server on a port of its own (S6 decision D5). It starts first and
 * closes last, thus the probes answer through the whole drain. Each probe answers from the cache, and
 * each 503 gets the `Retry-After` of `server_retry_after`.
 */
export const probeServer = (options: ProbeServerOptions): ProbeServer => {
  const { prefix = "", server = createServer(), server_retry_after, ...listen } = options;
  const retryAfter = retryAfterOf({ server_retry_after }, "probeServer");
  const problem = prefixProblem(prefix);
  if (problem !== null) throw new Error(problem);
  if (server.listenerCount("request") > 0) throw new Error("the probe server has a request listener of its own");
  let health: Health | null = null;
  let closing: Promise<void> | null = null;
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const response = probeResponse(health, req.method, pathOf(req.url), prefix);
    write(req, res, response ?? { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not Found" }, retryAfter);
  });
  return {
    server,
    listen(runtime) {
      health = runtime;
      if (server.listening) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server.off("listening", listened);
          reject(error);
        };
        const listened = (): void => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", listened);
        server.listen(listen);
      });
    },
    close() {
      if (closing !== null) return closing;
      closing = new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of [...sockets]) socket.destroy();
      });
      return closing;
    },
  };
};
