import type { Cell } from "@mark1russell7/harness";
import { count } from "../catalog.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import { PRESETS } from "../mongo/t03.ts";
import type { HikariSpec } from "./hikari.ts";
import { hikariCell } from "./hikari.ts";

/**
 * The PostgreSQL catalog of T03 for HikariCP 7.1.0 over pgjdbc 42.7.13: the pool, a NAT router with
 * conntrack, and one server of PostgreSQL 17.11. Each router stands for a cloud preset at its own
 * idle timeout, in real time. Each band comes from the documents, as in the catalog of T01. A fault
 * at the router toward the client is the same fault for the socket of the client. The keepalive of
 * the pool (96 to 120 s) refreshes each idle flow before each preset forgets it (O03).
 */

/** This text is the query in flight of the MTU cell: a reply of 2 MB in one row. Thus each segment of the reply is long. */
export const LONG_QUERY = "SELECT repeat('x', 2000000)";

/** These are the cells of T03 over hikaricp-pgjdbc and postgresql that this catalog starts. */
export const T03_HIKARI_SPECS: readonly HikariSpec[] = [
  { plan: "T03.defaults.6", name: "blackhole at the router, idle: the keepalive checks the connection, AWS NAT form", fault: "blackhole", mode: "idle", router: PRESETS.aws, toward: "client" },
  {
    plan: "T03.defaults.8",
    name: "mtu-blackhole at the router, a long reply in flight, Azure LB with TCP reset",
    fault: "mtu-blackhole",
    mode: "inflight",
    inflight: LONG_QUERY,
    mtu: 1200,
    router: PRESETS.azureLbReset,
    // the rule drops each long segment that comes from the side it faces: the reply comes from the target
    toward: "target",
  },
  {
    plan: "T03.defaults.9",
    name: "unreachable-host at the router, a query in flight, tcp_retries2 = 3, GCP firewall form",
    fault: "unreachable",
    mode: "inflight",
    icmp: "host",
    linux: { tcp_retries2: count(3) },
    router: PRESETS.gcp,
    toward: "client",
  },
  { plan: "T03.defaults.42", name: "event:idle, no fault, idle for 300 s: the keepalive keeps the flow, Azure NAT form", fault: "none", mode: "idle", router: PRESETS.azureNat, hold: 300 },
  { plan: "T03.defaults.43", name: "fin, idle, Azure LB with TCP reset", fault: "fin", mode: "idle", router: PRESETS.azureLbReset },
  { plan: "T03.defaults.51", name: "middlebox-forget, idle for 400 s: the keepalive keeps the flow, AWS NAT form", fault: "middlebox-forget", mode: "idle", router: PRESETS.aws, hold: 400 },
  { plan: "T03.defaults.52", name: "a 1 s stall at the router, a query in flight, AWS NAT form", fault: "stall", mode: "inflight", stall: 1, router: PRESETS.aws, toward: "client" },
];

/** These are the cells of the plan that are another cell of the catalogs. */
export const T03_HIKARI_ALIASES: readonly Alias[] = [
  { plan: "T03.defaults.10", is: "T01.defaults.2", why: "its tuple has no router: a reset of a query in flight on the direct pair" },
];

/** This reason is the reason of the cells with Supavisor between the client and the server. */
const SUPAVISOR = "the cell needs Supavisor 2.9 between the client and the server, and the harness has no Supavisor hop";

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T03_HIKARI_WAITING: readonly Waiting[] = [7, 29, 35, 36, 58, 59, 60, 61].map((n): Waiting => ({ plan: `T03.defaults.${n}`, trigger: "supavisor", why: SUPAVISOR }));

/** These are the HikariCP cells of T03 for the harness. */
export const T03_HIKARI: readonly Cell[] = T03_HIKARI_SPECS.map(hikariCell);
