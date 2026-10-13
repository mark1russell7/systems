// The prepublishOnly guard of each published package of this repository. It runs in the folder of the package.
//
// The source manifest points "main", "types", "exports" and "bin" at src/*.ts, because the workspace
// uses the source. "publishConfig" points them at build/. pnpm applies those fields when it packs,
// and npm ignores them, so `npm publish` would ship entry points that are not in the tarball.
// This guard computes the entry points that the packing tool will write, and stops the publish when
// one of them is outside build/.
//
// A release publishes a tarball that `pnpm pack` made (`npm publish <tgz>`). That runs no package
// scripts, so this guard does not get in its way.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const agent = process.env.npm_config_user_agent ?? "";
const tool = agent.split("/")[0] || "an unknown tool";

// The fields that pnpm takes from publishConfig. Other tools keep the top-level fields.
const OVERRIDES = ["main", "module", "types", "typings", "browser", "bin", "exports"];
const packed = { ...manifest };
if (tool === "pnpm") {
  for (const field of OVERRIDES) {
    if (manifest.publishConfig?.[field] !== undefined)
      packed[field] = manifest.publishConfig[field];
  }
}

const targets = [];
const collect = (where, value) => {
  if (typeof value === "string") targets.push([where, value]);
  else if (Array.isArray(value))
    value.forEach((item, index) => collect(`${where}[${index}]`, item));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      collect(`${where}[${JSON.stringify(key)}]`, item);
  }
};
for (const field of OVERRIDES) {
  if (packed[field] !== undefined) collect(field, packed[field]);
}

const inBuild = (target) => /^(\.\/)?build\//.test(target) || target === "./package.json";
const wrong = targets.filter(([, target]) => !inBuild(target));

if (wrong.length > 0) {
  process.stderr.write(
    [
      `${manifest.name}: ${tool} would publish entry points outside build/:`,
      ...wrong.map(([where, target]) => `  ${where} -> ${target}`),
      "Publish with `pnpm publish` (pnpm applies publishConfig), or publish the tarball of `pnpm pack`.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
process.stdout.write(
  `${manifest.name}: ${targets.length} entry points, all in build/ (${tool}).\n`,
);
