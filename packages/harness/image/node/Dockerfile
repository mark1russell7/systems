# The harness's Node client: ioredis 6.0.0 on Node 24.21.0, the releases the corpus's claims about
# ioredis and Node's keepalive name. It runs as a container in the client's
# network namespace, as the harness's own TCP client does, and prints the same JSON lines. The same
# image holds a group's client in Sentinel mode and the observer of its Sentinels.
# lab.ts stages the build context: this folder, under harness/image/node. The lockfile is
# npm-lock.json here, because npm leaves each package-lock.json out of a published tarball.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /opt/harness/node
COPY harness/image/node/package.json ./
COPY harness/image/node/npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY harness/image/node/client-ioredis.mjs harness/image/node/client-sentinel.mjs harness/image/node/observer.mjs ./
