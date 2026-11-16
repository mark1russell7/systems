// The handler of one folder of files: for example a built page next to the routes of a service, on one origin.
// The rule of a path refuses each path out of the folder. Examples are an encoded `..`, a NUL, a backslash and
// a link that points out. A path that is not a file of the folder goes to the next handler. Thus the transport
// gives its 404 at the end.

import { readFile as readFileOfNode, realpath as realpathOfNode, stat as statOfNode } from "node:fs/promises";
import type { ServerResponse } from "node:http";
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

/** The facts of a file that the handler reads before its body: its kind and its length in bytes. */
export interface FolderFileStat {
  /** This function tells if the path is a file, and not a folder or another kind. */
  isFile(): boolean;
  /** The length of the file in bytes. */
  readonly size: number;
}

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
  /** This function gives the kind and the length of a file. The default is `stat` of `node:fs/promises`. */
  readonly stat?: ((file: string) => Promise<FolderFileStat>) | undefined;
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

/** This function writes the headers of the answer of a file. HEAD and GET get the same headers. */
const writeHeaders = (res: ServerResponse, length: number, type: string, policy: string): void => {
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(length),
    "content-security-policy": policy,
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
};

/**
 * This function gives a request handler that serves the files of one folder. A path that is not for a
 * file of the folder goes to the next handler. A link in the folder that points out of the folder also
 * goes to the next handler.
 *
 * The handler answers GET and HEAD. Another method on a path of a file gets 405 with `allow: GET, HEAD`.
 * Only GET reads the body of the file. HEAD and the 405 use the stat of the file.
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
  const stat = options.stat ?? statOfNode;
  const base = normalize(root);
  return async (req, res) => {
    const path = pathOf(req.url);
    if (prefix !== "" && path !== prefix && !path.startsWith(`${prefix}/`)) return false;
    const file = fileOf(base, path === prefix ? "/" : path.slice(prefix.length), index);
    if (file === undefined) return false;
    let real: string;
    let size: number;
    try {
      // The real paths refuse a link in the folder that points out of the folder. The handler gives the
      // real path of the folder again at each request, because a deploy can replace the folder through a link.
      const [found, realBase] = await Promise.all([realpath(file), realpath(base)]);
      if (!isInside(realBase, found)) return false;
      // The stat gives the kind and the length of the file without its body.
      const facts = await stat(found);
      if (!facts.isFile()) return false;
      real = found;
      size = facts.size;
    } catch {
      // A missing file, or a path that the process cannot read
      return false;
    }
    const method = req.method ?? "GET";
    if (!METHODS.has(method)) {
      res.writeHead(405, { allow: "GET, HEAD", "content-length": "0", "x-content-type-options": "nosniff" });
      res.end();
      return true;
    }
    if (method === "HEAD") {
      writeHeaders(res, size, contentType(real), policy);
      res.end();
      return true;
    }
    let body: Uint8Array;
    try {
      body = await read(real);
    } catch {
      // A file that the process cannot read, or a file that went away after the stat
      return false;
    }
    writeHeaders(res, body.byteLength, contentType(real), policy);
    res.end(body);
    return true;
  };
};
