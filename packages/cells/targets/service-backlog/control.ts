// The worker of the target: the control port, PORT + 1, and the read of the queue each 5 ms. The
// main thread holds the listener and blocks. Thus this worker gives it `open` and `accept`, and it
// reads the queue from the kernel with no help of the main thread (proc.ts).
//
// The limit changes only at `open`, thus the worker reads it once for each `open`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import type { Socket } from "node:net";
import readline from "node:readline";
import { parentPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { emit } from "./emit.ts";
import { countersIn, countIn, limitIn } from "./proc.ts";
import type { Counters } from "./proc.ts";

/** These are the data that the main thread gives the worker. */
interface Data {
  readonly port: number;
  readonly flag: Int32Array;
  readonly channel: MessagePort;
}

/** This is a reply of the main thread, or of the worker, to one command. */
type Reply = Readonly<Record<string, unknown>> & { readonly error?: string };

/** These are the fields of a reply of `open` and `stats`, and of each `queue` line. */
type Fields = Counters & { readonly count: number; readonly max: number };

const { port, flag, channel } = workerData as Data;

/** The limit of the open listener, or undefined before the first `open`. */
let limit: number | undefined;

const fields = (): Fields => {
  const count = limit === undefined ? undefined : countIn(readFileSync("/proc/net/tcp", "utf8"), port);
  return { count: count ?? 0, max: count === undefined ? 0 : (limit ?? 0), ...countersIn(readFileSync("/proc/net/netstat", "utf8")) };
};

/** This function gives one command to the main thread, and waits for its reply. */
const ask = (message: { readonly command: string; readonly number: number }): Promise<Reply> =>
  new Promise((resolve) => {
    channel.once("message", (reply: Reply) => resolve(reply));
    channel.postMessage(message);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  });

const reply = async (line: string): Promise<Reply> => {
  const [command, word] = line.trim().split(/\s+/);
  const number = Number.parseInt(word ?? "", 10);
  if (command === "open" && Number.isInteger(number)) {
    limit = undefined;
    const done = await ask({ command: "open", number });
    if (done.error !== undefined) return { error: done.error, backlog: number };
    limit = limitIn(execFileSync("ss", ["-Hltn", `sport = :${port}`], { encoding: "utf8" }));
    return fields();
  }
  if (command === "accept" && Number.isInteger(number)) return ask({ command: "accept", number });
  if (command === "stats") return fields();
  return { refused: line };
};

const serve = async (socket: Socket): Promise<void> => {
  socket.setNoDelay(true);
  for await (const line of readline.createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY })) {
    const answer = await reply(line);
    if (answer.error !== undefined) emit("control-error", answer);
    socket.write(`${JSON.stringify(answer)}\n`);
  }
};

/** This function writes a `queue` line for each change of the queue or of its counters. */
const sample = (): void => {
  let last: string | undefined;
  setInterval(() => {
    if (limit === undefined) return;
    const now = fields();
    const text = JSON.stringify(now);
    if (text !== last) emit("queue", now);
    last = text;
  }, 5);
};

const control = net.createServer((socket) => {
  serve(socket).catch((error: unknown) => emit("control-error", { error: error instanceof Error ? error.message : String(error) }));
});
control.listen({ port: port + 1, host: "0.0.0.0" }, () => {
  sample();
  parentPort?.postMessage("ready");
});
