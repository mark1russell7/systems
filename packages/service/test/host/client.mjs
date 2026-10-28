// The program "b" of the group in src/host-it.test.ts (SYS-47). At its start, it sends a request
// to the program "a" and writes the status and the variable `GREETING` on stdout. At the IPC message
// "shutdown", it writes a line and stops with the code 0.

const status = await fetch(process.env["A_URL"]).then(
  (response) => response.status,
  () => "none",
);
process.stdout.write(`b start ${process.pid} a=${status} greeting=${process.env["GREETING"] ?? "none"}\n`);
process.on("message", (message) => {
  if (message !== "shutdown") return;
  process.stdout.write("b shutdown\n", () => process.exit(0));
});
setInterval(() => {}, 60_000);
