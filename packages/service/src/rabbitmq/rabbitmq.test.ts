import { machineProblems, machineSchema } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import type { JobSettle, JobSource, LifecycleEvent } from "../index.ts";
import { replay, service } from "../index.ts";
import { fakeClock } from "../testing.ts";
import type { RabbitClientSpec, RabbitConnectOptions, RabbitDelivery, RabbitKnobs } from "../rabbitmq.ts";
import {
  AMQP_HEADER,
  RABBIT_CLIENT_MACHINE,
  RABBIT_STARTING_KNOBS,
  RABBIT_STARTING_POLL,
  deliveryCount,
  failureOutcome,
  firstDetector,
  rabbitClient,
  rabbitOptions,
  specProblems,
  startJudge,
  unwatched,
} from "../rabbitmq.ts";
import { IllegalOperationError, fakeBroker } from "./fake.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const never = { value: "infinite" as const, unit: "s" };

// the heartbeat of 1 s ends a silent connection 3 s after the broker goes silent
const KNOBS: RabbitKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  heartbeat_interval: s(1),
  retry_base: ms(100),
  retry_cap: ms(400),
  keepalive_idle: s(5),
  max_connection_age: never,
  close_bound: ms(300),
  retrans_giveup_time: s(924.6),
};

const spec = (knobs: Partial<RabbitKnobs> = {}, more: Partial<RabbitClientSpec> = {}): RabbitClientSpec => ({
  host: "rabbit",
  port: 5672,
  system: "systems.component.rabbitmq",
  knobs: { ...KNOBS, ...knobs },
  seeds: [{ host: "rabbit2", port: 5673 }],
  operations: { "send event": { idempotent: true }, "send order": { idempotent: false }, "take job": { idempotent: true } },
  ...more,
});

/** a client on a fake broker and a fake clock, its events, and the options of each connect. The jitter is 0 */
const made = (knobs: Partial<RabbitKnobs> = {}, more: Partial<RabbitClientSpec> = {}) => {
  const clock = fakeClock(1000);
  const events: LifecycleEvent[] = [];
  const broker = fakeBroker(clock);
  const given: RabbitConnectOptions[] = [];
  const client = rabbitClient("mq", spec(knobs, more), {
    clock,
    random: () => 0,
    record: (event) => events.push(event),
    dial: async () => {},
    create: (options) => {
      given.push(options);
      return broker.create(options);
    },
  });
  const on = (name: string) => events.filter((event) => event.on === name);
  return { clock, client, events, broker, given, on };
};

/** a connected client: one connection and its confirm channel */
const connected = async (knobs: Partial<RabbitKnobs> = {}, more: Partial<RabbitClientSpec> = {}) => {
  const all = made(knobs, more);
  await all.client.handle.connect(new AbortController().signal);
  return all;
};

const event = { exchange: "events", routingKey: "a", content: "hi" };

describe("the declaration: knobs by the names of the law, and no default (C1, C2, E3)", () => {
  it("declares each knob as a time, the detection of the heartbeat, and the half heartbeat as the refresh of an idle flow", () => {
    const { client } = made();
    expect(Object.keys(client.declaration.knobs).sort()).toEqual(
      [
        "close_bound",
        "connect_bound",
        "heartbeat_detection_time",
        "heartbeat_interval",
        "idle_refresh_interval",
        "keepalive_idle",
        "max_connection_age",
        "request_timeout",
        "retrans_giveup_time",
        "retry_base",
        "retry_cap",
      ].sort(),
    );
    expect(client.declaration.knobs["heartbeat_detection_time"]).toEqual(s(3));
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(s(0.5));
    expect(client.declaration.operations["send order"]).toEqual({ idempotent: false });
    // with no heartbeat, nothing detects a silent connection, and keepalive refreshes an idle flow
    const open = made({ heartbeat_interval: never }).client.declaration.knobs;
    expect(open["heartbeat_detection_time"]).toEqual(never);
    expect(open["idle_refresh_interval"]).toEqual(s(5));
  });

  it("refuses what amqplib cannot do, and says why", () => {
    expect(specProblems("mq", spec({ request_timeout: ms(0) }))).toEqual([
      "mq's request_timeout is not a finite time above zero: the timer of the wrapper is the only bound of a call",
    ]);
    expect(specProblems("mq", spec({ connect_bound: never as never }))).toEqual([
      "mq's connect_bound is not a finite time above zero: amqplib reads 0 as no bound",
    ]);
    expect(specProblems("mq", spec({ heartbeat_interval: s(0) }))).toEqual(['mq\'s heartbeat_interval is zero: give "infinite" for no bound']);
    expect(specProblems("mq", spec({ heartbeat_interval: ms(1500) }))).toEqual(["mq's heartbeat_interval is not a whole number of seconds"]);
    expect(specProblems("mq", spec({ keepalive_idle: ms(2500) }))).toEqual(["mq's keepalive_idle is not a whole number of seconds"]);
    expect(specProblems("mq", spec({ retry_cap: ms(50) }))).toEqual(["mq's retry_cap is below its retry_base"]);
    expect(specProblems("mq", spec({ max_connection_age: s(1800) }))).toEqual([
      'mq\'s max_connection_age is not "infinite": the client does not replace its connection at an age',
    ]);
    expect(() => rabbitClient("mq", spec({ close_bound: ms(-1) }))).toThrow(/close_bound is not a time of zero or more/);
  });

  it("gives amqplib each timer from the declaration, the heartbeat in the URL, and the nodes in sequence", () => {
    expect(rabbitOptions("mq", spec({}, { username: "app", password: "p w", vhost: "/" }))).toEqual({
      url: "amqp://app:p%20w@rabbit:5672/%2F?heartbeat=1",
      socketOptions: { timeout: 500, noDelay: true, keepAlive: true, keepAliveDelay: 5000, clientProperties: { connection_name: "mq" } },
    });
    expect(rabbitOptions("mq", spec(), 1).url).toBe("amqp://rabbit2:5673/%2F?heartbeat=1");
    expect(rabbitOptions("mq", spec(), 2).url).toBe("amqp://rabbit:5672/%2F?heartbeat=1");
    // "infinite" asks for no heartbeat, and keepalive stays off, as at the defaults of amqplib
    expect(rabbitOptions("mq", spec({ heartbeat_interval: never, keepalive_idle: never }, { vhost: "orders" }))).toEqual({
      url: "amqp://rabbit:5672/orders?heartbeat=0",
      socketOptions: { timeout: 500, noDelay: true, keepAlive: false, clientProperties: { connection_name: "mq" } },
    });
  });

  it("starts from knobs that the cells of R3 measured, and they hold the borders of the law", () => {
    expect(specProblems("mq", spec(RABBIT_STARTING_KNOBS))).toEqual([]);
    const { client } = made(RABBIT_STARTING_KNOBS);
    expect(client.declaration.knobs["heartbeat_detection_time"]).toEqual(s(45));
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(s(7.5));
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(30))
      .phase("tear down dependencies", s(5))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll: RABBIT_STARTING_POLL, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([]);
  });
});

describe("the dial: the protocol header, and connection.start", () => {
  /** a method frame on a channel: type, channel, size, class, method, and no arguments */
  const frame = (type: number, channel: number, classId: number, methodId: number) => {
    const bytes = Buffer.alloc(11);
    bytes.writeUInt8(type, 0);
    bytes.writeUInt16BE(channel, 1);
    bytes.writeUInt32BE(4, 3);
    bytes.writeUInt16BE(classId, 7);
    bytes.writeUInt16BE(methodId, 9);
    return bytes;
  };

  it("sends the header of AMQP 0-9-1", () => {
    expect(Buffer.from(AMQP_HEADER).toString("latin1")).toBe("AMQP\u0000\u0000\u0009\u0001");
  });

  it("passes connection.start, waits for the whole frame head, and refuses a bad answer", () => {
    expect(startJudge(frame(1, 0, 10, 10))).toBeNull();
    expect(startJudge(frame(1, 0, 10, 10).subarray(0, 3))).toBe("more");
    expect(startJudge(frame(1, 0, 10, 10).subarray(0, 10))).toBe("more");
    expect(String(startJudge(Buffer.from("AMQP\u0000\u0000\u0009\u0000", "latin1")))).toMatch(/refused the version/);
    expect(String(startJudge(frame(8, 0, 10, 10)))).toMatch(/type 8 on channel 0/);
    expect(String(startJudge(frame(1, 1, 10, 10)))).toMatch(/channel 1/);
    expect(String(startJudge(frame(1, 0, 10, 11)))).toMatch(/method 10\.11, not connection\.start/);
  });
});

describe("the join at each generation: the node and the name of the connection (D1, D2)", () => {
  it("records the node, the generation and the ends of the socket when the confirm channel opens", async () => {
    const { client, given } = await connected();
    expect(client.status).toBe("ready");
    expect(client.joins).toEqual([
      {
        generation: 1,
        at: 1000,
        address: "rabbit:5672",
        connectionName: "10.0.0.2:50001 -> 10.0.0.3:5672",
        localAddress: "10.0.0.2",
        localPort: 50001,
        remoteAddress: "10.0.0.3",
        remotePort: 5672,
      },
    ]);
    expect(given[0]?.socketOptions.clientProperties).toEqual({ connection_name: "mq" });
  });

  it("does not stop the startup for a broker that is down: it tries the next node after its backoff", async () => {
    const { client, broker, clock, on, given } = made();
    broker.mode = "refuse";
    await client.handle.connect(new AbortController().signal);
    expect(client.status).toBe("failing");
    // the backoff doubles from retry_base to retry_cap: 100, 200, 400 and 400 ms
    await clock.advance(1100);
    expect(on("retry.connect").map((retried) => retried.at)).toEqual([1100, 1300, 1700, 2100]);
    expect(given.map((options) => new URL(options.url).host)).toEqual(["rabbit:5672", "rabbit2:5673", "rabbit:5672", "rabbit2:5673", "rabbit:5672"]);
    broker.mode = "up";
    await clock.advance(400);
    expect(client.status).toBe("ready");
    expect(client.joins.map((joined) => [joined.at, joined.address])).toEqual([[2500, "rabbit2:5673"]]);
    // a join starts the backoff again from retry_base
    broker.latest().reset();
    await clock.advance(100);
    expect(client.status).toBe("ready");
    expect(client.joins.map((joined) => [joined.at, joined.address])).toEqual([
      [2500, "rabbit2:5673"],
      [2600, "rabbit:5672"],
    ]);
  });

  it("bounds the open of a connection and its channel at connect_bound", async () => {
    const { client, broker, clock, on } = made();
    broker.mode = "silent";
    const connecting = client.handle.connect(new AbortController().signal);
    await clock.advance(500);
    await connecting;
    expect(client.status).toBe("failing");
    expect(on("connect.failed").map((failed) => [failed.at, failed.detail])).toEqual([[1500, "rabbit:5672: no open connection and channel in connect_bound"]]);
  });
});

describe("three outcomes, never an empty success (C7, C8, C10)", () => {
  it("calls a confirm ok, and a call while the client is not ready not sent", async () => {
    const { client, broker } = made();
    expect(await client.publish("send order", event)).toEqual({ outcome: "error", error: "mq has not connected", reply: false, attempts: 1 });
    await client.handle.connect(new AbortController().signal);
    expect(await client.publish("send order", event)).toEqual({ outcome: "ok", value: undefined, attempts: 1 });
    expect(broker.published).toEqual([{ connection: 1, exchange: "events", routingKey: "a", content: "hi", options: {} }]);
  });

  it("calls a nack not certain: a queue of the route can hold the message", async () => {
    const { client, broker } = await connected();
    broker.confirm = "nack";
    expect(await client.publish("send order", event)).toMatchObject({ outcome: "indeterminate", error: expect.stringMatching(/nacked/), attempts: 1 });
  });

  it("calls a reply code of the broker certain, and the end of the channel ends the generation", async () => {
    const { client, clock, on } = await connected();
    expect(await client.get("take job", "nope")).toMatchObject({ outcome: "error", reply: true, error: expect.stringMatching(/^404 /), attempts: 1 });
    await clock.advance(0);
    expect(on("channel.error")).toHaveLength(1);
    expect(on("channel.end")).toHaveLength(1);
    expect(client.status).toBe("failing");
    await clock.advance(100);
    expect(client.status).toBe("ready");
    expect(client.joins).toHaveLength(2);
  });

  it("reads the fields of each error of amqplib, and depends on no class of it", () => {
    expect(failureOutcome(new IllegalOperationError("Channel closed"))).toEqual({ outcome: "error", error: "Channel closed", reply: false });
    expect(failureOutcome(Object.assign(new Error("PRECONDITION_FAILED"), { code: 406 }))).toEqual({
      outcome: "error",
      error: "406 PRECONDITION_FAILED",
      reply: true,
    });
    expect(failureOutcome(new Error("message nacked"))).toMatchObject({ outcome: "indeterminate" });
    expect(failureOutcome(new Error("channel closed"))).toEqual({ outcome: "indeterminate", error: "channel closed" });
    expect(failureOutcome(new Error("Channel ended, no reply will be forthcoming"))).toMatchObject({ outcome: "indeterminate" });
  });

  it("refuses each call as not sent while a resource alarm blocks the connection", async () => {
    const { client, broker, on } = await connected();
    broker.latest().block("low on memory");
    expect(client.status).toBe("blocked");
    expect(await client.publish("send order", event)).toMatchObject({ outcome: "error", reply: false, error: expect.stringMatching(/blocked, not ready/) });
    broker.latest().unblock();
    expect(client.status).toBe("ready");
    expect(await client.publish("send order", event)).toMatchObject({ outcome: "ok" });
    expect(on("connection.blocked").map((blocked) => blocked.detail)).toEqual(["low on memory"]);
    // the broker wrote one message: the first call did not leave the client
    expect(broker.published).toHaveLength(1);
  });

  it("ends a publish with no confirm at request_timeout as indeterminate, and the connection stays", async () => {
    const { client, broker, clock } = await connected();
    broker.confirm = "hold";
    const pending = client.publish("send order", event);
    await clock.advance(800);
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "no confirm in request_timeout: the broker can have the message" });
    expect(client.status).toBe("ready");
    // a late confirm changes nothing
    broker.release();
    await clock.advance(0);
    expect(client.status).toBe("ready");
  });

  it("settles a publish in flight as indeterminate at the reset of its connection", async () => {
    const { client, broker, clock } = await connected();
    broker.confirm = "hold";
    const pending = client.publish("send order", event);
    await clock.advance(10);
    broker.latest().reset();
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "channel closed", attempts: 1 });
    expect(client.status).toBe("failing");
  });

  it("gives up a call that the caller abandons as indeterminate: the broker can still have it (principle 9)", async () => {
    const { client, broker, clock } = await connected();
    broker.confirm = "hold";
    const abort = new AbortController();
    const pending = client.publish("send event", event, { signal: abort.signal });
    await clock.advance(10);
    abort.abort();
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "the caller abandoned the publish after it was written", attempts: 1 });
  });

  it("takes a message with basic.get, its count of deliveries, and null for an empty queue", async () => {
    const { client, broker } = await connected();
    broker.queues.set("jobs", [{ content: "a", redelivered: false }]);
    const taken = await client.get("take job", "jobs");
    expect(taken).toMatchObject({ outcome: "ok", value: { generation: 1, delivery: 1 }, attempts: 1 });
    expect(taken.outcome === "ok" ? taken.value?.message.content.toString("utf8") : null).toBe("a");
    expect(await client.get("take job", "jobs")).toEqual({ outcome: "ok", value: null, attempts: 1 });
  });

  it("counts the deliveries from x-delivery-count, else from redelivered", () => {
    const message = (redelivered: boolean, headers?: Record<string, unknown>) => ({
      content: Buffer.from(""),
      fields: { deliveryTag: 1, redelivered, exchange: "", routingKey: "jobs" },
      properties: headers === undefined ? {} : { headers },
    });
    expect(deliveryCount(message(false))).toBe(1);
    expect(deliveryCount(message(true))).toBe(2);
    expect(deliveryCount(message(true, { "x-delivery-count": 3 }))).toBe(4);
    expect(deliveryCount(message(true, { "x-delivery-count": "3" }))).toBe(2);
  });

  it("gives a message that comes after the call ended back to its queue at once", async () => {
    const { client, broker, clock } = await connected();
    broker.queues.set("jobs", [{ content: "late", redelivered: false }]);
    broker.mode = "silent";
    const pending = client.get("take job", "jobs");
    await clock.advance(800);
    // the bound of the call is spent, thus the client does not send it again
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "no reply to basic.get in request_timeout", attempts: 1 });
    broker.mode = "up";
    broker.answerWaiting();
    await clock.advance(0);
    expect(broker.settled).toEqual([{ kind: "requeue", content: "late" }]);
    expect(broker.queues.get("jobs")).toEqual([{ content: "late", redelivered: true }]);
  });
});

describe("a second try: only a named, idempotent operation, one time, in the bound of the call (C8)", () => {
  /** a publish whose connection resets before its confirm, and a broker that confirms the next one */
  const resetInFlight = async (operation: string, options = {}) => {
    const all = await connected();
    all.broker.confirm = "hold";
    const pending = all.client.publish(operation, event, options);
    await all.clock.advance(10);
    all.broker.confirm = "ack";
    all.broker.latest().reset();
    await all.clock.advance(100);
    return { ...all, sent: await pending };
  };

  it("sends an idempotent operation again after the client connects again, on the new connection", async () => {
    const { sent, broker, on } = await resetInFlight("send event");
    expect(sent).toEqual({ outcome: "ok", value: undefined, attempts: 2 });
    expect(broker.published.map((published) => published.connection)).toEqual([1, 2]);
    expect(on("command.reissue").map((reissued) => reissued.detail)).toEqual(["send event"]);
  });

  it("never sends again an operation that is not idempotent, or that the table does not name", async () => {
    for (const operation of ["send order", "send something"]) {
      const { sent, broker } = await resetInFlight(operation);
      expect(sent).toMatchObject({ outcome: "indeterminate", attempts: 1 });
      expect(broker.published).toHaveLength(1);
    }
    expect((await resetInFlight("send event", { reissue: false })).sent).toMatchObject({ outcome: "indeterminate", attempts: 1 });
  });

  it("sends a call again after an unblock in the bound of the call, and not after it", async () => {
    const { client, broker, clock } = await connected();
    broker.latest().block("low on disk");
    const pending = client.publish("send event", event);
    await clock.advance(300);
    broker.latest().unblock();
    expect(await pending).toEqual({ outcome: "ok", value: undefined, attempts: 2 });
    broker.latest().block("low on disk");
    const late = client.publish("send event", event);
    await clock.advance(800);
    expect(await late).toMatchObject({ outcome: "error", reply: false, attempts: 1 });
  });
});

describe("no error of amqplib ends the process (A5)", () => {
  it("listens to the error event of the connection and of the channel", async () => {
    const { broker, clock, on } = await connected();
    expect(() => broker.latest().reset()).not.toThrow();
    await clock.advance(100);
    expect(() => broker.latest().channels[0]!.closeByBroker(406, "PRECONDITION_FAILED")).not.toThrow();
    expect(on("connection.error")).toHaveLength(1);
    expect(on("channel.error")).toHaveLength(1);
  });

  it("the fake throws as Node does when nobody listens: the negative control", async () => {
    const broker = fakeBroker(fakeClock(0));
    const c = await broker.create(rabbitOptions("mq", spec()));
    expect(() => (c as ReturnType<typeof broker.latest>).reset()).toThrow(/ECONNRESET/);
  });
});

describe("the heartbeat: it finds a silent broker, in flight and idle", () => {
  it("ends a call in flight at 3 heartbeats when the call has a longer bound, and connects again", async () => {
    const { client, broker, clock, on } = await connected({ request_timeout: s(5) });
    broker.mode = "silent";
    const pending = client.publish("send order", event);
    await clock.advance(3000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "channel closed" });
    expect(on("connection.end").map((ended) => [ended.at, ended.detail])).toEqual([[4000, "Heartbeat timeout"]]);
    broker.mode = "up";
    await clock.advance(100);
    expect(client.status).toBe("ready");
  });

  it("ends an idle connection to a silent broker at 3 heartbeats", async () => {
    const { client, broker, clock } = await connected();
    broker.mode = "silent";
    await clock.advance(2999);
    expect(client.status).toBe("ready");
    await clock.advance(1);
    expect(client.status).toBe("failing");
  });
});

describe("the jobs of a queue drain: the source and the settle", () => {
  it("takes each job, and acks, rejects or requeues it on its channel", async () => {
    const { client, broker } = await connected();
    broker.queues.set("jobs", [
      { content: "a", redelivered: false },
      { content: "b", redelivered: true },
      { content: "c", redelivered: true, headers: { "x-delivery-count": 3 } },
    ]);
    // the source and the settle are what a queue drain takes
    const drained: { readonly source: JobSource<RabbitDelivery>; readonly settle: JobSettle<RabbitDelivery> } = client.jobs("take job", "jobs");
    const { source, settle } = client.jobs("take job", "jobs");
    expect(typeof drained.source).toBe("function");
    const signal = new AbortController().signal;
    const a = (await source(signal))!;
    const b = (await source(signal))!;
    const c = (await source(signal))!;
    expect([a, b, c].map((job) => settle.delivery(job))).toEqual([1, 2, 4]);
    await settle.ack(a);
    await settle.reject(b, new Error("bad job"));
    await settle.requeue(c, "failed");
    expect(broker.settled).toEqual([
      { kind: "ack", content: "a" },
      { kind: "reject", content: "b" },
      { kind: "requeue", content: "c" },
    ]);
    broker.queues.set("empty", []);
    expect(await client.jobs("take job", "empty").source(signal)).toBeNull();
  });

  it("refuses a settle on a generation that ended: the broker put the message back by itself", async () => {
    const { client, broker, clock } = await connected();
    broker.queues.set("jobs", [{ content: "a", redelivered: false }]);
    const { source, settle } = client.jobs("take job", "jobs");
    const job = (await source(new AbortController().signal))!;
    broker.latest().reset();
    await clock.advance(100);
    expect(client.status).toBe("ready");
    expect(() => settle.ack(job)).toThrow(/generation 1 ended/);
  });

  it("throws from the source when the broker refuses the get", async () => {
    const { client } = await connected();
    await expect(client.jobs("take job", "nope").source(new AbortController().signal)).rejects.toThrow(/could not take a message from nope: 404/);
  });
});

describe("the close: connection.close in its bound, then a destroy of the socket (A9, A14, principle 9)", () => {
  it("closes at once when the broker answers", async () => {
    const { client, clock, broker } = await connected();
    await client.handle.close();
    expect(clock.now()).toBe(1000);
    expect(client.status).toBe("end");
    expect(broker.latest().closed).toBe(true);
  });

  it("destroys the socket at the bound when the broker is silent, and settles what is in flight", async () => {
    const { client, broker, clock, on, events } = await connected({ request_timeout: s(5) });
    broker.mode = "silent";
    const pending = client.publish("send order", event);
    await clock.advance(10);
    const closing = client.handle.close();
    await clock.advance(300);
    await closing;
    expect(events.map((each) => each.on).filter((name) => name.startsWith("close"))).toEqual(["close.request", "close.bound", "close.destroy"]);
    expect(on("status.end").map((ended) => ended.at)).toEqual([1310]);
    expect(client.status).toBe("end");
    expect(await pending).toMatchObject({ outcome: "indeterminate" });
    expect(broker.latest().closed).toBe(true);
  });

  it("stops its tries to connect at the close", async () => {
    const { client, broker, clock, given } = made();
    broker.mode = "refuse";
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
      ["mq.local-state", "local-state", "liveness", true],
      ["mq.round-trip", "round-trip", "readiness", true],
      ["mq.dial", "dial", null, false],
    ]);
  });

  it("passes a passive declare on the channel of the application, and fails while the client is not ready", async () => {
    const { client, broker, clock } = await connected();
    const checks = client.checks({ poll, steps: { "local-state": "liveness", "round-trip": "readiness" } });
    const local = checks[0]![1];
    const roundTrip = checks[1]![1];
    expect(await roundTrip(new AbortController().signal)).toBe("ok");
    expect(await local(new AbortController().signal)).toBe("ok");
    broker.mode = "refuse";
    broker.latest().reset();
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
      'mq\'s close_bound of 3000 ms does not fit in the cap of "tear down dependencies"',
      "mq's request_timeout outlives one jittered poll of mq.round-trip (B7, O13)",
    ]);
  });
});

describe("the manifestations that the client meets, and their detectors (E9, C3)", () => {
  it("finds each manifestation in each situation with the starting knobs", () => {
    const { client } = made(RABBIT_STARTING_KNOBS);
    const meet = (name: string) => client.meets.find((meeting) => meeting.manifestation === name)!;
    expect(firstDetector(meet("blackhole"), "in flight")).toMatchObject({ by: "request_timeout", within: s(9.5) });
    expect(firstDetector(meet("blackhole"), "idle")).toMatchObject({ by: "heartbeat_detection_time", within: s(45) });
    expect(firstDetector(meet("rst"), "idle")).toMatchObject({ by: "heartbeat_interval", within: s(15) });
    expect(firstDetector(meet("fin"), "idle")).toMatchObject({ within: s(0) });
    expect(firstDetector(meet("app-stall"), "in flight")).toMatchObject({ by: "request_timeout", within: s(9.5) });
    expect(unwatched(client.meets)).toEqual([]);
  });

  it("names what nothing finds with no heartbeat: an idle connection to a process that stops", () => {
    expect(unwatched(made({ heartbeat_interval: never }).client.meets)).toEqual([{ manifestation: "freeze-process", situation: "idle" }]);
    expect(unwatched(made({ heartbeat_interval: never, keepalive_idle: never }).client.meets)).toEqual([
      { manifestation: "rst", situation: "idle" },
      { manifestation: "blackhole", situation: "idle" },
      { manifestation: "freeze-host", situation: "idle" },
      { manifestation: "freeze-process", situation: "idle" },
    ]);
  });
});

describe("the client as a document (D4, E8)", () => {
  it("is a valid, consistent machine document", () => {
    expect(machineSchema.safeParse(RABBIT_CLIENT_MACHINE).success).toBe(true);
    expect(machineProblems(RABBIT_CLIENT_MACHINE)).toEqual([]);
  });

  const scenarios: Record<string, (all: Awaited<ReturnType<typeof connected>>) => Promise<void>> = {
    "a reset, and a new connection": async ({ client, broker, clock }) => {
      broker.latest().reset();
      await clock.advance(100);
      await client.publish("send event", event);
    },
    "a refused broker, then a broker that is back": async ({ client, broker, clock }) => {
      broker.mode = "refuse";
      broker.latest().reset();
      await clock.advance(700);
      await client.publish("send order", event);
      broker.mode = "up";
      await clock.advance(400);
      await client.publish("send order", event);
    },
    "the heartbeat of a silent broker, and a bounded open": async ({ broker, clock }) => {
      broker.mode = "silent";
      await clock.advance(3000);
      await clock.advance(600);
    },
    "a reply code of the broker": async ({ client, clock }) => {
      await client.get("take job", "nope");
      await clock.advance(100);
    },
    "a resource alarm, and its end": async ({ client, broker, clock }) => {
      broker.latest().block("low on memory");
      const pending = client.publish("send event", event);
      await clock.advance(10);
      broker.latest().unblock();
      await pending;
    },
    "a publish sent again": async ({ client, broker, clock }) => {
      broker.confirm = "hold";
      const pending = client.publish("send event", event);
      await clock.advance(10);
      broker.confirm = "ack";
      broker.latest().reset();
      await clock.advance(100);
      await pending;
    },
    "a bounded close of a silent broker": async ({ client, broker, clock }) => {
      broker.mode = "silent";
      const pending = client.publish("send order", event);
      await clock.advance(10);
      const closing = client.handle.close();
      await clock.advance(300);
      await closing;
      await pending;
    },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`replays ${name} against the document`, async () => {
      const all = await connected();
      await scenario(all);
      expect(all.events.length).toBeGreaterThan(2);
      expect(replay(RABBIT_CLIENT_MACHINE, all.events)).toEqual([]);
    });
  }
});
