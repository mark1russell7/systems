// observer H:P,H:P,...
//
// The observer of a group's Sentinels. It subscribes to every channel of each Sentinel
// (PSUBSCRIBE *): each Sentinel publishes each event of its own on a channel named for the event,
// +sdown, +odown, +try-failover, +elected-leader, +selected-slave, +promoted-slave, +switch-master
// and the others. Each message is a JSON line stamped on CLOCK_MONOTONIC when it arrives, the one
// clock of the harness. The faults of a cell never cut the observer: it is in a namespace of its
// own, and no rule names its address. A subscribed line gives the address of each connection, so
// the prober's records of a Sentinel's writes to it can calibrate the stamps.

import Redis from "ioredis";

const now = () => process.hrtime.bigint();
const emit = (ev, fields = {}, at = now()) =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(at), ...fields })}\n`);

const sentinels = (process.argv[2] ?? "").split(",").filter((each) => each !== "");
if (sentinels.length === 0) {
  emit("fail", { why: "observer H:P,H:P,..." });
  process.exit(1);
}

for (const address of sentinels) {
  const [host, port] = address.split(":");
  // RESP2: a Sentinel's events are plain pmessage frames, and a lost connection comes back
  const sub = new Redis({ host, port: Number(port), protocol: 2, enableReadyCheck: false, retryStrategy: () => 100 });
  sub.on("ready", () => {
    const { localAddress, localPort } = sub.stream;
    emit("subscribed", { sentinel: address, local: `${localAddress}:${localPort}` });
  });
  sub.on("error", (error) => emit("observer-error", { sentinel: address, message: error.message }));
  sub.on("pmessage", (_pattern, channel, message) => {
    const at = now();
    emit("sentinel", { sentinel: address, event: channel, detail: message }, at);
  });
  sub.psubscribe("*").catch((error) => emit("observer-error", { sentinel: address, message: error.message }));
}

process.on("SIGTERM", () => process.exit(0));
