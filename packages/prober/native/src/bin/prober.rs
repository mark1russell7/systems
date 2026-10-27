//! prober [--object PATH] NETNS... | prober --decode FILE
//!
//! The collector for the prober's kernel source. It loads `prober.bpf.o`, watches
//! the network namespaces given by their inode numbers, and prints every record the kernel writes
//! as one JSON line. Every second it also prints the clock track (CLOCK_TAI beside CLOCK_MONOTONIC)
//! and how many records the ring buffer had to drop, which must stay at zero.

use prober::record::{self, Ev};
use prober::{monotonic_ns, tai_ns};
use libbpf_rs::{MapCore, MapFlags, ObjectBuilder, RingBufferBuilder};
use serde_json::json;
use std::cell::RefCell;
use std::error::Error;
use std::ffi::CString;
use std::io::{BufWriter, Stdout, Write};
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

const OBJECT: &str = "/opt/harness/prober.bpf.o";
const TRACEFS: &str = "/sys/kernel/tracing";

/// Classic tracepoints (the connect and accept syscalls) attach through tracefs, which a
/// container does not mount. A privileged container can mount it for itself.
fn mount_tracefs() -> Result<(), Box<dyn Error>> {
    if Path::new(TRACEFS).join("events").exists() {
        return Ok(());
    }
    let (source, target) = (CString::new("tracefs")?, CString::new(TRACEFS)?);
    // SAFETY: every pointer is a NUL-terminated string that outlives the call. Data can be null
    let status = unsafe {
        libc::mount(source.as_ptr(), target.as_ptr(), source.as_ptr(), 0, std::ptr::null())
    };
    if status != 0 {
        return Err(format!("mount tracefs: {}", std::io::Error::last_os_error()).into());
    }
    Ok(())
}

fn line(out: &Rc<RefCell<BufWriter<Stdout>>>, value: &serde_json::Value) {
    let mut out = out.borrow_mut();
    let _ = serde_json::to_writer(&mut *out, value);
    let _ = out.write_all(b"\n");
}

/// A record's line, written by hand into a buffer the caller reuses, then out in one write.
fn record(out: &Rc<RefCell<BufWriter<Stdout>>>, ev: &Ev, buffer: &mut Vec<u8>) {
    buffer.clear();
    ev.append_line(buffer);
    buffer.push(b'\n');
    let _ = out.borrow_mut().write_all(buffer);
}

/// Prints the line for every record in a file of raw records, as the ring buffer gives them. This
/// is how the three collectors are held to one contract byte for byte.
fn decode_file(path: &str) -> Result<(), Box<dyn Error>> {
    let data = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
    let out = Rc::new(RefCell::new(BufWriter::with_capacity(1 << 16, std::io::stdout())));
    let mut buffer = Vec::with_capacity(1024);
    for chunk in data.chunks(record::SIZE) {
        match Ev::decode(chunk) {
            Ok(ev) => record(&out, &ev, &mut buffer),
            Err(why) => line(&out, &json!({ "ev": "undecodable", "why": why })),
        }
    }
    out.borrow_mut().flush()?;
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(at) = args.iter().position(|arg| arg == "--decode") {
        return decode_file(args.get(at + 1).ok_or("--decode needs a file")?);
    }
    let mut object = OBJECT.to_string();
    if let Some(at) = args.iter().position(|arg| arg == "--object") {
        object = args.get(at + 1).ok_or("--object needs a path")?.clone();
        args.drain(at..=at + 1);
    }
    let watched: Vec<u32> = args
        .iter()
        .map(|arg| arg.parse::<u32>().map_err(|_| format!("{arg} is not a netns inode")))
        .collect::<Result<_, _>>()?;
    if watched.is_empty() {
        return Err("name at least one network namespace to watch, by its inode".into());
    }

    mount_tracefs()?;
    let obj = ObjectBuilder::default().open_file(&object)?.load()?;
    let want = obj.maps().find(|map| map.name() == "want").ok_or("the object has no map want")?;
    for netns in &watched {
        want.update(&netns.to_ne_bytes(), &[1u8], MapFlags::ANY)?;
    }
    let mut links = Vec::new();
    for prog in obj.progs_mut() {
        let name = prog.name().to_string_lossy().into_owned();
        links.push(prog.attach().map_err(|error| format!("attach {name}: {error}"))?);
    }

    let out = Rc::new(RefCell::new(BufWriter::with_capacity(1 << 16, std::io::stdout())));
    let records = Rc::new(RefCell::new(0u64));
    let ring = obj.maps().find(|map| map.name() == "rb").ok_or("the object has no map rb")?;
    let mut builder = RingBufferBuilder::new();
    {
        let (out, records) = (Rc::clone(&out), Rc::clone(&records));
        let mut buffer = Vec::with_capacity(1024);
        builder.add(&ring, move |data: &[u8]| {
            match Ev::decode(data) {
                Ok(ev) => {
                    *records.borrow_mut() += 1;
                    record(&out, &ev, &mut buffer);
                }
                Err(why) => line(&out, &json!({ "ev": "undecodable", "why": why })),
            }
            0
        })?;
    }
    let ring = builder.build()?;
    let lost = obj.maps().find(|map| map.name() == "lost").ok_or("the object has no map lost")?;
    let dropped = || -> u64 {
        lost.lookup_percpu(&0u32.to_ne_bytes(), MapFlags::ANY)
            .ok()
            .flatten()
            .map(|cpus| {
                cpus.iter()
                    .filter_map(|bytes| bytes.get(..8))
                    .map(|bytes| u64::from_ne_bytes(bytes.try_into().unwrap_or([0; 8])))
                    .sum()
            })
            .unwrap_or(0)
    };

    line(
        &out,
        &json!({ "ev": "begin", "mono": monotonic_ns(), "tai": tai_ns(), "netns": watched, "programs": links.len() }),
    );
    out.borrow_mut().flush()?;
    let mut next = monotonic_ns() + 1_000_000_000;
    loop {
        // woken only when 256 KiB are waiting, so drain on every 20 ms tick as well
        ring.poll(Duration::from_millis(20))?;
        ring.consume()?;
        let now = monotonic_ns();
        if now >= next {
            let count = *records.borrow();
            line(
                &out,
                &json!({ "ev": "clock", "mono": now, "tai": tai_ns(), "records": count, "lost": dropped() }),
            );
            next += 1_000_000_000;
        }
        out.borrow_mut().flush()?;
    }
}

fn main() {
    if let Err(error) = run() {
        println!("{}", json!({ "ev": "fail", "mono": monotonic_ns(), "why": error.to_string() }));
        std::process::exit(1);
    }
}
