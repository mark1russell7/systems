import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Backoff, KindCell } from "./cell.ts";
import type { Cluster } from "./cluster.ts";
import type { PinnedChart } from "./helm.ts";
import { helmInstall } from "./helm.ts";
import { LOG_LABEL } from "./names.ts";

/**
 * This module installs Apache Pulsar 5.0.0 in a kind cluster (SYS-56): one ZooKeeper, one bookie and
 * two brokers, from the Helm chart 4.8.0. It also gives the producers of the cell: a Python script
 * in the image of Pulsar, with its client 3.13.0 over the C++ client 4.2.0. Each producer sends to
 * one topic, and a thread of it looks up the owner of that topic at each probe.
 *
 * The fault is a SIGKILL of the JVM of the broker that owns the topic. Each term of the return of a
 * producer comes from a pinned source:
 * - The owner of a bundle is an ephemeral znode of the session of its broker. A lookup gives the
 *   owner from the cache of the ownership, with no check of its life (pulsar-broker
 *   NamespaceService.java at v5.0.0, lines 489–508). Thus each lookup names the stopped broker
 *   until its session expires.
 * - The session timeout is `metadataStoreSessionTimeoutMillis`, 30000 (conf/broker.conf at v5.0.0,
 *   line 187, and the chart, values.yaml line 1474). ZKMetadataStore.java gives it to ZooKeeper (line 105).
 * - The client of ZooKeeper 3.9.6 pings after 9 s with no send (ClientCnxn.java, lines 422, 1184
 *   and 1263–1268). That is half of the read timeout of 2/3 of the session, less 1 s.
 *   The server rounds each expiry up to the next tick of 2000 ms (ExpiryQueue.java, lines 53–54
 *   and 87, and conf/zookeeper.conf of Pulsar, line 21). Thus the session expires 21–32 s after the stop.
 * - The broker that stays then takes the bundle at the next lookup.
 * - The chart starts a broker again only after its old znode is gone (templates/broker-statefulset.yaml,
 *   lines 296–302). Thus the stopped broker cannot take the bundle back first.
 */

/** This version is the release of Pulsar of the lab. */
export const PULSAR_VERSION = "5.0.0";

/**
 * This chart is the Helm chart 4.8.0 of Pulsar. The sha256 is of the file of the release. The URL is
 * on the archive of Apache, which keeps each release. The mirror downloads.apache.org keeps only the
 * latest releases.
 */
export const PULSAR_CHART: PinnedChart = {
  name: "pulsar",
  version: "4.8.0",
  url: "https://archive.apache.org/dist/pulsar/helm-chart/4.8.0/pulsar-4.8.0.tgz",
  sha256: "464f4a268463d187c9bc83b365b31de0b4a460533d948a04f846ba9b026068f5",
};

/**
 * This image is Pulsar 5.0.0 for linux/amd64, pinned by the digest of the manifest of the platform.
 * It has ZooKeeper 3.9.6, BookKeeper, the broker, Python 3 and the Python client 3.13.0. The lab
 * pulls it by its digest, tags it (`localPin`), and loads it into each node.
 */
export const PULSAR_IMAGE = "apachepulsar/pulsar:5.0.0@sha256:11e9a885121e16be91da77fdd3cfc3d4cbbece4700271d75e949585dbd3a5a5b";

/** This namespace holds Pulsar. The release of the chart is `pulsar` too. */
export const PULSAR_NAMESPACE = "pulsar";

/** This name is the app of the producers of a cell. */
export const PRODUCER = "producer";

/** This topic is the topic of the producers. */
export const PULSAR_TOPIC = "persistent://public/default/lab";

/** This URL is the Service of the brokers for the binary protocol. */
export const PULSAR_SERVICE: string = `pulsar://pulsar-broker.${PULSAR_NAMESPACE}.svc.cluster.local:6650`;

/** This URL is the lookup of the owner of the topic, on the Service of the brokers. */
export const PULSAR_LOOKUP: string = `http://pulsar-broker.${PULSAR_NAMESPACE}.svc.cluster.local:8080/lookup/v2/topic/persistent/public/default/lab`;

/** This time is the session timeout of each broker in ZooKeeper (`metadataStoreSessionTimeoutMillis`). */
export const SESSION: Quantity = { value: 30, unit: "s" };

/** This time is the tick of ZooKeeper (`tickTime`). The server rounds each expiry up to a tick. */
export const TICK: Quantity = { value: 2, unit: "s" };

/** This time is the longest idle time of the client of ZooKeeper before its ping: the half of 2/3 of the session, less 1 s. */
export const PING: Quantity = { value: 9, unit: "s" };

/**
 * This backoff is the backoff of a producer of the C++ client 4.2.0, with the defaults of the Python
 * client 3.13.0:
 * - The initial delay is 100 ms and the most is 60 s (lib/ClientConfigurationImpl.h, lines 39–40).
 * - The mandatory stop is the send timeout less 100 ms, and at least 100 ms (lib/ProducerImpl.cc,
 *   lines 55–57). The send timeout of `create_producer` is 30000 ms (pulsar/__init__.py, line 1015).
 * - The jitter takes 0–9 % of each delay (lib/Backoff.cc, line 54).
 * - A try that fails takes the lookup and the connect, which a reset ends at once. The lab gives it 100 ms.
 */
export const PRODUCER_BACKOFF: Backoff = {
  initial: { value: 100, unit: "ms" },
  max: { value: 60, unit: "s" },
  mandatoryStop: { value: 29.9, unit: "s" },
  jitter: 0.09,
  attempt: { value: 100, unit: "ms" },
};

/** This function gives the repository and the tag of a local image, for the values of a chart. */
const repositoryOf = (local: string): { repository: string; tag: string } => {
  const at = local.lastIndexOf(":");
  if (at <= 0) throw new Error(`the image ${local} has no tag`);
  return { repository: local.slice(0, at), tag: local.slice(at + 1) };
};

/**
 * This function gives the values of the chart: ZooKeeper, one bookie and two brokers, with no
 * proxy, no autorecovery, no toolset and no monitor. The bookie keeps one copy of each entry, and
 * the brokers do not move a bundle by load. Each image is the local image, with no pull.
 */
export const pulsarValues = (image: string): Record<string, unknown> => {
  const { repository, tag } = repositoryOf(image);
  const noMonitor = { podMonitor: { enabled: false } };
  return {
    components: { zookeeper: true, bookkeeper: true, broker: true, autorecovery: false, proxy: false, toolset: false, functions: false, function_worker: false },
    "victoria-metrics-k8s-stack": { enabled: false },
    defaultPulsarImageRepository: repository,
    defaultPulsarImageTag: tag,
    defaultPullPolicy: "Never",
    affinity: { anti_affinity: false },
    volumes: { persistence: false },
    zookeeper: { replicaCount: 1, statefulsetUpgrade: { enabled: false }, ...noMonitor },
    bookkeeper: { replicaCount: 1, ...noMonitor },
    autorecovery: noMonitor,
    proxy: noMonitor,
    broker: {
      replicaCount: 2,
      statefulsetUpgrade: { enabled: false },
      ...noMonitor,
      configData: {
        managedLedgerDefaultEnsembleSize: "1",
        managedLedgerDefaultWriteQuorum: "1",
        managedLedgerDefaultAckQuorum: "1",
        loadBalancerSheddingEnabled: "false",
        loadBalancerAutoBundleSplitEnabled: "false",
      },
    },
  };
};

/**
 * This script is a producer of the cell. Each line that it writes is JSON, with the time of
 * CLOCK_MONOTONIC in milliseconds, the pod and the node:
 * - `send`: one send, at its start, with its time to the answer and its outcome. A send is `ok` within
 *   the timeout, `late` after it, or the name of the result of the client (for example `timeout`).
 * - `lookup`: one lookup of the owner of the topic, with the host of the owner.
 * - `pulsar`: one line of the C++ client about the connection of the producer.
 */
export const PRODUCER_SCRIPT = `import json, logging, os, sys, threading, time, urllib.request
import pulsar

POD = os.environ["POD_NAME"]
NODE = os.environ["NODE_NAME"]
EVERY = int(os.environ["EVERY_MS"]) / 1000
TIMEOUT = int(os.environ["TIMEOUT_MS"])
PROBE = int(os.environ["PROBE_MS"]) / 1000
LOCK = threading.Lock()
KEPT = ("Schedule reconnection", "Getting connection from pool", "Created producer", "Connection closed", "Disconnected", "Lookup response", "Failed to", "Finished connecting")


def now():
    return time.monotonic() * 1000


def say(**line):
    text = json.dumps({**line, "p": POD, "n": NODE}, separators=(",", ":"))
    with LOCK:
        sys.stdout.write(text + "\\n")
        sys.stdout.flush()


class Relay(logging.Handler):
    def emit(self, record):
        message = record.getMessage()
        if any(word in message for word in KEPT):
            say(ev="pulsar", t=now(), m=message[:400])


def probe():
    while True:
        start = now()
        owner = None
        outcome = "ok"
        try:
            with urllib.request.urlopen(os.environ["LOOKUP"], timeout=1) as answer:
                data = json.loads(answer.read())
            url = data.get("brokerUrl") or ""
            owner = url.split("://", 1)[-1].rsplit(":", 1)[0] or None
        except Exception as error:
            outcome = type(error).__name__.lower()
        say(ev="lookup", t=start, d=round(now() - start, 3), o=outcome, owner=owner)
        time.sleep(max(0.0, PROBE - (now() - start) / 1000))


def answered(start):
    def done(result, message_id):
        took = now() - start
        if result == pulsar.Result.Ok:
            outcome = "ok" if took <= TIMEOUT else "late"
        else:
            outcome = getattr(result, "name", str(result).split(".")[-1]).lower()
        say(ev="send", t=start, d=round(took, 3), o=outcome)
    return done


logger = logging.getLogger("lab")
logger.setLevel(logging.INFO)
logger.propagate = False
logger.addHandler(Relay())
threading.Thread(target=probe, daemon=True).start()
client = pulsar.Client(os.environ["SERVICE"], logger=logger)
while True:
    try:
        producer = client.create_producer(os.environ["TOPIC"])
        break
    except Exception as error:
        say(ev="text", t=now(), text="create_producer: " + str(error)[:200])
        time.sleep(2)
at = time.monotonic()
while True:
    start = now()
    try:
        producer.send_async(b"lab", answered(start))
    except Exception as error:
        say(ev="send", t=start, d=0, o="refused-" + type(error).__name__.lower())
    at += EVERY
    time.sleep(max(0.0, at - time.monotonic()))
`;

/**
 * This function gives the producers of a cell in its namespace. They are the script in a ConfigMap,
 * and a Deployment of `clients` pods in the local image of Pulsar, one on each worker.
 */
export const pulsarObjects = (cell: KindCell, namespace: string, image: string): unknown[] => {
  if (cell.pulsar === undefined) throw new Error(`${cell.name} has no broker`);
  const env = {
    SERVICE: PULSAR_SERVICE,
    TOPIC: PULSAR_TOPIC,
    LOOKUP: PULSAR_LOOKUP,
    EVERY_MS: String(valueIn(cell.workload.every, "ms")),
    TIMEOUT_MS: String(valueIn(cell.workload.timeout, "ms")),
    PROBE_MS: String(valueIn(cell.pulsar.probe, "ms")),
    PYTHONUNBUFFERED: "1",
  };
  return [
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: PRODUCER, namespace }, data: { "producer.py": PRODUCER_SCRIPT } },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: PRODUCER, namespace, labels: { app: PRODUCER } },
      spec: {
        replicas: cell.pulsar.clients,
        selector: { matchLabels: { app: PRODUCER } },
        template: {
          metadata: { labels: { app: PRODUCER, [LOG_LABEL]: "1" } },
          spec: {
            terminationGracePeriodSeconds: 0,
            topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "DoNotSchedule", labelSelector: { matchLabels: { app: PRODUCER } } }],
            volumes: [{ name: "script", configMap: { name: PRODUCER } }],
            containers: [
              {
                name: PRODUCER,
                image,
                imagePullPolicy: "Never",
                command: ["python3", "/lab/producer.py"],
                volumeMounts: [{ name: "script", mountPath: "/lab" }],
                env: [
                  ...Object.entries(env).map(([name, value]) => ({ name, value })),
                  { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
                  { name: "NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
                ],
              },
            ],
          },
        },
      },
    },
  ];
};

/** A broker is a pod of a broker: its name, its node, its address, and if it is ready. */
export interface Broker {
  readonly pod: string;
  readonly node: string;
  readonly ip: string;
  readonly ready: boolean;
}

/** This function gives the pods of the brokers, in the sequence of their names. */
export const brokersOf = async (cluster: Pick<Cluster, "kubectl">): Promise<Broker[]> => {
  const list = JSON.parse(await cluster.kubectl(["-n", PULSAR_NAMESPACE, "get", "pods", "-l", "component=broker", "-o", "json"])) as {
    items: ReadonlyArray<{
      metadata: { name: string; deletionTimestamp?: string };
      spec: { nodeName?: string };
      status?: { podIP?: string; containerStatuses?: ReadonlyArray<{ ready: boolean }> };
    }>;
  };
  return list.items
    .filter((pod) => pod.metadata.deletionTimestamp === undefined)
    .map((pod) => ({
      pod: pod.metadata.name,
      node: pod.spec.nodeName ?? "",
      ip: pod.status?.podIP ?? "",
      ready: (pod.status?.containerStatuses ?? []).length > 0 && pod.status!.containerStatuses!.every((status) => status.ready),
    }))
    .sort((a, b) => a.pod.localeCompare(b.pod));
};

/** This function gives the broker that a host of a lookup names. Its pod is the first label of the host, or its address is the host. */
export const brokerOfHost = (brokers: readonly Broker[], host: string): Broker | undefined =>
  brokers.find((broker) => host.split(".")[0] === broker.pod || host === broker.ip);

/** This is the state of the producers that the hold reads. It has the last lookup and the last sends of each producer, and the last time of a line. */
export interface ProducerState {
  readonly owners: ReadonlyMap<string, { readonly t: number; readonly owner: string | null }>;
  readonly sends: ReadonlyMap<string, { readonly ok: number; readonly failed: number }>;
  readonly last: number;
}

/**
 * This function tells why the producers are not at rest, or gives the host of the owner of the
 * topic. At rest, each of `clients` producers had an answer in the last second and no failure in
 * the last 2 s. The last lookup of each one is in the last 2 s, and each names the same owner.
 */
export const ownerAtRest = (state: ProducerState, clients: number): { readonly owner: string } | string => {
  if (state.sends.size !== clients) return `${state.sends.size} producers send, not ${clients}`;
  for (const [pod, send] of state.sends) {
    if (state.last - send.ok > 1000) return `the producer ${pod} has no answer in the last second`;
    if (state.last - send.failed < 2000) return `the producer ${pod} failed in the last 2 s`;
  }
  const owners = new Set<string>();
  for (const pod of state.sends.keys()) {
    const seen = state.owners.get(pod);
    if (seen === undefined || seen.owner === null || state.last - seen.t > 2000) return `the producer ${pod} has no lookup with an owner in the last 2 s`;
    owners.add(seen.owner);
  }
  if (owners.size !== 1) return `the lookups name ${[...owners].join(" and ")}`;
  return { owner: [...owners][0]! };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This function waits until each broker is ready and the producers are at rest (`ownerAtRest`). It
 * gives the broker that owns the topic and the host that the lookups name, or why it could not in `within` ms.
 */
export const holdPulsar = async (
  cluster: Pick<Cluster, "kubectl">,
  state: () => ProducerState,
  clients: number,
  within = 300_000,
): Promise<{ readonly broker: Broker; readonly host: string } | string> => {
  const end = Date.now() + within;
  let why = "the hold did not start";
  do {
    const brokers = await brokersOf(cluster);
    const busy = brokers.find((broker) => !broker.ready);
    const rest = ownerAtRest(state(), clients);
    if (brokers.length !== 2) why = `${brokers.length} brokers, not 2`;
    else if (busy !== undefined) why = `the broker ${busy.pod} is not ready`;
    else if (typeof rest === "string") why = rest;
    else {
      const broker = brokerOfHost(brokers, rest.owner);
      if (broker !== undefined) return { broker, host: rest.owner };
      why = `the owner ${rest.owner} is no broker`;
    }
    await sleep(500);
  } while (Date.now() < end);
  return why;
};

/**
 * This function installs Pulsar in a cluster, with its image on each node. A failed install gives
 * the pods of Pulsar and the tail of their logs.
 */
export const installPulsar = async (cluster: Cluster, image: string): Promise<void> => {
  try {
    await helmInstall(cluster, "pulsar", PULSAR_CHART, PULSAR_NAMESPACE, pulsarValues(image), { createNamespace: true });
  } catch (error) {
    const state = async (args: readonly string[]): Promise<string> =>
      (await cluster.kubectl(["-n", PULSAR_NAMESPACE, ...args]).catch((why: unknown) => String(why))).slice(-4000);
    const pods = await state(["get", "pods", "-o", "wide"]);
    const logs = await state(["logs", "-l", "app=pulsar", "--tail=30", "--prefix", "--all-containers"]);
    throw new Error(`the install of Pulsar failed: ${String(error)}\nthe pods of Pulsar:\n${pods}\nthe logs:\n${logs}`);
  }
};

/** These words mark the lines of a broker that the record keeps: the sessions, the leader, the ownership and the topics. */
const KEPT = /[Ss]ession|[Ee]xpired|[Ll]eader|[Oo]wnership|[Bb]undle|Loaded|[Ll]oading topic|Created new producer|Disconnect|Closed connection|znode|ManagedLedger.*(open|recover)/;

/**
 * This function gives the record of Pulsar after a run. It has the brokers, and the kept lines of
 * each broker and of its last container, with the times of the kubelet.
 */
export const pulsarRecord = async (cluster: Pick<Cluster, "kubectl">): Promise<Record<string, unknown>> => {
  const brokers = await brokersOf(cluster);
  const logs: Record<string, string> = {};
  for (const broker of brokers) {
    for (const previous of [false, true]) {
      const text = await cluster
        .kubectl(["-n", PULSAR_NAMESPACE, "logs", broker.pod, "-c", "pulsar-broker", "--since=300s", "--tail=6000", "--timestamps", ...(previous ? ["--previous"] : [])])
        .catch((error: unknown) => String(error));
      logs[`${broker.pod}${previous ? ", the last container" : ""}`] = text
        .split("\n")
        .filter((line) => KEPT.test(line))
        .slice(-80)
        .join("\n")
        .slice(-8000);
    }
  }
  return { brokers, logs };
};
