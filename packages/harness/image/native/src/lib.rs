//! What the programs of the harness's native side share: their event lines and the arrivals of a
//! schedule.

use prober::monotonic_ns;
use serde_json::{json, Value};
use std::error::Error;

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
}
