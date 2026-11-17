//! What the programs of the harness's native side share: their event lines, the arrivals of a
//! schedule and the counters of the network stack.

use prober::monotonic_ns;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::error::Error;

/// The counters of the network stack, each by its name, for example `Tcp.RetransSegs`,
/// `TcpExt.TCPACKSkippedTimeWait`, `Dev.eth0.rx_drop` or `Softnet.dropped`. The files of snmp,
/// netstat and dev are of the namespace of the caller. The file softnet_stat is of the host.
pub fn stack_counters() -> BTreeMap<String, u64> {
    let read = |path: &str| std::fs::read_to_string(path).unwrap_or_default();
    let mut counters = pairs_of(&read("/proc/net/snmp"));
    counters.extend(pairs_of(&read("/proc/net/netstat")));
    counters.extend(devices_of(&read("/proc/net/dev")));
    counters.extend(softnet_of(&read("/proc/net/softnet_stat")));
    counters
}

/// Reads the format of /proc/net/snmp and /proc/net/netstat: a line of names, then a line of values
/// with the same prefix. A value that is not a count, as the -1 of `Tcp.MaxConn`, is skipped.
pub fn pairs_of(text: &str) -> BTreeMap<String, u64> {
    let lines: Vec<&str> = text.lines().collect();
    let mut counters = BTreeMap::new();
    let mut at = 0;
    while at + 1 < lines.len() {
        let (Some((prefix, names)), Some((other, values))) = (lines[at].split_once(':'), lines[at + 1].split_once(':')) else {
            at += 1;
            continue;
        };
        if prefix != other || values.split_whitespace().next().is_some_and(|first| first.parse::<i64>().is_err()) {
            at += 1;
            continue;
        }
        for (name, value) in names.split_whitespace().zip(values.split_whitespace()) {
            if let Ok(value) = value.parse::<u64>() {
                counters.insert(format!("{prefix}.{name}"), value);
            }
        }
        at += 2;
    }
    counters
}

/// The columns of /proc/net/dev that the counters keep, by their place after the name of the device.
const DEVICE_COLUMNS: [(usize, &str); 6] =
    [(1, "rx_packets"), (2, "rx_errs"), (3, "rx_drop"), (9, "tx_packets"), (10, "tx_errs"), (11, "tx_drop")];

/// Reads /proc/net/dev: one line for each device, after two lines of headings.
pub fn devices_of(text: &str) -> BTreeMap<String, u64> {
    let mut counters = BTreeMap::new();
    for line in text.lines() {
        let Some((device, values)) = line.split_once(':') else { continue };
        let values: Vec<u64> = values.split_whitespace().filter_map(|value| value.parse().ok()).collect();
        if values.len() < 16 {
            continue;
        }
        for (column, name) in DEVICE_COLUMNS {
            counters.insert(format!("Dev.{}.{name}", device.trim()), values[column]);
        }
    }
    counters
}

/// Reads /proc/net/softnet_stat: one line of hexadecimal columns for each processor. The sums of the
/// first three columns are the packets processed, the packets dropped at a full backlog, and the
/// rounds that ended with work left.
pub fn softnet_of(text: &str) -> BTreeMap<String, u64> {
    let mut sums = [0u64; 3];
    for line in text.lines() {
        for (sum, value) in sums.iter_mut().zip(line.split_whitespace()) {
            *sum += u64::from_str_radix(value, 16).unwrap_or(0);
        }
    }
    if text.trim().is_empty() {
        return BTreeMap::new();
    }
    ["processed", "dropped", "squeezed"].iter().zip(sums).map(|(name, sum)| (format!("Softnet.{name}"), sum)).collect()
}

/// Prints one event line, with the time of the call on CLOCK_MONOTONIC.
pub fn emit(event: &str, fields: Value) {
    emit_at(event, monotonic_ns(), fields);
}

/// Prints one event line with the stamp `t`: a JSON object with `ev`, `t` and the fields.
pub fn emit_at(event: &str, t: u64, fields: Value) {
    let mut line = json!({ "ev": event, "t": t });
    if let (Some(line), Value::Object(fields)) = (line.as_object_mut(), fields) {
        line.extend(fields);
    }
    println!("{line}");
}

/// The arrivals of a schedule of the format rigor-schedule/1, each in ns from the start of the schedule.
pub fn arrivals_in(plan: &Value) -> Result<Vec<u64>, Box<dyn Error>> {
    if plan["format"] != "rigor-schedule/1" {
        return Err(format!("the schedule has the format {}, not rigor-schedule/1", plan["format"]).into());
    }
    let times = plan["times"].as_array().ok_or("the schedule has no list of times")?;
    times
        .iter()
        .map(|time| time.as_f64().map(|ms| (ms * 1e6) as u64).ok_or_else(|| Box::<dyn Error>::from(format!("{time} is not a time"))))
        .collect()
}

/// The arrivals of a file of the format rigor-schedule/1.
pub fn arrivals_of(text: &str) -> Result<Vec<u64>, Box<dyn Error>> {
    arrivals_in(&serde_json::from_str(text)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_schedule_gives_its_times_in_ns_and_refuses_another_format() {
        let plan = r#"{"format":"rigor-schedule/1","times":[0.5,10,20.25]}"#;
        assert_eq!(arrivals_of(plan).unwrap(), [500_000, 10_000_000, 20_250_000]);
        assert!(arrivals_of(r#"{"format":"other","times":[]}"#).is_err());
        assert!(arrivals_of(r#"{"format":"rigor-schedule/1"}"#).is_err());
        assert!(arrivals_of(r#"{"format":"rigor-schedule/1","times":["a"]}"#).is_err());
    }

    #[test]
    fn the_counters_of_snmp_and_netstat_come_by_prefix_and_name() {
        let snmp = "Ip: Forwarding DefaultTTL InDiscards\nIp: 1 64 3\n\
                    IcmpMsg: InType3\nIcmpMsg: 2\n\
                    Tcp: RtoAlgorithm MaxConn RetransSegs\nTcp: 1 -1 7\n";
        let counters = pairs_of(snmp);
        assert_eq!(counters["Ip.InDiscards"], 3);
        assert_eq!(counters["IcmpMsg.InType3"], 2);
        assert_eq!(counters["Tcp.RetransSegs"], 7);
        assert!(!counters.contains_key("Tcp.MaxConn"));
        let netstat = "TcpExt: TCPACKSkippedTimeWait TCPChallengeACK\nTcpExt: 4 0\nIpExt: InNoRoutes\nIpExt: 0\n";
        let counters = pairs_of(netstat);
        assert_eq!(counters["TcpExt.TCPACKSkippedTimeWait"], 4);
        assert_eq!(counters["IpExt.InNoRoutes"], 0);
        assert!(pairs_of("Tcp: RetransSegs\nUdp: InDatagrams\nUdp: 5\n").get("Tcp.RetransSegs").is_none());
    }

    #[test]
    fn the_counters_of_a_device_and_of_the_backlog_come_from_their_columns() {
        let dev = "Inter-|   Receive |  Transmit\n face |bytes packets errs drop|bytes\n\
                   eth0: 1000 10 1 2 0 0 0 0 2000 20 3 4 0 0 0 0\n";
        let counters = devices_of(dev);
        assert_eq!(counters["Dev.eth0.rx_packets"], 10);
        assert_eq!(counters["Dev.eth0.rx_errs"], 1);
        assert_eq!(counters["Dev.eth0.rx_drop"], 2);
        assert_eq!(counters["Dev.eth0.tx_packets"], 20);
        assert_eq!(counters["Dev.eth0.tx_errs"], 3);
        assert_eq!(counters["Dev.eth0.tx_drop"], 4);
        assert_eq!(counters.len(), 6);
        let softnet = "0000000a 00000001 00000002 00000000\n00000010 00000000 00000001 00000000\n";
        let counters = softnet_of(softnet);
        assert_eq!((counters["Softnet.processed"], counters["Softnet.dropped"], counters["Softnet.squeezed"]), (26, 1, 3));
        assert!(softnet_of("").is_empty());
    }
}
