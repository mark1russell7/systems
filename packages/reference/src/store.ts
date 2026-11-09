/**
 * The store of the reference service: documents by tenant and id, each with a version. The service
 * reads and writes only through this port. The tests use the store in memory, and the cells use
 * the store of the replica set (`mongo-store.ts`).
 */

/** A document of a tenant: its id, its body and its version. The first write gives version 1. */
export interface Doc {
  readonly id: string;
  readonly body: unknown;
  readonly version: number;
}

/** The options of a page of a list: the ids after `after`, at most `limit` of them. */
export interface Page {
  readonly after?: string | undefined;
  readonly limit: number;
}

/** The port of the store. Each method sees only the documents of one tenant. */
export interface DocStore {
  /** This method writes the body of a document and gives its new version. */
  put(tenant: string, id: string, body: unknown): Promise<{ readonly version: number }>;
  /** This method gives a document, or undefined when the tenant has no document with this id. */
  get(tenant: string, id: string): Promise<Doc | undefined>;
  /** This method gives a page of the documents of a tenant, in the order of their ids. */
  list(tenant: string, page: Page): Promise<readonly Doc[]>;
}

/** This function makes a store in memory. Each tenant has its own map. */
export const memoryStore = (): DocStore => {
  const tenants = new Map<string, Map<string, Doc>>();
  const of = (tenant: string) => {
    let docs = tenants.get(tenant);
    if (!docs) tenants.set(tenant, (docs = new Map()));
    return docs;
  };
  return {
    put: async (tenant, id, body) => {
      const docs = of(tenant);
      const version = (docs.get(id)?.version ?? 0) + 1;
      docs.set(id, { id, body: structuredClone(body), version });
      return { version };
    },
    get: async (tenant, id) => {
      const doc = tenants.get(tenant)?.get(id);
      return doc && { ...doc, body: structuredClone(doc.body) };
    },
    list: async (tenant, { after, limit }) =>
      [...(tenants.get(tenant)?.values() ?? [])]
        .filter((doc) => after === undefined || doc.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map((doc) => ({ ...doc, body: structuredClone(doc.body) })),
  };
};
