//! The native side of the prober has these parts:
//! - The record contract: the C struct that the kernel source writes (`record`), and the JSON line
//!   that it becomes.
//! - The clock, the quantities and the errno names, which the tools of the harness share.
//! - With the `collector` feature, the `prober` binary, which loads `bpf/prober.bpf.c` and prints
//!   every record the kernel writes as one JSON line.
//!
//! Every instant printed is CLOCK_MONOTONIC in nanoseconds: eBPF stamps with that clock, and every
//! container on the VM shares it. Every amount is a quantity,
//! `{ "value": …, "unit": … }`, in @mark1russell7/quantity's canonical units.

pub mod record;

use serde::Serialize;

fn clock_ns(clock: libc::clockid_t) -> u64 {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: clock_gettime only writes the timespec it is handed, which lives on this stack
    let status = unsafe { libc::clock_gettime(clock, &mut now) };
    assert_eq!(status, 0, "clock_gettime({clock}) failed");
    now.tv_sec as u64 * 1_000_000_000 + now.tv_nsec as u64
}

/// CLOCK_MONOTONIC, the clock the kernel source stamps with.
pub fn monotonic_ns() -> u64 {
    clock_ns(libc::CLOCK_MONOTONIC)
}

/// CLOCK_TAI, for the clock track: REALTIME steps on this VM, TAI does not jump relative to it.
pub fn tai_ns() -> u64 {
    clock_ns(libc::CLOCK_TAI)
}

/// An amount and its canonical unit, as @mark1russell7/quantity writes one. Its keys are in byte
/// order, as serde_json writes any object it holds as a map.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Quantity {
    pub unit: &'static str,
    pub value: f64,
}

pub fn quantity(value: impl Into<f64>, unit: &'static str) -> Quantity {
    Quantity { value: value.into(), unit }
}

/// The name of an errno, as the harness's predictions name the error a detector raises.
pub fn errno_name(code: i32) -> String {
    match code {
        libc::ETIMEDOUT => "ETIMEDOUT".into(),
        libc::ECONNRESET => "ECONNRESET".into(),
        libc::ECONNREFUSED => "ECONNREFUSED".into(),
        libc::EHOSTUNREACH => "EHOSTUNREACH".into(),
        libc::ENETUNREACH => "ENETUNREACH".into(),
        libc::EPIPE => "EPIPE".into(),
        libc::ECONNABORTED => "ECONNABORTED".into(),
        other => format!("E{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_errors_a_detector_raises() {
        assert_eq!(errno_name(libc::ETIMEDOUT), "ETIMEDOUT");
        assert_eq!(errno_name(9999), "E9999");
    }

    #[test]
    fn reads_a_monotonic_clock_that_never_steps_back() {
        let first = monotonic_ns();
        assert!(monotonic_ns() >= first);
    }
}
