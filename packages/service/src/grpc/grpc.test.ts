import { machineProblems } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { describe, expect, it } from "vitest";
import type { GrpcClientSpec, GrpcConnectOptions, GrpcKnobs, GrpcStatus } from "../grpc.ts";
import {
  GRPC_CLIENT_MACHINE,
  GRPC_CLIENT_STARTING_KNOBS,
  GRPC_CLIENT_STARTING_POLL,
  GRPC_CLIENT_STARTING_WITHOUT_CALLS,
  GRPC_CODES,
  HEALTH_CHECK,
  HTTP2_PREFACE,
  STARTING_POLL,
  codeName,
  firstDetector,
  grpcClient,
  grpcDial,
  grpcOperations,
  grpcOptions,
  grpcOutcome,
  healthRequest,
  healthStatus,
  nodeGrpc,
  settingsJudge,
  specProblems,
  unwatched,
} from "../grpc.ts";
import type { LifecycleEvent } from "../index.ts";
import { replay, service } from "../index.ts";
import { fakeClock } from "../testing.ts";
import { SERVING_REPLY, fakeGrpcServer } from "./fake.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const never = { value: "infinite" as const, unit: "s" };

// The keepalive ends a silent transport 1 s + 0.5 s = 1.5 s after its last ACK
const KNOBS: GrpcKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  keepalive_time: s(1),
  keepalive_timeout: ms(500),
  server_keepalive_min_time: s(1),
  client_idle_timeout: s(5),
  server_idle_close: s(6),
  retry_base: ms(100),
  retry_cap: ms(400),
  keepalive_idle: never,
  max_connection_age: never,
  close_bound: ms(300),
  retrans_giveup_time: s(924.6),
};

const GET = "/kv.KV/Get";
const PUT = "/kv.KV/Put";

const spec = (knobs: Partial<GrpcKnobs> = {}, more: Partial<GrpcClientSpec> = {}): GrpcClientSpec => ({
  host: "rpc",
  port: 50051,
  system: "systems.component.grpc",
  knobs: { ...KNOBS, ...knobs },
  keepaliveWithoutCalls: false,
  operations: grpcOperations({ [GET]: "NO_SIDE_EFFECTS", [PUT]: "IDEMPOTENCY_UNKNOWN" }),
  ...more,
});

/** a client on a fake server and a fake clock, its events, and the options of each channel */
const made = (knobs: Partial<GrpcKnobs> = {}, more: Partial<GrpcClientSpec> = {}) => {
  const clock = fakeClock(1000);
  const events: LifecycleEvent[] = [];
  const server = fakeGrpcServer(clock);
  const given: GrpcConnectOptions[] = [];
  const client = grpcClient("rpc", spec(knobs, more), {
    clock,
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

/** a connected client: one READY channel */
const connected = async (knobs: Partial<GrpcKnobs> = {}, more: Partial<GrpcClientSpec> = {}) => {
  const all = made(knobs, more);
  await all.client.handle.connect(new AbortController().signal);
  return all;
};

const bytes = (text: string) => Buffer.from(text, "utf8");

describe("the declaration: knobs by the names of the law, and no default (C1, C2, E3)", () => {
  it("declares each knob as a time, the detection of the keepalive, and the refresh of an idle flow", () => {
    const { client } = made();
    expect(Object.keys(client.declaration.knobs).sort()).toEqual(
      [
        "client_idle_timeout",
        "close_bound",
        "connect_bound",
        "heartbeat_detection_time",
        "idle_refresh_interval",
        "keepalive_idle",
        "keepalive_time",
        "keepalive_timeout",
        "max_connection_age",
        "request_timeout",
        "retrans_giveup_time",
        "retry_base",
        "retry_cap",
      ].sort(),
    );
    expect(client.declaration.knobs["heartbeat_detection_time"]).toEqual(s(1.5));
    // Without a PING with no call in flight, nothing refreshes an idle flow
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(never);
    expect(made({}, { keepaliveWithoutCalls: true }).client.declaration.knobs["idle_refresh_interval"]).toEqual(s(1));
    expect(made({ keepalive_time: never }).client.declaration.knobs["heartbeat_detection_time"]).toEqual(never);
    expect(client.declaration.operations).toEqual({
      [HEALTH_CHECK]: { idempotent: true },
      [GET]: { idempotent: true },
      [PUT]: { idempotent: false },
    });
  });

  it("refuses what the client cannot do, and says why", () => {
    expect(specProblems("rpc", spec())).toEqual([]);
    expect(specProblems("rpc", spec({ request_timeout: ms(0) }))).toEqual([
      "rpc's request_timeout is not a finite time above zero: the timer of the wrapper is the only bound of a call",
    ]);
    expect(specProblems("rpc", spec({ keepalive_time: s(0) }))).toEqual(['rpc\'s keepalive_time is zero: give "infinite" for no bound']);
    expect(specProblems("rpc", spec({ keepalive_timeout: ms(1.5) }))).toEqual(["rpc's keepalive_timeout is not a whole number of milliseconds"]);
    expect(specProblems("rpc", spec({ keepalive_timeout: never as never }))).toEqual(["rpc's keepalive_timeout is not a finite time above zero"]);
    expect(specProblems("rpc", spec({ client_idle_timeout: s(3_000_000) }))).toEqual([
      "rpc's client_idle_timeout is above 2147483647 ms, the longest timer of Node",
    ]);
    expect(specProblems("rpc", spec({ client_idle_timeout: ms(500) }))).toEqual(["rpc's client_idle_timeout is below 1 s: grpc-js raises it to 1 s"]);
    expect(specProblems("rpc", spec({ retry_cap: ms(50) }))).toEqual(["rpc's retry_cap is below its retry_base"]);
    expect(specProblems("rpc", spec({ keepalive_idle: s(5) }))).toEqual([
      'rpc\'s keepalive_idle is not "infinite": grpc-js sets no TCP keepalive, and the PING of keepalive_time is its keepalive',
    ]);
    expect(specProblems("rpc", spec({ max_connection_age: s(60) }))).toEqual([
      'rpc\'s max_connection_age is not "infinite": grpc-js does not replace its connection at an age',
    ]);
    expect(specProblems("rpc", spec({}, { password: "secret" }))).toEqual(["rpc takes no password: give the credentials in metadata, for example authorization"]);
    expect(() => grpcClient("rpc", spec({ close_bound: ms(-1) }))).toThrow(/close_bound is not a time of zero or more/);
  });

  it("gives grpc-js each timer from the declaration, its retries off, and no service config from the resolver", () => {
    expect(grpcOptions(spec())).toEqual({
      target: "rpc:50051",
      options: {
        "grpc.enable_retries": 0,
        "grpc.service_config_disable_resolution": 1,
        "grpc.keepalive_time_ms": 1000,
        "grpc.keepalive_timeout_ms": 500,
        "grpc.keepalive_permit_without_calls": 0,
        "grpc.client_idle_timeout_ms": 5000,
        "grpc.initial_reconnect_backoff_ms": 100,
        "grpc.max_reconnect_backoff_ms": 400,
      },
    });
    // "infinite" sends no PING, as grpc-js does at its defaults, and an IPv6 host goes in brackets
    const open = grpcOptions(spec({ keepalive_time: never }, { host: "::1", keepaliveWithoutCalls: true }));
    expect(open.target).toBe("[::1]:50051");
    expect(open.options).not.toHaveProperty("grpc.keepalive_time_ms");
    expect(open.options["grpc.keepalive_permit_without_calls"]).toBe(1);
  });

  it("starts from knobs that the gRPC cells measured, and they hold the borders of the law", () => {
    const start = spec(GRPC_CLIENT_STARTING_KNOBS, { keepaliveWithoutCalls: GRPC_CLIENT_STARTING_WITHOUT_CALLS });
    expect(specProblems("rpc", start)).toEqual([]);
    expect(GRPC_CLIENT_STARTING_POLL).toBe(STARTING_POLL);
    const client = grpcClient("rpc", start, { dial: async () => {} });
    // One PING each 300 s, and no ACK in 20 s
    expect(client.declaration.knobs["heartbeat_detection_time"]).toEqual(s(320));
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(never);
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(30))
      .phase("tear down dependencies", s(5))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll: GRPC_CLIENT_STARTING_POLL, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([]);
  });
});

describe("the dial: the HTTP/2 preface, and a SETTINGS frame", () => {
  it("sends the connection preface of RFC 9113, and an empty SETTINGS frame", () => {
    expect(HTTP2_PREFACE.toString("hex")).toBe(`${Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1").toString("hex")}000000040000000000`);
    expect(grpcDial).toBeTypeOf("function");
  });

  it("passes only a SETTINGS frame on stream 0 with no ACK, and waits for 9 bytes", () => {
    expect(settingsJudge(Buffer.from([0, 0, 6, 4, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 100]))).toBeNull();
    expect(settingsJudge(Buffer.from([0, 0, 0, 4]))).toBe("more");
    expect(String(settingsJudge(Buffer.from([0, 0, 0, 4, 1, 0, 0, 0, 0])))).toBe(
      "Error: the server did not answer the HTTP/2 preface with a SETTINGS frame: its first bytes are 000000040100000000",
    );
    expect(String(settingsJudge(Buffer.from("HTTP/1.1 400 Bad Request\r\n")))).toBe(
      "Error: the server did not answer the HTTP/2 preface with a SETTINGS frame: its first bytes are 485454502f312e3120",
    );
  });
});

describe("the outcome of each status code: certain, not sent, or indeterminate (C8)", () => {
  const CERTAIN = ["INVALID_ARGUMENT", "NOT_FOUND", "ALREADY_EXISTS", "PERMISSION_DENIED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED", "UNAUTHENTICATED"];
  const INDETERMINATE = ["CANCELLED", "UNKNOWN", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS"];

  it("gives OK as ok, with the bytes of the response", () => {
    expect(grpcOutcome({ code: 0, details: "" }, bytes("v"))).toEqual({ outcome: "ok", value: bytes("v") });
    expect(grpcOutcome({ code: 0, details: "" }, undefined)).toEqual({ outcome: "ok", value: Buffer.alloc(0) });
  });

  it("gives each code that tells a refusal as a certain error, and each other code as indeterminate", () => {
    expect(GRPC_CODES).toHaveLength(17);
    expect([...CERTAIN, ...INDETERMINATE, "OK"].sort()).toEqual([...GRPC_CODES].sort());
    for (const name of CERTAIN)
      expect(grpcOutcome({ code: GRPC_CODES.indexOf(name as never), details: "x" }, undefined), name).toEqual({ outcome: "error", error: `${name}: x`, reply: true });
    for (const name of INDETERMINATE)
      expect(grpcOutcome({ code: GRPC_CODES.indexOf(name as never), details: "x" }, undefined), name).toEqual({ outcome: "indeterminate", error: `${name}: x` });
    expect(codeName(99)).toBe("code 99");
  });

  it("gives a status that tells that the call did not leave the client as not sent, and the same code after the send as indeterminate", () => {
    const sentNot: GrpcStatus[] = [
      { code: 14, details: "No connection established. Last error: connect ECONNREFUSED 127.0.0.1:50051" },
      { code: 14, details: "Name resolution failed for target dns:rpc:50051" },
      { code: 14, details: "Stream refused by server" },
      { code: 13, details: "Failed to start HTTP/2 stream with error Error: The session has been destroyed" },
      { code: 4, details: "Deadline exceeded after 0.801s,Waiting for LB pick" },
      { code: 4, details: "Deadline exceeded after 0.801s,waiting for name resolution" },
    ];
    for (const status of sentNot) expect(grpcOutcome(status, undefined), status.details).toMatchObject({ outcome: "error", reply: false });
    const after: GrpcStatus[] = [
      { code: 14, details: "Connection dropped" },
      { code: 13, details: "Received RST_STREAM with code 2 triggered by internal client error" },
      { code: 4, details: "Deadline exceeded after 0.801s,LB pick: 0.000s,remote_addr=127.0.0.1:50051" },
      { code: 1, details: "Call cancelled" },
    ];
    for (const status of after) expect(grpcOutcome(status, undefined).outcome, status.details).toBe("indeterminate");
  });

  it("takes the idempotency of each method from its proto", () => {
    expect(grpcOperations({ "/a.A/Get": "NO_SIDE_EFFECTS", "/a.A/Set": "IDEMPOTENT", "/a.A/Add": "IDEMPOTENCY_UNKNOWN" })).toEqual({
      "/a.A/Get": { idempotent: true },
      "/a.A/Set": { idempotent: true },
      "/a.A/Add": { idempotent: false },
    });
  });
});

describe("the health service: a HealthCheckRequest, and the status of its response", () => {
  it("encodes the request, with no field for the whole server", () => {
    expect(healthRequest("")).toEqual(Buffer.alloc(0));
    expect(healthRequest("kv").toString("hex")).toBe("0a026b76");
    expect(healthRequest("x".repeat(200)).subarray(0, 3).toString("hex")).toBe("0ac801");
  });

  it("decodes each status, skips an unknown field, and refuses bytes that are not a response", () => {
    expect(healthStatus(Buffer.alloc(0))).toBe("UNKNOWN");
    expect(healthStatus(SERVING_REPLY)).toBe("SERVING");
    expect(healthStatus(Buffer.from([8, 2]))).toBe("NOT_SERVING");
    expect(healthStatus(Buffer.from([8, 3]))).toBe("SERVICE_UNKNOWN");
    expect(healthStatus(Buffer.from([0x12, 1, 0x41, 8, 1]))).toBe("SERVING");
    expect(healthStatus(Buffer.from([8, 9]))).toBeNull();
    expect(healthStatus(Buffer.from([0x12, 5, 0x41]))).toBeNull();
    expect(healthStatus(Buffer.from([8]))).toBeNull();
    expect(healthStatus(Buffer.from([0x0b]))).toBeNull();
  });

  it("sends a Check, and gives the serving status", async () => {
    const { client, server } = await connected();
    server.answer = () => Buffer.from([8, 3]);
    expect(await client.health("kv")).toEqual({ outcome: "ok", value: "SERVICE_UNKNOWN", attempts: 1 });
    expect(server.latest().calls[0]).toMatchObject({ method: HEALTH_CHECK, request: healthRequest("kv") });
    server.answer = () => Buffer.from([8, 9]);
    expect(await client.health()).toEqual({ outcome: "error", error: "the response is not a HealthCheckResponse", reply: true, attempts: 1 });
  });
});

describe("the join at each generation: the target, and a new generation at each READY (D1, D2)", () => {
  it("records each READY of the channel, and a new generation after a reset", async () => {
    const { client, server, clock, on } = await connected();
    expect(client.status).toBe("ready");
    expect(client.joins).toEqual([{ generation: 1, at: 1000, target: "rpc:50051", localAddress: null, localPort: null, remoteAddress: null, remotePort: null }]);
    await clock.advance(50);
    server.latest().reset();
    await clock.advance(0);
    expect(client.status).toBe("ready");
    expect(client.joins.map((join) => [join.generation, join.at])).toEqual([
      [1, 1000],
      [2, 1050],
    ]);
    expect(on("connection.end").map((event) => event.at)).toEqual([1050]);
    expect(on("channel.connecting")).toHaveLength(1);
    expect(server.channels).toHaveLength(1);
  });

  it("ends the startup at TRANSIENT_FAILURE, and joins when a try of grpc-js passes", async () => {
    const { client, server, clock, on } = made();
    server.mode = "refuse";
    await client.handle.connect(new AbortController().signal);
    expect(client.status).toBe("failing");
    expect(clock.now()).toBe(1000);
    expect(await client.call(PUT, bytes("v"))).toMatchObject({ outcome: "error", reply: false, attempts: 1 });
    server.mode = "up";
    await clock.advance(100);
    expect(client.status).toBe("ready");
    expect(client.joins.map((join) => join.at)).toEqual([1100]);
    expect(on("connect.failed")).toHaveLength(1);
  });

  it("bounds the startup at connect_bound when the connect does not end", async () => {
    const { client, server, clock } = made();
    server.mode = "silent";
    const connecting = client.handle.connect(new AbortController().signal);
    await clock.advance(500);
    await connecting;
    expect(client.status).toBe("connecting");
    expect(clock.now()).toBe(1500);
    expect(await client.call(PUT, bytes("v"))).toEqual({
      outcome: "error",
      error: "rpc is connecting, not ready: the call did not leave the client",
      reply: false,
      attempts: 1,
    });
  });

  it("connects again at once when client_idle_timeout puts the channel in IDLE", async () => {
    const { client, clock, on } = await connected();
    await clock.advance(5000);
    expect(on("connection.end").map((event) => event.at)).toEqual([6000]);
    expect(client.status).toBe("ready");
    expect(client.joins).toHaveLength(2);
  });

  it("keeps a call in flight across a GOAWAY, and joins a new generation", async () => {
    const { client, server, clock } = await connected();
    server.replyDelay = 100;
    const pending = client.call(PUT, bytes("v"));
    await clock.advance(10);
    server.latest().goaway();
    await clock.advance(0);
    expect(client.joins).toHaveLength(2);
    await clock.advance(100);
    expect(await pending).toEqual({ outcome: "ok", value: bytes("v"), attempts: 1 });
  });
});

describe("three outcomes, never an empty success (C7, C8, C10)", () => {
  it("gives the response as ok, and a refusal of the server as a certain error", async () => {
    const { client, server } = await connected({}, { metadata: { authorization: "Bearer t" } });
    expect(await client.call(PUT, bytes("v"), { metadata: { "x-id": "1" } })).toEqual({ outcome: "ok", value: bytes("v"), attempts: 1 });
    expect(server.latest().calls[0]).toMatchObject({ method: PUT, metadata: { authorization: "Bearer t", "x-id": "1" }, timeout: 800 });
    server.answer = () => ({ code: 5, details: "no such key" });
    // A certain error is not sent again, also for an idempotent method
    expect(await client.call(GET, bytes("k"))).toEqual({ outcome: "error", error: "NOT_FOUND: no such key", reply: true, attempts: 1 });
  });

  it("does not send a call before the connect, or after the caller aborted it", async () => {
    const { client } = made();
    expect(await client.call(PUT, bytes("v"))).toEqual({ outcome: "error", error: "rpc has not connected", reply: false, attempts: 1 });
    await client.handle.connect(new AbortController().signal);
    const abort = new AbortController();
    abort.abort();
    expect(await client.call(PUT, bytes("v"), { signal: abort.signal })).toMatchObject({ outcome: "error", reply: false });
  });

  it("ends a call with no reply at request_timeout as indeterminate, and the channel stays", async () => {
    const { client, server, clock } = await connected();
    server.mode = "stall";
    const pending = client.call(GET, bytes("k"));
    await clock.advance(800);
    expect(await pending).toEqual({
      outcome: "indeterminate",
      error: "DEADLINE_EXCEEDED: Deadline exceeded after 0.800s,LB pick: 0.000s,remote_addr=127.0.0.1:50051",
      attempts: 1,
    });
    expect(client.status).toBe("ready");
    expect(client.joins).toHaveLength(1);
  });

  it("cancels a call that the caller abandons: grpc-js sends RST_STREAM CANCEL", async () => {
    const { client, server, clock } = await connected();
    server.mode = "stall";
    const abort = new AbortController();
    const pending = client.call(PUT, bytes("v"), { signal: abort.signal });
    await clock.advance(10);
    abort.abort();
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    expect(server.latest().calls[0]).toMatchObject({ cancelled: true, status: { code: 1 } });
  });
});

describe("a second try: only an idempotent method, one time, in the bound of the call (C8)", () => {
  it("sends an idempotent call again on the next generation, with the deadline that is left", async () => {
    const { client, server, clock, on } = await connected();
    server.replyDelay = 50;
    const pending = client.call(GET, bytes("k"));
    await clock.advance(10);
    server.latest().reset();
    await clock.advance(50);
    expect(await pending).toEqual({ outcome: "ok", value: bytes("k"), attempts: 2 });
    expect(server.latest().calls.map((call) => call.timeout)).toEqual([800, 790]);
    expect(on("command.reissue")).toHaveLength(1);
  });

  it("does not send again a method that is not idempotent, or one that the table does not name", async () => {
    const { client, server, clock } = await connected();
    server.replyDelay = 50;
    const put = client.call(PUT, bytes("v"));
    const other = client.call("/kv.KV/Watch", bytes("v"));
    await clock.advance(10);
    server.latest().reset();
    await clock.advance(50);
    expect(await put).toEqual({ outcome: "indeterminate", error: "UNAVAILABLE: Connection dropped", attempts: 1 });
    expect(await other).toEqual({ outcome: "indeterminate", error: "UNAVAILABLE: Connection dropped", attempts: 1 });
    expect(server.latest().calls).toHaveLength(2);
  });
});

describe("the keepalive: the HTTP/2 PING of grpc-js, and the end of a silent transport", () => {
  it("ends a silent transport at keepalive_time + keepalive_timeout with a call in flight", async () => {
    const { client, server, clock, on } = await connected({ request_timeout: s(5) });
    server.mode = "silent";
    const pending = client.call(PUT, bytes("v"));
    await clock.advance(1500);
    expect(await pending).toEqual({ outcome: "indeterminate", error: "UNAVAILABLE: Connection dropped", attempts: 1 });
    expect(server.latest().pings).toEqual([2000]);
    expect(on("connection.end").map((event) => event.at)).toEqual([2500]);
    expect(client.status).toBe("connecting");
  });

  it("sends no PING with no call in flight, unless keepaliveWithoutCalls permits it", async () => {
    const quiet = await connected();
    quiet.server.mode = "silent";
    await quiet.clock.advance(3000);
    expect(quiet.server.latest().pings).toEqual([]);
    expect(quiet.client.status).toBe("ready");
    const pinging = await connected({}, { keepaliveWithoutCalls: true });
    pinging.server.mode = "silent";
    await pinging.clock.advance(1500);
    expect(pinging.server.latest().pings).toEqual([2000]);
    expect(pinging.on("connection.end").map((event) => event.at)).toEqual([2500]);
  });

  it("keeps a transport whose library answers each PING: a stall is not a death", async () => {
    const { client, server, clock } = await connected({ request_timeout: s(5) });
    server.mode = "stall";
    const pending = client.call(PUT, bytes("v"));
    await clock.advance(5000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: expect.stringMatching(/^DEADLINE_EXCEEDED/) });
    expect(server.latest().pings).toEqual([2000, 3000, 4000, 5000]);
    expect(client.joins).toHaveLength(1);
  });
});

describe("the close: the calls in flight in their bound, then RST_STREAM CANCEL (A9, A14, principle 9)", () => {
  it("closes at once with no call in flight, and the channel is SHUTDOWN", async () => {
    const { client, clock, server } = await connected();
    await client.handle.close();
    expect(clock.now()).toBe(1000);
    expect(client.status).toBe("end");
    expect(server.latest().state(false)).toBe("SHUTDOWN");
  });

  it("waits for a call in flight, then closes", async () => {
    const { client, clock, server } = await connected();
    server.replyDelay = 100;
    const pending = client.call(PUT, bytes("v"));
    await clock.advance(0);
    const closing = client.handle.close();
    await clock.advance(100);
    await closing;
    expect(await pending).toMatchObject({ outcome: "ok" });
    expect(clock.now()).toBe(1100);
  });

  it("cancels each call at the bound when the server holds its reply, and settles what is in flight", async () => {
    const { client, server, clock, on, events } = await connected({ request_timeout: s(5) });
    server.mode = "stall";
    const pending = client.call(PUT, bytes("v"));
    await clock.advance(10);
    const closing = client.handle.close();
    await clock.advance(300);
    await closing;
    expect(events.map((each) => each.on).filter((name) => name.startsWith("close"))).toEqual(["close.request", "close.bound", "close.destroy"]);
    expect(on("status.end").map((ended) => ended.at)).toEqual([1310]);
    expect(await pending).toEqual({ outcome: "indeterminate", error: "the client closed with the call in flight", attempts: 1 });
    expect(server.latest().calls[0]!.cancelled).toBe(true);
  });

  it("stops the tries of grpc-js to connect at the close", async () => {
    const { client, server, clock } = made();
    server.mode = "refuse";
    await client.handle.connect(new AbortController().signal);
    await client.handle.close();
    await clock.advance(5000);
    expect(server.latest().connects).toEqual([1000]);
    expect(client.status).toBe("end");
  });
});

describe("the checks of each step of the connection (B7, B14)", () => {
  const poll = { interval: s(1), jitter: 0.2, timeout: ms(400) };

  it("gives a check for each step asked, with its policy, and whether it uses the application's connection", () => {
    const { client } = made();
    const checks = client.checks({ poll, steps: { "round-trip": "readiness", dial: null, "local-state": "liveness" } });
    expect(checks.map(([check]) => [check.name, check.step, check.gates, check.ownConnection])).toEqual([
      ["rpc.local-state", "local-state", "liveness", true],
      ["rpc.round-trip", "round-trip", "readiness", true],
      ["rpc.dial", "dial", null, false],
    ]);
  });

  it("passes a Check that answers SERVING on the channel of the application, and fails NOT_SERVING or a client that is not ready", async () => {
    const { client, server, clock } = await connected();
    const checks = client.checks({ poll, steps: { "local-state": "liveness", "round-trip": "readiness" } });
    const local = checks[0]![1];
    const roundTrip = checks[1]![1];
    expect(await roundTrip(new AbortController().signal)).toBe("ok");
    expect(await local(new AbortController().signal)).toBe("ok");
    server.answer = () => Buffer.from([8, 2]);
    expect(await roundTrip(new AbortController().signal)).toBe("error");
    server.mode = "refuse";
    server.latest().reset();
    await clock.advance(0);
    expect(client.status).toBe("failing");
    expect(await roundTrip(new AbortController().signal)).toBe("error");
    expect(await local(new AbortController().signal)).toBe("error");
  });

  const svc = () =>
    service("app")
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(6) })
      .startup(s(10))
      .phase("tear down dependencies", s(2))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));

  it("says when its close does not fit in its phase, or its call outlives a poll (O13)", () => {
    const { client } = made({ request_timeout: s(5), close_bound: s(3) });
    const app = svc();
    client.attach(app, { poll, steps: { "round-trip": "readiness" } });
    expect(client.problems(app.describe())).toEqual([
      'rpc\'s close_bound of 3000 ms does not fit in the cap of "tear down dependencies"',
      "rpc's request_timeout outlives one jittered poll of rpc.round-trip (B7, O13)",
    ]);
  });

  it("says when the server closes an idle connection first (O01), or its PING comes too often (O26)", () => {
    const { client } = made({ server_idle_close: s(5), server_keepalive_min_time: s(300) });
    const app = svc();
    client.attach(app, { poll, steps: { "round-trip": "readiness" } });
    expect(client.problems(app.describe())).toEqual([
      "rpc's client_idle_timeout is not below the idle close of its server: a request can go on a connection that the server closed (O01)",
      "rpc's keepalive_time is below server_keepalive_min_time: the server answers with GOAWAY too_many_pings (O26)",
    ]);
    const open = made({ server_idle_close: never, keepalive_time: never }).client;
    const other = svc();
    open.attach(other, { poll, steps: { "round-trip": "readiness" } });
    expect(open.problems(other.describe())).toEqual([]);
  });
});

describe("the manifestations that the client meets, and their detectors (E9, C3)", () => {
  it("finds each manifestation in each situation with the starting knobs", () => {
    const client = grpcClient("rpc", spec(GRPC_CLIENT_STARTING_KNOBS, { keepaliveWithoutCalls: false }), { dial: async () => {} });
    const meet = (name: string) => client.meets.find((meeting) => meeting.manifestation === name)!;
    expect(firstDetector(meet("blackhole"), "in flight")).toMatchObject({ by: "request_timeout", within: s(9.5) });
    expect(firstDetector(meet("blackhole"), "idle")).toMatchObject({ by: "client_idle_timeout", within: s(60) });
    expect(firstDetector(meet("freeze-process"), "idle")).toMatchObject({ by: "client_idle_timeout", within: s(60) });
    expect(firstDetector(meet("rst"), "idle")).toMatchObject({ by: "client_idle_timeout", within: s(60) });
    expect(firstDetector(meet("fin"), "idle")).toMatchObject({ within: s(0) });
    expect(firstDetector(meet("app-stall"), "in flight")).toMatchObject({ by: "request_timeout", within: s(9.5) });
    expect(unwatched(client.meets)).toEqual([{ manifestation: "app-stall", situation: "idle" }]);
  });

  it("finds a silent idle connection by the PING when keepaliveWithoutCalls permits it", () => {
    const client = made({ keepalive_time: s(30), keepalive_timeout: s(20), client_idle_timeout: s(300) }, { keepaliveWithoutCalls: true }).client;
    const meet = (name: string) => client.meets.find((meeting) => meeting.manifestation === name)!;
    expect(firstDetector(meet("blackhole"), "idle")).toMatchObject({ by: "heartbeat_detection_time", within: s(50) });
    expect(firstDetector(meet("rst"), "idle")).toMatchObject({ by: "keepalive_time", within: s(30) });
    // With no PING, client_idle_timeout still finds each manifestation but the stall of an idle server
    expect(unwatched(made({ keepalive_time: never }).client.meets)).toEqual([{ manifestation: "app-stall", situation: "idle" }]);
  });
});

describe("the client as a document (D4, E8)", () => {
  it("is a valid, consistent machine document", () => {
    expect(machineSchema.safeParse(GRPC_CLIENT_MACHINE).success).toBe(true);
    expect(machineProblems(GRPC_CLIENT_MACHINE)).toEqual([]);
  });

  const scenarios: Record<string, (all: Awaited<ReturnType<typeof connected>>) => Promise<void>> = {
    "a reset, and a new generation": async ({ client, server, clock }) => {
      server.latest().reset();
      await clock.advance(0);
      await client.call(GET, bytes("k"));
    },
    "a refused server, then a server that is back": async ({ client, server, clock }) => {
      server.mode = "refuse";
      server.latest().reset();
      await clock.advance(0);
      await client.call(PUT, bytes("v"));
      server.mode = "up";
      await clock.advance(100);
      await client.call(PUT, bytes("v"));
    },
    "the keepalive of a silent server, and a connect that does not end": async ({ client, server, clock }) => {
      server.mode = "silent";
      const pending = client.call(PUT, bytes("v"));
      await clock.advance(1500);
      await pending;
      await clock.advance(1000);
    },
    "an idle channel, and a GOAWAY": async ({ server, clock }) => {
      await clock.advance(5000);
      server.latest().goaway();
      await clock.advance(0);
    },
    "a call sent again": async ({ client, server, clock }) => {
      server.replyDelay = 50;
      const pending = client.call(GET, bytes("k"));
      await clock.advance(10);
      server.latest().reset();
      await clock.advance(50);
      await pending;
    },
    "a bounded close of a stalled server": async ({ client, server, clock }) => {
      server.mode = "stall";
      const pending = client.call(PUT, bytes("v"));
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
      expect(replay(GRPC_CLIENT_MACHINE, all.events)).toEqual([]);
    });
  }
});

describe("grpc-js on loopback: the real driver against a real server", () => {
  /** This type is the part of grpc-js that the test uses for its server. */
  interface Loaded {
    Server: new () => {
      addService(service: Record<string, unknown>, handlers: Record<string, (call: { request: Buffer }, callback: (error: null, value: Buffer) => void) => void>): void;
      bindAsync(port: string, credentials: unknown, callback: (error: Error | null, port: number) => void): void;
      tryShutdown(callback: () => void): void;
    };
    ServerCredentials: { createInsecure(): unknown };
  }

  it("connects, answers a call and a Check, passes the dial, and closes", async () => {
    const specifier = "@grpc/grpc-js";
    const grpc = (await import(specifier)) as Loaded;
    const server = new grpc.Server();
    const identity = (value: Buffer) => value;
    const method = (path: string) => ({
      path,
      requestStream: false,
      responseStream: false,
      requestSerialize: identity,
      requestDeserialize: identity,
      responseSerialize: identity,
      responseDeserialize: identity,
    });
    server.addService(
      { Check: method(HEALTH_CHECK), Put: method(PUT) },
      {
        Check: (_call, callback) => callback(null, SERVING_REPLY),
        Put: (call, callback) => callback(null, call.request),
      },
    );
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => (error === null ? resolve(bound) : reject(error))),
    );
    const live = { ...spec({ request_timeout: s(2), connect_bound: s(2), close_bound: s(2) }), host: "127.0.0.1", port };
    const client = grpcClient("rpc", live, { create: nodeGrpc });
    try {
      await client.handle.connect(new AbortController().signal);
      expect(client.status).toBe("ready");
      expect(client.joins[0]).toMatchObject({ generation: 1, target: `127.0.0.1:${port}` });
      expect(await client.call(PUT, bytes("v"))).toEqual({ outcome: "ok", value: bytes("v"), attempts: 1 });
      expect(await client.health()).toEqual({ outcome: "ok", value: "SERVING", attempts: 1 });
      expect(await client.call("/kv.KV/Missing", bytes("v"))).toMatchObject({ outcome: "error", error: expect.stringMatching(/^UNIMPLEMENTED/), reply: true });
      await expect(grpcDial("127.0.0.1", port, new AbortController().signal)).resolves.toBeUndefined();
    } finally {
      await client.handle.close();
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
    expect(client.status).toBe("end");
  });
});
