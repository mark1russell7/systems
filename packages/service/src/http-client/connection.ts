import type { ClientSocket, Factory } from "../client/core.ts";

/** An HTTP socket is the socket of a client in the core: the join of the prober and the bounded close read it. */
export type HttpSocket = ClientSocket;

/** An HTTP response is a whole response: its status, its headers, and its whole body. */
export interface HttpResponse {
  readonly status: number;
  /** These are the headers of the response, by their names in lower case, as Node gives them. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Buffer;
}

/** An agent request is one request that the wrapper gives the agent. */
export interface AgentRequest {
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | undefined;
}

/**
 * These are the events of one request that the wrapper reads. The agent gives each one at most one
 * time. `connect` comes only for a new connection. A request on a free socket left the client when it got that socket.
 */
export interface AgentEvents {
  /** The agent gave the request a socket. `reused` is true for a socket from the free list (`req.reusedSocket`). */
  socket(socket: HttpSocket, reused: boolean): void;
  /** The new socket of the request connected. The request then leaves the client. */
  connect(): void;
}

/** An agent exchange is one request in the agent: the promise of its whole response, and the abort that destroys its socket. */
export interface AgentExchange {
  /** This promise resolves with the whole response, or rejects with the error of the request, the socket or the body. */
  readonly response: Promise<HttpResponse>;
  /** This method destroys the request and its socket. A request that waits for a socket leaves the queue of the agent. */
  abort(error: Error): void;
}

/**
 * An agent is the part of an `http.Agent` of Node that the wrapper uses, with `http.request` on it.
 * A fake for tests has each part too. Thus the wrapper does not load node:http until it connects.
 */
export interface HttpAgent {
  /** This method sends one request on the agent. */
  request(request: AgentRequest, events: AgentEvents): AgentExchange;
  /** This method gives each socket of the agent that is open: the busy ones and the free ones. */
  sockets(): readonly HttpSocket[];
  /** This method destroys each socket of the agent. A request on a socket then fails. */
  destroy(): void;
}

/**
 * These are the options that the wrapper gives `new http.Agent`. Each one comes from the declaration.
 * The wrapper sets each option that has an effect on a timer, thus no default of Node decides one.
 */
export interface HttpAgentOptions {
  readonly keepAlive: true;
  /**
   * This time is the free socket timer (`timeout`). The agent closes a free socket at the smaller of
   * this time and the hint of the server less `agentKeepAliveTimeoutBuffer`. 0 is no timer, and then the hint does not apply.
   */
  readonly timeout: number;
  /** This time is subtracted from the hint of the server (`Keep-Alive: timeout=…`). A hint at or below it gives no reuse. */
  readonly agentKeepAliveTimeoutBuffer: number;
  /** This time is the idle time of TCP keepalive. The agent always turns keepalive on, and Node truncates the time to whole seconds. */
  readonly keepAliveMsecs: number;
  /** This count is the most sockets for one origin. A request waits in the agent for a socket above it. */
  readonly maxSockets: number;
  /** This count is the most free sockets for one origin. */
  readonly maxFreeSockets: number;
  /** The agent gives the socket that was free last, as the global agent does. */
  readonly scheduling: "lifo";
}

/** An agent factory makes the agent of the client from its options. */
export type AgentFactory = Factory<HttpAgentOptions, HttpAgent>;

/** These are the parts of `node:http` that the factory uses. The specifier is a value, thus the entry loads node:http only at the connect. */
interface NodeHttp {
  readonly Agent: new (options: HttpAgentOptions) => NodeAgent;
  request(options: object): NodeRequest;
}

interface NodeAgent {
  readonly sockets: Readonly<Record<string, readonly HttpSocket[] | undefined>>;
  readonly freeSockets: Readonly<Record<string, readonly HttpSocket[] | undefined>>;
  destroy(): void;
}

interface NodeSocket extends HttpSocket {
  readonly connecting: boolean;
  once(event: "connect", listener: () => void): unknown;
}

interface NodeIncoming {
  readonly statusCode?: number | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly complete: boolean;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface NodeRequest {
  readonly reusedSocket: boolean;
  on(event: "socket", listener: (socket: NodeSocket) => void): unknown;
  on(event: "response", listener: (response: NodeIncoming) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  end(body?: Uint8Array): void;
  destroy(error?: Error): void;
}

/**
 * This factory makes an `http.Agent` of Node. It loads node:http only when a client connects.
 * Each request goes through `http.request` with the agent. The response settles at the end of its body.
 * A body that ends before it is complete rejects the response.
 */
export const nodeAgent: AgentFactory = async (options) => {
  const specifier = "node:http";
  const http = (await import(specifier)) as NodeHttp;
  const agent = new http.Agent(options);
  const all = (lists: Readonly<Record<string, readonly HttpSocket[] | undefined>>): HttpSocket[] => Object.values(lists).flatMap((list) => list ?? []);
  return {
    request(request, events) {
      const req = http.request({ host: request.host, port: request.port, method: request.method, path: request.path, headers: request.headers, agent });
      const response = new Promise<HttpResponse>((resolve, reject) => {
        req.on("socket", (socket) => {
          events.socket(socket, req.reusedSocket);
          if (socket.connecting) socket.once("connect", () => events.connect());
          else if (!req.reusedSocket) events.connect();
        });
        req.on("response", (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }));
          incoming.on("close", () => {
            if (!incoming.complete) reject(new Error("the connection closed before the end of the body"));
          });
        });
        req.on("error", reject);
      });
      req.end(request.body);
      return { response, abort: (error) => req.destroy(error) };
    },
    sockets: () => [...all(agent.sockets), ...all(agent.freeSockets)],
    destroy: () => agent.destroy(),
  };
};
