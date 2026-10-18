import { createHmac } from "node:crypto";
import type { ProxyHop } from "@mark1russell7/harness";

/**
 * The hop of Supavisor 2.9.13 for the PostgreSQL catalogs. It is the image of Supabase, pinned by the
 * digest of its index. It has one tenant in transaction mode in front of the server of the cell.
 *
 * Supavisor keeps its tenants in a database of its own. The hop uses the server of the cell for it, in
 * the schema _supavisor. Its start script makes that schema, runs the migrations, starts the server, and
 * then makes the tenant through the API of Supavisor. A client connects as the user postgres.harness.
 */

/** This image is Supavisor 2.9.13 of Supabase, pinned by the digest of its index (2026-09-10). */
export const SUPAVISOR_IMAGE = "supabase/supavisor:2.9.13@sha256:07f1a6098ffc04b80263bca4eb5c3e7bd2e03dfd1fc465aa108d7329000a1a4e";

/** This name is the tenant of the hop, the second part of the user of a client. */
export const SUPAVISOR_TENANT = "harness";

/** These are the user and the password of a client of the hop. The server of a cell trusts each client, thus the password is only for Supavisor. */
export const SUPAVISOR_USER = { name: `postgres.${SUPAVISOR_TENANT}`, password: "postgres" } as const;

/** This port is the port of the transaction mode of Supavisor. */
export const SUPAVISOR_PORT = 6543;

/**
 * These values configure the release of Supavisor in the environment of one cell. They are constants of
 * the lab, not secrets: the environment lives for the runs of one cell, and nothing outside it can reach it.
 */
const LAB = {
  secretKeyBase: "systems-lab-secret-key-base-0123456789abcdef0123456789abcdef0123456789",
  vaultEncKey: "systems-lab-vault-key-0123456789",
  apiJwtSecret: "systems-lab-api-jwt-secret",
  metricsJwtSecret: "systems-lab-metrics-jwt-secret",
} as const;

const base64url = (text: string): string => Buffer.from(text).toString("base64url");

/** This token signs the calls of the lab to the API of Supavisor: HS256, the claims role and exp (2100-01-01) that the API needs. */
export const SUPAVISOR_TOKEN: string = (() => {
  const signed = `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(JSON.stringify({ role: "service_role", exp: 4102444800 }))}`;
  return `${signed}.${createHmac("sha256", LAB.apiJwtSecret).update(signed).digest("base64url")}`;
})();

/** These are the settings of the tenant and of its user that a cell can change, by the names of the documents. */
export interface SupavisorSettings {
  readonly client_heartbeat_interval?: number;
  readonly pool_checkout_timeout?: number;
  readonly pool_size?: number;
}

/** This line is the line of the start script that tells that the tenant serves. */
export const SUPAVISOR_READY = `supavisor: tenant ${SUPAVISOR_TENANT} ready`;

/** This function gives the body of the call that makes the tenant, with the settings of a cell. */
const tenantOf = (settings: SupavisorSettings): string =>
  JSON.stringify({
    tenant: {
      db_host: "{{next.host}}",
      db_port: "{{next.port}}",
      db_database: "postgres",
      require_user: true,
      default_parameter_status: { server_version: "17.11" },
      client_heartbeat_interval: settings.client_heartbeat_interval ?? 60,
      users: [
        {
          db_user: "postgres",
          db_password: SUPAVISOR_USER.password,
          pool_size: settings.pool_size ?? 10,
          mode_type: "transaction",
          pool_checkout_timeout: settings.pool_checkout_timeout ?? 60_000,
        },
      ],
    },
  }).replace('"{{next.port}}"', "{{next.port}}");

/**
 * This function gives the start script of the hop. It waits for the server of the cell, makes the schema
 * of Supavisor, runs the migrations and starts the release. Then it makes the tenant through the API, and
 * it writes the ready line.
 */
export const supavisorStart = (settings: SupavisorSettings = {}): string =>
  [
    "#!/bin/sh",
    "set -e",
    `export PORT=4000 PROXY_PORT_TRANSACTION=${SUPAVISOR_PORT} PROXY_PORT_SESSION=5432 REGION=local`,
    "export ERL_AFLAGS='-proto_dist inet_tcp'",
    "export DATABASE_URL='ecto://postgres:postgres@{{next.host}}:{{next.port}}/postgres'",
    `export SECRET_KEY_BASE='${LAB.secretKeyBase}' VAULT_ENC_KEY='${LAB.vaultEncKey}'`,
    `export API_JWT_SECRET='${LAB.apiJwtSecret}' METRICS_JWT_SECRET='${LAB.metricsJwtSecret}'`,
    // the migrations write into the schema _supavisor, which they do not make (dev/postgres/00-setup.sql)
    "until psql 'postgresql://postgres@{{next.host}}:{{next.port}}/postgres' -qc 'create schema if not exists _supavisor'; do sleep 0.5; done",
    "/app/bin/migrate",
    "/app/bin/server &",
    `until curl -sf -H 'Authorization: Bearer ${SUPAVISOR_TOKEN}' http://127.0.0.1:4000/api/health > /dev/null; do sleep 0.5; done`,
    `curl -sf -X PUT -H 'Authorization: Bearer ${SUPAVISOR_TOKEN}' -H 'Content-Type: application/json' http://127.0.0.1:4000/api/tenants/${SUPAVISOR_TENANT} -d '${tenantOf(settings)}' > /dev/null`,
    `echo '${SUPAVISOR_READY}'`,
    "wait",
    "",
  ].join("\n");

/** This function gives the hop of Supavisor 2.9.13 in transaction mode, with the settings of a cell. */
export const supavisorHop = (settings: SupavisorSettings = {}): ProxyHop => ({
  name: "supavisor",
  kind: "proxy",
  image: SUPAVISOR_IMAGE,
  port: SUPAVISOR_PORT,
  command: ["sh", "/lab/start.sh"],
  files: { "/lab/start.sh": supavisorStart(settings) },
  ready: SUPAVISOR_READY,
  settings: {
    mode: "transaction",
    version: "2.9.13",
    ...Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, String(value)])),
  },
});

/** This hop is Supavisor 2.9.13 in transaction mode at its defaults. */
export const SUPAVISOR_HOP: ProxyHop = supavisorHop();
