import type { CommandGroup } from "../index.ts";
import { renameRepo } from "./rename.ts";

export const repoCommands: CommandGroup = {
  rename: renameRepo,
};
