# LazyFS of the commit 3edad01, the disk tier of the harness. LazyFS is a FUSE file system that keeps
# each write in its own cache until an fsync. The command lazyfs::clear-cache loses each write after
# the last fsync: the state of the disk after a power cut. The build gets the tarball of the commit and
# the two sources that libpcache fetches (toml11 v3.7.1 and spdlog v1.10.0), and checks the SHA-256 of
# each before it builds. Thus the build fetches nothing that the file does not pin.
#
# The runtime stage has Node.js 24, thus a subject writes its files with node:sqlite or with node:fs.
# The container needs /dev/fuse and the capability of a mount: the disk tier starts it privileged.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make cmake libfuse3-dev curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG LAZYFS=3edad01aa936b81fed9bd64e47e725fc5ef6c977
ARG LAZYFS_SHA256=9c5004c4f704f059120daa2934a38a45002bda67ebd9e2d16a066a3499f5959d
ARG TOML11_SHA256=afeaa9aa0416d4b6b2cd3897ca55d9317084103077b32a852247d8efd4cf6068
ARG SPDLOG_SHA256=697f91700237dbae2326b90469be32b876b2b44888302afbc7aceb68bcfe8224
WORKDIR /src
RUN curl -fsSL -o /tmp/lazyfs.tar.gz "https://codeload.github.com/dsrhaslab/lazyfs/tar.gz/${LAZYFS}" \
 && curl -fsSL -o /tmp/toml11.tar.gz "https://codeload.github.com/ToruNiina/toml11/tar.gz/refs/tags/v3.7.1" \
 && curl -fsSL -o /tmp/spdlog.tar.gz "https://github.com/gabime/spdlog/archive/v1.10.0.tar.gz" \
 && echo "${LAZYFS_SHA256}  /tmp/lazyfs.tar.gz" | sha256sum -c - \
 && echo "${TOML11_SHA256}  /tmp/toml11.tar.gz" | sha256sum -c - \
 && echo "${SPDLOG_SHA256}  /tmp/spdlog.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/lazyfs.tar.gz --strip-components=1 \
 && mkdir -p libs/libpcache/build/_deps/toml-src libs/libpcache/build/_deps/spdlog-src \
 && tar -xzf /tmp/toml11.tar.gz -C libs/libpcache/build/_deps/toml-src --strip-components=1 \
 && tar -xzf /tmp/spdlog.tar.gz -C libs/libpcache/build/_deps/spdlog-src --strip-components=1
# The CMake file of lazyfs reads the headers of spdlog from build/_deps/spdlog-src of libpcache. Thus
# the sources go to the folders that FetchContent uses, and FetchContent gets them from there.
RUN cd libs/libpcache/build \
 && cmake -DFETCHCONTENT_SOURCE_DIR_TOML=/src/libs/libpcache/build/_deps/toml-src \
          -DFETCHCONTENT_SOURCE_DIR_SPDLOG=/src/libs/libpcache/build/_deps/spdlog-src .. \
 && cmake --build . -j2 \
 && mkdir -p /src/lazyfs/build \
 && cd /src/lazyfs/build \
 && cmake -DLAZYFS_BUILD_TESTS=OFF .. \
 && cmake --build . -j2 \
 && mkdir -p /out/bin /out/lib \
 && install -m 0755 lazyfs /out/bin/lazyfs \
 && cp -a /src/libs/libpcache/build/libpcache.so* /out/lib/

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf \
 && mkdir -p /etc/lazyfs /run/lazyfs /var/disk /mnt/disk /opt/subject
COPY --from=build /out/bin/ /usr/local/bin/
# A copy of a folder keeps the links of the library (libpcache.so to libpcache.so.0)
COPY --from=build /out/lib/ /usr/local/lib/
RUN ldconfig
COPY harness/image/lazyfs/config.toml /etc/lazyfs/config.toml
COPY harness/image/lazyfs/start.sh /usr/local/bin/start-lazyfs
RUN chmod 0755 /usr/local/bin/start-lazyfs
CMD ["/usr/local/bin/start-lazyfs"]
