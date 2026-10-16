// The names and the ports of the objects of a cell. The judge reads them, thus this module imports
// nothing.

/** These are the ports of the app: its server, and its health server for the probes. */
export const PORT = 8080;
export const HEALTH_PORT = 9000;
/** This label makes the watcher follow the log of a pod. */
export const LOG_LABEL = "lab.systems/log";
/** These are the names of the objects of a cell. */
export const SERVER = "lab";
export const CLIENT = "client";
export const REDIS = "redis";
