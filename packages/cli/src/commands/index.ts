import { packageCommands } from "./package/index.ts";
import { repoCommands } from "./repo/index.ts";

export type CommandHandler = (args: string[]) => Promise<void> | void;
export type CommandGroup = Record<string, CommandHandler>;

export const commands: Record<string, CommandGroup> = {
  package: packageCommands,
  repo: repoCommands,
};
