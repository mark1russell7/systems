# The Node HTTP clients of the harness: the http.Agent of Node 24.21.0, and an HTTP/1.1 Client of
# undici 8.12.2. Each runs as a container in the client's network namespace, as the harness's own
# TCP client does, and prints the same JSON lines. The digest of the image and an npm lockfile pin
# them. The image is apart from the ioredis image, thus the cells of ioredis keep their image.
# lab.ts stages the build context: this folder, under harness/image/node-http. The lockfile is
# npm-lock.json here, because npm leaves each package-lock.json out of a published tarball.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /opt/harness/node-http
COPY harness/image/node-http/package.json ./
COPY harness/image/node-http/npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY harness/image/node-http/lines.mjs harness/image/node-http/client-agent.mjs harness/image/node-http/client-undici.mjs ./
