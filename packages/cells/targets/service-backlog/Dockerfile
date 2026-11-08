# The target of the cells of a declared backlog (SYS-103): the http.Server of Node 24.21.0 under
# httpTransport of @mark1russell7/service 0.7.3, from npm. The digest of the image, the version of
# the package of ss and an npm lockfile pin them. The image is Alpine 3.24, and ss reads the limit of
# the queue (proc.ts). The lockfile is npm-lock.json here, because npm leaves each
# package-lock.json out of a published tarball. The harness builds this folder as the context
# (packages/cells/src/accept-queue.ts).
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
RUN apk add --no-cache iproute2-ss=7.0.0-r0
WORKDIR /srv
COPY package.json ./
COPY npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.ts control.ts proc.ts emit.ts ./
