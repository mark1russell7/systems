// The program "a" of the group in src/host-it.test.ts (SYS-47). After approximately 1 s, it answers
// each HTTP request on the port of `PORT` with 200. Thus its ready probe fails first. It writes one
// line on stdout and one on stderr at its start. At SIGTERM, it writes a line and stops.

import { createServer } from "node:http";

const port = Number(process.env["PORT"]);
process.stdout.write(`a start ${process.pid}\n`);
process.stderr.write(`a note ${process.pid}\n`);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("a");
});
setTimeout(() => server.listen(port, "127.0.0.1"), 1000);
process.on("SIGTERM", () => {
  process.stdout.write("a sigterm\n", () => {
    server.close();
    process.exit(0);
  });
});
