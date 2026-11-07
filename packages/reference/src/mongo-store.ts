/**
 * The store of the reference service on MongoDB, through the Mongo client of
 * `@mark1russell7/service/mongodb`. Thus the cells measure the client of the service, with its
 * timers, its checks and its three outcomes, under the service of the reference.
 *
 * Each document is one record of the collection `docs`. Its `_id` is `<tenant>/<id>`, thus the
 * index of `_id` holds the documents of a tenant in the order of their ids. A tenant name has no
 * `/`, and the procedures refuse such a name before it comes here.
 */
import type { MongoClient } from "@mark1russell7/service/mongodb";
import type { Operation } from "@mark1russell7/service";
import type { Doc, DocStore } from "./store.ts";

/** The name of the collection of the documents. */
export const DOCS = "docs";

/**
 * These are the commands of the store, with their idempotency, for the spec of the client. A put
 * adds one to the version, thus a second send is not safe. A get and a list change nothing.
 */
export const STORE_OPERATIONS: Readonly<Record<string, Operation>> = {
  "doc.put": { idempotent: false },
  "doc.get": { idempotent: true },
  "doc.list": { idempotent: true },
};

/**
 * A command that did not give `ok`. The outcome `error` tells that the command failed. The outcome
 * `indeterminate` tells that the store does not know: a put can then be in the store or not.
 */
export class StoreError extends Error {
  constructor(
    readonly operation: string,
    readonly outcome: "error" | "indeterminate",
    detail: string,
  ) {
    super(`${operation}: ${outcome}: ${detail}`);
    this.name = "StoreError";
  }
}

const keyOf = (tenant: string, id: string) => `${tenant}/${id}`;

interface Row {
  readonly _id: string;
  readonly body: unknown;
  readonly version: number;
}

const docOf = (tenant: string, row: Row): Doc => ({ id: row._id.slice(tenant.length + 1), body: row.body, version: row.version });

/** This function makes the store over a connected Mongo client of the service. */
export const mongoStore = (client: MongoClient): DocStore => {
  const send = async (operation: string, document: Record<string, unknown>) => {
    const sent = await client.command(operation, document);
    if (sent.outcome !== "ok") throw new StoreError(operation, sent.outcome, sent.error);
    return sent.value as Record<string, unknown>;
  };
  const rows = (reply: Record<string, unknown>) => ((reply["cursor"] as { firstBatch?: Row[] } | undefined)?.firstBatch ?? []);
  return {
    put: async (tenant, id, body) => {
      const reply = await send("doc.put", {
        findAndModify: DOCS,
        query: { _id: keyOf(tenant, id) },
        update: { $set: { body }, $inc: { version: 1 } },
        upsert: true,
        new: true,
        fields: { version: 1 },
      });
      const row = reply["value"] as Row | null | undefined;
      if (!row) throw new StoreError("doc.put", "error", "the reply has no document");
      return { version: row.version };
    },
    get: async (tenant, id) => {
      const [row] = rows(await send("doc.get", { find: DOCS, filter: { _id: keyOf(tenant, id) }, limit: 1, singleBatch: true }));
      return row && docOf(tenant, row);
    },
    list: async (tenant, { after, limit }) => {
      // "0" is the character after "/", thus the bound holds each id of the tenant and no other id
      const filter = { _id: { $gt: keyOf(tenant, after ?? ""), $lt: `${tenant}0` } };
      const reply = await send("doc.list", { find: DOCS, filter, sort: { _id: 1 }, limit, singleBatch: true });
      return rows(reply).map((row) => docOf(tenant, row));
    },
  };
};
