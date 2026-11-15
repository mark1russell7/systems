import type { Quantity } from "@mark1russell7/quantity";
import { convertible, isQuantity, valueIn } from "@mark1russell7/quantity";
import { escapeAttribute as xmlText } from "@mark1russell7/text";

/**
 * A service start tells when the system starts the program.
 * - `logon`: at the logon of the user. The program runs until it stops.
 * - `boot`: at the start of the computer, before a logon. The program runs until it stops. It runs in the background.
 * - `{ daily: "HH:MM" }`: each day at that local time, as a job that runs to its end.
 */
export type ServiceStart = "logon" | "boot" | { readonly daily: string };

/** A restart policy tells how long the system waits before it starts a program again after it stops. */
export interface RestartPolicy {
  /** This time is the wait before the next start. On Windows, the task starts again at whole minutes, 1 minute or more. */
  readonly after: Quantity;
}

/** A service spec tells which program the system runs as a user service, and when. */
export interface ServiceSpec {
  /** This name is the name of the Windows task and of the systemd unit: letters, digits, `.`, `_` and `-`. */
  readonly name: string;
  readonly description: string;
  /** This path is the full path of the program, for example the path of Node. */
  readonly program: string;
  readonly args: readonly string[];
  /** This folder is the working folder of the program. */
  readonly cwd?: string | undefined;
  readonly start: ServiceStart;
  /** This policy starts a program at logon or at boot again after it stops. Null starts it only at its start. A daily job has no restart. */
  readonly restart: RestartPolicy | null;
  /**
   * True runs the program when the user is not logged on. On Windows, the task gets an S4U logon, and Task Scheduler
   * then refuses the task from a shell that is not elevated. On Linux, the install sets the linger of the user
   * (`loginctl enable-linger`), thus the user manager of systemd starts at boot and stays after the logout.
   * The default is true for a boot start, and false for the other starts.
   */
  readonly background?: boolean | undefined;
  /** This folder keeps the files of the host, for example the task file of Windows. */
  readonly stateDir: string;
  /** On Windows, `hidden` starts the program through `conhost --headless`, thus no window opens. The default is `hidden`. */
  readonly console?: "hidden" | "visible" | undefined;
  /** This time is the most that one run can take. The default is no limit. */
  readonly timeLimit?: Quantity | undefined;
}

/** These are the parts of the task of Windows that come from the system, not from the spec. */
export interface TaskContext {
  /** This text is the user of the task, for example `HOST\name`. */
  readonly user: string;
  /** This path is the path of `conhost.exe`, for a hidden console. */
  readonly conhost: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAILY = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** This function tells if a text has a control character. Such a character can add a line to a unit, or break the task file. */
const hasControl = (text: string): boolean => {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** This function gives the time of a daily start, or null when the text is not `HH:MM`. */
export const dailyTime = (text: string): { readonly hour: string; readonly minute: string } | null => {
  const found = DAILY.exec(text);
  return found === null ? null : { hour: found[1]!, minute: found[2]! };
};

/** This function tells if the program of a spec runs until it stops: a start at logon or at boot, not a daily job. */
export const runsUntilStop = (start: ServiceStart): start is "logon" | "boot" => start === "logon" || start === "boot";

/** This function tells if a spec runs when the user is not logged on: its `background`, or true for a boot start. */
export const inBackground = (spec: ServiceSpec): boolean => spec.background ?? spec.start === "boot";

/** This function tells if a value is a time: a quantity in a unit of time. */
export const isTime = (value: unknown): value is Quantity => isQuantity(value) && convertible(value.unit, "ms");

/** This function gives the problems of a service spec: each value that the task or the unit cannot use. */
export const serviceProblems = (spec: ServiceSpec): string[] => {
  const problems: string[] = [];
  if (!NAME.test(spec.name)) problems.push(`the name ${JSON.stringify(spec.name)} is not letters, digits, ".", "_" and "-"`);
  const fields: Array<[string, string]> = [
    ["description", spec.description],
    ["program", spec.program],
    ["stateDir", spec.stateDir],
    ...spec.args.map((arg, at): [string, string] => [`argument ${at}`, arg]),
    ...(spec.cwd === undefined ? [] : [["cwd", spec.cwd] as [string, string]]),
  ];
  for (const [field, value] of fields) if (hasControl(value)) problems.push(`the ${field} has a control character`);
  if (spec.program === "") problems.push("the program is empty");
  if (spec.stateDir === "") problems.push("the stateDir is empty");
  if (!runsUntilStop(spec.start) && dailyTime(spec.start.daily) === null)
    problems.push(`the daily start ${JSON.stringify(spec.start.daily)} is not a time HH:MM`);
  if (!runsUntilStop(spec.start) && spec.restart !== null) problems.push("a daily job has no restart: give null");
  if (spec.background !== undefined && typeof spec.background !== "boolean") problems.push("the background is not true or false");
  if (spec.start === "boot" && spec.background === false) problems.push("a boot start runs before a logon: give background true, or leave it out");
  if (inBackground(spec) && spec.console === "visible") problems.push("a program in the background has no desktop: give the console hidden, or leave it out");
  if (spec.restart !== null && !(isTime(spec.restart.after) && valueIn(spec.restart.after, "ms") >= 0))
    problems.push("the restart wait is not a time of zero or more");
  if (spec.timeLimit !== undefined && !(isTime(spec.timeLimit) && valueIn(spec.timeLimit, "ms") > 0))
    problems.push("the time limit is not a time above zero");
  if (spec.console !== undefined && spec.console !== "hidden" && spec.console !== "visible")
    problems.push(`the console ${JSON.stringify(spec.console)} is not "hidden" or "visible"`);
  return problems;
};

/**
 * This function quotes one argument for a command line of Windows, by the rules of `CommandLineToArgvW`.
 * It doubles each backslash before a quote and at the end. One pass keeps the time linear.
 */
export const windowsArg = (arg: string): string => {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    quoted += char === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${char}`;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
};

/**
 * This function quotes one argument for the `ExecStart` line of a systemd unit. It writes `%` as
 * `%%` and `$` as `$$`, thus systemd expands no specifier and no variable. An argument with a space,
 * a quote, a backslash or a `;` goes in double quotes.
 */
export const systemdArg = (arg: string): string => {
  const escaped = arg.replace(/%/g, () => "%%").replace(/\$/g, () => "$$");
  if (escaped !== "" && !/[\s"'\\;]/.test(escaped)) return escaped;
  return `"${escaped.replace(/\\/g, () => "\\\\").replace(/"/g, () => '\\"')}"`;
};

/** This function gives a time as an ISO 8601 duration of Task Scheduler in whole seconds, for example `PT90S`. */
const isoSeconds = (time: Quantity): string => `PT${Math.max(1, Math.ceil(valueIn(time, "s")))}S`;

/** This function gives the interval of the repeat trigger of a task: whole minutes, 1 minute or more. */
const repeatMinutes = (time: Quantity): number => Math.max(1, Math.ceil(valueIn(time, "min")));

/** This function gives the seconds of a restart wait for systemd, a whole number. */
const restartSeconds = (time: Quantity): number => Math.max(0, Math.ceil(valueIn(time, "s")));

const refuse = (spec: ServiceSpec): void => {
  const problems = serviceProblems(spec);
  if (problems.length > 0) throw new Error(`the service spec has problems: ${problems.join("; ")}`);
};

/**
 * This function gives the task file of Windows for a spec, as text. It is a pure function: the same
 * spec and context give the same text. Each start boundary is in the past, thus the task does not wait for a date.
 * - A start at logon gets a logon trigger, and a start at boot gets a boot trigger. With a restart, a time trigger
 *   also starts the task each few minutes. The task ignores a start while its program runs (`IgnoreNew`).
 * - A daily start gets a calendar trigger at its time. A start that the computer missed occurs when it can (`StartWhenAvailable`).
 * - A spec in the background gets an S4U logon: the task runs when the user is not logged on, and Windows keeps no password.
 *   Otherwise the task runs only in the session of the user (`InteractiveToken`).
 * Task Scheduler reads the file as UTF-16 with a byte order mark: give the text to `utf16le`.
 */
export const renderTaskXml = (spec: ServiceSpec, context: TaskContext): string => {
  refuse(spec);
  const user = xmlText(context.user);
  const hidden = (spec.console ?? "hidden") === "hidden";
  const command = hidden ? context.conhost : spec.program;
  const args = (hidden ? ["--headless", spec.program, ...spec.args] : [...spec.args]).map(windowsArg).join(" ");
  const triggers: string[] = [];
  if (runsUntilStop(spec.start)) {
    triggers.push(
      spec.start === "logon"
        ? `    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>`
        : `    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>`,
    );
    if (spec.restart !== null)
      triggers.push(`    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT${repeatMinutes(spec.restart.after)}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>`);
  } else {
    const time = dailyTime(spec.start.daily)!;
    triggers.push(`    <CalendarTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2000-01-01T${time.hour}:${time.minute}:00</StartBoundary>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`);
  }
  const cwd = spec.cwd === undefined ? "" : `\n      <WorkingDirectory>${xmlText(spec.cwd)}</WorkingDirectory>`;
  const limit = spec.timeLimit === undefined ? "PT0S" : isoSeconds(spec.timeLimit);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlText(spec.description)}</Description>
    <URI>\\${xmlText(spec.name)}</URI>
  </RegistrationInfo>
  <Triggers>
${triggers.join("\n")}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>${inBackground(spec) ? "S4U" : "InteractiveToken"}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>${limit}</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlText(windowsArg(command))}</Command>
      <Arguments>${xmlText(args)}</Arguments>${cwd}
    </Exec>
  </Actions>
</Task>
`;
};

/** This function encodes a text as UTF-16, little-endian, with a byte order mark: the encoding that Task Scheduler reads. */
export const utf16le = (text: string): Uint8Array => {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    bytes[2 + at * 2] = unit & 0xff;
    bytes[3 + at * 2] = unit >> 8;
  }
  return bytes;
};

/**
 * This function gives the systemd user unit of a spec (`<name>.service`), as text. It is a pure function.
 * - A start at logon or at boot is a service of the type `simple`, wanted by `default.target`. With a restart, it has `Restart=on-failure`.
 *   The unit is the same for the two starts: the linger of the user (`installService`) starts the user manager at boot.
 * - A daily start is a service of the type `oneshot` with no `[Install]` section. Its timer (`renderSystemdTimer`) starts it.
 */
export const renderSystemdUnit = (spec: ServiceSpec): string => {
  refuse(spec);
  const lines = ["[Unit]", `Description=${spec.description.replace(/%/g, "%%")}`, "", "[Service]"];
  lines.push(runsUntilStop(spec.start) ? "Type=simple" : "Type=oneshot");
  lines.push(`ExecStart=${[spec.program, ...spec.args].map(systemdArg).join(" ")}`);
  if (spec.cwd !== undefined) lines.push(`WorkingDirectory=${spec.cwd.replace(/%/g, "%%")}`);
  if (spec.restart !== null) lines.push("Restart=on-failure", `RestartSec=${restartSeconds(spec.restart.after)}`);
  if (spec.timeLimit !== undefined) lines.push(`RuntimeMaxSec=${Math.max(1, Math.ceil(valueIn(spec.timeLimit, "s")))}`);
  if (runsUntilStop(spec.start)) lines.push("", "[Install]", "WantedBy=default.target");
  return `${lines.join("\n")}\n`;
};

/** This function gives the systemd timer (`<name>.timer`) of a daily spec, or null for a start at logon or at boot. It is a pure function. */
export const renderSystemdTimer = (spec: ServiceSpec): string | null => {
  refuse(spec);
  if (runsUntilStop(spec.start)) return null;
  const time = dailyTime(spec.start.daily)!;
  return `${[
    "[Unit]",
    `Description=${spec.description.replace(/%/g, "%%")}`,
    "",
    "[Timer]",
    `OnCalendar=*-*-* ${time.hour}:${time.minute}:00`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
  ].join("\n")}\n`;
};
