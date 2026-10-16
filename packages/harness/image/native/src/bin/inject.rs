//! inject ACTION ARGS... [--at NS]
//!
//! A cell's fault, applied inside the network namespace this sidecar shares with the target (or,
//! for the server's side, with the client), so the target's image stays stock. Each lands in one
//! commit, bracketed by CLOCK_MONOTONIC stamps taken in the VM: a docker exec from Windows lands
//! 190 ms late at the median, and the bracket does not care.
//!
//! The actions, each with its lift:
//!
//! - `blackhole PEER [--direction both|in|out]` / `clear PEER [--direction …]`: the peer's
//!   segments drop, in both directions or one. `in` drops what comes from the peer, `out` what
//!   goes to it: a simplex partition.
//! - `rst PEER` / `clear-rst PEER`: the peer's next segment is answered with a reset, so its next
//!   send fails at once. A REJECT resets only the sender of the matched segment: the target's
//!   process never hears of it.
//! - `reject PEER --code host|net|port|admin` / `clear-reject PEER --code …`: each segment from the
//!   peer is answered with that ICMP unreachable. On an established socket Linux keeps it as a
//!   soft error (tcp_v4_err) and goes on retransmitting.
//! - `mtu PEER --above N` / `clear-mtu PEER --above N`: each segment from the peer longer than N
//!   bytes drops, as a path MTU black hole does, in the namespace that receives it. It acts on
//!   segments only when the sender's TSO and GSO and the receiver's GRO are off (`offload`).
//! - `netem DEV SPEC…` / `clear-netem DEV`: tc netem on the device's egress, for example
//!   `netem eth0 delay 100ms 10ms` or `netem eth0 loss 5%`.
//! - `offload DEV on|off`: the device's TSO, GSO and GRO, so that netem and length matches act on
//!   segments rather than on GSO super-packets of up to 64 KB.
//! - `http METHOD ADDR:PORT PATH [BODY]`: one HTTP/1.1 request to an API in the VM, for example a
//!   toxic of Toxiproxy. The stamps bracket the request and its answer, after the connect, so the
//!   commit of the toxic is known on the same clock as the kernel's records.
//!
//! `--at NS` holds the commit until that instant on CLOCK_MONOTONIC, the clock every stamp is on.
//! A stall's end is timed that way, from inside the VM: the exec only has to arrive before it, and
//! its 190 ms never reach the stall's length.
//!
//! `--via DEV` puts a filter rule in the FORWARD chain, for a router: its INPUT and OUTPUT see only
//! what the router itself sends and receives. The rule faces one side by the device toward it:
//! what comes from the peer arrives on DEV (`-i DEV -s PEER`), and what goes to it leaves on DEV
//! (`-o DEV -d PEER`). A REJECT then answers from the router: a reset spoofs the address the
//! segment was going to, and an ICMP error comes from the router's own address on DEV.

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

/// The options after the positional arguments: `--at NS`, `--direction D`, `--code C`, `--above N`,
/// `--via DEV`.
#[derive(Default)]
struct Options {
    at: Option<u64>,
    direction: Option<String>,
    code: Option<String>,
    above: Option<u32>,
    via: Option<String>,
}

fn options(args: &[String]) -> Result<Options, Box<dyn Error>> {
    let mut out = Options::default();
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        let value = rest.next().ok_or_else(|| format!("{flag} takes a value"))?;
        match flag.as_str() {
            "--at" => out.at = Some(value.parse()?),
            "--direction" => out.direction = Some(value.clone()),
            "--code" => out.code = Some(value.clone()),
            "--above" => out.above = Some(value.parse()?),
            "--via" => out.via = Some(device(value)?.to_string()),
            other => return Err(format!("unknown option {other}").into()),
        }
    }
    Ok(out)
}

/// The iptables rules of an action that is a filter rule, or None for an action that is not.
fn rules(action: &str, peer: Ipv4Addr, opts: &Options) -> Result<String, Box<dyn Error>> {
    let op = |set: &str| if action == set { "-I" } else { "-D" };
    // what comes from the peer, and what goes to it: at an end, the INPUT and OUTPUT of its own
    // sockets; at a router, what it forwards in and out of the device toward the peer
    let (from, to) = match opts.via.as_deref() {
        None => (format!("INPUT -s {peer}/32"), format!("OUTPUT -d {peer}/32")),
        Some(dev) => (format!("FORWARD -i {dev} -s {peer}/32"), format!("FORWARD -o {dev} -d {peer}/32")),
    };
    Ok(match action {
        "blackhole" | "clear" => {
            let op = op("blackhole");
            let direction = opts.direction.as_deref().unwrap_or("both");
            let input = format!("{op} {from} -j DROP\n");
            let output = format!("{op} {to} -j DROP\n");
            match direction {
                "both" => format!("{input}{output}"),
                "in" => input,
                "out" => output,
                other => return Err(format!("unknown direction {other}").into()),
            }
        }
        "rst" | "clear-rst" => {
            let op = op("rst");
            format!("{op} {from} -p tcp -j REJECT --reject-with tcp-reset\n")
        }
        "reject" | "clear-reject" => {
            let op = op("reject");
            let with = match opts.code.as_deref().ok_or("--code host|net|port|admin")? {
                "host" => "icmp-host-unreachable",
                "net" => "icmp-net-unreachable",
                "port" => "icmp-port-unreachable",
                "admin" => "icmp-admin-prohibited",
                other => return Err(format!("unknown code {other}").into()),
            };
            format!("{op} {from} -p tcp -j REJECT --reject-with {with}\n")
        }
        // the long segments drop where they arrive: in the sender's own namespace, an OUTPUT drop
        // would fail its sends with EPERM rather than lose them on the way
        "mtu" | "clear-mtu" => {
            let op = op("mtu");
            let above = opts.above.ok_or("--above N")?;
            format!("{op} {from} -p tcp -m length --length {}:65535 -j DROP\n", above + 1)
        }
        other => return Err(format!("unknown action {other}").into()),
    })
}

/// a token of a netem specification: a word, or a number with an optional unit
fn netem_token(token: &str) -> bool {
    let word = !token.is_empty() && token.chars().all(|c| c.is_ascii_lowercase());
    let number = token
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '%')
        .parse::<f64>()
        .is_ok()
        && token
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.')
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '%');
    word || number
}

/// a device name: letters, digits, dots, dashes
fn device(name: &str) -> Result<&str, Box<dyn Error>> {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        Ok(name)
    } else {
        Err(format!("not a device: {name}").into())
    }
}

/// runs a command and fails with its stderr when it fails
fn command(program: &str, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let out = Command::new(program).args(args).output()?;
    if !out.status.success() {
        return Err(format!(
            "{program} {} exited {}: {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )
        .into());
    }
    Ok(())
}

/// an HTTP path: a slash, then letters, digits and `/ - _ .` only
fn http_path(path: &str) -> Result<&str, Box<dyn Error>> {
    if path.starts_with('/')
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        Ok(path)
    } else {
        Err(format!("not an HTTP path: {path}").into())
    }
}

/// the head of one HTTP/1.1 request, with its body
fn http_request(method: &str, host: &str, path: &str, body: &str) -> Result<String, Box<dyn Error>> {
    if !matches!(method, "GET" | "POST" | "DELETE") {
        return Err(format!("not a method: {method}").into());
    }
    Ok(format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ))
}

/// one request to an API: the status, and the stamps around the request and its answer
fn http(args: &[String]) -> Result<(), Box<dyn Error>> {
    use std::io::Read;
    use std::net::{SocketAddrV4, TcpStream};
    let method = args.get(1).ok_or("http METHOD ADDR:PORT PATH [BODY]")?.as_str();
    let addr: SocketAddrV4 = args.get(2).ok_or("and the address and port")?.parse()?;
    let path = http_path(args.get(3).ok_or("and the path")?)?;
    let body = args.get(4).map_or("", String::as_str);
    let request = http_request(method, &addr.to_string(), path, body)?;
    let mut stream = TcpStream::connect(addr)?;
    let t0 = monotonic_ns();
    stream.write_all(request.as_bytes())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer)?;
    let t1 = monotonic_ns();
    let text = String::from_utf8_lossy(&answer);
    let status: u16 = text
        .split_whitespace()
        .nth(1)
        .ok_or("no status in the answer")?
        .parse()?;
    if !(200..300).contains(&status) {
        let detail = text.split("\r\n\r\n").nth(1).unwrap_or("").trim();
        return Err(format!("{method} {path} answered {status}: {detail}").into());
    }
    println!("{}", json!({ "action": "http", "method": method, "path": path, "status": status, "t0": t0, "t1": t1 }));
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = args.first().ok_or("say an action: blackhole, clear, rst, reject, mtu, netem, offload, http …")?.as_str();
    if action == "http" {
        return http(&args);
    }
    match action {
        "netem" | "clear-netem" | "offload" => {
            let dev = device(args.get(1).ok_or("and a device")?)?;
            let rest: Vec<&str> = args[2..].iter().map(String::as_str).collect();
            let (spec, at) = match rest.iter().position(|token| *token == "--at") {
                Some(index) => (
                    rest[..index].to_vec(),
                    Some(rest.get(index + 1).ok_or("--at takes an instant in ns")?.parse::<u64>()?),
                ),
                None => (rest, None),
            };
            if let Some(at) = at {
                until(at)?;
            }
            let t0 = monotonic_ns();
            match action {
                "netem" => {
                    if spec.is_empty() || !spec.iter().all(|token| netem_token(token)) {
                        return Err(format!("not a netem specification: {}", spec.join(" ")).into());
                    }
                    let mut tc = vec!["qdisc", "replace", "dev", dev, "root", "netem"];
                    tc.extend(spec.iter().copied());
                    command("tc", &tc)?;
                }
                "clear-netem" => command("tc", &["qdisc", "del", "dev", dev, "root"])?,
                _ => {
                    let state = match spec.as_slice() {
                        ["on"] => "on",
                        ["off"] => "off",
                        _ => return Err("offload takes on or off".into()),
                    };
                    command("ethtool", &["-K", dev, "tso", state, "gso", state, "gro", state])?;
                }
            }
            let t1 = monotonic_ns();
            println!("{}", json!({ "action": action, "device": dev, "spec": spec, "t0": t0, "t1": t1 }));
            Ok(())
        }
        _ => {
            // parsed, never pasted: only an address reaches the rules
            let peer: Ipv4Addr = args.get(1).ok_or("and the peer's address")?.parse()?;
            let opts = options(&args[2..])?;
            let script = format!("*filter\n{}COMMIT\n", rules(action, peer, &opts)?);
            if let Some(at) = opts.at {
                until(at)?;
            }
            let t0 = monotonic_ns();
            let mut child =
                Command::new("iptables-restore").arg("--noflush").stdin(Stdio::piped()).spawn()?;
            child.stdin.take().ok_or("iptables-restore took no stdin")?.write_all(script.as_bytes())?;
            let status = child.wait()?;
            let t1 = monotonic_ns();
            if !status.success() {
                return Err(format!("iptables-restore exited {status}").into());
            }
            println!("{}", json!({ "action": action, "peer": peer.to_string(), "t0": t0, "t1": t1 }));
            Ok(())
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("inject: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netem_specifications_are_words_and_numbers_with_units() {
        for token in ["delay", "100ms", "10ms", "loss", "5%", "25.5%", "distribution", "normal", "1"] {
            assert!(netem_token(token), "{token}");
        }
        for token in ["", ";", "100ms;rm", "$(x)", "-1", "a b"] {
            assert!(!netem_token(token), "{token}");
        }
    }

    #[test]
    fn rules_cover_each_direction_code_and_length() {
        let peer: Ipv4Addr = "10.0.0.2".parse().unwrap();
        let with = |direction: &str| Options { direction: Some(direction.into()), ..Options::default() };
        assert_eq!(rules("blackhole", peer, &with("in")).unwrap(), "-I INPUT -s 10.0.0.2/32 -j DROP\n");
        assert_eq!(rules("clear", peer, &with("out")).unwrap(), "-D OUTPUT -d 10.0.0.2/32 -j DROP\n");
        let code = Options { code: Some("net".into()), ..Options::default() };
        assert!(rules("reject", peer, &code).unwrap().contains("icmp-net-unreachable"));
        let above = Options { above: Some(1200), ..Options::default() };
        assert_eq!(
            rules("mtu", peer, &above).unwrap(),
            "-I INPUT -s 10.0.0.2/32 -p tcp -m length --length 1201:65535 -j DROP\n"
        );
        assert!(rules("reject", peer, &Options::default()).is_err());
    }

    #[test]
    fn a_router_gets_forward_rules_that_face_one_device() {
        let peer: Ipv4Addr = "10.0.0.2".parse().unwrap();
        let via = |direction: Option<&str>| Options {
            direction: direction.map(Into::into),
            via: Some("eth0".into()),
            ..Options::default()
        };
        assert_eq!(
            rules("blackhole", peer, &via(None)).unwrap(),
            "-I FORWARD -i eth0 -s 10.0.0.2/32 -j DROP\n-I FORWARD -o eth0 -d 10.0.0.2/32 -j DROP\n"
        );
        assert_eq!(rules("clear", peer, &via(Some("out"))).unwrap(), "-D FORWARD -o eth0 -d 10.0.0.2/32 -j DROP\n");
        assert_eq!(
            rules("rst", peer, &via(None)).unwrap(),
            "-I FORWARD -i eth0 -s 10.0.0.2/32 -p tcp -j REJECT --reject-with tcp-reset\n"
        );
        let host = Options { code: Some("host".into()), ..via(None) };
        assert_eq!(
            rules("clear-reject", peer, &host).unwrap(),
            "-D FORWARD -i eth0 -s 10.0.0.2/32 -p tcp -j REJECT --reject-with icmp-host-unreachable\n"
        );
        // a device name is letters, digits, dots and dashes: nothing else reaches the rules
        assert!(options(&["--via".into(), "eth0;x".into()]).is_err());
        assert_eq!(options(&["--via".into(), "eth1".into()]).unwrap().via.as_deref(), Some("eth1"));
    }

    #[test]
    fn http_requests_take_only_a_method_a_path_and_a_length() {
        assert!(http_path("/proxies/redis/toxics").is_ok());
        for path in ["proxies", "/a b", "/a;b", "/a?b=1", "/$(x)"] {
            assert!(http_path(path).is_err(), "{path}");
        }
        let request = http_request("POST", "10.0.0.3:8474", "/proxies/redis/toxics", "{}").unwrap();
        assert!(request.starts_with("POST /proxies/redis/toxics HTTP/1.1\r\n"));
        assert!(request.contains("Content-Length: 2\r\n"));
        assert!(request.ends_with("\r\n\r\n{}"));
        assert!(http_request("PUT", "h", "/", "").is_err());
    }
}
