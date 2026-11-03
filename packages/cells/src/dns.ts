import type { KindCell, Workload } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { DESIGN, WORKERS, WORKLOAD, kubeDefaults, s, say } from "./kind.ts";

/**
 * This module holds the cells of CoreDNS in S2 (SYS-50). A client resolves the name of the Service,
 * and no answer of the cluster DNS gets to it for a hold. The question of the family: when do its
 * failures start and end, and which timer sets the end?
 *
 * The client is Node on Alpine, thus its resolver is the resolver of musl. Each term comes from a
 * documented timer:
 * - The kubelet writes the resolv.conf of a pod with `dnsPolicy: ClusterFirst`: the nameserver of
 *   the cluster DNS, the search list `<namespace>.svc.cluster.local svc.cluster.local cluster.local`,
 *   and `options ndots:5` only (pkg/kubelet/network/dns/dns.go of v1.37.0, line 44 and lines
 *   164–173). Thus the resolver of the pod keeps the defaults of musl.
 * - By default, musl stops a lookup at 5 s, and it sends each query 2 times (src/network/resolvconf.c
 *   of v1.2.5). Thus its send loop sends each query again 5 / 2 = 2.5 s after the first send
 *   (res_msend.c). It accepts an answer to any send of a query.
 * - The short name `server` has fewer dots than ndots, thus musl asks for the first name of the
 *   search list first. With no answer, musl gives EAI_AGAIN, and the search stops there
 *   (name_from_dns and name_from_dns_search of lookup_name.c). The query of the first name answers
 *   in each run without the fault.
 * - musl has no cache. Thus the TTL of the answer (`ttl 30` of the kubernetes plugin) and the cache
 *   of CoreDNS (`cache 30` with `disable success` and `disable denial` for cluster.local) do not act
 *   at the client (the Corefile of kubeadm, cmd/kubeadm/app/phases/addons/dns/manifests.go of
 *   v1.37.0, lines 177–191). Each new connection does a lookup.
 * - Node runs each `dns.lookup()` as a blocking `getaddrinfo` on the threadpool of libuv, with 4
 *   threads at the default `UV_THREADPOOL_SIZE` (the docs of `node:dns` and of libuv). A lookup that
 *   waits for a thread waits in a queue. The timeout of a request does not stop its lookup.
 * - A connection that a client keeps does no lookup. Thus only a new connection meets the fault.
 */

/** These are the defaults of the resolver of musl: the timeout of a lookup, and the sends of each query (src/network/resolvconf.c of v1.2.5). */
export const MUSL_RESOLVER: { readonly timeout: Quantity; readonly sends: number } = { timeout: s(5), sends: 2 };

/** This time is the interval between two sends of one query of musl: the timeout over the sends (res_msend.c of v1.2.5). */
export const RETRY_INTERVAL: Quantity = s(valueIn(MUSL_RESOLVER.timeout, "s") / MUSL_RESOLVER.sends);

/** This count is the threads of the threadpool of libuv at the default `UV_THREADPOOL_SIZE`. Each lookup of Node takes one. */
export const THREADPOOL = 4;

/** These are the TTL of an answer of the kubernetes plugin and the cache of CoreDNS for other zones (the Corefile of kubeadm v1.37.0). A client of musl keeps no answer. */
export const COREDNS: { readonly ttl: Quantity; readonly cache: Quantity } = { ttl: s(30), cache: s(30) };

/**
 * This time is the most that the drops of one act take to change in each client pod after the stamp
 * of the act. The lab enters each namespace through the injector, the nodes at the same time. A
 * record of the act gives its start and its end, thus a run shows the real time.
 */
export const DNS_ACT: Quantity = s(0.5);

/**
 * This time is the most that the queue of lookups takes to drain after the first thread is free. A
 * queue of approximately 400 lookups goes through 4 threads, each with one round trip to CoreDNS.
 * This value is an assumption: a run measures it.
 */
export const DNS_DRAIN: Quantity = s(0.5);

/** This time is the hold of the fault: more than one timeout of musl, thus each thread starts a second lookup in the fault. */
export const DNS_HOLD: Quantity = s(6);

/** This workload is the clients of the black hole: a request each 20 ms on a new connection, to the name of the Service. */
export const BY_NAME: Workload = { ...WORKLOAD, byName: true };

/** This workload is the control: the same requests, on 2 connections that each client keeps. */
export const BY_NAME_KEPT: Workload = { ...WORKLOAD, connections: 2, byName: true };

/** A band is a time from its reference. */
interface Band {
  readonly lo: Quantity;
  readonly hi: Quantity;
}

const time = (value: number): Quantity => s(Math.round(value * 1e6) / 1e6);

/** This is the prediction of a black hole of DNS: the band of the first failure, the band of the last failure, and the reasons. */
export interface DnsPrediction {
  /** This band is the first failed request, from the fault. */
  readonly start: Band;
  /** This band is the last failed request, from the heal. */
  readonly end: Band;
  /**
   * This band is the last failed request, from the heal, if the threads stay in phase with the fault.
   * The judge does not use it. The prediction of the run records it.
   */
  readonly phase: Band;
  readonly why: string;
}

/**
 * This function gives the bands of a black hole of DNS from the timers of the module:
 * - The first failure is the first request after the drops, up to one interval and the act later.
 * - Each request that starts more than one timeout before the heal fails. Thus the last failure is
 *   at the earliest one timeout before the heal.
 * - After the heal, a thread is free at its next send, or at the end of its lookup. Either comes in
 *   one retry interval. Then the queue drains. A request fails if its lookup ends after its timeout.
 *   Thus the last failure starts at the latest after the heal by the retry interval less the timeout,
 *   with the drain and the act added.
 * - In phase: each thread starts its lookups at the fault, and each 5 s after it. With the hold
 *   between one and 1.5 timeouts, the threads are free 2.5 s after their second lookup. That is the
 *   fault, the timeout of musl and the retry interval.
 */
export const dnsOf = (workload: Workload, hold: Quantity): DnsPrediction => {
  const every = valueIn(workload.every, "s");
  const timeout = valueIn(workload.timeout, "s");
  const retry = valueIn(RETRY_INTERVAL, "s");
  const lookup = valueIn(MUSL_RESOLVER.timeout, "s");
  const held = valueIn(hold, "s");
  if (held <= lookup || held >= lookup + retry) throw new RangeError(`the hold of a black hole of DNS is between ${lookup} s and ${lookup + retry} s, not ${held} s`);
  const act = valueIn(DNS_ACT, "s");
  const drain = valueIn(DNS_DRAIN, "s");
  const start = { lo: s(0), hi: time(every + act) };
  const end = { lo: time(-timeout), hi: time(retry - timeout + drain + act) };
  // the threads are free at the fault + the timeout of musl + the retry interval, thus that much less the hold after the heal
  const free = lookup + retry - held;
  const phase = { lo: time(free - timeout), hi: time(free - timeout + drain + act) };
  const why = `Each client resolves the name of the Service for each new connection, with the resolver of musl. No answer gets to a client for ${say(hold)}. Each lookup in the fault takes a thread of the pool of ${THREADPOOL} for ${say(MUSL_RESOLVER.timeout)}, and the other lookups wait in the queue. Thus each request from the fault fails at its timeout of ${say(workload.timeout)}. After the heal, a thread is free at its next send, up to ${say(RETRY_INTERVAL)} later. Then the queue drains in up to ${say(DNS_DRAIN)}. Thus the last failure starts from ${say(end.lo)} to ${say(end.hi)} after the heal. If the threads stay in phase with the fault, it starts ${say(phase.lo)}–${say(phase.hi)} after the heal`;
  return { start, end, phase, why };
};

/** This function gives the cell of the black hole of DNS, with new connections or with kept connections. */
const dnsCellOf = (kept: boolean): KindCell => {
  const workload = kept ? BY_NAME_KEPT : BY_NAME;
  const base = {
    template: "T07" as const,
    substitutes: null,
    mode: "iptables" as const,
    workers: WORKERS,
    pod: kubeDefaults(2),
    declaration: DESIGN,
    workload,
    trigger: { kind: "dns-blackhole" as const, hold: DNS_HOLD },
    calibrates: false,
  };
  if (kept)
    return {
      ...base,
      id: "S2.T07.iptables.dns.kept",
      name: "T07 iptables, a black hole of CoreDNS: a client by name with kept connections",
      runs: 3,
      prediction: {
        kind: "none",
        why: `Each client keeps ${workload.connections ?? 0} connections from before the fault, and a kept connection does no lookup. Thus no request fails in the ${say(DNS_HOLD)} with no answer of DNS`,
      },
    };
  const predicted = dnsOf(workload, DNS_HOLD);
  return {
    ...base,
    id: "S2.T07.iptables.dns.blackhole",
    name: "T07 iptables, a black hole of CoreDNS: a client by name with new connections",
    runs: 4,
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: predicted.start },
      end: { from: "heal", band: predicted.end },
      certain: true,
      outcomes: ["timeout"],
      why: predicted.why,
    },
  };
};

/** These are the cells of CoreDNS: the black hole with new connections, and its control with kept connections. */
export const DNS_CELLS: readonly KindCell[] = [dnsCellOf(false), dnsCellOf(true)];
