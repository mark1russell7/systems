// The watcher of a kind cell. It runs in a container on the Docker network of the cluster, thus in
// the VM, and it stamps each event on CLOCK_MONOTONIC when it arrives. It watches the pods, the
// EndpointSlices and the events of one namespace through the API, and it follows the log of each
// pod with the label lab.systems/log=1. A log line is JSON with its own stamp, and the watcher
// passes it on as it is.
import https from "node:https";

const kube = JSON.parse(process.env.KUBE ?? "{}");
const namespaces = (process.env.NAMESPACES ?? "default").split(",");
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

/** a stream of lines from the API, again after each end, from the last resource version it saw */
const stream = (path, query, onLine, again = true) => {
  let version = null;
  const open = () => {
    const search = new URLSearchParams(query);
    if (version !== null) search.set("resourceVersion", version);
    const req = https.request(
      { host: server.hostname, port: server.port, path: `${path}?${search}`, method: "GET", agent },
      (res) => {
        if (res.statusCode !== 200) {
          say({ ev: "watch-fail", t: now(), path, status: res.statusCode });
          res.resume();
          if (res.statusCode === 410) version = null;
          if (again) setTimeout(open, 500);
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
            if (typeof next === "string") version = next;
          }
        });
        res.on("end", () => {
          if (again) setTimeout(open, 100);
        });
        res.on("error", () => undefined);
      },
    );
    req.on("error", (error) => {
      say({ ev: "watch-fail", t: now(), path, why: String(error.message) });
      if (again) setTimeout(open, 500);
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

const following = new Set();
const follow = (ns, pod, container, id) => {
  const key = `${ns}/${pod}/${container}/${id}`;
  if (following.has(key)) return;
  following.add(key);
  stream(
    `/api/v1/namespaces/${ns}/pods/${pod}/log`,
    { container, follow: "true" },
    (text) => {
      if (text.startsWith("{")) pending.push(`${text}\n`);
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
      return null;
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
      labels: pod.metadata.labels ?? {},
    });
    if (event.type !== "DELETED" && pod.metadata.labels?.["lab.systems/log"] === "1")
      for (const status of pod.status?.containerStatuses ?? [])
        if (status.state?.running && status.containerID) follow(ns, pod.metadata.name, status.name, status.containerID);
    return pod.metadata.resourceVersion;
  });
  stream(`/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices`, { watch: "1", allowWatchBookmarks: "true" }, (text, t) => {
    const event = JSON.parse(text);
    const slice = event.object;
    if (event.type === "BOOKMARK") return slice?.metadata?.resourceVersion;
    if (event.type === "ERROR") return null;
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
    if (event.type === "ERROR") return null;
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
say({ ev: "watcher", what: "start", t: now(), namespaces });
