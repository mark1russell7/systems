// The parser of the rules of kube-proxy and of the services of Cilium. The agent of each node reads
// the rules with it, and the image copies this file, thus it imports nothing.

/** A service rule names the Service whose backends the agent reads: its namespace, its name, and its ClusterIP and port for IPVS and Cilium. */
export interface ServiceRule {
  readonly mode: "iptables" | "ipvs" | "nftables" | "cilium";
  readonly ns: string;
  readonly svc: string;
  readonly ip: string;
  readonly port: number;
}

const hexIp = (hex: string): string =>
  [0, 2, 4, 6].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(".");

/**
 * This function gives the backends of a Service in a dump of the rules of kube-proxy, as
 * `ip:port`, sorted. A backend of IPVS with the weight zero takes no new connection, thus it is
 * not a backend.
 * - iptables: the `KUBE-SVC` chain of the Service jumps to a `KUBE-SEP` chain for each backend, and that chain does the DNAT.
 * - nftables: the `service-` chain of the Service does the DNAT to each backend, or it names an `endpoint-` chain for each one.
 * - IPVS: `/proc/net/ip_vs` has the line of the virtual service, then a line for each real server.
 * - Cilium: the JSON of the services of the agent (`ciliumBackendsOf`).
 */
export const backendsOf = (mode: ServiceRule["mode"], text: string, rule: Pick<ServiceRule, "ns" | "svc" | "ip" | "port">): string[] => {
  if (mode === "cilium") return ciliumBackendsOf(text, rule);
  const out = new Set<string>();
  const lines = text.split("\n");
  if (mode === "iptables") {
    const seps = new Set<string>();
    for (const line of lines) {
      if (!line.startsWith("-A KUBE-SVC-") || !line.includes(`${rule.ns}/${rule.svc}:`)) continue;
      const jump = / -j (KUBE-SEP-\S+)/.exec(line);
      if (jump !== null) seps.add(jump[1]!);
    }
    for (const line of lines) {
      const chain = /^-A (KUBE-SEP-\S+) /.exec(line);
      if (chain === null || !seps.has(chain[1]!)) continue;
      const to = / --to-destination (\S+)/.exec(line);
      if (to !== null) out.add(to[1]!);
    }
  } else if (mode === "nftables") {
    // a chain name with a slash can print in quotes: `chain "service-…" {` and `goto "endpoint-…"`
    let inside = false;
    const ours = `-${rule.ns}/${rule.svc}/`;
    for (const line of lines) {
      const head = /^\s*chain\s+"?([^"\s{]+)"?\s*\{/.exec(line);
      if (head !== null) inside = head[1]!.startsWith("service-") && head[1]!.includes(ours);
      else if (/^\s*(set|map)\s/.test(line)) inside = false;
      if (!inside) continue;
      // one chain for each endpoint, as kube-proxy 1.31 writes it
      for (const match of line.matchAll(/(?:goto|jump)\s+"?endpoint-[0-9A-Za-z]+(-[^\s,}"]+)__([0-9.]+)\/(\d+)"?/g))
        if (match[1]!.startsWith(ours)) out.add(`${match[2]}:${match[3]}`);
      // a DNAT in the service chain, as kube-proxy 1.37 writes it: `numgen random mod 2 map { 0 : IP . PORT, … }`, or `dnat to IP:PORT`
      for (const match of line.matchAll(/(?:^|[\s{,:])(\d+\.\d+\.\d+\.\d+) \. (\d+)(?=\s*[,}]|\s*$)/g)) out.add(`${match[1]}:${match[2]}`);
      for (const match of line.matchAll(/\bdnat (?:ip )?to (\d+\.\d+\.\d+\.\d+):(\d+)/g)) out.add(`${match[1]}:${match[2]}`);
    }
  } else {
    let inside = false;
    for (const line of lines) {
      // each virtual service starts a block: a UDP or an SCTP one ends the block of the TCP service before it
      const service = /^(TCP|UDP|SCTP)\s+([0-9A-F]{8}):([0-9A-F]{4})\s/.exec(line);
      if (service !== null) {
        inside = service[1] === "TCP" && hexIp(service[2]!) === rule.ip && parseInt(service[3]!, 16) === rule.port;
        continue;
      }
      const real = /^\s+->\s+([0-9A-F]{8}):([0-9A-F]{4})\s+\S+\s+(\d+)/.exec(line);
      if (inside && real !== null && Number(real[3]) > 0) out.add(`${hexIp(real[1]!)}:${parseInt(real[2]!, 16)}`);
    }
  }
  return [...out].sort();
};

/** This is one service of the agent of Cilium, as `GET /v1/service` gives it: the fields that the parser reads. */
interface CiliumService {
  readonly spec?: {
    readonly "frontend-address"?: { readonly ip?: string; readonly port?: number; readonly protocol?: string; readonly scope?: string };
    readonly "backend-addresses"?: ReadonlyArray<{ readonly ip?: string; readonly port?: number; readonly state?: string }> | null;
    readonly flags?: { readonly type?: string; readonly name?: string; readonly namespace?: string };
  };
}

/** This function gives the services in a reply of the agent of Cilium. It refuses a reply that is not a JSON list. */
const ciliumServices = (text: string): CiliumService[] => {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("the reply of the agent of Cilium is not a list of services");
  return data as CiliumService[];
};

/**
 * This function gives the backends of a Service in the reply of `GET /v1/service` of the agent of
 * Cilium 1.20, as `ip:port`, sorted. The model is `ServiceSpec` of `api/v1/openapi.yaml`. The
 * frontend is the ClusterIP and the port of the rule, with the scope `external` or no scope.
 *
 * The backends are those in the state `active`, or with no state. If no backend is active, the
 * backends are those in the state `terminating`. The BPF reconciler gives the slots of a service
 * in this sequence (`pkg/loadbalancer/reconciler/bpf_reconciler.go`). Thus a new connection goes
 * only to them. kube-proxy does the same with the endpoints that serve and stop. The other
 * states take no new connection: `terminating-not-serving`, `quarantined` and `maintenance`.
 */
export const ciliumBackendsOf = (text: string, rule: Pick<ServiceRule, "ip" | "port">): string[] => {
  const ours = ciliumServices(text).filter((service) => {
    const front = service.spec?.["frontend-address"];
    const protocol = (front?.protocol ?? "tcp").toLowerCase();
    return front?.ip === rule.ip && front.port === rule.port && (protocol === "tcp" || protocol === "any") && (front.scope ?? "external") === "external";
  });
  const backends = ours.flatMap((service) => service.spec?.["backend-addresses"] ?? []);
  const of = (states: readonly (string | undefined)[]): string[] =>
    [...new Set(backends.filter((b) => states.includes(b.state) && b.ip !== undefined).map((b) => `${b.ip}:${b.port ?? 0}`))].sort();
  const active = of(["active", undefined]);
  return active.length > 0 ? active : of(["terminating"]);
};

/**
 * This function tells if a dump of the rules names the Service of a rule. The rules of kube-proxy
 * name it as `namespace/name`. The JSON of Cilium names it in the flags of its frontend.
 */
export const namesService = (mode: ServiceRule["mode"], text: string, rule: Pick<ServiceRule, "ns" | "svc">): boolean => {
  if (mode !== "cilium") return text.includes(`${rule.ns}/${rule.svc}`);
  try {
    return ciliumServices(text).some((service) => service.spec?.flags?.namespace === rule.ns && service.spec.flags.name === rule.svc);
  } catch {
    return false;
  }
};
