# The prober's comparison image: one kernel program and three collectors for it, in Rust, Go and C,
# held to one record contract (packages/prober/README.md). Each collector builds in a stage of its
# own, timed, from what that language needs alone; the last stage decodes one fixture of raw
# records with all three and refuses to exist unless every line is the same, byte for byte. Then
# image/compare.sh runs the three live (privileged). The build context is packages/prober.

# --- the kernel program, compiled against the running kernel's BTF ------------------------------
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS bpf
RUN apk add --no-cache clang llvm bpftool libbpf-dev linux-headers
WORKDIR /src
COPY bpf/ bpf/
RUN bpftool btf dump file /sys/kernel/btf/vmlinux format c > bpf/vmlinux.h \
 && clang -O2 -g -target bpf -D__TARGET_ARCH_x86 -Ibpf -c bpf/prober.bpf.c -o prober.bpf.o

# --- Rust, on libbpf-rs (the collector the harness runs) ----------------------------------------
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS rust
RUN apk add --no-cache rust cargo build-base elfutils-dev zlib-dev zstd-dev pkgconf linux-headers
WORKDIR /src/native
COPY native/ ./
# the record tests read the identity fixture
COPY fixtures/ /src/fixtures/
RUN s=$(date +%s) \
 && cargo build --release --locked --features collector \
 && echo $(($(date +%s) - s)) > /build.seconds \
 && cargo test --release --locked --features collector

# --- Go, on cilium/ebpf: no cgo, one static binary ----------------------------------------------
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS go
RUN apk add --no-cache go
WORKDIR /src/go
COPY go/ ./
RUN go mod download && go mod verify
RUN s=$(date +%s) \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /prober-go . \
 && echo $(($(date +%s) - s)) > /build.seconds \
 && go vet ./... && test -z "$(gofmt -l .)"

# --- C, on libbpf, and the workload ---------------------------------------------------------------
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS c
RUN apk add --no-cache build-base libbpf-dev elfutils-dev zlib-dev linux-headers
WORKDIR /src/c
COPY c/ ./
RUN s=$(date +%s) \
 && cc -O2 -Wall -Wextra -Werror -o /prober-c prober.c -lbpf \
 && echo $(($(date +%s) - s)) > /build.seconds \
 && cc -O2 -Wall -Wextra -Werror -pthread -o /storm storm.c

# --- run: the three, the fixture, and the comparison -----------------------------------------------
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62
RUN apk add --no-cache libbpf libelf zlib zstd-libs libgcc jq coreutils diffutils
WORKDIR /opt/prober
COPY --from=bpf /src/prober.bpf.o /opt/harness/prober.bpf.o
COPY --from=rust /src/native/target/release/prober prober-rust
COPY --from=rust /build.seconds build-rust.seconds
COPY --from=go /prober-go prober-go
COPY --from=go /build.seconds build-go.seconds
COPY --from=c /prober-c /storm ./
COPY --from=c /build.seconds build-c.seconds
COPY fixtures/records.bin image/compare.sh ./
# the contract, byte for byte: no image unless all three decode the fixture to the same lines
RUN for c in rust go c; do ./prober-$c --decode records.bin > decode-$c.jsonl; done \
 && diff decode-rust.jsonl decode-go.jsonl && diff decode-rust.jsonl decode-c.jsonl \
 && test "$(wc -l < decode-rust.jsonl)" -gt 0
CMD ["sh", "/opt/prober/compare.sh"]
