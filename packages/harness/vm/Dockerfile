# The root file system of a guest of layer E4 (docs/S7.md). The command `root` of `src/vm.ts` builds this image on the
# runner, with no VM, and writes its files to a disk. The guest then has systemd, sshd and the Docker
# version of the runner, and the cells operate in it with the command of the cells workflow. The
# build context is the root of the repository. The context keeps the folder .git, and git in the
# guest gives the commit of the code to each record (`codeHere` of the cells).
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server iproute2 iptables kmod ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*
# the version of the hosted runner, because the version of Debian is another program
RUN curl -fsSL -o /tmp/docker.tgz https://download.docker.com/linux/static/stable/x86_64/docker-28.0.4.tgz \
 && echo "6b130fa5fb13516620d5ece0b63f63a495cede428bb2f9e24449022e9d72e0cb  /tmp/docker.tgz" | sha256sum -c - \
 && tar -xzf /tmp/docker.tgz --strip-components=1 -C /usr/local/bin \
 && rm /tmp/docker.tgz
# the buildx plugin of the same weeks as that Docker. The harness builds its images with BuildKit
# (`--progress=plain`), and the legacy builder of the static bundle refuses that flag
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx https://github.com/docker/buildx/releases/download/v0.22.0/buildx-v0.22.0.linux-amd64 \
 && echo "805195386fba0cea5a1487cf0d47da82a145ea0a792bd3fb477583e2dbcdcc2f  /usr/local/lib/docker/cli-plugins/docker-buildx" | sha256sum -c - \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx \
 && docker buildx version
RUN npm install -g pnpm@12.10.1
COPY packages/harness/vm/lab-net.service packages/harness/vm/docker.service /etc/systemd/system/
RUN ssh-keygen -A \
 && systemctl enable ssh lab-net docker \
 && systemctl mask serial-getty@ttyS0 getty@tty1
WORKDIR /lab
COPY . .
RUN pnpm install --frozen-lockfile
