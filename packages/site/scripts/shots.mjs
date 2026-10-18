// Takes a screenshot of each page of the built site at a phone width and a desktop width, in light and
// in dark. It also writes what a picture does not show well: a page that is wider than its screen, the
// elements that make it wider, and each error of a page. The report goes to report.md, and to the
// summary of the job in CI.
//
// usage: PW_DIR=<a directory with playwright in its node_modules> node shots.mjs <dist> <out>
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [dist, out] = process.argv.slice(2);
if (!dist || !out || !process.env.PW_DIR) throw new Error("usage: PW_DIR=<dir> node shots.mjs <dist> <out>");
// Playwright is not a dependency of the site: the job installs it in a directory of its own
const { chromium } = createRequire(path.join(process.env.PW_DIR, "index.js"))("playwright");

const BASE = "/systems/";
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".txt": "text/plain", ".xml": "application/xml" };
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
const SCHEMES = ["light", "dark"];
// a full page longer than this is cut: the top of a page is what a reader sees first
const MAX_HEIGHT = 7000;

// the pages of the site: each index.html under dist, as the path that GitHub Pages serves
const pagesOf = async (dir, prefix = "") => {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_") || entry.name === "pagefind") continue;
      found.push(...(await pagesOf(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.name === "index.html") found.push(prefix);
  }
  return found.sort();
};

// a static server of dist at the base of the site
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(BASE)) return res.writeHead(404).end();
  let file = path.join(dist, decodeURIComponent(url.pathname.slice(BASE.length)));
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    await stat(file);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const pages = await pagesOf(dist);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const rows = [];
for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme, deviceScaleFactor: 1 });
    for (const page of pages) {
      const tab = await context.newPage();
      const errors = [];
      tab.on("pageerror", (error) => errors.push(error.message));
      tab.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await tab.goto(`${origin}${BASE}${page}`, { waitUntil: "networkidle" });
      // the islands of React hydrate after the load
      await tab.waitForTimeout(400);
      const measured = await tab.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const clipped = (el) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if (o !== "visible") return true;
          }
          return false;
        };
        const wide = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > width + 1 && !clipped(el)) {
            const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
            wide.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls} to ${Math.round(r.right)} px`);
            if (wide.length >= 4) break;
          }
        }
        return { width, scroll: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, wide };
      });
      const name = `${(page.replace(/\/$/, "") || "home").replaceAll("/", "-")}-${viewport.name}-${scheme}.jpg`;
      await tab.screenshot({ path: path.join(out, name), type: "jpeg", quality: 72, fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height: Math.min(measured.height, MAX_HEIGHT) } });
      rows.push({ page, viewport: viewport.name, scheme, ...measured, errors: [...new Set(errors)] });
      await tab.close();
    }
    await context.close();
  }
}
await browser.close();
server.close();

const lines = ["# The site at a phone width and a desktop width", "", `${pages.length} pages, ${rows.length} shots.`, ""];
const wider = rows.filter((row) => row.scroll > row.width + 1);
const failing = rows.filter((row) => row.errors.length);
lines.push(wider.length ? `## Pages wider than their screen (${wider.length})` : "## No page is wider than its screen", "");
for (const row of wider) lines.push(`- \`${row.page || "/"}\` ${row.viewport} ${row.scheme}: ${row.scroll} px for a screen of ${row.width} px. ${row.wide.join("; ")}`);
lines.push("", failing.length ? `## Pages with an error (${failing.length})` : "## No page has an error", "");
for (const row of failing) lines.push(`- \`${row.page || "/"}\` ${row.viewport} ${row.scheme}: ${row.errors.slice(0, 3).join(" | ")}`);
lines.push("", "## The height of each page", "", "| Page | Phone | Desktop |", "| --- | --- | --- |");
for (const page of pages) {
  const at = (viewport) => rows.find((row) => row.page === page && row.viewport === viewport && row.scheme === "light")?.height ?? "";
  lines.push(`| \`${page || "/"}\` | ${at("phone")} px | ${at("desktop")} px |`);
}
const report = `${lines.join("\n")}\n`;
await writeFile(path.join(out, "report.md"), report);
await writeFile(path.join(out, "report.json"), `${JSON.stringify(rows, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
