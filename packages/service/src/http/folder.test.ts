import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentTypeOf, FOLDER_CONTENT_SECURITY_POLICY, folderHandler, UNKNOWN_CONTENT_TYPE, WEB_CONTENT_TYPES } from "../http-folder.ts";
import type { RequestHandler } from "../http.ts";
import { FakeResponse, FakeSocket } from "./fake-server.ts";

/** The handler of one folder: a built page next to the routes of a service. */

const fakeReq = (url: string, method = "GET") => ({ url, method }) as IncomingMessage;

interface Answer {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** This function asks a handler for a path. It gives the answer, or null when the path goes to the next handler. */
const asker =
  (handler: RequestHandler) =>
  async (url: string, method = "GET"): Promise<Answer | null> => {
    const res = new FakeResponse(new FakeSocket());
    if (!(await handler(fakeReq(url, method), res as unknown as ServerResponse, undefined as never))) return null;
    return { status: res.statusCode, headers: res.headers, body: res.chunks.join("") };
  };

describe("folderHandler: the files of one folder", () => {
  let top: string;
  let root: string;
  beforeEach(() => {
    top = mkdtempSync(join(tmpdir(), "folder-handler-"));
    root = join(top, "page");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>page</title>");
    writeFileSync(join(root, "assets", "app.js"), "export const a = 1;");
    writeFileSync(join(root, "assets", "STYLE.CSS"), "body { margin: 0 }");
    writeFileSync(join(root, "data.bin"), "bytes");
    mkdirSync(join(top, "outside"));
    writeFileSync(join(top, "outside", "secret.txt"), "secret");
  });
  afterEach(() => {
    rmSync(top, { recursive: true, force: true });
  });

  it("serves the index for / and each file with its type, its length and the headers of the policy", async () => {
    const ask = asker(folderHandler(root));
    const index = await ask("/");
    expect(index?.status).toBe(200);
    expect(index?.body).toBe("<!doctype html><title>page</title>");
    expect(index?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index?.headers.get("content-length")).toBe(String(Buffer.byteLength("<!doctype html><title>page</title>")));
    expect(index?.headers.get("content-security-policy")).toBe(FOLDER_CONTENT_SECURITY_POLICY);
    expect(index?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(index?.headers.get("cache-control")).toBe("no-cache");
    const script = await ask("/assets/app.js?v=2");
    expect(script?.body).toBe("export const a = 1;");
    expect(script?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await ask("/assets/STYLE.CSS"))?.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await ask("/data.bin"))?.headers.get("content-type")).toBe(UNKNOWN_CONTENT_TYPE);
    expect((await ask("/index.html"))?.status).toBe(200);
  });

  it("gives the headers of GET and no body to HEAD, and 405 with allow to another method on a file", async () => {
    const ask = asker(folderHandler(root));
    const get = await ask("/assets/app.js");
    const head = await ask("/assets/app.js", "HEAD");
    expect(head?.status).toBe(200);
    expect(head?.body).toBe("");
    expect([...(head?.headers ?? [])]).toEqual([...(get?.headers ?? [])]);
    const post = await ask("/assets/app.js", "POST");
    expect(post?.status).toBe(405);
    expect(post?.headers.get("allow")).toBe("GET, HEAD");
    // A method on a path that is not a file goes to the next handler, for example a route of the service.
    expect(await ask("/orders", "POST")).toBeNull();
  });

  it("reads the body only for GET: HEAD and the 405 take the length and the kind from the stat", async () => {
    const reads: string[] = [];
    const ask = asker(
      folderHandler(root, {
        readFile: async (file) => {
          reads.push(file);
          return new TextEncoder().encode("export const a = 1;");
        },
      }),
    );
    const head = await ask("/assets/app.js", "HEAD");
    expect(head?.status).toBe(200);
    expect(head?.headers.get("content-length")).toBe(String(Buffer.byteLength("export const a = 1;")));
    expect((await ask("/assets/app.js", "POST"))?.status).toBe(405);
    expect(reads).toEqual([]);
    expect((await ask("/assets/app.js"))?.body).toBe("export const a = 1;");
    expect(reads).toHaveLength(1);
  });

  it("gives a path that the stat does not find as a file, and a file that the reader cannot read, to the next handler", async () => {
    const notFile = asker(folderHandler(root, { stat: async () => ({ isFile: () => false, size: 0 }) }));
    expect(await notFile("/index.html")).toBeNull();
    const unreadable = asker(
      folderHandler(root, {
        readFile: async () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(await unreadable("/index.html")).toBeNull();
  });

  it("gives each path out of the folder, a missing file and a folder to the next handler", async () => {
    const ask = asker(folderHandler(root));
    for (const path of [
      "/../outside/secret.txt",
      "/%2e%2e/outside/secret.txt",
      "/assets/..%2f..%2foutside%2fsecret.txt",
      "/%5c..%5coutside%5csecret.txt",
      "/index.html%00.txt",
      "/%E0%A4%A",
      "/missing.js",
      "/assets",
      "/assets/",
    ]) {
      expect(await ask(path), path).toBeNull();
    }
  });

  it("gives a link in the folder that points out of the folder to the next handler, and serves a link inside", async () => {
    // A junction needs no privilege on Windows. On the other systems, the type is ignored.
    symlinkSync(join(top, "outside"), join(root, "out"), "junction");
    symlinkSync(join(root, "assets"), join(root, "same"), "junction");
    const ask = asker(folderHandler(root));
    expect(await ask("/out/secret.txt")).toBeNull();
    expect((await ask("/same/app.js"))?.body).toBe("export const a = 1;");
  });

  it("serves the folder under a prefix, and gives each other path to the next handler", async () => {
    const ask = asker(folderHandler(root, { prefix: "/page" }));
    expect((await ask("/page"))?.body).toBe("<!doctype html><title>page</title>");
    expect((await ask("/page/"))?.body).toBe("<!doctype html><title>page</title>");
    expect((await ask("/page/assets/app.js"))?.status).toBe(200);
    expect(await ask("/assets/app.js")).toBeNull();
    expect(await ask("/pages/assets/app.js")).toBeNull();
  });

  it("takes the index, the content types, the policy and the reader from the options", async () => {
    writeFileSync(join(root, "assets", "start.html"), "start");
    const reads: string[] = [];
    const ask = asker(
      folderHandler(root, {
        index: "start.html",
        contentType: () => "text/x-test",
        contentSecurityPolicy: "default-src 'self'",
        readFile: async (file) => {
          reads.push(file);
          return new TextEncoder().encode("from the reader");
        },
      }),
    );
    const answer = await ask("/assets/");
    expect(answer?.body).toBe("from the reader");
    expect(answer?.headers.get("content-type")).toBe("text/x-test");
    expect(answer?.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(reads).toHaveLength(1);
  });

  it("refuses a prefix and an index with a wrong form", () => {
    expect(() => folderHandler(root, { prefix: "page" })).toThrow(/prefix/);
    expect(() => folderHandler(root, { prefix: "/page/" })).toThrow(/prefix/);
    expect(() => folderHandler(root, { index: "a/b.html" })).toThrow(/index/);
    expect(() => folderHandler(root, { index: "" })).toThrow(/index/);
  });
});

describe("contentTypeOf: the type of a file from its extension", () => {
  it("reads the extension in lower case, and gives the unknown type for an extension that the table does not have", () => {
    expect(contentTypeOf("a/b/page.HTML")).toBe(WEB_CONTENT_TYPES[".html"]);
    expect(contentTypeOf("module.mjs")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeOf("README")).toBe(UNKNOWN_CONTENT_TYPE);
    expect(contentTypeOf("a.constructor")).toBe(UNKNOWN_CONTENT_TYPE);
    expect(contentTypeOf("a.x", { ".x": "text/x" })).toBe("text/x");
  });
});
