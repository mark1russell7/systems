import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { FilePort } from "./ports.ts";

/** A log spec tells where the output of a program goes, and when the file rotates. */
export interface LogSpec {
  /** This path is the log file. */
  readonly path: string;
  /** This size is the most that the file gets before it rotates, for example `{ value: 10, unit: "MB" }`. */
  readonly maxSize: Quantity;
  /** This count is the number of old files that stay: `<path>.1` is the newest. 0 keeps no old file. */
  readonly keep: number;
}

/** A rotating log writes data to a file, and rotates the file at its size. */
export interface RotatingLog {
  /** This method adds data to the log. The writes occur in sequence. A failed write does not throw. */
  write(chunk: string | Uint8Array): void;
  /** This promise ends when each write before it is done. */
  flush(): Promise<void>;
  /** This count is the number of writes that failed. */
  readonly failures: number;
}

const byteLength = (chunk: string | Uint8Array): number => (typeof chunk === "string" ? new TextEncoder().encode(chunk).length : chunk.length);

/**
 * This function makes a rotating log on a file port. Before a write that makes the file larger than
 * `maxSize`, the file rotates: `<path>.<keep>` goes, each `<path>.<n>` becomes `<path>.<n + 1>`, and the
 * file becomes `<path>.1`. A chunk larger than the size goes into a new file of its own.
 */
export const rotatingLog = (spec: LogSpec, files: FilePort): RotatingLog => {
  const max = valueIn(spec.maxSize, "B");
  let chain: Promise<void> = Promise.resolve();
  let size: number | null = null;
  let failures = 0;
  const rotate = async (): Promise<void> => {
    if (spec.keep <= 0) {
      await files.remove(spec.path);
      return;
    }
    await files.remove(`${spec.path}.${spec.keep}`);
    for (let at = spec.keep - 1; at >= 1; at -= 1)
      if ((await files.size(`${spec.path}.${at}`)) !== null) await files.rename(`${spec.path}.${at}`, `${spec.path}.${at + 1}`);
    await files.rename(spec.path, `${spec.path}.1`);
  };
  const append = async (chunk: string | Uint8Array): Promise<void> => {
    const length = byteLength(chunk);
    size ??= (await files.size(spec.path)) ?? 0;
    if (size > 0 && size + length > max) {
      await rotate();
      size = 0;
    }
    await files.append(spec.path, chunk);
    size += length;
  };
  return {
    write(chunk) {
      chain = chain.then(() => append(chunk)).catch(() => {
        failures += 1;
        // the size is not known after a failure: the next write reads it again
        size = null;
      });
    },
    flush: () => chain,
    get failures() {
      return failures;
    },
  };
};
