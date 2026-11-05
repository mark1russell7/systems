# The root file system of a guest of layer E4 (docs/S7.md). The command `root` of `src/vm.ts` builds this image on the
# runner, with no VM, and writes its files to a disk. The guest then has systemd, sshd and the Docker
# version of the runner, and the cells operate in it with the command of the cells workflow. The
# build context is the root of the repository.
FROM node:26-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server iproute2 iptables kmod ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# the version of the hosted runner, because the version of Debian is another program
RUN curl -fsSL -o /tmp/docker.tgz https://download.docker.com/linux/static/stable/x86_64/docker-28.0.4.tgz \
 && echo "6b130fa5fb13516620d5ece0b63f63a495cede428bb2f9e24449022e9d72e0cb  /tmp/docker.tgz" | sha256sum -c - \
 && tar -xzf /tmp/docker.tgz --strip-components=1 -C /usr/local/bin \
 && rm /tmp/docker.tgz
RUN npm install -g pnpm@12.10.1
COPY packages/harness/vm/lab-net.service packages/harness/vm/docker.service /etc/systemd/system/
RUN ssh-keygen -A \
 && systemctl enable ssh lab-net docker \
 && systemctl mask serial-getty@ttyS0 getty@tty1
WORKDIR /lab
COPY . .
RUN pnpm install --frozen-lockfile
