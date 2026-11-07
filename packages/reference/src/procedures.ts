/**
 * The procedures of the reference service, its policy and its events.
 *
 * - `doc.put`, `doc.get` and `doc.list` read and write the documents of the tenant of the call.
 *   The tenant comes from the token of the call, not from its input.
 * - Each put publishes the event `doc.<tenant>` with the id and the new version of the document.
 * - A caller subscribes only to the topic of its own tenant. Another topic gives `FORBIDDEN`.
 */
import type { HostPolicy, Principal, ProcedureContext } from "@procedures/client";
import { ProcedureRegistry, ServerError, createEventBus, defineProcedure, hostPolicy } from "@procedures/client";
import { z } from "zod";
import type { DocStore } from "./store.ts";

/** The bus of the events of the service. The root of the client names its class `EventBus`, thus this file names the interface by its maker. */
export type EventBus = ReturnType<typeof createEventBus>;

/** A tenant name: letters, digits, `-` and `_`. It has no `/`, thus the Mongo keys of tenants do not mix. */
export const TENANT = /^[A-Za-z0-9_-]{1,64}$/;

/** The most documents of one page of `doc.list`. */
export const MAX_PAGE = 1000;

/** How the principal of a tenant token names its authentication. */
export const VIA = "tenant-token";

/** The topic of the events of a tenant. */
export const topicOf = (tenant: string) => `doc.${tenant}`;

const id = z.string().min(1).max(256);
const doc = z.object({ id, body: z.unknown(), version: z.number().int().positive() });

const tenantOf = (ctx: ProcedureContext): string => {
  const principal: Principal | undefined = ctx.principal;
  if (principal?.via !== VIA || !TENANT.test(principal.id)) throw new ServerError("the call has no tenant", "UNAUTHORIZED", false);
  return principal.id;
};

/** This function gives the procedures of the service over a store, and the bus of their events. */
export const docProcedures = (store: DocStore, bus: EventBus) => [
  defineProcedure({
    path: ["doc", "put"],
    input: z.object({ id, body: z.unknown() }),
    output: z.object({ version: z.number().int().positive() }),
    metadata: { description: "This procedure writes the body of a document and publishes its new version.", effects: { reads: [], writes: ["docs"] } },
    handler: async (input, ctx) => {
      const tenant = tenantOf(ctx);
      const { version } = await store.put(tenant, input.id, input.body);
      bus.emit(topicOf(tenant), { id: input.id, version });
      return { version };
    },
  }),
  defineProcedure({
    path: ["doc", "get"],
    input: z.object({ id }),
    output: z.object({ doc: doc.nullable() }),
    metadata: { description: "This procedure gives a document of the tenant, or null.", effects: { reads: ["docs"], writes: [], idempotent: true } },
    handler: async (input, ctx) => ({ doc: (await store.get(tenantOf(ctx), input.id)) ?? null }),
  }),
  defineProcedure({
    path: ["doc", "list"],
    input: z.object({ after: id.nullable(), limit: z.number().int().min(1).max(MAX_PAGE) }),
    output: z.object({ docs: z.array(doc) }),
    metadata: { description: "This procedure gives a page of the documents of the tenant, in the order of their ids.", effects: { reads: ["docs"], writes: [], idempotent: true } },
    handler: async (input, ctx) => ({ docs: [...(await store.list(tenantOf(ctx), { after: input.after ?? undefined, limit: input.limit }))] }),
  }),
];

/** The parts of the service: the registry of its procedures, its policy and the bus of its events. */
export interface Reference {
  readonly registry: ProcedureRegistry;
  readonly policy: HostPolicy;
  readonly bus: EventBus;
}

/**
 * This function makes the parts of the service. `tenants` maps each token to its tenant. A call
 * with no token, or with a token that the map does not hold, gets `UNAUTHORIZED`.
 */
export const reference = (store: DocStore, tenants: Readonly<Record<string, string>>): Reference => {
  for (const tenant of Object.values(tenants)) if (!TENANT.test(tenant)) throw new Error(`the tenant ${JSON.stringify(tenant)} is not a tenant name`);
  const byToken = new Map(Object.entries(tenants));
  const bus = createEventBus();
  const registry = new ProcedureRegistry();
  registry.registerAll(docProcedures(store, bus));
  const policy = hostPolicy({
    principalOf: (credentials) => {
      const token = credentials.bearer ?? credentials.query?.["token"];
      const tenant = token === undefined ? undefined : byToken.get(token);
      return tenant === undefined ? undefined : { principal: { id: tenant, via: VIA } };
    },
    events: {
      bus,
      topics: ["doc.*"],
      allow: (topic, call) => call.principal?.via === VIA && topic === topicOf(call.principal.id),
    },
  });
  return { registry, policy, bus };
};
