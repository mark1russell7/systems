/**
 * The check of the self-test of the disk tier (`disk.test.ts`). It operates in the folder below the mount of LazyFS,
 * after the fault. It writes one JSON value: for each file of the writer, the count of the lines that the disk kept in
 * their sequence. A file that the disk did not keep gives `null`.
 */
import { readFileSync } from "node:fs";

/** This function gives the count of the whole lines `line 0`, `line 1` and the next lines at the start of a file. */
const kept = (file: string): number | null => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  const lines = text.split("\n");
  let count = 0;
  while (count < lines.length - 1 && lines[count] === `line ${count}`) count += 1;
  return count;
};

process.stdout.write(`${JSON.stringify({ synced: kept("synced.log"), unsynced: kept("unsynced.log") })}\n`);
