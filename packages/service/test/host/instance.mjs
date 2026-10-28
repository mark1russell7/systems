// A child of src/host-it.test.ts (SYS-47). It uses the real ports of Node, and it stays alive.
// - `lock <path>`: it takes the instance lock and writes the kind of the result on stdout.
// - `discovery <path>`: it writes its discovery record and writes "written" on stdout.
// It does not release the lock and does not remove the record. Thus its end leaves a stale file.

import { acquireInstanceLock, discoveryOf, nodeHostPorts, writeDiscovery } from "../../src/host.ts";

const [mode, path] = process.argv.slice(2);
const ports = nodeHostPorts();
if (mode === "lock") {
  const result = await acquireInstanceLock(path, ports);
  process.stdout.write(`${result.kind}\n`);
} else if (mode === "discovery") {
  await writeDiscovery(path, discoveryOf({ port: 4321, url: "http://127.0.0.1:4321/" }, ports), ports);
  process.stdout.write("written\n");
} else {
  process.stderr.write(`the mode ${mode} is not lock or discovery\n`);
  process.exit(2);
}
setInterval(() => {}, 60_000);
