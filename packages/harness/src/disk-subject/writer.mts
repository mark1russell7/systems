/**
 * The writer of the self-test of the disk tier (`disk.test.ts`). It operates in the mount of LazyFS, in a container. In
 * each step, it writes one line to `synced.log` with an fsync, and one line to `unsynced.log` with no fsync. Then it
 * gets to a stop point.
 *
 * The container has no packages, thus this file speaks the stop protocol of `@mark1russell7/rigor-testkit/stop` itself.
 * The protocol is data: the order in the variable `RIGOR_STOP`, and one JSON line for each stop point in the progress
 * file of the order. Thus a subject in each language can speak it. `DISK_STEPS` and `DISK_PAUSE_MS` set the steps.
 */
import { fsyncSync, openSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

interface Order {
  readonly progress: string;
  readonly step?: number;
  readonly signal?: string;
}

const text = process.env["RIGOR_STOP"];
const order: Order | undefined = text === undefined ? undefined : (JSON.parse(text) as Order);
const progress = order === undefined ? undefined : openSync(order.progress, "a");
let next = 0;

/** This function writes the line of the next stop point, and stops this process at the step of the order. */
const stopPoint = (label: string): void => {
  if (order === undefined || progress === undefined) return;
  const step = next;
  next += 1;
  const stops = step === order.step;
  writeSync(progress, `${JSON.stringify({ step, label, ...(stops ? { stop: true } : {}) })}\n`);
  if (stops) process.kill(process.pid, order.signal ?? "SIGKILL");
};

const steps = Number(process.env["DISK_STEPS"] ?? "8");
const pauseMs = Number(process.env["DISK_PAUSE_MS"] ?? "0");
const synced = openSync("synced.log", "w");
const unsynced = openSync("unsynced.log", "w");
for (let index = 0; index < steps; index += 1) {
  writeSync(synced, `line ${index}\n`);
  fsyncSync(synced);
  writeSync(unsynced, `line ${index}\n`);
  stopPoint(`write ${index}`);
  if (pauseMs > 0) await sleep(pauseMs);
}
