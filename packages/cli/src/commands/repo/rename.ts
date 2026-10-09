import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { packagesDir, repoRoot } from "../../paths.ts";

const SCOPE_RE = /^[a-z0-9][a-z0-9-]*$/;
const TEMPLATE_SCOPE = "template";
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

interface ParsedArgs {
  scope: string | undefined;
  dryRun: boolean;
  reinitGit: boolean;
  force: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let scope: string | undefined;
  let dryRun = false;
  let reinitGit = false;
  let force = false;
  for (const a of args) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--reinit-git") reinitGit = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else if (!scope) scope = a;
    else throw new Error(`Unexpected positional argument: ${a}`);
  }
  return { scope, dryRun, reinitGit, force };
}

interface FileChange {
  path: string;
  before: string;
  after: string;
}

function rewritePackageJson(raw: string, fromScope: string, toScope: string): string {
  return raw
    .split(`"${fromScope}-monorepo"`).join(`"${toScope}-monorepo"`)
    .split(`@${fromScope}/`).join(`@${toScope}/`);
}

function rewriteSourceFile(raw: string, fromScope: string, toScope: string): string {
  return raw.split(`@${fromScope}/`).join(`@${toScope}/`);
}

async function collectPackageJsonChanges(fromScope: string, toScope: string): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  const rootPath = resolve(repoRoot, "package.json");
  const rootRaw = await readFile(rootPath, "utf8");
  const rootUpdated = rewritePackageJson(rootRaw, fromScope, toScope);
  if (rootUpdated !== rootRaw) changes.push({ path: rootPath, before: rootRaw, after: rootUpdated });

  if (!existsSync(packagesDir)) return changes;
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = resolve(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const raw = await readFile(pkgPath, "utf8");
    const updated = rewritePackageJson(raw, fromScope, toScope);
    if (updated !== raw) changes.push({ path: pkgPath, before: raw, after: updated });
  }
  return changes;
}

async function collectSourceFileChanges(fromScope: string, toScope: string): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  if (!existsSync(packagesDir)) return changes;
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const srcDir = resolve(packagesDir, entry.name, "src");
    if (!existsSync(srcDir)) continue;
    await walkSourceDir(srcDir, fromScope, toScope, changes);
  }
  return changes;
}

async function walkSourceDir(dir: string, fromScope: string, toScope: string, out: FileChange[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSourceDir(path, fromScope, toScope, out);
      continue;
    }
    if (!SOURCE_EXT_RE.test(entry.name)) continue;
    const raw = await readFile(path, "utf8");
    const updated = rewriteSourceFile(raw, fromScope, toScope);
    if (updated !== raw) out.push({ path, before: raw, after: updated });
  }
}

async function reinitGit(): Promise<void> {
  const gitDir = resolve(repoRoot, ".git");
  if (existsSync(gitDir)) {
    const ok = await p.confirm({
      message: "About to delete .git and reinitialize. This wipes all history. Continue?",
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) {
      p.log.warn("Skipped git reinit.");
      return;
    }
    await rm(gitDir, { recursive: true, force: true });
  }
  execSync("git init", { cwd: repoRoot, stdio: "inherit" });
  p.log.success("Initialized fresh git repository.");
}

export async function renameRepo(args: string[]): Promise<void> {
  const { scope: rawScope, dryRun, reinitGit: reinit, force } = parseArgs(args);

  const rootPath = resolve(repoRoot, "package.json");
  const rootRaw = await readFile(rootPath, "utf8");
  const rootPkg = JSON.parse(rootRaw) as { name?: string };
  const currentName = rootPkg.name ?? "";
  if (!currentName.endsWith("-monorepo")) {
    throw new Error(
      `Root package.json name "${currentName}" does not end with "-monorepo"; cannot derive current scope.`,
    );
  }
  const currentScope = currentName.slice(0, -"-monorepo".length);

  if (currentScope !== TEMPLATE_SCOPE && !force) {
    throw new Error(
      `Repo already initialized (current scope: "${currentScope}"). Pass --force to re-init.`,
    );
  }

  let scope = rawScope;
  if (!scope) {
    const answer = await p.text({
      message: "Scope for this repo (will become @<scope>/<package>):",
      validate: (v) =>
        SCOPE_RE.test(v ?? "")
          ? undefined
          : "lowercase letters, digits, hyphens; must start with letter/digit",
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    scope = answer;
  }

  if (!SCOPE_RE.test(scope)) {
    throw new Error(`Invalid scope "${scope}". Allowed: ^[a-z0-9][a-z0-9-]*$`);
  }
  if (scope === currentScope) {
    throw new Error(`Scope is already "${scope}"; nothing to do.`);
  }

  const pkgChanges = await collectPackageJsonChanges(currentScope, scope);
  const srcChanges = await collectSourceFileChanges(currentScope, scope);
  const allChanges = [...pkgChanges, ...srcChanges];

  if (allChanges.length === 0) {
    p.log.warn(`No files reference "@${currentScope}/" or "${currentScope}-monorepo".`);
  } else if (dryRun) {
    p.log.info(`(dry-run) Would rewrite "@${currentScope}/" → "@${scope}/" in ${allChanges.length} file(s):`);
    for (const c of allChanges) p.log.info(`  ${relative(repoRoot, c.path)}`);
  } else {
    await Promise.all(allChanges.map((c) => writeFile(c.path, c.after)));
    p.log.success(`Rewrote ${allChanges.length} file(s): "@${currentScope}/" → "@${scope}/"`);
    for (const c of allChanges) p.log.info(`  ${relative(repoRoot, c.path)}`);
  }

  if (reinit) {
    if (dryRun) {
      p.log.info("(dry-run) Would delete .git and run 'git init'.");
    } else {
      await reinitGit();
    }
  }

  if (!dryRun && allChanges.length > 0) {
    p.log.info("Run 'pnpm install' to refresh the workspace.");
  }
}
