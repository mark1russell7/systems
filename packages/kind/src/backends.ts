// The parser of the rules of kube-proxy. The agent of each node reads the rules with it, and the
// image copies this file, thus it imports nothing.

/** A service rule names the Service whose backends the agent reads: its namespace, its name, and its ClusterIP and port for IPVS. */
export interface ServiceRule {
  readonly mode: "iptables" | "ipvs" | "nftables";
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
 */
export const backendsOf = (mode: ServiceRule["mode"], text: string, rule: Pick<ServiceRule, "ns" | "svc" | "ip" | "port">): string[] => {
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
      const service = /^TCP\s+([0-9A-F]{8}):([0-9A-F]{4})\s/.exec(line);
      if (service !== null) {
        inside = hexIp(service[1]!) === rule.ip && parseInt(service[2]!, 16) === rule.port;
        continue;
      }
      const real = /^\s+->\s+([0-9A-F]{8}):([0-9A-F]{4})\s+\S+\s+(\d+)/.exec(line);
      if (inside && real !== null && Number(real[3]) > 0) out.add(`${hexIp(real[1]!)}:${parseInt(real[2]!, 16)}`);
    }
  }
  return [...out].sort();
};
