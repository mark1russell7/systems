import { NODE_HTTP_SERVER } from "@mark1russell7/machines";

// The settings that an HTTP cell gives to its client and its server. Each name is the name of a
// knob of the machine document of that system, in @mark1russell7/machines.

/** These are the settings of the server that a cell can give, by the names of the document. */
export interface NodeServerSettings {
  readonly keepAliveTimeout?: number;
  readonly keepAliveTimeoutBuffer?: number;
  readonly headersTimeout?: number;
  readonly requestTimeout?: number;
  readonly connectionsCheckingInterval?: number;
  readonly timeout?: number;
  readonly maxRequestsPerSocket?: number;
}

/** This function gives the hint of a server: the `timeout=` of its `Keep-Alive` header, in seconds, or null when it sends none. */
export const hintOf = (settings: NodeServerSettings): number | null => {
  const kat = settings.keepAliveTimeout ?? NODE_HTTP_SERVER.knobs["keepAliveTimeout"]!.default!;
  return kat > 0 ? Math.floor(kat / 1000) : null;
};

/** These are the options of the agent that a cell can give, in milliseconds. */
export interface AgentSettings {
  readonly timeout?: number;
  readonly keepAliveMsecs?: number;
  readonly agentKeepAliveTimeoutBuffer?: number;
}

/** These are the options of the client that a cell can give, in milliseconds. */
export interface UndiciSettings {
  readonly keepAliveTimeout?: number;
  readonly keepAliveMaxTimeout?: number;
  readonly keepAliveTimeoutThreshold?: number;
  readonly headersTimeout?: number;
  readonly bodyTimeout?: number;
  readonly connectTimeout?: number;
  readonly keepAliveInitialDelay?: number;
}

/** These are the settings of the Go client that a cell can give, by the names of the document, in seconds or as counts. */
export interface GoSettings {
  readonly IdleConnTimeout?: number;
  readonly MaxIdleConnsPerHost?: number;
  readonly DialTimeout?: number;
  readonly KeepAlive?: number;
  readonly KeepAliveInterval?: number;
  readonly KeepAliveCount?: number;
  readonly Timeout?: number;
}
