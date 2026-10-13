//! inject blackhole PEER | inject clear PEER [--at NS] | inject rst PEER | inject clear-rst PEER
//!
//! A cell's fault, applied inside the network namespace this sidecar shares with the target, so
//! the target's image stays stock. Each lands in one iptables-restore commit,
//! bracketed by CLOCK_MONOTONIC stamps taken in the VM: a docker exec from Windows lands 190 ms late
//! at the median, and the bracket does not care.
//!
//! - blackhole: both directions drop, so nothing comes back;
//! - rst: the peer's next segment is answered with a reset, so its next send fails at once. A
//!   REJECT resets only the sender of the matched segment: the target's process
//!   never hears of it.
//!
//! `--at NS` holds the commit until that instant on CLOCK_MONOTONIC, the clock every stamp is on.
//! A stall's end is timed that way, from inside the VM: the exec only has to arrive before it, and
//! its 190 ms never reach the stall's length.

use prober::monotonic_ns;
use serde_json::json;
use std::error::Error;
use std::io::Write;
use std::net::Ipv4Addr;
use std::process::{Command, Stdio};

/// sleeps until an instant on CLOCK_MONOTONIC, or returns at once if it has passed
fn until(at: u64) -> Result<(), Box<dyn Error>> {
    let deadline = libc::timespec {
        // the fields' own types: musl is moving time_t to 64 bits
        tv_sec: (at / 1_000_000_000) as _,
        tv_nsec: (at % 1_000_000_000) as _,
    };
    loop {
        // SAFETY: a valid timespec, and no remainder is asked for with an absolute time
        let code = unsafe {
            libc::clock_nanosleep(
                libc::CLOCK_MONOTONIC,
                libc::TIMER_ABSTIME,
                &deadline,
                std::ptr::null_mut(),
            )
        };
        match code {
            0 => return Ok(()),
            libc::EINTR => continue,
            other => return Err(format!("clock_nanosleep failed: {other}").into()),
        }
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = args.first().ok_or("say blackhole, clear, rst or clear-rst")?.as_str();
    // parsed, never pasted: only an address reaches the rules
    let peer: Ipv4Addr = args.get(1).ok_or("and the peer's address")?.parse()?;
    let at: Option<u64> = match args.get(2).map(String::as_str) {
        None => None,
        Some("--at") => Some(args.get(3).ok_or("--at takes an instant in ns")?.parse()?),
        Some(other) => return Err(format!("unknown option {other}").into()),
    };
    let rules = match action {
        "blackhole" | "clear" => {
            let op = if action == "blackhole" { "-I" } else { "-D" };
            format!("{op} INPUT -s {peer}/32 -j DROP\n{op} OUTPUT -d {peer}/32 -j DROP\n")
        }
        "rst" | "clear-rst" => {
            let op = if action == "rst" { "-I" } else { "-D" };
            format!("{op} INPUT -s {peer}/32 -p tcp -j REJECT --reject-with tcp-reset\n")
        }
        other => return Err(format!("unknown action {other}").into()),
    };
    let script = format!("*filter\n{rules}COMMIT\n");
    if let Some(at) = at {
        until(at)?;
    }
    let t0 = monotonic_ns();
    let mut child = Command::new("iptables-restore").arg("--noflush").stdin(Stdio::piped()).spawn()?;
    child.stdin.take().ok_or("iptables-restore took no stdin")?.write_all(script.as_bytes())?;
    let status = child.wait()?;
    let t1 = monotonic_ns();
    if !status.success() {
        return Err(format!("iptables-restore exited {status}").into());
    }
    println!("{}", json!({ "action": action, "peer": peer.to_string(), "t0": t0, "t1": t1 }));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("inject: {error}");
        std::process::exit(1);
    }
}
