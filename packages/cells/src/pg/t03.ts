import type { Cell } from "@mark1russell7/harness";
import { count, seconds } from "../catalog.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import { PRESETS } from "../mongo/t03.ts";
import type { HikariSpec } from "./hikari.ts";
import { hikariCell, hikariPrediction } from "./hikari.ts";
import { SUPAVISOR_HOP } from "./supavisor.ts";
import { SUPAVISOR_HIKARI, SUPAVISOR_LATENCY, supavisorAllows } from "./t10.ts";

/**
 * The PostgreSQL catalog of T03 for HikariCP 7.1.0 over pgjdbc 42.7.13: the pool, a NAT router with
 * conntrack, and one server of PostgreSQL 17.11. Each router stands for a cloud preset at its own
 * idle timeout, in real time. Each band comes from the documents, as in the catalog of T01. A fault
 * at the router toward the client is the same fault for the socket of the client. The keepalive of
 * the pool (96 to 120 s) refreshes each idle flow before each preset forgets it (O03).
 *
 * Other cells have the chain of R3 for Supavisor 2.9: the router, and then Supavisor 2.9.13 in
 * transaction mode in front of the server. The router is between the client and Supavisor. The client
 * connects as the user of the tenant of Supavisor.
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

/**
 * These are the cells of T03 with the chain of a router and Supavisor. A fault at the router acts
 * between the client and Supavisor. Supavisor writes a heartbeat to each idle client each 60 s, which
 * also refreshes an idle flow through the router.
 */
export const T03_SUPAVISOR_SPECS: readonly HikariSpec[] = (
  [
    { plan: "T03.defaults.7", name: "middlebox-forget through Supavisor, idle for 300 s: the keepalive keeps the flow, Azure NAT form", fault: "middlebox-forget", mode: "idle", router: PRESETS.azureNat, hold: 300 },
    {
      plan: "T03.defaults.29",
      name: "simplex-to-client at the router in front of Supavisor, idle: the keepalive checks the connection, AWS NAT form",
      fault: "simplex",
      drops: "to-client",
      mode: "idle",
      router: PRESETS.aws,
      toward: "client",
    },
    { plan: "T03.defaults.35", name: "a 1 s stall at the router in front of Supavisor, a query in flight, GCP firewall form", fault: "stall", mode: "inflight", stall: 1, router: PRESETS.gcp, toward: "client" },
    { plan: "T03.defaults.36", name: "blackhole at a plain router in front of Supavisor, idle: the keepalive checks the connection", fault: "blackhole", mode: "idle", router: PRESETS.linux, toward: "client" },
    {
      plan: "T03.defaults.58",
      name: "unreachable-host at the router in front of Supavisor, a query in flight, tcp_retries2 = 3, AWS NAT form",
      fault: "unreachable",
      mode: "inflight",
      icmp: "host",
      linux: { tcp_retries2: count(3) },
      router: PRESETS.aws,
      toward: "client",
    },
    {
      plan: "T03.defaults.59",
      name: "mtu-blackhole at the router in front of Supavisor, a long reply in flight, AWS NAT form",
      fault: "mtu-blackhole",
      mode: "inflight",
      inflight: LONG_QUERY,
      mtu: 1200,
      router: PRESETS.aws,
      // the rule drops each long segment that comes from the side it faces: the reply comes from Supavisor.
      // A write of Supavisor that waits 30 s closes the client socket (ranch), but its FIN waits behind
      // the long segments. Thus the client gets nothing in the window
      toward: "target",
    },
    { plan: "T03.defaults.60", name: "event:idle through Supavisor, no fault, idle for 400 s: the keepalive keeps the flow, AWS NAT form", fault: "none", mode: "idle", router: PRESETS.aws, hold: 400 },
  ] satisfies readonly Omit<HikariSpec, "pooler" | "poolerLatency">[]
).map((spec): HikariSpec => ({ ...spec, pooler: SUPAVISOR_HOP, poolerLatency: SUPAVISOR_LATENCY }));

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T03_HIKARI_WAITING: readonly Waiting[] = [
  {
    plan: "T03.defaults.61",
    trigger: "fin",
    why: "as in T10.defaults.3, through Supavisor the end of the idle client depends on a race in the shutdown of the server: the router in front of Supavisor does not change it",
  },
];

/**
 * This function gives the HikariCP cell of T03 for a spec with the chain of Supavisor. The client
 * connects as the user of the tenant. The prediction is the prediction of the same fault at the router
 * without Supavisor. The function checks that no timer of Supavisor ends the client before the band ends.
 */
const throughSupavisor = (spec: HikariSpec): Cell => {
  const cell = hikariCell(spec);
  const p = hikariPrediction(spec);
  const ends = p.detects === true ? seconds(p.high, "the band") + (p.startsBy === undefined ? 0 : seconds(p.startsBy, "the start of the check")) : seconds(p.window, "the window");
  supavisorAllows(spec.plan, spec.mode === "idle" ? "idle" : "busy", ends);
  return { ...cell, driverOptions: { ...cell.driverOptions, ...SUPAVISOR_HIKARI } };
};

/** These are the HikariCP cells of T03 for the harness. */
export const T03_HIKARI: readonly Cell[] = [...T03_HIKARI_SPECS.map(hikariCell), ...T03_SUPAVISOR_SPECS.map(throughSupavisor)];
