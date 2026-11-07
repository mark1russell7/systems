import type { MongoClient } from "@mark1russell7/service/mongodb";
import { Client, HttpTransport } from "@procedures/client";
import { WebSocketTransport } from "@procedures/client/node";
import { createPeer, type Peer } from "@procedures/peer";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DOCS, StoreError, mongoStore } from "./mongo-store.ts";
import { reference } from "./procedures.ts";
import { memoryStore } from "./store.ts";

const TENANTS = { "token-a": "a", "token-b": "b" };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

describe("the store in memory", () => {
  it("gives each write a new version, and each tenant its own documents in the order of their ids", async () => {
    const store = memoryStore();
    expect(await store.put("a", "y", { n: 1 })).toEqual({ version: 1 });
    expect(await store.put("a", "y", { n: 2 })).toEqual({ version: 2 });
    await store.put("a", "x", { n: 3 });
    await store.put("b", "x", { n: 4 });
    expect(await store.get("a", "y")).toEqual({ id: "y", body: { n: 2 }, version: 2 });
    expect(await store.get("b", "y")).toBeUndefined();
    expect((await store.list("a", { limit: 10 })).map((doc) => doc.id)).toEqual(["x", "y"]);
    expect((await store.list("a", { after: "x", limit: 10 })).map((doc) => doc.id)).toEqual(["y"]);
    expect((await store.list("a", { limit: 1 })).map((doc) => doc.id)).toEqual(["x"]);
    expect((await store.list("b", { limit: 10 })).map((doc) => doc.body)).toEqual([{ n: 4 }]);
  });

  it("keeps no reference to a body that a caller holds", async () => {
    const store = memoryStore();
    const body = { n: 1 };
    await store.put("a", "x", body);
    body.n = 2;
    const got = await store.get("a", "x");
    expect(got?.body).toEqual({ n: 1 });
    (got!.body as { n: number }).n = 3;
    expect((await store.get("a", "x"))?.body).toEqual({ n: 1 });
  });
});

describe("the store on MongoDB", () => {
  const fake = (reply: (operation: string, document: Record<string, unknown>) => unknown) => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    const client = {
      command: async (operation: string, document: Record<string, unknown>) => {
        sent.push([operation, document]);
        const value = reply(operation, document);
        return value instanceof Error
          ? { outcome: "indeterminate" as const, error: value.message, attempts: 1 }
          : { outcome: "ok" as const, value, attempts: 1 };
      },
    } as unknown as MongoClient;
    return { client, sent };
  };

  it("keys each document by its tenant, and bounds a list to the ids of the tenant", async () => {
    const { client, sent } = fake((operation) =>
      operation === "doc.put"
        ? { value: { _id: "a/x", version: 3 }, ok: 1 }
        : { cursor: { firstBatch: [{ _id: "a/x", body: { n: 1 }, version: 3 }] }, ok: 1 },
    );
    const store = mongoStore(client);
    expect(await store.put("a", "x", { n: 1 })).toEqual({ version: 3 });
    expect(await store.get("a", "x")).toEqual({ id: "x", body: { n: 1 }, version: 3 });
    expect(await store.list("a", { after: "w", limit: 5 })).toEqual([{ id: "x", body: { n: 1 }, version: 3 }]);
    expect(sent.map(([operation]) => operation)).toEqual(["doc.put", "doc.get", "doc.list"]);
    expect(sent[0]![1]).toMatchObject({ findAndModify: DOCS, query: { _id: "a/x" }, update: { $set: { body: { n: 1 } }, $inc: { version: 1 } }, upsert: true, new: true });
    expect(sent[1]![1]).toMatchObject({ find: DOCS, filter: { _id: "a/x" }, limit: 1 });
    expect(sent[2]![1]).toMatchObject({ find: DOCS, filter: { _id: { $gt: "a/w", $lt: "a0" } }, sort: { _id: 1 }, limit: 5 });
  });

  it("gives an outcome that is not ok as a StoreError with that outcome", async () => {
    const { client } = fake(() => new Error("socket closed"));
    const error = await mongoStore(client).put("a", "x", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ operation: "doc.put", outcome: "indeterminate" });
  });
});

describe("the reference service", () => {
  let peer: Peer | undefined;
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await peer?.stop();
    peer = undefined;
  });

  const started = async () => {
    const port = await freePort();
    const parts = reference(memoryStore(), TENANTS);
    peer = await createPeer({
      id: "reference-test",
      registry: parts.registry,
      policy: parts.policy,
      transports: [
        { type: "http", port },
        { type: "websocket", port },
      ],
    });
    await peer.start();
    const http = (token?: string) => {
      const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
      const client = new Client({ transport: new HttpTransport({ baseUrl: `http://127.0.0.1:${port}/api`, defaultHeaders: headers }) });
      clients.push(client);
      return client;
    };
    const ws = (token: string) => {
      const client = new Client({ transport: new WebSocketTransport({ url: `ws://127.0.0.1:${port}/ws?token=${token}` }) });
      clients.push(client);
      return client;
    };
    return { http, ws };
  };

  const put = (client: Client, id: string, body: unknown) => client.call<unknown, { version: number }>({ service: "doc", operation: "put" }, { id, body });
  const get = (client: Client, id: string) => client.call<unknown, { doc: unknown }>({ service: "doc", operation: "get" }, { id });
  const list = (client: Client) => client.call<unknown, { docs: Array<{ id: string }> }>({ service: "doc", operation: "list" }, { after: null, limit: 10 });

  it("serves each tenant only its own documents over HTTP", async () => {
    const { http } = await started();
    const a = http("token-a");
    const b = http("token-b");
    expect(await put(a, "x", { n: 1 })).toEqual({ version: 1 });
    expect(await put(a, "x", { n: 2 })).toEqual({ version: 2 });
    expect(await get(a, "x")).toEqual({ doc: { id: "x", body: { n: 2 }, version: 2 } });
    expect(await get(b, "x")).toEqual({ doc: null });
    expect((await list(b)).docs).toEqual([]);
    expect((await list(a)).docs.map((doc) => doc.id)).toEqual(["x"]);
  });

  it("refuses a call with no token or with an unknown token", async () => {
    const { http } = await started();
    await expect(get(http(), "x")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(get(http("token-c"), "x")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("publishes each put to the subscribers of its own tenant, and refuses the topic of another tenant", async () => {
    const { http, ws } = await started();
    const watcher = ws("token-a");
    const events: unknown[] = [];
    const subscription = watcher.subscribe("doc.a", (event) => {
      events.push(event);
    });
    await subscription.ready;
    // The bus keeps the order of the puts, thus an event of tenant b comes before the events of a.
    await put(http("token-b"), "y", { n: 0 });
    await put(http("token-a"), "x", { n: 1 });
    await put(http("token-a"), "x", { n: 2 });
    await expect.poll(() => events.length).toBe(2);
    const text = JSON.stringify(events);
    expect(text).not.toContain('"id":"y"');
    expect(text.indexOf('"version":1')).toBeLessThan(text.indexOf('"version":2'));

    const refused = watcher.subscribe("doc.b", () => {});
    await expect(refused.ready).rejects.toMatchObject({ code: "FORBIDDEN" });
    subscription();
  });
});
