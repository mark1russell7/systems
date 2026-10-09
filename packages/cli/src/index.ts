#!/usr/bin/env -S npx tsx
import { commands } from "./commands/index.ts";
import * as p from "@clack/prompts";

async function main(): Promise<void> {
  const [groupName, subName, ...rest] = process.argv.slice(2);

  if (!groupName) {
    printHelp();
    process.exit(1);
  }

  const group = commands[groupName];
  if (!group) {
    p.log.error(`Unknown command: ${groupName}`);
    printHelp();
    process.exit(1);
  }

  if (!subName) {
    p.log.error(`Missing subcommand for "${groupName}". Available: ${Object.keys(group).join(", ")}`);
    process.exit(1);
  }

  const sub = group[subName];
  if (!sub) {
    p.log.error(`Unknown "${groupName}" subcommand: ${subName}. Available: ${Object.keys(group).join(", ")}`);
    process.exit(1);
  }

  await sub(rest);
}

function printHelp(): void {
  const lines: string[] = ["Usage: pnpm <group> <subcommand> [args]", "", "Groups:"];
  for (const [g, subs] of Object.entries(commands)) {
    lines.push(`  ${g}: ${Object.keys(subs).join(", ")}`);
  }
  p.log.info(lines.join("\n"));
}

main().catch((err: unknown) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
