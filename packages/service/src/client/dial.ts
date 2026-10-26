// The dial of a client: a new TCP connection that sends the first bytes of its protocol and reads
// the answer. Each driver gives its bytes and its rule for the answer. The core keeps node:net out
// of `core.ts`, thus only an entry that gives a dial loads it.

import { connect as dialTcp } from "node:net";
import type { DialFn } from "./core.ts";

/**
 * A judge reads the bytes that the server sent so far. It gives null for a good answer, an error for
 * a bad answer, or "more" when it must wait for more bytes.
 */
export type Judge = (received: Buffer) => Error | null | "more";

/**
 * This function makes a dial function. The dial opens a TCP connection, sends `hello`, and reads the
 * answer until `judge` decides. An abort, an error of the socket, and a close before the decision fail the dial.
 * The dial destroys its socket at its end.
 */
export const helloDial =
  (hello: string | Uint8Array, judge: Judge): DialFn =>
  (host, port, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("the dial was aborted"));
        return;
      }
      const socket = dialTcp({ host, port });
      let received = Buffer.alloc(0);
      const end = (error?: Error): void => {
        signal.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => end(new Error("the dial was aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => socket.write(hello));
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const verdict = judge(received);
        if (verdict === "more") return;
        end(verdict ?? undefined);
      });
      socket.once("error", (error) => end(error));
      socket.once("close", () => end(new Error("the server closed the dial")));
    });

/** This function gives the authority of a host and a port for a Host header. An IPv6 address goes in brackets. */
export const authority = (host: string, port: number): string => `${host.includes(":") ? `[${host}]` : host}:${port}`;

/**
 * This function makes a judge of the status line of an HTTP/1.1 answer. The judge waits for the end
 * of the line, in the first 8 KiB. Then `accept` reads the status code, and gives null for a good status or an error.
 * The HTTP client accepts each status. The WebSocket client accepts only 101.
 */
export const statusLineJudge =
  (accept: (status: number, line: string) => Error | null): Judge =>
  (received) => {
    const end = received.indexOf("\r\n");
    if (end < 0) return received.length > 8192 ? new Error("the answer has no status line in its first 8 KiB") : "more";
    const line = received.toString("latin1", 0, end);
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(line);
    return status === null ? new Error(`the answer ${JSON.stringify(line)} is not an HTTP/1.1 status line`) : accept(Number(status[1]), line);
  };
