//! resources read DIR...
//! resources watch --period-ms N DIR...
//!
//! This program reads the resources of one container. It reads the files of the cgroup of the
//! container, and the devices of the network namespace that the program is in. Each line is JSON
//! with the event `resources` and a `t` on CLOCK_MONOTONIC, the clock of each other line of a lab.
//!
//! The harness starts the program in a sidecar: in the network namespace of the container, and in
//! the cgroup namespace of the host. Thus the program is not in the cgroup of the container, and
//! its own CPU time and memory are not in the readings.
//!
//! Each `DIR` is a folder where the cgroup of the container can be. The program takes the first one
//! that is there: the folder under the cgroup driver of systemd, or under the driver cgroupfs.
//!
//! `read` writes one line. `watch` writes one line each `--period-ms` milliseconds, until the
//! harness stops it. Each line of a series has its place on the clock from the start of the
//! series, thus the time of a reading does not move the later ones.
//!
//! A line has the text of each file, as the kernel gives it. The harness reads the numbers from
//! that text, thus one program reads each file format. A file that the program cannot read is
//! `null`: no read, never a zero. `t` is the time before the first file, which is `cpu.stat`. `t1`
//! is the time after the last file.

use harness_native::{emit, emit_at};
use prober::monotonic_ns;
use serde_json::{json, Map, Value};
use std::error::Error;
use std::path::Path;
use std::time::Duration;

/// the files of the cgroup, in the order of the reads: the CPU time first, next to the stamp
const FILES: [&str; 9] = [
    "cpu.stat",
    "memory.current",
    "memory.peak",
    "memory.stat",
    "memory.events",
    "pids.current",
    "cpu.max",
    "memory.max",
    "cpuset.cpus.effective",
];
/// the counters of each device of the network namespace of the program
const DEVICES: &str = "/proc/net/dev";
const MILLISECOND_NS: u64 = 1_000_000;
const USAGE: &str = "resources read DIR... | resources watch --period-ms N DIR...";

#[derive(Debug, PartialEq)]
struct Plan {
    /// the period of a series in milliseconds, or None for one line
    period_ms: Option<u64>,
    dirs: Vec<String>,
}

/// Reads the mode, the period of a series and the folders where the cgroup can be.
fn plan_of(args: &[String]) -> Result<Plan, Box<dyn Error>> {
    let (mode, rest) = args.split_first().ok_or(USAGE)?;
    let mut period_ms = None;
    let mut dirs = Vec::new();
    let mut rest = rest.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--period-ms" => period_ms = Some(rest.next().ok_or("--period-ms needs a value")?.parse::<u64>()?),
            other if other.starts_with("--") => return Err(format!("no flag {other}").into()),
            dir => dirs.push(dir.to_string()),
        }
    }
    match (mode.as_str(), period_ms) {
        ("read", None) => {}
        ("watch", Some(period)) if period > 0 => {}
        ("watch", _) => return Err("watch needs --period-ms with a period above 0".into()),
        _ => return Err(USAGE.into()),
    }
    if dirs.is_empty() {
        return Err("resources needs a folder of a cgroup".into());
    }
    Ok(Plan { period_ms, dirs })
}

/// The first folder that is there: the cgroup of the container under the cgroup driver of this host.
fn found_in<'a>(dirs: &'a [String], there: impl Fn(&str) -> bool) -> Option<&'a str> {
    dirs.iter().map(String::as_str).find(|&dir| there(dir))
}

/// The text of a file, or null when the program cannot read it: no read, never a zero.
fn text_of(path: &str) -> Value {
    match std::fs::read_to_string(path) {
        Ok(text) => Value::String(text),
        Err(_) => Value::Null,
    }
}

/// One reading: its stamp, and the text of each file of the cgroup and of the devices.
fn reading(dir: &str) -> (u64, Value) {
    let t = monotonic_ns();
    let mut files = Map::new();
    // the CPU time comes first, next to the stamp
    files.insert(FILES[0].to_string(), text_of(&format!("{dir}/{}", FILES[0])));
    let net = text_of(DEVICES);
    for name in &FILES[1..] {
        files.insert(name.to_string(), text_of(&format!("{dir}/{name}")));
    }
    let t1 = monotonic_ns();
    (t, json!({ "t1": t1, "cgroup": dir, "files": files, "net": net }))
}

/// Writes one line of a reading.
fn line(dir: &str) {
    let (t, fields) = reading(dir);
    emit_at("resources", t, fields);
}

fn run(args: &[String]) -> Result<(), Box<dyn Error>> {
    let plan = plan_of(args)?;
    let dir = found_in(&plan.dirs, |dir| Path::new(dir).is_dir())
        .ok_or_else(|| format!("no cgroup folder of the container: {}", plan.dirs.join(", ")))?;
    let Some(period_ms) = plan.period_ms else {
        line(dir);
        return Ok(());
    };
    let period = period_ms * MILLISECOND_NS;
    let start = monotonic_ns();
    loop {
        line(dir);
        let now = monotonic_ns();
        // the next place on the clock after this reading: a slow reading skips a place, and the series does not drift
        let next = start + ((now - start) / period + 1) * period;
        std::thread::sleep(Duration::from_nanos(next - now));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // an error is a line too: the harness reads it, and it does not take it for a reading
    if let Err(error) = run(&args) {
        emit("error", json!({ "what": error.to_string() }));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(each: &[&str]) -> Vec<String> {
        each.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn a_plan_reads_its_mode_its_period_and_its_folders() {
        assert_eq!(plan_of(&argv(&["read", "/a", "/b"])).expect("a plan"), Plan { period_ms: None, dirs: argv(&["/a", "/b"]) });
        assert_eq!(plan_of(&argv(&["watch", "--period-ms", "250", "/a"])).expect("a plan"), Plan { period_ms: Some(250), dirs: argv(&["/a"]) });
        assert!(plan_of(&argv(&[])).is_err());
        assert!(plan_of(&argv(&["read"])).is_err());
        assert!(plan_of(&argv(&["read", "--period-ms", "250", "/a"])).is_err());
        assert!(plan_of(&argv(&["watch", "/a"])).is_err());
        assert!(plan_of(&argv(&["watch", "--period-ms", "0", "/a"])).is_err());
        assert!(plan_of(&argv(&["watch", "--period-ms", "x", "/a"])).is_err());
        assert!(plan_of(&argv(&["watch", "--period-ms"])).is_err());
        assert!(plan_of(&argv(&["read", "--no-such", "/a"])).is_err());
        assert!(plan_of(&argv(&["other", "/a"])).is_err());
    }

    #[test]
    fn the_cgroup_is_the_first_folder_that_is_there() {
        let dirs = argv(&["/sys/fs/cgroup/system.slice/docker-1.scope", "/sys/fs/cgroup/docker/1"]);
        assert_eq!(found_in(&dirs, |dir| dir.starts_with("/sys/fs/cgroup/docker/")), Some("/sys/fs/cgroup/docker/1"));
        assert_eq!(found_in(&dirs, |_| true), Some("/sys/fs/cgroup/system.slice/docker-1.scope"));
        assert_eq!(found_in(&dirs, |_| false), None);
    }

    #[test]
    fn a_reading_has_the_text_of_each_file_and_null_for_a_file_that_is_not_there() {
        let dir = std::env::temp_dir().join(format!("resources-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder");
        std::fs::write(dir.join("cpu.stat"), "usage_usec 12\n").expect("a file");
        let (t, fields) = reading(dir.to_str().expect("a path"));
        std::fs::remove_dir_all(&dir).expect("a removal");
        assert!(fields["t1"].as_u64().expect("a stamp") >= t);
        assert_eq!(fields["cgroup"], json!(dir.to_str()));
        assert_eq!(fields["files"]["cpu.stat"], json!("usage_usec 12\n"));
        // no read is null: a zero is a value
        assert_eq!(fields["files"]["memory.peak"], Value::Null);
        assert_eq!(fields["files"].as_object().expect("the files").len(), FILES.len());
        assert!(fields.get("net").is_some());
    }
}
