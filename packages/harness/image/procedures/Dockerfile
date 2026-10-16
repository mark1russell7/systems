# The procedures image of the harness: @procedures/client 0.2.3 on Node 24.21.0. Its WebSocket
# client runs as a container in the client's network namespace, as the harness's own TCP client
# does, and prints the same JSON lines (client-ws.mjs). A target runs the same image with the
# script of the procedures server (server-ws.mjs), thus the client and the server share one
# release of the package. The digest of the image and an npm lockfile pin them.
# lab.ts stages the build context: this folder, under harness/image/procedures. The lockfile is
# npm-lock.json here, because npm leaves each package-lock.json out of a published tarball.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /opt/harness/procedures
COPY harness/image/procedures/package.json ./
COPY harness/image/procedures/npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY harness/image/procedures/lines.mjs harness/image/procedures/client-ws.mjs harness/image/procedures/server-ws.mjs ./
