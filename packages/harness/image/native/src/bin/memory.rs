//! memory grow --until-pages N [--step N] [--wait-s N] HOST PORT [--mode M] [--max-s N]
//! memory oom --task NAME:PAGES:ADJ [--task NAME:PAGES:ADJ]... [--wait-s N] HOST PORT [--mode M] [--max-s N]
//! memory task NAME PAGES ADJ
//!
//! This program is the client of the memory cells. Each line is JSON with an `ev` and a `t` on
//! CLOCK_MONOTONIC. The program does not connect. The address and the port of the target are in its
//! argv because the harness gives them to each client.
//!
//! The harness writes the files of the cgroup of the container, and then it makes the file
//! `/tmp/cgroup`. The program waits for that file, and it writes `ready` with the limits that it
//! reads. The container has a cgroup namespace of its own, thus its cgroup is the root of
//! `/sys/fs/cgroup`.
//!
//! `grow` keeps itself on one CPU, because the stock of a charge is for each CPU. It maps anonymous
//! memory with no huge pages, thus each fault charges one page. It touches that memory in steps of
//! `--step` pages until `memory.current` reaches `--until-pages`. Before it maps that memory, it locks
//! the pages that it has, thus a reclaim frees none of them. The `ready` line says `locked` true or
//! false. A `step` line gives each step: its time, the usage after it and the count of the event
//! `high`. The last lines are `pressure`, `events` and `done`.
//!
//! `oom` starts each task in order, and it waits until the task holds its pages or ends. Each task is
//! the program again, as `memory task`. A `task` line then gives each task: `held`, `killed` by
//! SIGKILL, or `ended`. The last lines are `events` and `done`.
//!
//! `task` sets its own `oom_score_adj`, and it touches its pages. It then writes `held` with its
//! resident pages, and it sleeps until its parent stops it.

use harness_native::{emit, emit_at};
use prober::monotonic_ns;
use serde_json::{json, Map, Value};
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::FileExt;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// the cgroup of the container: its own namespace shows it at the root of the mount
const CGROUP: &str = "/sys/fs/cgroup";
/// the harness makes this file after it writes the files of the cgroup
const SET: &str = "/tmp/cgroup";
/// the wait after the last task, so that the OOM killer ends its victim, in milliseconds
const SETTLE_MS: u64 = 1_000;
const SECOND_NS: u64 = 1_000_000_000;
const USAGE: &str = "memory grow --until-pages N [flags] HOST PORT | memory oom --task NAME:PAGES:ADJ... HOST PORT | memory task NAME PAGES ADJ";

#[derive(Debug, PartialEq)]
struct Grow {
    until: u64,
    step: u64,
    wait_s: u64,
    max_s: u64,
}

#[derive(Debug, PartialEq)]
struct Task {
    name: String,
    pages: u64,
    adj: i32,
}

#[derive(Debug, PartialEq)]
struct Oom {
    tasks: Vec<Task>,
    wait_s: u64,
}

/// Reads the flags of `grow`. The harness gives `--mode` and `--max-s` to each client, and the place of the target.
fn grow_of(args: &[String]) -> Result<Grow, Box<dyn Error>> {
    let mut plan = Grow { until: 0, step: 64, wait_s: 30, max_s: 600 };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--until-pages" => plan.until = value()?.parse()?,
            "--step" => plan.step = value()?.parse()?,
            "--wait-s" => plan.wait_s = value()?.parse()?,
            // the harness writes the window of the cell in seconds, which can have a fraction
            "--max-s" => plan.max_s = value()?.parse::<f64>()?.ceil() as u64,
            "--mode" => {
                value()?;
            }
            other if other.starts_with("--") => return Err(format!("no flag {other}").into()),
            _ => {}
        }
    }
    if plan.until == 0 {
        return Err("grow needs --until-pages".into());
    }
    if plan.step == 0 {
        return Err("a step of 0 pages touches nothing".into());
    }
    Ok(plan)
}

/// Reads one task of `oom`: its name, its pages and its `oom_score_adj`.
fn task_of(text: &str) -> Result<Task, Box<dyn Error>> {
    let mut parts = text.split(':');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(name), Some(pages), Some(adj), None) if !name.is_empty() => Ok(Task { name: name.into(), pages: pages.parse()?, adj: adj.parse()? }),
        _ => Err(format!("a task is NAME:PAGES:ADJ, not {text}").into()),
    }
}

/// Reads the flags of `oom`.
fn oom_of(args: &[String]) -> Result<Oom, Box<dyn Error>> {
    let mut plan = Oom { tasks: Vec::new(), wait_s: 30 };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--task" => plan.tasks.push(task_of(value()?)?),
            "--wait-s" => plan.wait_s = value()?.parse()?,
            "--mode" | "--max-s" => {
                value()?;
            }
            other if other.starts_with("--") => return Err(format!("no flag {other}").into()),
            _ => {}
        }
    }
    if plan.tasks.is_empty() {
        return Err("oom needs a --task".into());
    }
    Ok(plan)
}

fn page_size() -> u64 {
    // SAFETY: sysconf reads a constant of the system
    unsafe { libc::sysconf(libc::_SC_PAGESIZE) as u64 }
}

fn number(text: &str) -> Result<u64, Box<dyn Error>> {
    Ok(text.trim().parse()?)
}

/// The counts of a flat keyed file of a cgroup, as `memory.events` gives them: one `key value` on each line.
fn keyed(text: &str) -> Map<String, Value> {
    text.lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(' ')?;
            Some((name.to_string(), json!(value.trim().parse::<u64>().ok()?)))
        })
        .collect()
}

/// One count of a flat keyed file of a cgroup.
fn count_of(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(' ')?;
        if name == key {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

/// The total stall of one line of `memory.pressure` (`some` or `full`), in microseconds.
fn stall_of(text: &str, kind: &str) -> Option<u64> {
    text.lines()
        .find(|line| line.split_whitespace().next() == Some(kind))?
        .split_whitespace()
        .find_map(|field| field.strip_prefix("total=")?.parse().ok())
}

fn read(name: &str) -> Result<String, Box<dyn Error>> {
    let path = format!("{CGROUP}/{name}");
    Ok(std::fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?.trim().to_string())
}

/// The limits of the cgroup as the kernel prints them, its usage in pages and its events.
fn limits(page: u64) -> Result<Value, Box<dyn Error>> {
    Ok(json!({
        "high": read("memory.high")?,
        "max": read("memory.max")?,
        "swap": read("memory.swap.max")?,
        "current": number(&read("memory.current")?)? / page,
        "events": keyed(&read("memory.events")?),
        "page": page,
    }))
}

/// One file of the cgroup, open for the whole run. Each read is a pread at 0, which opens no file:
/// the `struct file` of an open is charged to the cgroup too.
struct Knob {
    file: File,
    buffer: Vec<u8>,
}

impl Knob {
    fn open(name: &str) -> Result<Knob, Box<dyn Error>> {
        let path = format!("{CGROUP}/{name}");
        let file = File::open(&path).map_err(|error| format!("{path}: {error}"))?;
        Ok(Knob { file, buffer: vec![0; 4096] })
    }

    fn text(&mut self) -> Result<String, Box<dyn Error>> {
        let read = self.file.read_at(&mut self.buffer, 0)?;
        Ok(String::from_utf8_lossy(&self.buffer[..read]).trim().to_string())
    }
}

/// Waits for the file of the harness. It gives false when `wait_s` passes first.
fn wait_set(wait_s: u64) -> bool {
    let end = monotonic_ns() + wait_s * SECOND_NS;
    while !Path::new(SET).exists() {
        if monotonic_ns() > end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    true
}

/// Keeps the task on the last CPU that it can use, which other work uses less than CPU 0. It gives
/// that CPU.
fn pin() -> Result<usize, Box<dyn Error>> {
    let size = std::mem::size_of::<libc::cpu_set_t>();
    // SAFETY: each set is on this stack, passed with its exact size
    unsafe {
        let mut allowed: libc::cpu_set_t = std::mem::zeroed();
        if libc::sched_getaffinity(0, size, &mut allowed) != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let cpu = (0..libc::CPU_SETSIZE as usize).rev().find(|&cpu| libc::CPU_ISSET(cpu, &allowed)).ok_or("the task can use no CPU")?;
        let mut one: libc::cpu_set_t = std::mem::zeroed();
        libc::CPU_SET(cpu, &mut one);
        if libc::sched_setaffinity(0, size, &one) != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(cpu)
    }
}

/// Locks each page that the program maps at this point: its code, its libraries and its stack. A
/// reclaim above `memory.high` then frees no page of the program, and each step charges one batch. It
/// gives false when the kernel refuses the lock, for example above `RLIMIT_MEMLOCK`. It comes before the
/// map of the region, because `MCL_CURRENT` faults in each page that is mapped.
fn lock() -> bool {
    // SAFETY: the call changes no memory of the program
    unsafe { libc::mlockall(libc::MCL_CURRENT) == 0 }
}

/// Linux gives `EINVAL` for `MADV_NOHUGEPAGE` when the kernel has no transparent huge pages
/// (`CONFIG_TRANSPARENT_HUGEPAGE` is not set). Then the fault of each page takes one page, and the
/// advice has nothing to turn off. The range of a new mapping is aligned, thus `EINVAL` has no other cause here.
fn no_huge_pages(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::EINVAL)
}

/// Anonymous memory with no huge pages: the fault of each page charges one page to the cgroup.
struct Region {
    base: *mut u8,
    pages: u64,
    page: u64,
}

impl Region {
    fn map(pages: u64, page: u64) -> Result<Region, Box<dyn Error>> {
        let bytes = (pages * page) as usize;
        // SAFETY: a new private anonymous mapping, which nothing else holds
        let base = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                bytes,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | libc::MAP_NORESERVE,
                -1,
                0,
            )
        };
        if base == libc::MAP_FAILED {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: the range is the mapping above
        if unsafe { libc::madvise(base, bytes, libc::MADV_NOHUGEPAGE) } != 0 {
            let error = std::io::Error::last_os_error();
            if !no_huge_pages(&error) {
                return Err(error.into());
            }
        }
        Ok(Region { base: base.cast(), pages, page })
    }

    /// Writes one byte in each page from `from` to `to`, in the mapping.
    fn touch(&self, from: u64, to: u64) {
        for index in from..to.min(self.pages) {
            // SAFETY: the page is inside the mapping
            unsafe { std::ptr::write_volatile(self.base.add((index * self.page) as usize), 1) }
        }
    }
}

fn grow(plan: &Grow) -> Result<(), Box<dyn Error>> {
    let page = page_size();
    let cpu = pin()?;
    if !wait_set(plan.wait_s) {
        emit("deadline", json!({ "wait": "cgroup" }));
        return Ok(());
    }
    let mut current = Knob::open("memory.current")?;
    let mut events = Knob::open("memory.events")?;
    let locked = lock();
    let region = Region::map(plan.until, page)?;
    let mut ready = limits(page)?;
    ready["cpu"] = json!(cpu);
    ready["locked"] = json!(locked);
    emit("ready", ready);
    let end = monotonic_ns() + plan.max_s * SECOND_NS;
    let mut usage = number(&current.text()?)? / page;
    let mut touched = 0;
    let mut index = 0u64;
    while usage < plan.until {
        if touched >= region.pages {
            return Err(format!("{touched} pages are touched, and the usage is {usage} pages, below {}", plan.until).into());
        }
        if monotonic_ns() > end {
            emit("deadline", json!({ "wait": "growth", "current": usage }));
            return Ok(());
        }
        let start = monotonic_ns();
        region.touch(touched, touched + plan.step);
        let stop = monotonic_ns();
        touched += plan.step;
        usage = number(&current.text()?)? / page;
        let high = count_of(&events.text()?, "high").unwrap_or(0);
        emit_at("step", stop, json!({ "n": index, "ns": stop - start, "current": usage, "high": high }));
        index += 1;
    }
    let pressure = std::fs::read_to_string(format!("{CGROUP}/memory.pressure")).ok();
    let stall = |kind: &str| pressure.as_deref().and_then(|text| stall_of(text, kind));
    emit("pressure", json!({ "some": stall("some"), "full": stall("full") }));
    emit("events", Value::Object(keyed(&events.text()?)));
    emit("done", json!({ "touched": touched }));
    Ok(())
}

fn oom(plan: &Oom) -> Result<(), Box<dyn Error>> {
    let page = page_size();
    if !wait_set(plan.wait_s) {
        emit("deadline", json!({ "wait": "cgroup" }));
        return Ok(());
    }
    emit("ready", limits(page)?);
    let me = std::env::current_exe()?;
    let mut children: Vec<(&Task, Child)> = Vec::new();
    for task in &plan.tasks {
        let mut child = Command::new(&me)
            .args(["task", &task.name, &task.pages.to_string(), &task.adj.to_string()])
            .stdout(Stdio::piped())
            .spawn()?;
        let out = child.stdout.take().ok_or("the task has no output")?;
        // each line of the task goes on as a line of this program, until the task holds its pages or ends
        for line in BufReader::new(out).lines() {
            let line = line?;
            println!("{line}");
            if line.contains("\"ev\":\"held\"") {
                break;
            }
        }
        children.push((task, child));
    }
    std::thread::sleep(Duration::from_millis(SETTLE_MS));
    for (task, child) in &mut children {
        let pid = child.id();
        let fields = match child.try_wait()? {
            None => json!({ "name": task.name, "pid": pid, "outcome": "held", "signal": null }),
            Some(status) => {
                let outcome = if status.signal() == Some(libc::SIGKILL) { "killed" } else { "ended" };
                json!({ "name": task.name, "pid": pid, "outcome": outcome, "signal": status.signal(), "code": status.code() })
            }
        };
        emit("task", fields);
    }
    emit("events", Value::Object(keyed(&read("memory.events")?)));
    for (_, child) in &mut children {
        if child.try_wait()?.is_none() {
            child.kill()?;
            child.wait()?;
        }
    }
    emit("done", json!({}));
    Ok(())
}

fn task(args: &[String]) -> Result<(), Box<dyn Error>> {
    let [name, pages, adj] = args else {
        return Err("memory task NAME PAGES ADJ".into());
    };
    let pages: u64 = pages.parse()?;
    let adj: i32 = adj.parse()?;
    // a value below the value of the parent needs CAP_SYS_RESOURCE
    std::fs::write("/proc/self/oom_score_adj", adj.to_string()).map_err(|error| format!("oom_score_adj {adj}: {error}"))?;
    let region = Region::map(pages, page_size())?;
    region.touch(0, pages);
    let statm = std::fs::read_to_string("/proc/self/statm")?;
    let rss: u64 = statm.split_whitespace().nth(1).ok_or("statm has no resident count")?.parse()?;
    emit("held", json!({ "name": name, "pid": std::process::id(), "pages": pages, "rss": rss, "adj": adj }));
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args.first().map(String::as_str) {
        Some("grow") => grow_of(&args[1..]).and_then(|plan| grow(&plan)),
        Some("oom") => oom_of(&args[1..]).and_then(|plan| oom(&plan)),
        Some("task") => task(&args[1..]),
        _ => Err(USAGE.into()),
    };
    // an error is a line too: the harness ends the run at it, and the judge makes the run void
    if let Err(error) = outcome {
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
    fn a_growth_reads_its_flags_and_skips_the_flags_of_the_harness() {
        let plan = grow_of(&argv(&["--until-pages", "30400", "10.0.0.2", "6392", "--mode", "idle", "--max-s", "70.5"])).expect("a plan");
        assert_eq!(plan, Grow { until: 30_400, step: 64, wait_s: 30, max_s: 71 });
        assert!(grow_of(&argv(&["10.0.0.2", "6392"])).is_err());
        assert!(grow_of(&argv(&["--until-pages", "10", "--step", "0"])).is_err());
        assert!(grow_of(&argv(&["--until-pages", "10", "--no-such", "1"])).is_err());
    }

    #[test]
    fn an_oom_reads_each_task_with_a_negative_adjustment() {
        let plan = oom_of(&argv(&["--task", "a:46080:-1000", "--task", "b:7680:0", "10.0.0.2", "6392", "--mode", "idle", "--max-s", "30"])).expect("a plan");
        assert_eq!(plan.tasks, vec![Task { name: "a".into(), pages: 46_080, adj: -1000 }, Task { name: "b".into(), pages: 7_680, adj: 0 }]);
        assert!(oom_of(&argv(&["10.0.0.2", "6392"])).is_err());
        assert!(task_of("a:1").is_err());
        assert!(task_of(":1:0").is_err());
        assert!(task_of("a:1:0:9").is_err());
    }

    #[test]
    fn the_files_of_a_cgroup_give_their_counts() {
        let events = "low 0\nhigh 52\nmax 0\noom 1\noom_kill 1\noom_group_kill 0\n";
        assert_eq!(count_of(events, "high"), Some(52));
        assert_eq!(count_of(events, "oom_kill"), Some(1));
        assert_eq!(count_of(events, "nothing"), None);
        assert_eq!(keyed(events).get("oom"), Some(&json!(1)));
        assert_eq!(keyed(events).len(), 6);
        let pressure = "some avg10=0.00 avg60=0.00 avg300=0.00 total=1234\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=567\n";
        assert_eq!(stall_of(pressure, "some"), Some(1234));
        assert_eq!(stall_of(pressure, "full"), Some(567));
        assert_eq!(stall_of("", "some"), None);
    }

    #[test]
    fn a_region_takes_a_touch_of_each_of_its_pages() {
        let page = page_size();
        let region = Region::map(8, page).expect("a mapping");
        region.touch(0, 100);
        // SAFETY: the page is inside the mapping
        assert_eq!(unsafe { std::ptr::read_volatile(region.base.add((7 * page) as usize)) }, 1);
    }

    #[test]
    fn einval_of_the_advice_is_a_kernel_with_no_huge_pages_and_each_other_error_stays() {
        assert!(no_huge_pages(&std::io::Error::from_raw_os_error(libc::EINVAL)));
        assert!(!no_huge_pages(&std::io::Error::from_raw_os_error(libc::ENOMEM)));
        assert!(!no_huge_pages(&std::io::Error::from_raw_os_error(libc::EPERM)));
        assert!(!no_huge_pages(&std::io::Error::other("no code")));
    }
}
