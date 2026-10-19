import type { Cell } from "@mark1russell7/harness";
import { count } from "../catalog.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import { PRESETS } from "../mongo/t03.ts";
import type { GrpcSpec } from "./t01.ts";
import { grpcCell } from "./t01.ts";

/**
 * The gRPC catalog of T03: grpc-js 1.14.6, a NAT router with conntrack, and a server of grpc-go v1.84.0.
 * Each router stands for a cloud preset at its own idle timeout, in real time. Each band comes from the
 * documents, as in the catalog of T01. A fault at the router toward the client is the same fault for
 * the socket of the client. The listener of the server probes an idle flow each 15 s, before each
 * preset forgets it (O03). grpc-js itself sends nothing on an idle connection.
 */

/** These are the cells of T03 over grpc-js-1.14 and grpc-go-server that this catalog starts. */
export const T03_GRPC_SPECS: readonly GrpcSpec[] = [
  {
    plan: "T03.defaults.17",
    server: "grpc-go",
    name: "unreachable-host at the router, a call in flight, tcp_retries2 = 3, Azure NAT form",
    fault: "unreachable",
    mode: "inflight",
    icmp: "host",
    linux: { tcp_retries2: count(3) },
    router: PRESETS.azureNat,
    toward: "client",
  },
  {
    plan: "T03.defaults.18",
    server: "grpc-go",
    name: "blackhole at the router, idle: nothing at the client detects it, Azure LB with TCP reset",
    fault: "blackhole",
    mode: "idle",
    router: PRESETS.azureLbReset,
    toward: "client",
  },
  {
    plan: "T03.defaults.19",
    server: "grpc-go",
    name: "middlebox-forget, idle for 700 s: the probes of the listener of grpc-go keep the flow, GCP firewall form",
    fault: "middlebox-forget",
    mode: "idle",
    router: PRESETS.gcp,
    hold: 700,
  },
  { plan: "T03.defaults.20", server: "grpc-go", name: "event:idle, no fault, idle for 300 s, a plain router", fault: "none", mode: "idle", router: PRESETS.linux, hold: 300 },
  { plan: "T03.defaults.46", server: "grpc-go", name: "a 1 s stall at the router, a call in flight, Azure NAT form", fault: "stall", mode: "inflight", stall: 1, router: PRESETS.azureNat, toward: "client" },
  { plan: "T03.defaults.47", server: "grpc-go", name: "rst at the router, a call in flight, AWS NAT form", fault: "rst", mode: "inflight", router: PRESETS.aws, toward: "client" },
  {
    plan: "T03.defaults.48",
    server: "grpc-go",
    name: "simplex-to-client at the router, a call in flight: nothing at the client detects it, AWS NAT form",
    fault: "simplex",
    drops: "to-client",
    mode: "inflight",
    router: PRESETS.aws,
    toward: "client",
  },
  { plan: "T03.defaults.49", server: "grpc-go", name: "fin, idle: the killed server ends the connection with a FIN, AWS NAT form", fault: "fin", mode: "idle", router: PRESETS.aws },
];

/**
 * These are the cells of the array stage that this catalog starts. T03.array.68 has no cell at the
 * defaults. DP11 raises the idle timeout of an NLB to 3,600 s. The conntrack of its target keeps 350 s. The router of the cell is the timer that binds, the AWS form at 350 s.
 */
export const T03_GRPC_ARRAY_SPECS: readonly GrpcSpec[] = [
  {
    plan: "T03.array.68",
    server: "grpc-go",
    name: "middlebox-forget, idle for 400 s, under DP11: the probes of the listener of grpc-go keep the flow through the conntrack at 350 s",
    fault: "middlebox-forget",
    mode: "idle",
    router: PRESETS.aws,
    hold: 400,
  },
];

/** These are the cells of the plan over these systems that are another cell of the catalogs. */
export const T03_GRPC_ALIASES: readonly Alias[] = [
  { plan: "T03.defaults.26", is: "T03.defaults.49", why: "its client is any client of T01 with the keepalive on or off: grpc-js has it off" },
  { plan: "T03.array.17", is: "T03.defaults.17", why: "DP07 sets ingress-nginx in front of Node: it names no system of this cell" },
  {
    plan: "T03.array.18",
    is: "T03.defaults.18",
    why: "DP10 sets the TCP keepalive of the endpoints below 350 s. grpc-js has no option for it, and the server probes each 15 s at its defaults",
  },
  { plan: "T03.array.19", is: "T03.defaults.19", why: "DP09 sets an NLB at its defaults: the router of this cell is the GCP firewall form" },
  { plan: "T03.array.20", is: "T03.defaults.20", why: "DP14 sets the egress of Azure: the router of this cell is a plain router" },
  { plan: "T03.array.26", is: "T03.defaults.49", why: "DP49 sets the path MTU of each cloud. A FIN is one short segment" },
  { plan: "T03.array.46", is: "T03.defaults.46", why: "DP13 sets the TCP keepalive of the endpoints below each timer of the path. grpc-js has no option for it, and a stall of 1 s ends first" },
  { plan: "T03.array.47", is: "T03.defaults.47", why: "DP39 sets the TCP keepalive and TCP_USER_TIMEOUT of each socket. grpc-js has no option for them, and the reset ends the call first" },
  { plan: "T03.array.48", is: "T03.defaults.48", why: "DP15 sets the egress of GCP: the router of this cell is the AWS NAT form" },
  { plan: "T03.array.49", is: "T03.defaults.49", why: "DP12 sets pools through an AWS NAT gateway at the defaults: the router of this cell" },
  {
    plan: "T03.array.69",
    is: "T03.defaults.18",
    why: "DP49 sets the path MTU of each cloud. A black hole at the router toward the client drops each segment, whatever its length and the form of the router",
  },
];

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T03_GRPC_WAITING: readonly Waiting[] = [
  {
    plan: "T03.defaults.16",
    trigger: "mtu-blackhole",
    why: "the health service of gRPC has no long reply: a reply of many long segments needs a method of the server of the harness",
  },
  {
    plan: "T03.array.16",
    trigger: "mtu-blackhole",
    why: "as T03.defaults.16, under DP08: the health service of gRPC has no long reply: a reply of many long segments needs a method of the server of the harness",
  },
];

/** These are the gRPC cells of T03 for the harness. */
export const T03_GRPC: readonly Cell[] = [...T03_GRPC_SPECS, ...T03_GRPC_ARRAY_SPECS].map(grpcCell);
