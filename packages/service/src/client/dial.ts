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
