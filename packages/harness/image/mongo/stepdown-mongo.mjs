// stepdown-mongo HOST:PORT STEP_DOWN_SECS CATCH_UP_SECS
//
// A planned step-down of a replica set: replSetStepDown to its primary, as a client sends it. The
// script connects to the member and pings it first. Then it stamps t0 on CLOCK_MONOTONIC and sends
// the command. It stamps t1 on the next turn of the event loop after the driver starts the command,
// when the driver wrote it. Its last line is the stamps, as the injector prints them.

import { MongoClient } from "mongodb";

const now = () => Number(process.hrtime.bigint());
const [address, stepDownSecs = "60", catchUpSecs = "10"] = process.argv.slice(2);
const client = new MongoClient(`mongodb://${address}/?directConnection=true`, { serverSelectionTimeoutMS: 10000, monitorCommands: true });
let written = null;
const sent = new Promise((resolve) => {
  client.on("commandStarted", (event) => {
    if (event.commandName === "replSetStepDown") setImmediate(() => resolve(now()));
  });
});
try {
  await client.connect();
  const admin = client.db("admin");
  await admin.command({ ping: 1 });
  const t0 = now();
  const reply = admin.command({ replSetStepDown: Number(stepDownSecs), secondaryCatchUpPeriodSecs: Number(catchUpSecs) });
  written = await sent;
  let ok = false;
  let error = null;
  try {
    ok = (await reply).ok === 1;
  } catch (failure) {
    // a primary that steps down closes its connections: the reply can be a network error
    error = failure.message;
  }
  process.stdout.write(`${JSON.stringify({ action: "step-down", t0, t1: written, replied: now(), ok, error })}\n`);
} finally {
  await client.close().catch(() => undefined);
}
