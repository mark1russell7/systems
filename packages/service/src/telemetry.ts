// The telemetry that `run()` starts: the context of OpenTelemetry for the service, from @mark1russell7/otel-ts.
// otel-ts is an optional peer. This file loads it only when `run()` calls `startTelemetry`, with `require`
// from `process.getBuiltinModule`. Thus the root entry loads no package and no `node:` module at its import,
// and a program with no otel-ts starts as before.

/** These options set the telemetry of a service. `run()` starts it by default, and `false` turns it off. */
export interface TelemetryOptions {
  /**
   * This environment gives `OTEL_EXPORTER_OTLP_ENDPOINT` and the variables of the exporters. The default is
   * `process.env`. Without an endpoint, no span leaves the process, and the exporters do not load.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** This text is the version of the service: the resource attribute `service.version`. */
  readonly version?: string | undefined;
}

/** The telemetry that `startTelemetry` started: the lifecycle stops it in the phase `flush the output`. */
export interface StartedTelemetry {
  /** This method flushes the spans, and removes the registration of the context. A second call does nothing. */
  shutdown(): Promise<void>;
}

/** The reason that `startTelemetry` started nothing */
export type NoTelemetry = "off" | "no otel-ts" | "owned";

/** This function loads a package, as `require` does. */
export type Load = (specifier: string) => unknown;

interface ContextEntry {
  readonly contextOwner?: () => string | undefined;
}

interface NodeContextEntry {
  readonly startNodeContext: (options: {
    readonly serviceName: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly spanProcessors: readonly unknown[];
    readonly resourceAttributes?: Readonly<Record<string, string>>;
  }) => StartedTelemetry;
}

interface ExportEntry {
  readonly exportSpanProcessors: (options: { readonly env: Readonly<Record<string, string | undefined>> }) => readonly unknown[];
}

/** This function tells an error of a package that is not installed. */
const notFound = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
};

interface NodeProcess {
  readonly getBuiltinModule?: (id: string) => unknown;
}

/** This function gives the `require` of this file, or undefined outside Node (a process with no `getBuiltinModule`). */
export const nodeLoad = (node: NodeProcess | undefined = (globalThis as { process?: NodeProcess }).process): Load | undefined => {
  const module = node?.getBuiltinModule?.("node:module") as { createRequire(url: string): Load } | undefined;
  return module?.createRequire(import.meta.url);
};

/**
 * This function starts the context of OpenTelemetry for a service, with `startNodeContext()` of otel-ts. It
 * starts nothing, and gives the reason, when:
 * - the options are `false` (`"off"`);
 * - otel-ts, or a package of its entry `/node/context`, is not installed, or its version has no `contextOwner()`
 *   (`"no otel-ts"`);
 * - a part of the program registered the context first, for example the program itself or the capture of a test
 *   (`"owned"`). The service then uses that context.
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT`, the spans go to the exporters of `exportSpanProcessors()` of otel-ts.
 */
export const startTelemetry = (
  serviceName: string,
  options: false | TelemetryOptions | undefined,
  // null, not undefined, is "no loader": undefined selects this default
  load: Load | null = nodeLoad() ?? null,
): StartedTelemetry | NoTelemetry => {
  if (options === false) return "off";
  if (load === null) return "no otel-ts";
  let owner: ContextEntry;
  let node: NodeContextEntry;
  try {
    owner = load("@mark1russell7/otel-ts/context") as ContextEntry;
    if (typeof owner.contextOwner !== "function") return "no otel-ts";
    if (owner.contextOwner() !== undefined) return "owned";
    node = load("@mark1russell7/otel-ts/node/context") as NodeContextEntry;
  } catch (error) {
    if (notFound(error)) return "no otel-ts";
    throw error;
  }
  const env = options?.env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  // the exporters load only with an endpoint: without it, nothing leaves the process
  const spanProcessors = env["OTEL_EXPORTER_OTLP_ENDPOINT"] ? (load("@mark1russell7/otel-ts/node/export") as ExportEntry).exportSpanProcessors({ env }) : [];
  return node.startNodeContext({
    serviceName,
    env,
    spanProcessors,
    ...(options?.version === undefined ? {} : { resourceAttributes: { "service.version": options.version } }),
  });
};
