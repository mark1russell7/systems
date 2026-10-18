# PgBouncer 1.26.1, the pooler hop of the harness. The build gets the release tarball of
# pgbouncer.org and checks its SHA-256 before it builds. The C sources of that tarball are those of
# the tag pgbouncer_1_26_1, which the machine documents pgbouncer-client and pgbouncer-server cite.
# The configuration of a cell goes in by its files: /etc/pgbouncer/pgbouncer.ini and
# /etc/pgbouncer/userlist.txt. PgBouncer does not start as root, thus it runs as its own user. The
# build makes only the program: the man pages of the tarball need pandoc, which the image does not hold.
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS build
RUN apk add --no-cache build-base pkgconf libevent-dev openssl-dev curl
ARG VERSION=1.26.1
ARG SHA256=00886a2994b4844cd37110970df777772cfc42a74c400522c82fba509a3f42d9
RUN curl -fsSL -o /tmp/pgbouncer.tar.gz "https://www.pgbouncer.org/downloads/files/${VERSION}/pgbouncer-${VERSION}.tar.gz" \
 && echo "${SHA256}  /tmp/pgbouncer.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/pgbouncer.tar.gz -C /tmp \
 && cd "/tmp/pgbouncer-${VERSION}" \
 && ./configure --prefix=/usr/local --without-cares --without-pam --without-ldap --without-systemd \
 && make -j2 pgbouncer \
 && install -m 0755 pgbouncer /usr/local/bin/pgbouncer

FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62
RUN apk add --no-cache libevent openssl \
 && adduser -D -H -s /sbin/nologin pgbouncer \
 && mkdir -p /etc/pgbouncer
COPY --from=build /usr/local/bin/pgbouncer /usr/local/bin/pgbouncer
USER pgbouncer
EXPOSE 6432
CMD ["/usr/local/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
