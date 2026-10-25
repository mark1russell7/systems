// The watcher of a kind cell. It runs in a container on the Docker network of the cluster, thus in
// the VM, and it stamps each event on CLOCK_MONOTONIC when it arrives. It watches the pods, the
// EndpointSlices and the events of one namespace through the API, and it follows the log of each
// pod with the label lab.systems/log=1. A log line is JSON with its own stamp, and the watcher
// passes it on as it is.
//
// The sidecar of Istio (the container istio-proxy) is a native sidecar: an init container that
// runs beside the app. The watcher follows it too. Its lines are the access log of Envoy (JSON, a
// stamp of the wall clock) and the text of pilot-agent. Each one becomes a line `proxy` with the
// stamp of its arrival: evidence, not a time that a band reads. An access line of a call that
// succeeded at its first attempt is only counted (`proxy-ok`, each second), thus the record keeps
// the failures, the retries and the local replies.
//
// With ZTUNNEL=1, for a cell in the ambient mesh, the watcher also follows each ztunnel pod in
// istio-system. Each such pod is a line `ztunnel-pod`, not `pod`: the tracker of the cell counts only
// the pods of the cell. Each line of the log of ztunnel becomes a line `ztunnel` with the stamp of
// its arrival. Its own stamp is of the wall clock, thus it is evidence, not a time that a band reads.
import https from "node:https";

const kube = JSON.parse(process.env.KUBE ?? "{}");
const namespaces = (process.env.NAMESPACES ?? "default").split(",");
const ztunnel = process.env.ZTUNNEL === "1";
const now = () => Number(process.hrtime.bigint()) / 1e6;
const server = new URL(kube.server);
const agent = new https.Agent({
  ca: Buffer.from(kube.ca, "base64"),
  cert: Buffer.from(kube.cert, "base64"),
  key: Buffer.from(kube.key, "base64"),
  keepAlive: true,
});

let pending = [];
const flush = () => {
  if (pending.length > 0) process.stdout.write(pending.join(""));
  pending = [];
};
setInterval(flush, 50);
const say = (line) => pending.push(`${JSON.stringify(line)}\n`);

/**
 * A handler gives this value for an ERROR event of 410 Gone: the API has no history from the last
 * resource version. The status of the response is 200, thus only the event tells. The watch then
 * opens again with no resource version, and the API gives each object again as ADDED.
 */
const GONE = Symbol("gone");
/** the result of a handler for an ERROR event: GONE for an expired resource version, else null */
const errorOf = (status) => (status?.code === 410 ? GONE : null);

/** a stream of lines from the API, again after each end, from the last resource version it saw */
const stream = (path, query, onLine, again = true) => {
  let version = null;
  const open = () => {
    // An error and a close can both end one request: only the first opens the next one.
    let ended = false;
    const reopen = (delay) => {
      if (!again || ended) return;
      ended = true;
      setTimeout(open, delay);
    };
    const search = new URLSearchParams(query);
    if (version !== null) search.set("resourceVersion", version);
    const req = https.request(
      { host: server.hostname, port: server.port, path: `${path}?${search}`, method: "GET", agent },
      (res) => {
        if (res.statusCode !== 200) {
          say({ ev: "watch-fail", t: now(), path, status: res.statusCode });
          res.resume();
          if (res.statusCode === 410) version = null;
          reopen(500);
          return;
        }
        let partial = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          const t = now();
          partial += chunk;
          const split = partial.split("\n");
          partial = split.pop() ?? "";
          for (const text of split) {
            if (text.trim() === "") continue;
            const next = onLine(text, t);
            if (next === GONE) version = null;
            else if (typeof next === "string") version = next;
          }
        });
        // A response that the connection cuts has no end, only its error and its close.
        res.on("error", (error) => say({ ev: "watch-fail", t: now(), path, why: String(error.message) }));
        res.on("close", () => reopen(100));
      },
    );
    req.on("error", (error) => {
      say({ ev: "watch-fail", t: now(), path, why: String(error.message) });
      reopen(500);
    });
    req.end();
  };
  open();
};

const stateOf = (state) => {
  if (state?.running) return "running";
  if (state?.waiting) return `waiting:${state.waiting.reason ?? ""}`;
  if (state?.terminated) return `terminated:${state.terminated.reason ?? ""}:${state.terminated.exitCode}`;
  return "none";
};

/** the container of the sidecar of Istio */
const PROXY = "istio-proxy";
/** the access lines of each sidecar that the watcher only counted, by pod, since the last count */
const counted = new Map();
setInterval(() => {
  const t = now();
  for (const [pod, n] of counted) say({ ev: "proxy-ok", t, p: pod, n });
  counted.clear();
}, 1000);

/** an access line of Envoy that tells nothing more than its call: status 200, no flag, gRPC status 0, one attempt */
const plain = (log) =>
  String(log.code) === "200" && (log.flags === "-" || log.flags === "" || log.flags === undefined) && String(log.grpc) === "0" && Number(log.attempts ?? 1) <= 1;

/** a line of the sidecar: an access line of Envoy as JSON, or a text line of pilot-agent */
const proxyLine = (pod, text) => {
  if (text.startsWith("{")) {
    try {
      const log = JSON.parse(text);
      if (plain(log)) {
        counted.set(pod, (counted.get(pod) ?? 0) + 1);
        return;
      }
      say({ ev: "proxy", t: now(), p: pod, log });
      return;
    } catch {
      // a line that is not whole JSON is text
    }
  }
  say({ ev: "proxy", t: now(), p: pod, text: text.slice(0, 500) });
};

/** the namespace of the mesh, with the ztunnel pods */
const MESH_NS = "istio-system";

const following = new Set();
const follow = (ns, pod, container, id) => {
  const key = `${ns}/${pod}/${container}/${id}`;
  if (following.has(key)) return;
  following.add(key);
  stream(
    `/api/v1/namespaces/${ns}/pods/${pod}/log`,
    // a ztunnel ran before the cell: only its lines from the start of the watcher
    ns === MESH_NS ? { container, follow: "true", sinceSeconds: "5" } : { container, follow: "true" },
    (text) => {
      if (ns === MESH_NS) say({ ev: "ztunnel", t: now(), p: pod, text: text.slice(0, 500) });
      else if (container === PROXY) proxyLine(pod, text);
      else if (text.startsWith("{")) pending.push(`${text}\n`);
      else say({ ev: "text", t: now(), p: pod, text: text.slice(0, 500) });
    },
    false,
  );
};

for (const ns of namespaces) {
  stream(`/api/v1/namespaces/${ns}/pods`, { watch: "1", allowWatchBookmarks: "true" }, (text, t) => {
    const event = JSON.parse(text);
    const pod = event.object;
    if (event.type === "BOOKMARK") return pod?.metadata?.resourceVersion;
    if (event.type === "ERROR") {
      say({ ev: "watch-fail", t, path: "pods", status: pod?.code });
      return errorOf(pod);
    }
    const ready = (pod.status?.conditions ?? []).find((condition) => condition.type === "Ready")?.status === "True";
    const containers = (pod.status?.containerStatuses ?? []).map((status) => ({
      n: status.name,
      r: status.ready,
      rc: status.restartCount,
      st: stateOf(status.state),
      last: stateOf(status.lastState),
      id: status.containerID ?? null,
    }));
    // the native sidecar of Istio is a running init container: its state, apart from the containers
    const sidecars = (pod.status?.initContainerStatuses ?? [])
      .filter((status) => status.name === PROXY)
      .map((status) => ({ n: status.name, r: status.ready, rc: status.restartCount, st: stateOf(status.state), id: status.containerID ?? null }));
    say({
      ev: "pod",
      t,
      type: event.type,
      ns,
      name: pod.metadata.name,
      node: pod.spec?.nodeName ?? null,
      ip: pod.status?.podIP ?? null,
      del: pod.metadata.deletionTimestamp !== undefined,
      ready,
      phase: pod.status?.phase ?? null,
      cs: containers,
      ...(sidecars.length === 0 ? {} : { sc: sidecars }),
      labels: pod.metadata.labels ?? {},
    });
    if (event.type !== "DELETED" && pod.metadata.labels?.["lab.systems/log"] === "1") {
      const running = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? []).filter((status) => status.name === PROXY)];
      for (const status of running) if (status.state?.running && status.containerID) follow(ns, pod.metadata.name, status.name, status.containerID);
    }
    return pod.metadata.resourceVersion;
  });
  stream(`/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices`, { watch: "1", allowWatchBookmarks: "true" }, (text, t) => {
    const event = JSON.parse(text);
    const slice = event.object;
    if (event.type === "BOOKMARK") return slice?.metadata?.resourceVersion;
    if (event.type === "ERROR") return errorOf(slice);
    say({
      ev: "slice",
      t,
      type: event.type,
      ns,
      name: slice.metadata.name,
      svc: slice.metadata.labels?.["kubernetes.io/service-name"] ?? null,
      eps: (slice.endpoints ?? []).map((endpoint) => ({
        ip: endpoint.addresses?.[0] ?? null,
        r: endpoint.conditions?.ready ?? null,
        s: endpoint.conditions?.serving ?? null,
        x: endpoint.conditions?.terminating ?? null,
        pod: endpoint.targetRef?.name ?? null,
        node: endpoint.nodeName ?? null,
      })),
    });
    return slice.metadata.resourceVersion;
  });
  stream(`/api/v1/namespaces/${ns}/events`, { watch: "1", allowWatchBookmarks: "true" }, (text, t) => {
    const event = JSON.parse(text);
    const object = event.object;
    if (event.type === "BOOKMARK") return object?.metadata?.resourceVersion;
    if (event.type === "ERROR") return errorOf(object);
    say({
      ev: "event",
      t,
      type: event.type,
      ns,
      reason: object.reason ?? null,
      msg: String(object.message ?? "").slice(0, 300),
      obj: object.involvedObject?.name ?? null,
      kind: object.involvedObject?.kind ?? null,
      n: object.count ?? object.series?.count ?? 1,
      last: object.lastTimestamp ?? object.eventTime ?? null,
      src: object.source?.component ?? object.reportingComponent ?? null,
    });
    return object.metadata.resourceVersion;
  });
}
if (ztunnel) {
  stream(`/api/v1/namespaces/${MESH_NS}/pods`, { watch: "1", allowWatchBookmarks: "true", labelSelector: "app=ztunnel" }, (text, t) => {
    const event = JSON.parse(text);
    const pod = event.object;
    if (event.type === "BOOKMARK") return pod?.metadata?.resourceVersion;
    if (event.type === "ERROR") {
      say({ ev: "watch-fail", t, path: "ztunnel pods", status: pod?.code });
      return errorOf(pod);
    }
    const containers = (pod.status?.containerStatuses ?? []).map((status) => ({ n: status.name, r: status.ready, rc: status.restartCount, st: stateOf(status.state), id: status.containerID ?? null }));
    say({ ev: "ztunnel-pod", t, type: event.type, name: pod.metadata.name, node: pod.spec?.nodeName ?? null, ip: pod.status?.podIP ?? null, del: pod.metadata.deletionTimestamp !== undefined, cs: containers });
    if (event.type !== "DELETED")
      for (const status of pod.status?.containerStatuses ?? []) if (status.state?.running && status.containerID) follow(MESH_NS, pod.metadata.name, status.name, status.containerID);
    return pod.metadata.resourceVersion;
  });
}
say({ ev: "watcher", what: "start", t: now(), namespaces, ztunnel });
