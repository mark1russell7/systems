// prober-go [--object PATH] NETNS... | prober-go --decode FILE
//
// The collector for the prober's kernel source, in Go on cilium/ebpf. It does what the Rust
// collector does, line for line: loads prober.bpf.o, watches the network namespaces given by
// inode, prints each record as one JSON line, and every second the clock track and how many
// records the ring buffer dropped. With --decode it reads raw records from a file instead, which
// is how the three collectors are held to one contract byte for byte.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"
	"golang.org/x/sys/unix"
)

const (
	defaultObject = "/opt/harness/prober.bpf.o"
	tracefs       = "/sys/kernel/tracing"
)

func clockNs(clock int32) uint64 {
	var ts unix.Timespec
	if err := unix.ClockGettime(clock, &ts); err != nil {
		panic(err)
	}
	return uint64(ts.Sec)*1_000_000_000 + uint64(ts.Nsec)
}

func monotonicNs() uint64 { return clockNs(unix.CLOCK_MONOTONIC) }
func taiNs() uint64       { return clockNs(unix.CLOCK_TAI) }

// mountTracefs mounts tracefs for the syscall tracepoints, which a container lacks.
func mountTracefs() error {
	if _, err := os.Stat(tracefs + "/events"); err == nil {
		return nil
	}
	if err := unix.Mount("tracefs", tracefs, "tracefs", 0, ""); err != nil {
		return fmt.Errorf("mount tracefs: %w", err)
	}
	return nil
}

// attach attaches every program by its section: a classic tracepoint through tracefs, a BTF
// tracepoint or an fentry through a tracing link.
func attach(spec *ebpf.CollectionSpec, coll *ebpf.Collection) ([]link.Link, error) {
	names := make([]string, 0, len(spec.Programs))
	for name := range spec.Programs {
		names = append(names, name)
	}
	sort.Strings(names)
	var links []link.Link
	for _, name := range names {
		section, prog := spec.Programs[name].SectionName, coll.Programs[name]
		var l link.Link
		var err error
		switch {
		case strings.HasPrefix(section, "tracepoint/"):
			group, event, _ := strings.Cut(strings.TrimPrefix(section, "tracepoint/"), "/")
			l, err = link.Tracepoint(group, event, prog, nil)
		case strings.HasPrefix(section, "tp_btf/"), strings.HasPrefix(section, "fentry/"):
			l, err = link.AttachTracing(link.TracingOptions{Program: prog})
		default:
			err = fmt.Errorf("no way to attach section %s", section)
		}
		if err != nil {
			return links, fmt.Errorf("attach %s: %w", name, err)
		}
		links = append(links, l)
	}
	return links, nil
}

// decodeFile prints the line for every record in a file of raw records.
func decodeFile(path string, out *bufio.Writer) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var line []byte
	for at := 0; at < len(data); at += Size {
		end := min(at+Size, len(data))
		if e, err := decode(data[at:end]); err != nil {
			out.WriteString(undecodable(err))
		} else {
			line = e.appendLine(line[:0])
			out.Write(line)
		}
		out.WriteByte('\n')
	}
	return out.Flush()
}

func run(args []string, out *bufio.Writer) error {
	objectPath := defaultObject
	var watched []uint32
	for at := 0; at < len(args); at++ {
		switch args[at] {
		case "--decode":
			if at+1 >= len(args) {
				return errors.New("--decode needs a file")
			}
			return decodeFile(args[at+1], out)
		case "--object":
			if at+1 >= len(args) {
				return errors.New("--object needs a path")
			}
			objectPath = args[at+1]
			at++
		default:
			netns, err := strconv.ParseUint(args[at], 10, 32)
			if err != nil {
				return fmt.Errorf("%s is not a netns inode", args[at])
			}
			watched = append(watched, uint32(netns))
		}
	}
	if len(watched) == 0 {
		return errors.New("name at least one network namespace to watch, by its inode")
	}

	if err := mountTracefs(); err != nil {
		return err
	}
	if err := rlimit.RemoveMemlock(); err != nil {
		return err
	}
	spec, err := ebpf.LoadCollectionSpec(objectPath)
	if err != nil {
		return err
	}
	coll, err := ebpf.NewCollection(spec)
	if err != nil {
		return err
	}
	defer coll.Close()
	for _, netns := range watched {
		if err := coll.Maps["want"].Update(netns, uint8(1), ebpf.UpdateAny); err != nil {
			return err
		}
	}
	links, err := attach(spec, coll)
	for _, l := range links {
		defer l.Close()
	}
	if err != nil {
		return err
	}
	reader, err := ringbuf.NewReader(coll.Maps["rb"])
	if err != nil {
		return err
	}
	defer reader.Close()
	dropped := func() uint64 {
		var perCPU []uint64
		if err := coll.Maps["lost"].Lookup(uint32(0), &perCPU); err != nil {
			return 0
		}
		var sum uint64
		for _, n := range perCPU {
			sum += n
		}
		return sum
	}

	netns := make([]string, len(watched))
	for k, n := range watched {
		netns[k] = u(uint64(n))
	}
	var begin object
	begin.set("ev", jsonString("begin"))
	begin.set("mono", u(monotonicNs()))
	begin.set("tai", u(taiNs()))
	begin.set("netns", "["+strings.Join(netns, ",")+"]")
	begin.set("programs", strconv.Itoa(len(links)))
	out.WriteString(begin.String() + "\n")
	if err := out.Flush(); err != nil {
		return err
	}

	var records uint64
	var record ringbuf.Record
	var line []byte
	next := monotonicNs() + 1_000_000_000
	for {
		// drain what is waiting, then flush and look at the clock at least every 20 ms
		reader.SetDeadline(time.Now().Add(20 * time.Millisecond))
		for {
			if err := reader.ReadInto(&record); err != nil {
				if errors.Is(err, os.ErrDeadlineExceeded) {
					break
				}
				return err
			}
			// the count is of records decoded, as the Rust collector keeps it
			if e, err := decode(record.RawSample); err != nil {
				out.WriteString(undecodable(err))
			} else {
				records++
				line = e.appendLine(line[:0])
				out.Write(line)
			}
			out.WriteByte('\n')
			if records%1024 == 0 && monotonicNs() >= next {
				break
			}
		}
		if now := monotonicNs(); now >= next {
			var clock object
			clock.set("ev", jsonString("clock"))
			clock.set("mono", u(now))
			clock.set("tai", u(taiNs()))
			clock.set("records", u(records))
			clock.set("lost", u(dropped()))
			out.WriteString(clock.String() + "\n")
			next += 1_000_000_000
		}
		if err := out.Flush(); err != nil {
			return err
		}
	}
}

func main() {
	out := bufio.NewWriterSize(os.Stdout, 1<<16)
	if err := run(os.Args[1:], out); err != nil {
		var fail object
		fail.set("ev", jsonString("fail"))
		fail.set("mono", u(monotonicNs()))
		fail.set("why", jsonString(err.Error()))
		out.WriteString(fail.String() + "\n")
		out.Flush()
		os.Exit(1)
	}
}
