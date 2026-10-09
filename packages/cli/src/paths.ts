import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here: string = dirname(fileURLToPath(import.meta.url));
export const repoRoot: string = resolve(here, "..", "..", "..");
export const packagesDir: string = resolve(repoRoot, "packages");
