import { describe, expect, it } from "vitest";
import type { ServiceSpec } from "./render.ts";
import { renderSystemdTimer, renderSystemdUnit, renderTaskXml, serviceProblems, systemdArg, utf16le, windowsArg } from "./render.ts";

const windowsSpec: ServiceSpec = {
  name: "demo-host",
  description: "The demo host & its <tasks>",
  program: "Z:\\Node Runtime\\node.exe",
  args: ["Z:\\demo dir\\host.js", "--port", "8080"],
  cwd: "Z:\\demo dir",
  start: "logon",
  restart: { after: { value: 90, unit: "s" } },
  stateDir: "Z:\\state",
};
const context = { user: "HOST\\test", conhost: "Z:\\Windows\\System32\\conhost.exe" };

const linuxSpec: ServiceSpec = {
  name: "demo-host",
  description: "Demo host at 100%",
  program: "/opt/node runtime/bin/node",
  args: ["/srv/demo/host.js", "--name", "a$b"],
  cwd: "/srv/demo 100%",
  start: "logon",
  restart: { after: { value: 10, unit: "s" } },
  stateDir: "/home/test/.demo",
};

const dailySpec: ServiceSpec = {
  name: "demo-job",
  description: "Demo job",
  program: "/usr/bin/node",
  args: ["/srv/demo/job.js"],
  start: { daily: "06:30" },
  restart: null,
  stateDir: "/home/test/.demo",
  timeLimit: { value: 30, unit: "min" },
};

describe("windowsArg quotes by the rules of CommandLineToArgvW", () => {
  it("keeps a plain argument, and quotes an empty one, a space and a quote", () => {
    expect(windowsArg("Z:\\dir\\x.js")).toBe("Z:\\dir\\x.js");
    expect(windowsArg("")).toBe('""');
    expect(windowsArg("a b")).toBe('"a b"');
    expect(windowsArg('a"b')).toBe('"a\\"b"');
  });

  it("doubles the backslashes at the end, and before a quote", () => {
    expect(windowsArg("Z:\\dir with space\\")).toBe('"Z:\\dir with space\\\\"');
    expect(windowsArg('a\\"b c')).toBe('"a\\\\\\"b c"');
  });
});

describe("systemdArg quotes for ExecStart", () => {
  it("doubles % and $, and quotes a space, a quote, a backslash and a semicolon", () => {
    expect(systemdArg("/usr/bin/node")).toBe("/usr/bin/node");
    expect(systemdArg("100%")).toBe("100%%");
    expect(systemdArg("a$b")).toBe("a$$b");
    expect(systemdArg("a b")).toBe('"a b"');
    expect(systemdArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(systemdArg("a\\b")).toBe('"a\\\\b"');
    expect(systemdArg("a;b")).toBe('"a;b"');
    expect(systemdArg("")).toBe('""');
  });
});

describe("serviceProblems", () => {
  it("gives no problem for a good spec", () => {
    expect(serviceProblems(windowsSpec)).toEqual([]);
    expect(serviceProblems(linuxSpec)).toEqual([]);
    expect(serviceProblems(dailySpec)).toEqual([]);
  });

  it("names a bad name, a control character, a bad daily time, a daily restart and bad times", () => {
    expect(serviceProblems({ ...linuxSpec, name: "bad name" })).toEqual(['the name "bad name" is not letters, digits, ".", "_" and "-"']);
    expect(serviceProblems({ ...linuxSpec, args: ["a\nb"] })).toEqual(["the argument 0 has a control character"]);
    expect(serviceProblems({ ...dailySpec, start: { daily: "25:00" } })).toEqual(['the daily start "25:00" is not a time HH:MM']);
    expect(serviceProblems({ ...dailySpec, restart: { after: { value: 1, unit: "min" } } })).toEqual(["a daily job has no restart: give null"]);
    expect(serviceProblems({ ...linuxSpec, restart: { after: { value: 1, unit: "MB" } } })).toEqual(["the restart wait is not a time of zero or more"]);
    expect(serviceProblems({ ...dailySpec, timeLimit: { value: 0, unit: "s" } })).toEqual(["the time limit is not a time above zero"]);
    expect(serviceProblems({ ...linuxSpec, program: "", stateDir: "" })).toEqual(["the program is empty", "the stateDir is empty"]);
  });

  it("makes each render throw on a problem", () => {
    const bad = { ...linuxSpec, name: "bad name" };
    expect(() => renderSystemdUnit(bad)).toThrow(/the service spec has problems/);
    expect(() => renderSystemdTimer(bad)).toThrow(/the service spec has problems/);
    expect(() => renderTaskXml(bad, context)).toThrow(/the service spec has problems/);
  });
});

describe("renderTaskXml", () => {
  const xml = renderTaskXml(windowsSpec, context);

  it("starts at logon, and starts again each 2 minutes for a wait of 90 s, with IgnoreNew", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4"')).toBe(true);
    expect(xml).toContain(`  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>HOST\\test</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT2M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>`);
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  it("escapes the description, and names the task with one backslash", () => {
    expect(xml).toContain("<Description>The demo host &amp; its &lt;tasks&gt;</Description>");
    expect(xml).toContain("<URI>\\demo-host</URI>");
  });

  it("runs the program through conhost --headless, with each path that has a space in quotes", () => {
    expect(xml).toContain(`    <Exec>
      <Command>Z:\\Windows\\System32\\conhost.exe</Command>
      <Arguments>--headless &quot;Z:\\Node Runtime\\node.exe&quot; &quot;Z:\\demo dir\\host.js&quot; --port 8080</Arguments>
      <WorkingDirectory>Z:\\demo dir</WorkingDirectory>
    </Exec>`);
  });

  it("runs a visible program itself, and a daily job at its time with its limit", () => {
    const visible = renderTaskXml({ ...windowsSpec, console: "visible", cwd: undefined }, context);
    expect(visible).toContain(`      <Command>&quot;Z:\\Node Runtime\\node.exe&quot;</Command>
      <Arguments>&quot;Z:\\demo dir\\host.js&quot; --port 8080</Arguments>
    </Exec>`);
    const daily = renderTaskXml({ ...dailySpec, program: "Z:\\node.exe", args: [] }, context);
    expect(daily).toContain(`    <CalendarTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2000-01-01T06:30:00</StartBoundary>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`);
    expect(daily).not.toContain("LogonTrigger");
    expect(daily).toContain("<ExecutionTimeLimit>PT1800S</ExecutionTimeLimit>");
  });

  it("starts only at logon without a restart", () => {
    const once = renderTaskXml({ ...windowsSpec, restart: null }, context);
    expect(once).toContain("<LogonTrigger>");
    expect(once).not.toContain("<TimeTrigger>");
  });
});

describe("utf16le", () => {
  it("writes a byte order mark, then each code unit, low byte first", () => {
    expect([...utf16le("A<")]).toEqual([0xff, 0xfe, 0x41, 0x00, 0x3c, 0x00]);
    expect(new TextDecoder("utf-16le").decode(utf16le("Z:\\x").slice(2))).toBe("Z:\\x");
  });
});

describe("renderSystemdUnit and renderSystemdTimer", () => {
  it("gives a simple service at logon, with Restart=on-failure and escapes", () => {
    expect(renderSystemdUnit(linuxSpec)).toBe(`[Unit]
Description=Demo host at 100%%

[Service]
Type=simple
ExecStart="/opt/node runtime/bin/node" /srv/demo/host.js --name a$$b
WorkingDirectory=/srv/demo 100%%
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`);
    expect(renderSystemdTimer(linuxSpec)).toBeNull();
  });

  it("gives a oneshot daily job and its timer", () => {
    expect(renderSystemdUnit(dailySpec)).toBe(`[Unit]
Description=Demo job

[Service]
Type=oneshot
ExecStart=/usr/bin/node /srv/demo/job.js
RuntimeMaxSec=1800
`);
    expect(renderSystemdTimer(dailySpec)).toBe(`[Unit]
Description=Demo job

[Timer]
OnCalendar=*-*-* 06:30:00
Persistent=true

[Install]
WantedBy=timers.target
`);
  });
});
