import type { CommandGroup } from "../index.ts";
import { addPackage } from "./add.ts";

export const packageCommands: CommandGroup = {
  add: addPackage,
};
