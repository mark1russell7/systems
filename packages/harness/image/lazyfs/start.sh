#!/bin/sh
# This file starts LazyFS in the foreground: /mnt/disk is the mount, and /var/disk holds the files.
# LazyFS opens done.fifo to write, and that open waits for a reader. The descriptor 3 is a reader that
# stays open, thus LazyFS starts at once, and a write after a reader went away does not stop it.
set -eu
mkfifo /run/lazyfs/faults.fifo /run/lazyfs/done.fifo
exec 3<>/run/lazyfs/done.fifo
exec /usr/local/bin/lazyfs /mnt/disk --config-path /etc/lazyfs/config.toml \
  -o allow_other -o modules=subdir -o subdir=/var/disk -f
