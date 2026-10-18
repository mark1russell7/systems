// The probe of the F6 cells against a real Redis. It runs in a container on the network of Redis,
// in the VM of Docker, thus its clock is the CLOCK_MONOTONIC of the injector and the agent. It
// starts one service for each posture, each with its own Redis client, and prints each change of
// a verdict and each transition of a client as a JSON line. A file /tmp/shutdown asks each service
// to shut down, and the probe prints each exit.
import { existsSync } from "node:fs";
import { service } from "@mark1russell7/service";
import { redisClient } from "@mark1russell7/service/redis";

const config = JSON.parse(process.argv[2]);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const clock = {
  now,
  after(ms, run) {
    const timer = setTimeout(run, Math.max(0, ms));
    return () => clearTimeout(timer);
  },
};
const say = (line) => process.stdout.write(`${JSON.stringify({ ...line, t: now() })}\n`);

const lives = [];
for (const posture of config.postures) {
  const client = redisClient(
    `cache-${posture}`,
    { host: config.host, port: config.port, system: "systems.component.redis", knobs: config.knobs, heartbeatMisses: config.misses },
    { clock, record: (event) => say({ ev: "client", posture, from: event.from, to: event.to, on: event.on, detail: event.detail ?? null }) },
  );
  const svc = service(`f6-${posture}`)
    .readiness(posture === "readiness" ? config.timings.readiness : config.other)
    .liveness(posture === "liveness" ? config.timings.liveness : config.other)
    .startup(config.startup)
    .phase("stop the poller", config.phaseCap)
    .phase("tear down dependencies", config.phaseCap)
    .onRepeatSignal("ignore")
    .cooperativeWindow(config.cooperative);
  client.attach(svc, { poll: config.poll, steps: { "round-trip": posture === "reports" ? null : posture } });
  const exits = [];
  const life = await svc.run({ clock, process: { on: () => () => {}, exit: (code) => exits.push(code) } });
  let last = null;
  const look = () => {
    const verdict = life.health.verdict();
    const check = verdict.checks[`cache-${posture}.round-trip`];
    const line = { ready: verdict.ready, alive: verdict.alive, check: check?.last?.outcome ?? null };
    if (last !== null && last.ready === line.ready && last.alive === line.alive && last.check === line.check) return;
    last = line;
    say({ ev: "verdict", posture, ...line });
  };
  // a change of a policy comes at once; the result of a check that only reports has no latch to
  // publish it, thus the probe also samples the verdict each 20 ms
  life.health.subscribe(look);
  setInterval(look, 20);
  lives.push({ posture, life, client });
}

// all ready: the cells start
const ready = () => lives.every(({ life }) => life.health.verdict().ready);
while (!ready()) await new Promise((resolve) => setTimeout(resolve, 20));
say({ ev: "ready", joins: lives.map(({ posture, client }) => ({ posture, ...client.joins.at(-1) })) });

while (!existsSync("/tmp/shutdown")) await new Promise((resolve) => setTimeout(resolve, 20));
say({ ev: "shutdown" });
await Promise.all(
  lives.map(async ({ posture, life, client }) => {
    const code = await life.shutdown("F6");
    say({ ev: "exit", posture, code, errors: life.errors, status: client.status });
  }),
);
process.exit(0);
