#!/usr/bin/env bash
# The VM tier of layer E4 (SYS-81, docs/S7.md). QEMU boots a pinned kernel with no boot loader, thus
# the kernel of a guest is independent of the runner. Each command takes the working folder first.
#
#   vm.sh kernel <folder> <version> <sha256> <hz>   builds bzImage and its configuration
#   vm.sh root <folder>                             builds the disk from the Dockerfile of this folder
#   vm.sh arm <folder> e1|e4 <name> <only>          operates the cells, and keeps their records
#
# This tier has one guest, and it holds the whole lab. A fault that needs a second kernel adds a
# second node, on its own overlay of root.img.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
port=2222
memory=12G
# one conntrack table of one size for each layer: the cells workflow gives the runner this size
cmdline="console=ttyS0 root=/dev/vda rw net.ifnames=0 panic=1 nf_conntrack.hashsize=16384"

kernel() {
  local out="$1" version="$2" sum="$3" hz="$4" src
  src="$(mktemp -d)"
  curl -fsSL -o "$src/linux.tar.xz" "https://cdn.kernel.org/pub/linux/kernel/v${version%%.*}.x/linux-$version.tar.xz"
  echo "$sum  $src/linux.tar.xz" | sha256sum -c -
  tar -xf "$src/linux.tar.xz" -C "$src" --strip-components=1
  rm "$src/linux.tar.xz"
  { grep '^CONFIG_' "$here/kernel.config"; echo "CONFIG_HZ_$hz=y"; } > "$src/fragment"
  (
    cd "$src"
    make -s defconfig kvm_guest.config
    scripts/kconfig/merge_config.sh -m .config fragment
    make -s olddefconfig
    # an option can leave the configuration if an option that it depends on is off: stop before the build
    local missing
    missing="$(grep -Fxv -f .config fragment || true)"
    if [ -n "$missing" ]; then
      echo "::error::these options are not in the final configuration: $(echo "$missing" | tr '\n' ' ')"
      exit 1
    fi
    make -s -j"$(nproc)" bzImage
    mkdir -p "$out"
    cp arch/x86/boot/bzImage "$out/bzImage"
    cp .config "$out/config"
    make -s kernelrelease > "$out/release"
  )
  rm -rf "$src"
}

root() {
  local out="$1" tree="$1/tree" release id
  release="$(cat "$out/release")"
  docker build -q -f "$here/Dockerfile" -t lab-guest "$here/../../.."
  ssh-keygen -q -t ed25519 -N "" -f "$out/key"
  id="$(docker create lab-guest)"
  sudo mkdir -p "$tree"
  docker export "$id" | sudo tar -xf - -C "$tree"
  docker rm "$id" >/dev/null
  # `readHost` and `cells.sh` read the HZ from this file, as on the runner
  sudo install -D -m 644 "$out/config" "$tree/boot/config-$release"
  sudo install -D -m 600 "$out/key.pub" "$tree/root/.ssh/authorized_keys"
  # an export has empty copies of these files, because Docker mounts them in a container
  echo "nameserver 10.0.2.3" | sudo tee "$tree/etc/resolv.conf" >/dev/null
  echo "guest" | sudo tee "$tree/etc/hostname" >/dev/null
  echo "127.0.0.1 localhost guest" | sudo tee "$tree/etc/hosts" >/dev/null
  sudo mkdir -p "$tree/out"
  sudo mkfs.ext4 -q -F -L root -d "$tree" "$out/root.img" 40G
  sudo chown "$(id -u):$(id -g)" "$out/root.img"
  sudo rm -rf "$tree"
  # the runner has approximately 14 GB of disk: the image is in root.img, and each arm of the host needs that space
  docker image rm -f lab-guest >/dev/null
  docker builder prune -af >/dev/null
  qemu-img create -q -f qcow2 -b "$out/root.img" -F raw "$out/node0.qcow2"
}

guest() {
  local out="$1"
  shift
  ssh -q -i "$out/key" -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -o ServerAliveInterval=30 root@127.0.0.1 "$@"
}

start() {
  local out="$1" waited=0
  qemu-system-x86_64 -name node0 -enable-kvm -cpu host -smp "$(nproc)" -m "$memory" -display none \
    -kernel "$out/bzImage" -append "$cmdline" \
    -drive "file=$out/node0.qcow2,if=virtio,format=qcow2,cache=none" \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$port-:22" -device virtio-net-pci,netdev=net0 \
    -serial "file:$out/console.log" -pidfile "$out/qemu.pid" -daemonize
  # the time to the first ssh reply and to Docker is the boot time of this layer
  until guest "$out" docker info >/dev/null 2>&1; do
    waited=$((waited + 2))
    if [ "$waited" -ge 180 ]; then
      echo "::error::the guest gave no Docker in 180 s"
      tail -n 40 "$out/console.log"
      exit 1
    fi
    sleep 2
  done
  echo "boot: $waited s to Docker, kernel $(guest "$out" uname -r)"
}

stop() {
  local out="$1" pid waited=0
  pid="$(cat "$out/qemu.pid")"
  guest "$out" systemctl poweroff || true
  while kill -0 "$pid" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -ge 60 ]; then
      kill "$pid"
      break
    fi
    sleep 1
  done
}

arm() {
  local out="$1" layer="$2" name="$3" only="$4" status=0
  mkdir -p "$out/records"
  case "$layer" in
    e1)
      bash "$here/cells.sh" "$only" "$out/records/$name"
      ;;
    e4)
      start "$out"
      guest "$out" "LAB_RUNNER=$(printf %q "$(cat "$out/runner.json")") bash /lab/packages/harness/vm/cells.sh $(printf %q "$only") /out/$name" || status=$?
      # the records come back first: a failed arm keeps what it measured
      guest "$out" tar -C /out -cf - "$name" | tar -xf - -C "$out/records" || status=$?
      stop "$out"
      ;;
    *)
      echo "::error::an arm is e1 or e4, not $layer"
      exit 1
      ;;
  esac
  return "$status"
}

command="$1"
shift
case "$command" in
  kernel | root | arm) "$command" "$@" ;;
  *)
    echo "::error::no command $command"
    exit 1
    ;;
esac
