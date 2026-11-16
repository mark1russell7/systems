// The handler of one folder of files: for example a built page next to the routes of a service, on one origin.
// The rule of a path refuses each path out of the folder. Examples are an encoded `..`, a NUL, a backslash and
// a link that points out. A path that is not a file of the folder goes to the next handler. Thus the transport
// gives its 404 at the end.

import { readFile as readFileOfNode, realpath as realpathOfNode } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { isInside } from "@mark1russell7/files";
import { pathOf, type RequestHandler } from "./transport.ts";

/**
 * The content types of the files of a web page, by the extension of the file in lower case. A module
 * script must have a JavaScript type, else the browser refuses it.
 */
export const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** The content type of a file with an extension that the table does not have. */
export const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

/**
 * This function gives the content type of a file from the extension of its name. An extension that the
 * table does not have gives `UNKNOWN_CONTENT_TYPE`.
 *
 * @param file - The name or the path of the file.
 * @param types - The table of the content types. The default is `WEB_CONTENT_TYPES`.
 */
export const contentTypeOf = (file: string, types: Readonly<Record<string, string>> = WEB_CONTENT_TYPES): string =>
  types[extname(file).toLowerCase()] ?? UNKNOWN_CONTENT_TYPE;

/**
 * The default content security policy of each file of the folder. The page loads only its own scripts,
 * styles, images and fonts, and it connects only to its own origin. It has no inline script.
 */
export const FOLDER_CONTENT_SECURITY_POLICY: string = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** These options change the handler of a folder. */
export interface FolderHandlerOptions {
  /** This path goes before each path of the folder, for example `/page`. It starts with `/`, or it is empty. The default is empty. */
  readonly prefix?: string | undefined;
  /** This file answers a path that ends with `/`. The default is `index.html`. */
  readonly index?: string | undefined;
  /** This function gives the content type of a file. The default is `contentTypeOf` with `WEB_CONTENT_TYPES`. */
  readonly contentType?: ((file: string) => string) | undefined;
  /** This value is the content security policy of each file. The default is `FOLDER_CONTENT_SECURITY_POLICY`. */
  readonly contentSecurityPolicy?: string | undefined;
  /** This function reads a file. The default is `readFile` of `node:fs/promises`. A test can give a fake. */
  readonly readFile?: ((file: string) => Promise<Uint8Array>) | undefined;
  /** This function gives the real path of a file, after each link. The default is `realpath` of `node:fs/promises`. */
  readonly realpath?: ((file: string) => Promise<string>) | undefined;
}

/** The methods that the handler answers. */
const METHODS = new Set(["GET", "HEAD"]);

/**
 * This function gives the file in the folder of the path of a request. A path that is not for a file in
 * the folder gives `undefined`. A path that does not decode, or that has a NUL or a backslash, also gives
 * `undefined`. Thus the rule is the same on Windows and on Linux.
 */
const fileOf = (base: string, path: string, index: string): string | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const file = normalize(join(base, decoded.endsWith("/") ? decoded + index : decoded));
  return isInside(base, file) ? file : undefined;
};

/** This function writes the answer of a file. HEAD gets the same headers as GET, and no body. */
const writeFile = (req: IncomingMessage, res: ServerResponse, body: Uint8Array, type: string, policy: string): void => {
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(body.byteLength),
    "content-security-policy": policy,
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
};

/**
 * This function gives a request handler that serves the files of one folder. A path that is not for a
 * file of the folder goes to the next handler. A link in the folder that points out of the folder also
 * goes to the next handler.
 *
 * The handler answers GET and HEAD. Another method on a path of a file gets 405 with `allow: GET, HEAD`.
 * Each file gets its content type, its length, the content security policy, `nosniff` and `no-cache`.
 *
 * @param root - The folder of the files.
 * @param options - The prefix of the paths, the index file, the content types, the policy and the file functions.
 */
export const folderHandler = (root: string, options: FolderHandlerOptions = {}): RequestHandler => {
  const prefix = options.prefix ?? "";
  if (!(prefix === "" || (prefix.startsWith("/") && !prefix.endsWith("/")))) throw new Error(`the folder prefix "${prefix}" does not start with "/", or it ends with "/"`);
  const index = options.index ?? "index.html";
  if (index === "" || index.includes("/") || index.includes("\\")) throw new Error(`the index file "${index}" is not the name of one file`);
  const contentType = options.contentType ?? ((file: string) => contentTypeOf(file));
  const policy = options.contentSecurityPolicy ?? FOLDER_CONTENT_SECURITY_POLICY;
  const read = options.readFile ?? readFileOfNode;
  const realpath = options.realpath ?? realpathOfNode;
  const base = normalize(root);
  return async (req, res) => {
    const path = pathOf(req.url);
    if (prefix !== "" && path !== prefix && !path.startsWith(`${prefix}/`)) return false;
    const file = fileOf(base, path === prefix ? "/" : path.slice(prefix.length), index);
    if (file === undefined) return false;
    let real: string;
    let body: Uint8Array;
    try {
      // The real paths refuse a link in the folder that points out of the folder.
      const [found, realBase] = await Promise.all([realpath(file), realpath(base)]);
      if (!isInside(realBase, found)) return false;
      real = found;
      body = await read(real);
    } catch {
      // A missing file, a folder at the path, or a file that the process cannot read
      return false;
    }
    if (!METHODS.has(req.method ?? "GET")) {
      res.writeHead(405, { allow: "GET, HEAD", "content-length": "0", "x-content-type-options": "nosniff" });
      res.end();
      return true;
    }
    writeFile(req, res, body, contentType(real), policy);
    return true;
  };
};
