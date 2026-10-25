// The hosts of one cluster in the Envoy of a sidecar, from the text of its admin endpoint
// `/clusters`. The agent of the lab image reads it with Node, thus this module imports nothing.

/**
 * These are the hosts of a cluster: the healthy ones (`b`, in sequence), and each other host with its
 * health flags (`u`). Each host is `ip:port`.
 */
export interface ClusterHosts {
  readonly b: readonly string[];
  readonly u: Readonly<Record<string, string>>;
}

/**
 * This function gives the name of the outbound cluster of a Service port in a sidecar of Istio:
 * `outbound|<port>||<service>.<namespace>.svc.cluster.local`.
 */
export const outboundCluster = (service: string, namespace: string, port: number): string => `outbound|${port}||${service}.${namespace}.svc.cluster.local`;

/** This function gives the filter of `/clusters` that selects one cluster: a regular expression of RE2 with anchors. */
export const clusterFilter = (cluster: string): string => `^${cluster.replace(/[.|\\^$*+?()[\]{}]/g, (c) => `\\${c}`)}$`;

/**
 * This function gives the hosts of a cluster from the text of `/clusters`. Each host of the text has
 * a line `<cluster>::<ip:port>::health_flags::<flags>`. The flags are `healthy`, or the names of the
 * flags that the host has (`clusters_handler.cc` and `host_utility.cc` of Envoy v1.39.4).
 */
export const hostsOf = (text: string, cluster: string): ClusterHosts => {
  const healthy: string[] = [];
  const other: Record<string, string> = {};
  const prefix = `${cluster}::`;
  for (const line of text.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const parts = line.slice(prefix.length).split("::");
    if (parts.length !== 3 || parts[1] !== "health_flags") continue;
    const [host, , flags] = parts as [string, string, string];
    if (flags.trim() === "healthy") healthy.push(host);
    else other[host] = flags.trim();
  }
  return { b: healthy.sort(), u: other };
};
