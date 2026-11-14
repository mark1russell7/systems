import { describe, expect, it } from "vitest";
import { answerText } from "./node.ts";

const encoder = new TextEncoder();

/** This function gives a body in parts, as a network gives it. */
const parts = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe("the text of an answer, for the net port of Node", () => {
  it("gives the status and the whole text of a body in parts", async () => {
    const answer = new Response(parts(encoder.encode('{"now":'), encoder.encode("1}")), { status: 503 });
    expect(await answerText(answer, 1000)).toEqual({ status: 503, body: '{"now":1}', complete: true });
  });

  it("gives a body of exactly the limit as complete", async () => {
    expect(await answerText(new Response(parts(encoder.encode("abcd"))), 4)).toEqual({ status: 200, body: "abcd", complete: true });
  });

  it("stops in the part that passes the limit, and cancels the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("abcd"));
        controller.enqueue(encoder.encode("efgh"));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await answerText(new Response(body), 6)).toEqual({ status: 200, body: "abcdef", complete: false });
    expect(cancelled).toBe(true);
  });

  it("joins the bytes of a character that two parts split", async () => {
    const bytes = encoder.encode("é");
    expect(bytes.byteLength).toBe(2);
    const answer = new Response(parts(bytes.subarray(0, 1), bytes.subarray(1)));
    expect(await answerText(answer, 10)).toEqual({ status: 200, body: "é", complete: true });
  });

  it("gives an empty text for an answer with no body", async () => {
    expect(await answerText(new Response(null, { status: 204 }), 10)).toEqual({ status: 204, body: "", complete: true });
  });
});
