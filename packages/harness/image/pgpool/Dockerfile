# Pgpool-II 4.7.3, a pooler hop of the harness. The build gets the source of the tag V4_7_3 (commit
# 07d24655e42d) from GitHub and checks its SHA-256 before it builds. The machine documents of
# Pgpool-II cite that source. www.pgpool.net does not serve its release tarball to curl, and the
# tree of git holds no configure, thus the build runs autoreconf, and bison and flex make the parser.
# The configuration of a cell goes in by its file: /etc/pgpool/pgpool.conf. Each other file that
# Pgpool-II reads is empty in the image. Pgpool-II runs in the foreground (-n) as its own user.
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS build
RUN apk add --no-cache build-base autoconf automake libtool bison flex libpq-dev curl linux-headers
ARG COMMIT=07d24655e42dfdbfe2e7549df6166e057b99b622
ARG SHA256=e48ff26faa8b20ac1e956c0d8fb763d235d7d6c560f678ab4f759eb98230acd2
RUN curl -fsSL -o /tmp/pgpool.tar.gz "https://codeload.github.com/pgpool/pgpool2/tar.gz/${COMMIT}" \
 && echo "${SHA256}  /tmp/pgpool.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/pgpool.tar.gz -C /tmp \
 && cd "/tmp/pgpool2-${COMMIT}" \
 && autoreconf -fi \
 && ./configure --prefix=/usr/local --with-pgsql-includedir=/usr/include/postgresql --with-pgsql-libdir=/usr/lib \
 && make -j2 -C src \
 && make -C src install

FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62
RUN apk add --no-cache libpq \
 && adduser -D -H -s /sbin/nologin pgpool \
 && mkdir -p /etc/pgpool \
 && touch /etc/pgpool/pcp.conf /etc/pgpool/pool_hba.conf /etc/pgpool/pool_passwd \
 && chown -R pgpool /etc/pgpool
COPY --from=build /usr/local /usr/local
USER pgpool
EXPOSE 9999
CMD ["/usr/local/bin/pgpool", "-n", "-f", "/etc/pgpool/pgpool.conf", "-F", "/etc/pgpool/pcp.conf", "-a", "/etc/pgpool/pool_hba.conf"]
