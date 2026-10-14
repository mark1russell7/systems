# The harness's own image: the prober, the cell client, the injector and the namespace admin all
# run from it. A target's image stays stock. Both stages are pinned by digest,
# the crates by Cargo.lock, and the packages apk installs are recorded in each run's manifest.
# lab.ts stages the build context: the prober's and the harness's native sources, and the prober's
# identity fixture, each under its package's name.

# --- build: the prober's kernel program in C (CO-RE), the user side in Rust --------------------
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS build
RUN apk add --no-cache clang llvm bpftool libbpf-dev linux-headers \
      rust cargo build-base elfutils-dev zlib-dev zstd-dev pkgconf
WORKDIR /src
COPY prober/bpf/ prober/bpf/
# the kernel's own types, from the kernel the build runs on: the program relocates against them
RUN bpftool btf dump file /sys/kernel/btf/vmlinux format c > prober/bpf/vmlinux.h \
 && clang -O2 -g -target bpf -D__TARGET_ARCH_x86 -Iprober/bpf -c prober/bpf/prober.bpf.c -o prober.bpf.o
COPY prober/native/ prober/native/
# the record tests read the prober's identity fixture
COPY prober/fixtures/ prober/fixtures/
RUN cd prober/native && cargo build --release --locked --features collector \
 && cargo test --release --locked --features collector
COPY harness/image/native/ harness/image/native/
RUN cd harness/image/native && cargo build --release --locked && cargo test --release --locked

# --- run ------------------------------------------------------------------------------------------
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62
# tc for netem, ethtool for the offloads that decide whether netem acts on segments
RUN apk add --no-cache iproute2 iproute2-tc iptables ethtool libelf zlib zstd-libs libgcc
COPY --from=build /src/prober.bpf.o /src/prober/native/target/release/prober /opt/harness/
COPY --from=build /src/harness/image/native/target/release/client /src/harness/image/native/target/release/inject /opt/harness/
WORKDIR /opt/harness
CMD ["sleep", "infinity"]
