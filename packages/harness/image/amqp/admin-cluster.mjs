// admin-cluster HOST:PORT declare|holds QUEUE
//
// The admin of the lab of a cluster cell of RabbitMQ: amqplib 2.2.0, as the user guest. It prints one
// JSON line with its result.
// - declare: declares the quorum queue on the node HOST, durable. Its leader locator is client-local,
//   thus the member on HOST is the first leader. It prints { ok: true }.
// - holds: takes each message of the queue, and prints { held: [n, ...] }: the sequence numbers that
//   the queue holds, in their order. The queue is empty after it.

const [at, command, queue] = process.argv.slice(2);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (at === undefined || queue === undefined || !["declare", "holds"].includes(command)) {
  print({ ok: false, why: "admin-cluster HOST:PORT declare|holds QUEUE" });
  process.exit(1);
}

const { default: amqp } = await import("amqplib");
const connection = await amqp.connect(`amqp://guest:guest@${at}/`);
const channel = await connection.createChannel();
try {
  if (command === "declare") {
    await channel.assertQueue(queue, { durable: true, arguments: { "x-queue-type": "quorum", "x-queue-leader-locator": "client-local" } });
    print({ ok: true });
  } else {
    const held = [];
    for (;;) {
      const message = await channel.get(queue, { noAck: true });
      if (message === false) break;
      held.push(Number(message.content.toString()));
    }
    print({ held });
  }
} catch (error) {
  print({ ok: false, why: error.message });
  process.exitCode = 1;
} finally {
  await connection.close().catch(() => undefined);
}
