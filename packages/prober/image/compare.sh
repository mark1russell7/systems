#!/bin/sh
# compare.sh [LIGHT HEAVY THREADS ROUNDS]
#
# The prober's three collectors (Rust, Go, C) against one record contract. Run in the comparison
# image, privileged. It prints one JSON line, the summary:
#   - identity: each decodes the fixture of raw records to the Rust collector's bytes;
#   - throughput: each decodes and writes 639,000 raw records from a file, to /dev/null: the cost
#     of the user side alone, with no kernel and no workload in the way;
#   - together: all three watch one storm of LIGHT connections at once, each with its own copy of
#     the kernel program, and must print the same records, setting aside the instant each copy
#     stamped (mono, tai);
#   - alone: each watches a storm of HEAVY connections by itself, ROUNDS times, taking turns: the
#     records it printed, the records the ring buffer dropped, how fast the kernel produced them,
#     its CPU, its peak memory, and how long it took to start.
set -eu
cd /opt/prober
LIGHT=${1:-2000}
HEAVY=${2:-20000}
THREADS=${3:-8}
ROUNDS=${4:-3}
COLLECTORS="rust go c"
NS=$(stat -L -c %i /proc/self/ns/net)
work=/tmp/compare
rm -rf "$work"
mkdir -p "$work"

now_ms() { echo $(($(date +%s%N) / 1000000)); }
# a process's CPU so far, user and system, in clock ticks (100 a second)
ticks() { awk '{ print $14 + $15 }' "/proc/$1/stat"; }
last_clock() { jq -s "map(select(.ev == \"clock\")) | last | .$2" "$work/$1.jsonl"; }

# start NAME: runs a collector as this shell's child and waits for its begin line; sets $pid, and
# $startup to how long that took in ms
start() {
	t0=$(now_ms)
	"/opt/prober/prober-$1" "$NS" >"$work/$1.jsonl" 2>"$work/$1.err" &
	pid=$!
	until grep -q '"ev":"begin"' "$work/$1.jsonl" 2>/dev/null; do
		if grep -q '"ev":"fail"' "$work/$1.jsonl" 2>/dev/null || ! kill -0 "$pid" 2>/dev/null; then
			echo "{\"failed\":\"$1\",\"why\":$(cat "$work/$1.jsonl" "$work/$1.err" | jq -Rs .)}"
			exit 1
		fi
		sleep 0.01
	done
	startup=$(($(now_ms) - t0))
}
stop() {
	kill "$1" 2>/dev/null || true
	wait "$1" 2>/dev/null || true
}

# 1. identity: the fixture, decoded by each
for c in $COLLECTORS; do "./prober-$c" --decode records.bin >"$work/decode-$c.jsonl"; done
identity=$(jq -n --argjson lines "$(wc -l <"$work/decode-rust.jsonl")" \
	--argjson go "$(cmp -s "$work/decode-rust.jsonl" "$work/decode-go.jsonl" && echo true || echo false)" \
	--argjson c "$(cmp -s "$work/decode-rust.jsonl" "$work/decode-c.jsonl" && echo true || echo false)" \
	'{lines: $lines, go: $go, c: $c}')

# 2. throughput: the fixture's whole records, doubled 14 times, decoded and written by each
head -c $((39 * 184)) records.bin >"$work/big.bin"
for _ in $(seq 14); do cat "$work/big.bin" "$work/big.bin" >"$work/twice.bin" && mv "$work/twice.bin" "$work/big.bin"; done
big=$(($(stat -c %s "$work/big.bin") / 184))
throughput="{}"
for c in $COLLECTORS; do
	t0=$(date +%s%N)
	"./prober-$c" --decode "$work/big.bin" >/dev/null
	ns=$(($(date +%s%N) - t0))
	throughput=$(echo "$throughput" | jq -c --arg c "$c" --argjson records "$big" --argjson ns "$ns" \
		'. + {($c): {records: $records, time: {value: ($ns / 1000000), unit: "ms"}, per_second: ($records * 1000000000 / $ns | floor)}}')
done
rm -f "$work/big.bin"

# 3. together: one light storm, all three at once
pids=""
for c in $COLLECTORS; do
	start "$c"
	pids="$pids $pid"
done
./storm "$LIGHT" "$THREADS" >"$work/storm-together.json"
sleep 2 # two clock ticks: every collector has drained and counted
for pid in $pids; do stop "$pid"; done
for c in $COLLECTORS; do
	jq -c 'select(.ev != "begin" and .ev != "clock") | del(.mono, .tai)' "$work/$c.jsonl" | sort >"$work/$c.norm"
done
differ() { diff "$work/rust.norm" "$work/$1.norm" | grep -c '^[-+][^-+]' || true; }
together=$(jq -n \
	--argjson storm "$(cat "$work/storm-together.json")" \
	--argjson rust "$(wc -l <"$work/rust.norm")" --argjson go "$(wc -l <"$work/go.norm")" --argjson c "$(wc -l <"$work/c.norm")" \
	--argjson go_differ "$(differ go)" --argjson c_differ "$(differ c)" \
	--argjson lost_rust "$(last_clock rust lost)" --argjson lost_go "$(last_clock go lost)" --argjson lost_c "$(last_clock c lost)" \
	--argjson kinds "$(jq -s 'map(.ev) | unique' "$work/rust.norm")" \
	'{storm: $storm, records: {rust: $rust, go: $go, c: $c}, lines_differing_from_rust: {go: $go_differ, c: $c_differ},
	  lost: {rust: $lost_rust, go: $lost_go, c: $lost_c}, kinds: $kinds}')

# 4. alone: a heavy storm each, ROUNDS times, taking turns so that no collector always runs first
alone="[]"
for round in $(seq "$ROUNDS"); do
	for c in $COLLECTORS; do
		start "$c"
		before=$(ticks "$pid")
		./storm "$HEAVY" "$THREADS" >"$work/storm-$c.json"
		sleep 2
		after=$(ticks "$pid")
		peak=$(awk '/^VmHWM:/ { print $2 }' "/proc/$pid/status")
		stop "$pid"
		alone=$(echo "$alone" | jq -c \
			--arg collector "$c" --argjson round "$round" \
			--argjson storm "$(cat "$work/storm-$c.json")" \
			--argjson records "$(last_clock "$c" records)" --argjson lost "$(last_clock "$c" lost)" \
			--argjson cpu "$(((after - before) * 10))" --argjson peak "$((peak * 1024))" --argjson startup "$startup" \
			'. + [{collector: $collector, round: $round, storm: $storm, records: $records, lost: $lost,
			       # a collector that wrote no clock line before it was stopped says nothing: null
			       produced_per_second: (if ($records | type) == "number" and ($lost | type) == "number"
			         then (($records + $lost) * 1000000000 / $storm.ns | floor) else null end),
			       cpu: {value: $cpu, unit: "ms"}, peak_memory: {value: $peak, unit: "B"},
			       startup: {value: $startup, unit: "ms"}}]')
	done
done

binaries=$(jq -n --argjson rust "$(stat -c %s prober-rust)" --argjson go "$(stat -c %s prober-go)" \
	--argjson c "$(stat -c %s prober-c)" \
	'{rust: {value: $rust, unit: "B"}, go: {value: $go, unit: "B"}, c: {value: $c, unit: "B"}}')
build=$(jq -n --argjson rust "$(cat build-rust.seconds)" --argjson go "$(cat build-go.seconds)" \
	--argjson c "$(cat build-c.seconds)" \
	'{rust: {value: $rust, unit: "s"}, go: {value: $go, unit: "s"}, c: {value: $c, unit: "s"}}')
jq -nc --argjson identity "$identity" --argjson throughput "$throughput" --argjson together "$together" \
	--argjson alone "$alone" --argjson binaries "$binaries" --argjson build "$build" \
	--arg kernel "$(uname -r)" --argjson cpus "$(nproc)" \
	'{kernel: $kernel, cpus: $cpus, identity: $identity, throughput: $throughput, together: $together,
	  alone: $alone, binaries: $binaries, build: $build}'
