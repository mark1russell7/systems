// A child of src/host-it.test.ts (SYS-47). It writes the line "ready" on stdout and stays alive
// until a signal or a stop of its process tree.

process.stdout.write("ready\n");
setInterval(() => {}, 60_000);
