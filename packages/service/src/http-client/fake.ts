// A fake server and a fake http.Agent for the tests of the HTTP client, on a fake clock. It keeps the
// parts of the agent that the client depends on. The agent gives the free socket that was free last
// (LIFO), and opens a new socket below maxSockets. Above it, a request waits in the queue of the agent.
// The free socket timer is the smaller of `timeout` and the hint less the buffer. The agent sends no
// request again. A test changes what the server does: it answers, it refuses, it is silent, or it holds its reply.

import type { Cancel, Clock } from "../clock.ts";
import type { AgentEvents, AgentExchange, AgentFactory, AgentRequest, HttpAgent, HttpAgentOptions, HttpResponse, HttpSocket } from "./connection.ts";

/**
 * What the server does with a new connection or a request:
 * - `up`: it accepts each connection, and answers each request.
 * - `refuse`: it refuses each new connection with a reset.
 * - `silent`: a new connection gets no answer: a black hole.
 * - `frozen`: it accepts each connection, and holds each reply.
 */
export type ServerMode = "up" | "refuse" | "silent" | "frozen";

/** A reply is what the server answers to one request. `cut` ends the body before it is complete. `after` delays the reply. */
export interface FakeReply {
  readonly status: number;
  readonly body?: string | undefined;
  readonly cut?: boolean | undefined;
  readonly after?: number | undefined;
}

/** A call is one request that reached the server: its socket, and if that socket was reused. */
export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly socket: number;
  readonly reused: boolean;
}

/** A fake socket, with what a test must see. */
export interface FakeSocket extends HttpSocket {
  readonly id: number;
  readonly closed: boolean;
  /** True when the server closed the socket while it was free, and the agent does not know yet: the keep-alive race. */
  readonly crossed: boolean;
}

interface Socket extends FakeSocket {
  closed: boolean;
  crossed: boolean;
  timer: Cancel;
  exchange: Pending | null;
  destroy(): void;
}

interface Pending {
  readonly request: AgentRequest;
  readonly events: AgentEvents;
  settled: boolean;
  socket: Socket | null;
  resolve(response: HttpResponse): void;
  reject(error: Error): void;
}

const errorWithCode = (text: string, code: string): Error => Object.assign(new Error(text), { code });

/** A fake server is the server, its agents, and the methods that change it. */
export interface FakeServer {
  readonly create: AgentFactory;
  /** These are the requests that reached the server, in their sequence. */
  readonly calls: readonly FakeCall[];
  /** These are the options of each agent that the factory made. */
  readonly options: readonly HttpAgentOptions[];
  /** This method changes what the server does with the next connections and requests. */
  set(next: ServerMode): void;
  /** This method changes the reply of the server to each request. */
  answer(next: (call: FakeCall) => FakeReply): void;
  /** This method changes the hint of the server, in seconds, or null for no hint. */
  hint(next: number | null): void;
  /** This method gives each socket of the last agent that is open. */
  open(): FakeSocket[];
  /** This method gives the free sockets of the last agent. */
  free(): FakeSocket[];
  /** This method gives the count of the requests that wait in the queue of the last agent. */
  queued(): number;
  /** This method closes each free socket from the server, and the agent does not know yet: the crossed race. */
  crossFree(): void;
  /** This method resets each socket. A busy socket fails its request with ECONNRESET. */
  resetAll(): void;
  /** This method closes each socket with a FIN. A busy socket fails its request with "socket hang up". */
  finAll(): void;
}

interface FakeAgent extends HttpAgent {
  readonly all: readonly Socket[];
  readonly free: readonly Socket[];
  readonly queue: readonly Pending[];
}

/** This function makes a fake server and the factory of its fake agents. */
export const fakeServer = (clock: Clock): FakeServer => {
  let mode: ServerMode = "up";
  let reply: (call: FakeCall) => FakeReply = () => ({ status: 200, body: "ok" });
  // the hint of the server, in seconds (`Keep-Alive: timeout=5`), or null for no hint
  let hint: number | null = 5;
  const calls: FakeCall[] = [];
  const options: HttpAgentOptions[] = [];
  const agents: FakeAgent[] = [];

  const create: AgentFactory = (given) => {
    options.push(given);
    const all: Socket[] = [];
    const free: Socket[] = [];
    const queue: Pending[] = [];
    let next = 1;
    const open = (): Socket[] => all.filter((socket) => !socket.closed);

    const fail = (pending: Pending, error: Error): void => {
      if (pending.settled) return;
      pending.settled = true;
      pending.reject(error);
    };
    const remove = (socket: Socket): void => {
      socket.closed = true;
      socket.timer();
      const at = free.indexOf(socket);
      if (at >= 0) free.splice(at, 1);
      queueMicrotask(drain);
    };
    const release = (socket: Socket): void => {
      socket.exchange = null;
      if (socket.closed) return;
      const waiter = queue.shift();
      if (waiter !== undefined) {
        assign(waiter, socket, true);
        return;
      }
      // the agent subtracts its buffer from the hint, and a hint at or below the buffer gives no reuse
      const hinted = hint === null ? Number.POSITIVE_INFINITY : hint * 1000 - given.agentKeepAliveTimeoutBuffer;
      if (hinted <= 0 || free.length >= given.maxFreeSockets) {
        socket.destroy();
        return;
      }
      // a timeout of 0 is no free socket timer, and then the hint does not apply
      if (given.timeout > 0) socket.timer = clock.after(Math.min(given.timeout, hinted), () => socket.destroy());
      free.push(socket);
    };
    const serve = (pending: Pending, socket: Socket, reused: boolean): void => {
      const text = pending.request.body === undefined ? undefined : Buffer.from(pending.request.body).toString("utf8");
      const call: FakeCall = { method: pending.request.method, path: pending.request.path, headers: pending.request.headers, body: text, socket: socket.id, reused };
      calls.push(call);
      if (mode === "frozen") return;
      const answer = reply(call);
      const send = (): void => {
        if (pending.settled || socket.closed) return;
        if (answer.cut === true) {
          fail(pending, new Error("the connection closed before the end of the body"));
          socket.destroy();
          return;
        }
        pending.settled = true;
        pending.resolve({ status: answer.status, headers: {}, body: Buffer.from(answer.body ?? "", "utf8") });
        release(socket);
      };
      if (answer.after === undefined) queueMicrotask(send);
      else clock.after(answer.after, send);
    };
    const assign = (pending: Pending, socket: Socket, reused: boolean): void => {
      pending.socket = socket;
      socket.exchange = pending;
      socket.timer();
      queueMicrotask(() => {
        if (pending.settled) return;
        pending.events.socket(socket, reused);
        if (reused) {
          // the server closed this free socket, and its FIN or its reset arrives with the request
          if (socket.crossed) {
            fail(pending, errorWithCode("read ECONNRESET", "ECONNRESET"));
            socket.destroy();
            return;
          }
          serve(pending, socket, true);
          return;
        }
        if (mode === "refuse") {
          fail(pending, errorWithCode("connect ECONNREFUSED", "ECONNREFUSED"));
          socket.destroy();
          return;
        }
        // a silent server gives no answer: the request waits until the wrapper ends it
        if (mode === "silent") return;
        queueMicrotask(() => {
          if (pending.settled || socket.closed) return;
          pending.events.connect();
          serve(pending, socket, false);
        });
      });
    };
    const fresh = (): Socket => {
      const socket: Socket = {
        id: next++,
        closed: false,
        crossed: false,
        timer: () => {},
        exchange: null,
        localAddress: "10.0.0.1",
        localPort: 40000 + all.length,
        remoteAddress: "10.0.0.2",
        remotePort: 80,
        destroy() {
          if (socket.closed) return;
          const pending = socket.exchange;
          remove(socket);
          if (pending !== null) fail(pending, new Error("socket hang up"));
        },
      };
      all.push(socket);
      return socket;
    };
    const place = (pending: Pending): void => {
      const reused = free.pop();
      if (reused !== undefined) assign(pending, reused, true);
      else if (open().length < given.maxSockets) assign(pending, fresh(), false);
      else queue.push(pending);
    };
    const drain = (): void => {
      while (queue.length > 0 && open().length < given.maxSockets) place(queue.shift()!);
    };

    const agent: FakeAgent = {
      all,
      free,
      queue,
      request(request, events): AgentExchange {
        let pending!: Pending;
        const response = new Promise<HttpResponse>((resolve, reject) => {
          pending = { request, events, settled: false, socket: null, resolve, reject };
        });
        place(pending);
        return {
          response,
          abort(error) {
            const at = queue.indexOf(pending);
            if (at >= 0) queue.splice(at, 1);
            const socket = pending.socket;
            fail(pending, error);
            if (socket !== null && socket.exchange === pending) socket.destroy();
          },
        };
      },
      sockets: () => open(),
      destroy() {
        for (const socket of open()) socket.destroy();
        for (const pending of queue.splice(0)) fail(pending, new Error("socket hang up"));
      },
    };
    agents.push(agent);
    return agent;
  };

  const last = (): FakeAgent => agents.at(-1)!;

  return {
    create,
    calls,
    options,
    set(next) {
      mode = next;
    },
    answer(next) {
      reply = next;
    },
    hint(next) {
      hint = next;
    },
    open: () => last().all.filter((socket) => !socket.closed),
    free: () => [...last().free],
    queued: () => last().queue.length,
    crossFree() {
      for (const socket of last().free) socket.crossed = true;
    },
    resetAll() {
      for (const socket of last().all.filter((one) => !one.closed)) {
        const pending = socket.exchange;
        if (pending !== null && !pending.settled) {
          pending.settled = true;
          pending.reject(errorWithCode("read ECONNRESET", "ECONNRESET"));
        }
        socket.destroy();
      }
    },
    finAll() {
      for (const socket of last().all.filter((one) => !one.closed)) socket.destroy();
    },
  };
};
