# The router of the harness: a NAT box with conntrack, the middle of a stateful middlebox chain. It
# forgets an idle flow at its idle timeout, and its form tells what a late packet then meets (mbx.sh).
# lab.ts stages the build context: this folder, under harness/image/router. The base is pinned by
# digest, and the manifest of each run records the packages that apk installs.
FROM alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62
RUN apk add --no-cache conntrack-tools nftables iproute2 python3
COPY harness/image/router/mbx.sh harness/image/router/ctwatch.py harness/image/router/resetter.py /opt/mbx/
ENTRYPOINT ["/bin/sh", "/opt/mbx/mbx.sh"]
