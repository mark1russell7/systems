import { machineProblems } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "../index.ts";
import { replay, service } from "../index.ts";
import { fakeClock } from "../testing.ts";
import type { WsClientSpec, WsConnectOptions, WsKnobs, WsReplies } from "../websocket.ts";
import {
  STARTING_POLL,
  WS_CLIENT_MACHINE,
  WS_CLIENT_STARTING_KNOBS,
  WS_CLIENT_STARTING_MISSES,
  WS_CLIENT_STARTING_POLL,
  firstDetector,
  nodeWs,
  specProblems,
  unwatched,
  upgradeJudge,
  upgradeRequest,
  wsClient,
  wsDial,
  wsOptions,
} from "../websocket.ts";
import { fakeWsServer } from "./fake.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const never = { value: "infinite" as const, unit: "s" };

// two misses: the heartbeat ends a silent connection 2 × 1 s + 0.5 s = 2.5 s after the join
const KNOBS: WsKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  heartbeat_interval: s(1),
  heartbeat_timeout: ms(500),
  retry_base: ms(100),
  retry_cap: ms(400),
  keepalive_idle: s(5),
  max_connection_age: never,
  close_bound: ms(300),
  retrans_giveup_time: s(924.6),
};

/** The replies of the tests: a JSON message with a string `id` answers the request of that id. */
const REPLIES: WsReplies = {
  reply: (data) => {
    const parsed = JSON.parse(data.toString("utf8")) as { id?: unknown; error?: unknown };
    if (typeof parsed.id !== "string") return null;
    return typeof parsed.error === "string" ? { id: parsed.id, error: parsed.error } : { id: parsed.id };
  },
};

const spec = (knobs: Partial<WsKnobs> = {}, more: Partial<WsClientSpec> = {}): WsClientSpec => ({
  host: "feed",
  port: 8080,
  path: "/live",
  system: "systems.component.websocket",
  knobs: { ...KNOBS, ...knobs },
  heartbeatMisses: 2,
  replies: REPLIES,
  operations: { "read quote": { idempotent: true }, "place order": { idempotent: false } },
  ...more,
});

/** a client on a fake server and a fake clock, its events, and the options of each connect. The jitter is 0 */
const made = (knobs: Partial<WsKnobs> = {}, more: Partial<WsClientSpec> = {}) => {
  const clock = fakeClock(1000);
  const events: LifecycleEvent[] = [];
  const server = fakeWsServer(clock);
  const given: WsConnectOptions[] = [];
  const client = wsClient("feed", spec(knobs, more), {
    clock,
    random: () => 0,
    turn: () => Promise.resolve(),
    record: (event) => events.push(event),
    dial: async () => {},
    create: (options) => {
      given.push(options);
      return server.create(options);
    },
  });
  const on = (name: string) => events.filter((event) => event.on === name);
  return { clock, client, events, server, given, on };
};

/** a connected client: one open connection */
const connected = async (knobs: Partial<WsKnobs> = {}, more: Partial<WsClientSpec> = {}) => {
  const all = made(knobs, more);
  await all.client.handle.connect(new AbortController().signal);
  return all;
};

const quote = (id: string) => ({ id, data: JSON.stringify({ id, read: "quote" }) });

describe("the declaration: knobs by the names of the law, and no default (C1, C2, E3)", () => {
  it("declares each knob as a time, the detection of the heartbeat, and the interval as the refresh of an idle flow", () => {
    const { client } = made();
    expect(Object.keys(client.declaration.knobs).sort()).toEqual(
      [
        "close_bound",
        "connect_bound",
        "heartbeat_detection_time",
        "heartbeat_interval",
        "heartbeat_timeout",
        "idle_refresh_interval",
        "keepalive_idle",
        "max_connection_age",
        "request_timeout",
        "retrans_giveup_time",
        "retry_base",
        "retry_cap",
      ].sort(),
    );
    expect(client.declaration.knobs["heartbeat_detection_time"]).toEqual(s(2.5));
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(s(1));
    expect(client.declaration.operations).toEqual({
      ping: { idempotent: true },
      "read quote": { idempotent: true },
      "place order": { idempotent: false },
    });
    // with no heartbeat, nothing detects a silent connection, and keepalive refreshes an idle flow
    const open = made({ heartbeat_interval: never }).client.declaration.knobs;
    expect(open["heartbeat_detection_time"]).toEqual(never);
    expect(open["idle_refresh_interval"]).toEqual(s(5));
  });

  it("refuses what the client cannot do, and says why", () => {
    expect(specProblems("feed", spec({ request_timeout: ms(0) }))).toEqual([
      "feed's request_timeout is not a finite time above zero: the timer of the wrapper is the only bound of a call",
    ]);
    expect(specProblems("feed", spec({ heartbeat_timeout: never as never }))).toEqual([
      "feed's heartbeat_timeout is not a finite time above zero: the timer of the wrapper is the only bound of a ping of the heartbeat",
    ]);
    expect(specProblems("feed", spec({ heartbeat_interval: s(0) }))).toEqual(['feed\'s heartbeat_interval is zero: give "infinite" for no bound']);
    expect(specProblems("feed", spec({ keepalive_idle: ms(2500) }))).toEqual(["feed's keepalive_idle is not a whole number of seconds"]);
    expect(specProblems("feed", spec({ retry_cap: ms(50) }))).toEqual(["feed's retry_cap is below its retry_base"]);
    expect(specProblems("feed", spec({}, { heartbeatMisses: 0 }))).toEqual([
      "feed's heartbeat closes the connection after 0 misses, not a whole number above zero",
    ]);
    expect(specProblems("feed", spec({ heartbeat_timeout: s(1) }))).toEqual([
      "feed's heartbeat_timeout is not below its heartbeat_interval: with one ping at a time, a tick sends no ping while a ping waits",
    ]);
    // with one miss, the first miss is the end, thus a long timeout keeps its detection time
    expect(specProblems("feed", spec({ heartbeat_timeout: s(1) }, { heartbeatMisses: 1 }))).toEqual([]);
    expect(specProblems("feed", spec({ max_connection_age: s(1800) }))).toEqual([
      'feed\'s max_connection_age is not "infinite": the client does not replace its connection at an age',
    ]);
    expect(specProblems("feed", spec({}, { path: "live" }))).toEqual(['feed\'s path does not start with "/"']);
    expect(specProblems("feed", spec({}, { password: "p" }))).toEqual([
      "feed takes no password: give the credentials in headers, for example authorization",
    ]);
    expect(() => wsClient("feed", spec({ close_bound: ms(-1) }))).toThrow(/close_bound is not a time of zero or more/);
  });

  it("gives ws each timer from the declaration, and keepalive only when the declaration gives an idle time", () => {
    expect(wsOptions(spec({}, { protocols: ["quotes.v1"], headers: { authorization: "Bearer t" } }))).toEqual({
      url: "ws://feed:8080/live",
      protocols: ["quotes.v1"],
      options: {
        handshakeTimeout: 500,
        autoPong: true,
        closeTimeout: 300,
        keepAlive: true,
        keepAliveInitialDelay: 5000,
        headers: { authorization: "Bearer t" },
      },
    });
    // "infinite" keeps keepalive off, as ws does, and an IPv6 host goes in brackets
    expect(wsOptions(spec({ keepalive_idle: never }, { host: "::1", path: undefined }))).toEqual({
      url: "ws://[::1]:8080/",
      protocols: [],
      options: { handshakeTimeout: 500, autoPong: true, closeTimeout: 300, keepAlive: false },
    });
  });

  it("starts from knobs that the WS cells measured, and they hold the borders of the law", () => {
    const start = spec(WS_CLIENT_STARTING_KNOBS, { heartbeatMisses: WS_CLIENT_STARTING_MISSES });
    expect(specProblems("feed", start)).toEqual([]);
    expect(WS_CLIENT_STARTING_POLL).toBe(STARTING_POLL);
    const client = wsClient("feed", start, { dial: async () => {} });
    // one miss: a ping each 4 s, and no pong in 3 s
    expect(client.declaration.knobs["heartbeat_detection_time"]).toEqual(s(7));
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(s(4));
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(30))
      .phase("tear down dependencies", s(5))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll: WS_CLIENT_STARTING_POLL, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([]);
  });
});

describe("the dial: the upgrade request, and 101", () => {
  it("sends the upgrade request of RFC 6455, with the subprotocols and the headers of the spec", () => {
    expect(upgradeRequest({ host: "feed", port: 8080, path: "/live", protocols: ["a", "b"], headers: { authorization: "Bearer t" } })).toBe(
      "GET /live HTTP/1.1\r\nHost: feed:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: a, b\r\nauthorization: Bearer t\r\n\r\n",
    );
    expect(upgradeRequest({ host: "::1", port: 80 })).toBe(
      "GET / HTTP/1.1\r\nHost: [::1]:80\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
  });

  it("passes only 101, and waits for the end of the status line", () => {
    expect(upgradeJudge(Buffer.from("HTTP/1.1 101 Switching Protocols\r\n"))).toBeNull();
    expect(upgradeJudge(Buffer.from("HTTP/1.1 10"))).toBe("more");
    expect(String(upgradeJudge(Buffer.from("HTTP/1.1 426 Upgrade Required\r\n")))).toBe(
      'Error: the server answered "HTTP/1.1 426 Upgrade Required" to the upgrade, not 101',
    );
    expect(String(upgradeJudge(Buffer.from("+PONG\r\n")))).toBe('Error: the answer "+PONG" is not an HTTP/1.1 status line');
  });
});

describe("the join at each generation: the URL and the ends of the socket (D1, D2)", () => {
  it("records each connection when its upgrade ends, and a new generation after a reset", async () => {
    const { client, server, clock, on } = await connected();
    server.protocol = "quotes.v1";
    expect(client.status).toBe("ready");
    expect(client.joins).toEqual([
      { generation: 1, at: 1000, url: "ws://feed:8080/live", protocol: "", localAddress: "127.0.0.1", localPort: 40000, remoteAddress: "127.0.0.1", remotePort: 8080 },
    ]);
    server.latest().reset();
    await clock.advance(0);
    expect(client.status).toBe("failing");
    expect(on("connection.error").map((event) => event.detail)).toEqual(["read ECONNRESET"]);
    expect(on("connection.end").map((event) => event.detail)).toEqual(["code 1006"]);
    await clock.advance(100);
    expect(client.status).toBe("ready");
    expect(client.joins.map((join) => [join.generation, join.at, join.localPort, join.protocol])).toEqual([
      [1, 1000, 40000, ""],
      [2, 1100, 40001, "quotes.v1"],
    ]);
  });

  it("connects again after a backoff that doubles to its cap, and starts it again at a join", async () => {
    const { client, server, clock, on, given } = made();
    server.mode = "refuse";
    await client.handle.connect(new AbortController().signal);
    expect(client.status).toBe("failing");
    await clock.advance(100 + 200 + 400 + 400);
    expect(on("retry.connect").map((event) => [event.at, event.detail])).toEqual([
      [1100, "try 1, ws://feed:8080/live"],
      [1300, "try 2, ws://feed:8080/live"],
      [1700, "try 3, ws://feed:8080/live"],
      [2100, "try 4, ws://feed:8080/live"],
    ]);
    server.mode = "up";
    await clock.advance(400);
    expect(client.status).toBe("ready");
    expect(given).toHaveLength(6);
    server.latest().fin();
    await clock.advance(100);
    expect(on("retry.connect").at(-1)).toMatchObject({ at: 2600, detail: "try 1, ws://feed:8080/live" });
  });

  it("bounds an open that does not end, and destroys it", async () => {
    const { client, server, clock, on } = made();
    server.mode = "silent";
    const connecting = client.handle.connect(new AbortController().signal);
    await clock.advance(500);
    await connecting;
    expect(on("connect.failed").map((event) => [event.at, event.detail])).toEqual([[1500, "no open connection in connect_bound"]]);
    expect(server.latest().terminated).toBe(true);
    expect(client.status).toBe("failing");
  });
});

describe("three outcomes, never an empty success (C7, C8, C10)", () => {
  it("gives the reply of the server as ok, and a reply with an error as a certain error", async () => {
    const { client, server } = await connected();
    const ok = await client.request("read quote", quote("1"));
    expect(ok).toMatchObject({ outcome: "ok", attempts: 1 });
    expect(ok.outcome === "ok" && JSON.parse(ok.value.data.toString("utf8"))).toEqual({ id: "1", read: "quote" });
    server.answer = (data) => JSON.stringify({ id: (JSON.parse(data.toString("utf8")) as { id: string }).id, error: "no such symbol" });
    expect(await client.request("read quote", quote("2"))).toEqual({ outcome: "error", error: "no such symbol", reply: true, attempts: 1 });
  });

  it("does not send a call while it is not ready, with no replies, or with an id in flight", async () => {
    const before = made();
    // an operation that is not idempotent gets one try: an idempotent one waits for a ready client in the time that is left
    expect(await before.client.request("place order", quote("1"))).toEqual({ outcome: "error", error: "feed has not connected", reply: false, attempts: 1 });
    const { client, server, clock } = await connected({ request_timeout: s(5) });
    server.replyDelay = 100;
    const first = client.request("place order", quote("7"));
    expect(await client.request("place order", quote("7"))).toEqual({
      outcome: "error",
      error: "feed has a request with the id 7 in flight",
      reply: false,
      attempts: 1,
    });
    await clock.advance(100);
    expect(await first).toMatchObject({ outcome: "ok" });
    server.mode = "refuse";
    server.latest().reset();
    await clock.advance(0);
    expect(await client.request("place order", quote("8"))).toEqual({
      outcome: "error",
      error: "feed is failing, not ready: the call did not leave the client",
      reply: false,
      attempts: 1,
    });
    const bare = await connected({}, { replies: undefined });
    expect(await bare.client.request("place order", quote("1"))).toEqual({
      outcome: "error",
      error: "feed has no replies in its spec: no message can answer a request",
      reply: false,
      attempts: 1,
    });
  });

  it("ends a call with no reply at request_timeout as indeterminate, and the connection stays", async () => {
    const { client, server, clock, given } = await connected();
    server.mode = "stall";
    const pending = client.request("place order", quote("1"));
    await clock.advance(800);
    expect(await pending).toEqual({
      outcome: "indeterminate",
      error: "no reply in request_timeout: the server can have applied the request",
      attempts: 1,
    });
    expect(client.status).toBe("ready");
    expect(given).toHaveLength(1);
  });

  it("settles each call in flight as indeterminate at the end of its generation, and an abandoned call too", async () => {
    const { client, server, clock } = await connected({ request_timeout: s(5) });
    server.replyDelay = 1000;
    const order = client.request("place order", quote("1"));
    server.pongDelay = 1000;
    const ping = client.ping({ reissue: false });
    await clock.advance(0);
    server.latest().reset();
    await clock.advance(0);
    expect(await order).toEqual({ outcome: "indeterminate", error: "the generation ended with the call in flight (code 1006)", attempts: 1 });
    expect(await ping).toEqual({ outcome: "indeterminate", error: "the generation ended with the call in flight (code 1006)", attempts: 1 });
    await clock.advance(100);
    const controller = new AbortController();
    const abandoned = client.request("place order", quote("2"), { signal: controller.signal });
    controller.abort();
    expect(await abandoned).toEqual({ outcome: "indeterminate", error: "the caller abandoned the request after it was written", attempts: 1 });
  });

  it("gives a message that answers no request to the listeners, and a late reply to nobody", async () => {
    const { client, server, clock } = await connected();
    const heard: string[] = [];
    const stop = client.onMessage((data) => heard.push(data.toString("utf8")));
    server.latest().push("tick");
    server.latest().push(JSON.stringify({ event: "trade" }));
    server.mode = "stall";
    const late = client.request("place order", quote("9"));
    await clock.advance(800);
    expect(await late).toMatchObject({ outcome: "indeterminate" });
    server.latest().push(JSON.stringify({ id: "9" }));
    await clock.advance(0);
    stop();
    server.latest().push("after");
    await clock.advance(0);
    expect(heard).toEqual(["tick", '{"event":"trade"}']);
  });

  it("sends a message with no reply only while it is ready", async () => {
    const { client, server, clock } = await connected();
    expect(client.send("subscribe")).toBe(true);
    expect(server.latest().sent).toEqual(["subscribe"]);
    server.mode = "refuse";
    server.latest().fin();
    await clock.advance(0);
    expect(client.send("subscribe")).toBe(false);
  });

  it("matches a pong to its ping, and a pong for a later ping answers the earlier ones too", async () => {
    const { client, server, clock } = await connected({ request_timeout: s(5) });
    server.mode = "stall";
    server.pongDelay = 10_000;
    const first = client.ping();
    const second = client.ping();
    await clock.advance(0);
    expect(server.latest().pings.map((data) => data.toString("latin1"))).toEqual(["1", "2"]);
    // the RFC lets a server answer only the latest ping
    server.latest().pong(Buffer.from("2"));
    await clock.advance(0);
    expect(await first).toMatchObject({ outcome: "ok", attempts: 1 });
    expect(await second).toMatchObject({ outcome: "ok", attempts: 1 });
  });
});

describe("a second try: only a named, idempotent operation, one time, in the bound of the call (C8)", () => {
  it("sends an idempotent request again on the next generation, and a ping too", async () => {
    const { client, server, clock, on } = await connected({ request_timeout: s(2) });
    server.replyDelay = 50;
    const pending = client.request("read quote", quote("1"));
    await clock.advance(10);
    server.latest().reset();
    await clock.advance(200);
    expect(await pending).toMatchObject({ outcome: "ok", attempts: 2 });
    expect(on("command.reissue").map((event) => event.detail)).toEqual(["read quote"]);
    expect(server.connections.map((connection) => connection.sent.length)).toEqual([1, 1]);
  });

  it("does not send again an operation that is not idempotent, or one that the table does not name", async () => {
    const { client, server, clock, on } = await connected({ request_timeout: s(2) });
    server.replyDelay = 50;
    const order = client.request("place order", quote("1"));
    const unnamed = client.request("cancel order", quote("2"));
    await clock.advance(10);
    server.latest().reset();
    await clock.advance(200);
    expect(await order).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    expect(await unnamed).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    expect(on("command.reissue")).toEqual([]);
  });
});

describe("the heartbeat: a ping frame each interval, one at a time, and terminate() at the last miss", () => {
  it("ends a silent connection at misses × interval + timeout, destroys its socket, and connects again", async () => {
    const { client, server, clock, on } = await connected();
    const first = server.latest();
    await clock.advance(1000);
    expect(first.pings.map((data) => data.toString("latin1"))).toEqual(["1"]);
    // the silence starts at 2000, after the pong of the first ping. The drop comes 2 × 1 s + 0.5 s later
    server.mode = "silent";
    await clock.advance(2500);
    expect(on("heartbeat.miss").map((event) => [event.at, event.detail])).toEqual([
      [3500, "1 of 2"],
      [4500, "2 of 2"],
    ]);
    expect(on("heartbeat.dead").map((event) => [event.at, event.to])).toEqual([[4500, "failing"]]);
    expect(first.pings.map((data) => data.toString("latin1"))).toEqual(["1", "2", "3"]);
    expect(first.terminated).toBe(true);
    expect(first.closes).toEqual([]);
    server.mode = "up";
    await clock.advance(100);
    expect(client.status).toBe("ready");
    expect(client.joins).toHaveLength(2);
  });

  it("keeps a connection whose pongs come late but in their timeout: a stall is not a death", async () => {
    const { client, server, clock, on } = await connected();
    server.mode = "stall";
    server.pongDelay = 400;
    await clock.advance(10_000);
    expect(server.latest().pings).toHaveLength(10);
    expect(on("heartbeat.miss")).toEqual([]);
    expect(client.status).toBe("ready");
  });

  it("forgets a miss when the next pong comes", async () => {
    const { server, clock, on, client } = await connected();
    server.pongDelay = 600;
    await clock.advance(3000);
    server.pongDelay = 0;
    await clock.advance(3000);
    expect(on("heartbeat.miss").map((event) => event.detail)).toEqual(["1 of 2", "1 of 2", "1 of 2"]);
    expect(on("heartbeat.dead")).toEqual([]);
    expect(client.status).toBe("ready");
  });

  it("sends no ping with no heartbeat", async () => {
    const { server, clock } = await connected({ heartbeat_interval: never });
    await clock.advance(10_000);
    expect(server.latest().pings).toEqual([]);
  });
});

describe("the close: the calls in flight and the close handshake in their bound, then terminate() (A9, A14, principle 9)", () => {
  it("closes at once when the server answers the close frame", async () => {
    const { client, clock, server } = await connected();
    await client.handle.close();
    expect(clock.now()).toBe(1000);
    expect(client.status).toBe("end");
    expect(server.latest().closes).toEqual([{ code: 1000, reason: "the client closed" }]);
    expect(server.latest().terminated).toBe(false);
  });

  it("waits for a call in flight, then closes", async () => {
    const { client, clock, server } = await connected();
    server.replyDelay = 100;
    const pending = client.request("place order", quote("1"));
    await clock.advance(0);
    const closing = client.handle.close();
    await clock.advance(100);
    await closing;
    expect(await pending).toMatchObject({ outcome: "ok" });
    expect(clock.now()).toBe(1100);
    expect(server.latest().closes).toHaveLength(1);
  });

  it("destroys the socket at the bound when the server is silent, and settles what is in flight", async () => {
    const { client, server, clock, on, events } = await connected({ request_timeout: s(5) });
    server.mode = "silent";
    const pending = client.request("place order", quote("1"));
    await clock.advance(10);
    const closing = client.handle.close();
    await clock.advance(300);
    await closing;
    expect(events.map((each) => each.on).filter((name) => name.startsWith("close"))).toEqual(["close.request", "close.bound", "close.destroy"]);
    expect(on("status.end").map((ended) => ended.at)).toEqual([1310]);
    expect(await pending).toEqual({ outcome: "indeterminate", error: "the client closed with the call in flight", attempts: 1 });
    expect(server.latest().terminated).toBe(true);
  });

  it("stops its tries to connect at the close", async () => {
    const { client, server, clock, given } = made();
    server.mode = "refuse";
    await client.handle.connect(new AbortController().signal);
    await client.handle.close();
    await clock.advance(5000);
    expect(given).toHaveLength(1);
    expect(client.status).toBe("end");
  });
});

describe("the checks of each step of the connection (B7, B14)", () => {
  const poll = { interval: s(1), jitter: 0.2, timeout: ms(400) };

  it("gives a check for each step asked, with its policy, and whether it uses the application's connection", () => {
    const { client } = made();
    const checks = client.checks({ poll, steps: { "round-trip": "readiness", dial: null, "local-state": "liveness" } });
    expect(checks.map(([check]) => [check.name, check.step, check.gates, check.ownConnection])).toEqual([
      ["feed.local-state", "local-state", "liveness", true],
      ["feed.round-trip", "round-trip", "readiness", true],
      ["feed.dial", "dial", null, false],
    ]);
  });

  it("passes a ping on the connection of the application, and fails while the client is not ready", async () => {
    const { client, server, clock } = await connected();
    const checks = client.checks({ poll, steps: { "local-state": "liveness", "round-trip": "readiness" } });
    const local = checks[0]![1];
    const roundTrip = checks[1]![1];
    expect(await roundTrip(new AbortController().signal)).toBe("ok");
    expect(await local(new AbortController().signal)).toBe("ok");
    server.mode = "refuse";
    server.latest().reset();
    await clock.advance(0);
    expect(await roundTrip(new AbortController().signal)).toBe("error");
    expect(await local(new AbortController().signal)).toBe("error");
  });

  it("says when its close does not fit in its phase, or its request outlives a poll (O13)", () => {
    const { client } = made({ request_timeout: s(5), close_bound: s(3) });
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(6) })
      .startup(s(10))
      .phase("tear down dependencies", s(2))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([
      'feed\'s close_bound of 3000 ms does not fit in the cap of "tear down dependencies"',
      "feed's request_timeout outlives one jittered poll of feed.round-trip (B7, O13)",
    ]);
  });
});

describe("the manifestations that the client meets, and their detectors (E9, C3)", () => {
  it("finds each manifestation in each situation with the starting knobs", () => {
    const client = wsClient("feed", spec(WS_CLIENT_STARTING_KNOBS, { heartbeatMisses: WS_CLIENT_STARTING_MISSES }), { dial: async () => {} });
    const meet = (name: string) => client.meets.find((meeting) => meeting.manifestation === name)!;
    expect(firstDetector(meet("blackhole"), "in flight")).toMatchObject({ by: "heartbeat_detection_time", within: s(7) });
    expect(firstDetector(meet("blackhole"), "idle")).toMatchObject({ by: "heartbeat_detection_time", within: s(7) });
    expect(firstDetector(meet("freeze-process"), "idle")).toMatchObject({ by: "heartbeat_detection_time", within: s(7) });
    expect(firstDetector(meet("rst"), "idle")).toMatchObject({ by: "heartbeat_interval", within: s(4) });
    expect(firstDetector(meet("fin"), "idle")).toMatchObject({ within: s(0) });
    expect(firstDetector(meet("app-stall"), "in flight")).toMatchObject({ by: "request_timeout", within: s(9.5) });
    expect(unwatched(client.meets)).toEqual([{ manifestation: "app-stall", situation: "idle" }]);
  });

  it("names what nothing finds with no heartbeat", () => {
    expect(unwatched(made({ heartbeat_interval: never }).client.meets)).toEqual([
      { manifestation: "freeze-process", situation: "idle" },
      { manifestation: "app-stall", situation: "idle" },
    ]);
    expect(unwatched(made({ heartbeat_interval: never, keepalive_idle: never }).client.meets)).toEqual([
      { manifestation: "rst", situation: "idle" },
      { manifestation: "blackhole", situation: "idle" },
      { manifestation: "freeze-host", situation: "idle" },
      { manifestation: "freeze-process", situation: "idle" },
      { manifestation: "app-stall", situation: "idle" },
    ]);
  });
});

describe("the client as a document (D4, E8)", () => {
  it("is a valid, consistent machine document", () => {
    expect(machineSchema.safeParse(WS_CLIENT_MACHINE).success).toBe(true);
    expect(machineProblems(WS_CLIENT_MACHINE)).toEqual([]);
  });

  const scenarios: Record<string, (all: Awaited<ReturnType<typeof connected>>) => Promise<void>> = {
    "a reset, and a new connection": async ({ client, server, clock }) => {
      server.latest().reset();
      await clock.advance(100);
      await client.request("read quote", quote("1"));
    },
    "a refused server, then a server that is back": async ({ client, server, clock }) => {
      server.mode = "refuse";
      server.latest().fin();
      await clock.advance(700);
      await client.request("place order", quote("1"));
      server.mode = "up";
      await clock.advance(400);
      await client.request("place order", quote("2"));
    },
    "the heartbeat of a silent server, and a bounded open": async ({ server, clock }) => {
      server.mode = "silent";
      await clock.advance(2500);
      await clock.advance(600);
    },
    "a request sent again": async ({ client, server, clock }) => {
      server.replyDelay = 50;
      const pending = client.request("read quote", quote("1"));
      await clock.advance(10);
      server.latest().reset();
      await clock.advance(200);
      await pending;
    },
    "a bounded close of a silent server": async ({ client, server, clock }) => {
      server.mode = "silent";
      const pending = client.request("place order", quote("1"));
      await clock.advance(10);
      const closing = client.handle.close();
      await clock.advance(300);
      await closing;
      await pending;
    },
    "a clean close": async ({ client }) => {
      await client.handle.close();
    },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`replays ${name} against the document`, async () => {
      const all = await connected({ request_timeout: s(2) });
      await scenario(all);
      expect(all.events.length).toBeGreaterThan(2);
      expect(replay(WS_CLIENT_MACHINE, all.events)).toEqual([]);
    });
  }
});

describe("ws on loopback: the real driver against a real server", () => {
  /** This type is the part of the server of ws that the test uses. */
  interface Server {
    on(event: "connection", listener: (socket: { on(event: "message", listener: (data: Buffer) => void): void; send(data: Buffer): void }) => void): void;
    once(event: "listening", listener: () => void): void;
    address(): { port: number };
    close(callback: () => void): void;
  }

  it("connects, answers a request and a ping, passes the dial, and closes with the handshake", async () => {
    const specifier = "ws";
    const loaded = (await import(specifier)) as { WebSocketServer: new (options: { host: string; port: number }) => Server };
    const server = new loaded.WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
    const { port } = server.address();
    const live = { ...spec({ request_timeout: s(2), connect_bound: s(2), close_bound: s(2) }), host: "127.0.0.1", port, path: "/" };
    const client = wsClient("feed", live, { create: nodeWs });
    try {
      await client.handle.connect(new AbortController().signal);
      expect(client.status).toBe("ready");
      expect(client.joins[0]).toMatchObject({ url: `ws://127.0.0.1:${port}/`, remoteAddress: "127.0.0.1", remotePort: port });
      expect(client.joins[0]!.localPort).toBeGreaterThan(0);
      expect(await client.request("read quote", quote("1"))).toMatchObject({ outcome: "ok", attempts: 1 });
      expect(await client.ping()).toMatchObject({ outcome: "ok", attempts: 1 });
      await expect(wsDial(live)("127.0.0.1", port, new AbortController().signal)).resolves.toBeUndefined();
    } finally {
      await client.handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(client.status).toBe("end");
  });
});
