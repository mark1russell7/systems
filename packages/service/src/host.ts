/**
 * The host entry keeps a program alive on the computer of a user. It installs a Windows task or a
 * systemd user unit. It keeps a discovery file and the lock of one instance. It also supervises a group
 * of programs that start in sequence. Each effect of the system goes through `HostPorts`.
 * A test gives `fakeHost()` of `./testing`, and a program gives `nodeHostPorts()`.
 */
export type { CommandOptions, CommandPort, CommandResult, ChildHandle, FilePort, HostPorts, HttpAnswer, NetPort, ProcessesPort, ProcessMark, SpawnRequest, StopSignal } from "./host/ports.ts";
export { joinPath } from "./host/ports.ts";
export type { RestartPolicy, ServiceSpec, ServiceStart, TaskContext } from "./host/render.ts";
export { renderSystemdTimer, renderSystemdUnit, renderTaskXml, serviceProblems, systemdArg, utf16le, windowsArg } from "./host/render.ts";
export type { TreeStopOutcome } from "./host/processes.ts";
export { START_MARGIN_MS, sameProcess, stopTree } from "./host/processes.ts";
export type { Discovery, DiscoveryFields, DiscoveryRead, ReadDiscoveryOptions } from "./host/discovery.ts";
export { discoveryOf, parseDiscovery, readDiscovery, removeDiscovery, writeDiscovery } from "./host/discovery.ts";
export type { InstanceLock, LockOptions, LockOwner, LockResult, LockState } from "./host/lock.ts";
export { acquireInstanceLock, inspectInstanceLock, lockText, parseLockOwner } from "./host/lock.ts";
export type { CommandRecord, InstallOptions, InstanceOptions, ServiceOutcome, ServicePaths, ServiceStatus } from "./host/install.ts";
export { installService, servicePaths, serviceStatus, startService, stopService, uninstallService } from "./host/install.ts";
export type { FreshnessBound, ProbeResult, ReadyProbe } from "./host/probes.ts";
export { PROBE_BODY_LIMIT, probeOnce, probeProblems } from "./host/probes.ts";
export type { TargetChange, TargetHealth, TargetState, TargetVerdict, TargetWatch, WatchOptions, WatchSpec, WatchTarget } from "./host/watch.ts";
export { DEFAULT_VERDICT, watchProblems, watchTargets } from "./host/watch.ts";
export type { EnvFile } from "./host/env.ts";
export { parseEnvFile } from "./host/env.ts";
export type { LogSpec, RotatingLog } from "./host/logs.ts";
export { rotatingLog } from "./host/logs.ts";
export type { AliveSpec, GroupOptions, GroupSpec, GroupSupervisor, ProgramPhase, ProgramRestart, ProgramSpec, ProgramState, ReadySpec, StopSpec } from "./host/group.ts";
export { DEFAULT_RESTART, groupProblems, startOrder, superviseGroup } from "./host/group.ts";
export type { NodeHostOptions } from "./host/node.ts";
export { nodeHostPorts } from "./host/node.ts";
