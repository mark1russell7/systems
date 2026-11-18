# The image of the Socket.IO cells (SYS-87): the client and the server of Socket.IO 4.8.4 on Node
# 24.21.0, from npm. The digest of the image and an npm lockfile pin them: engine.io 6.6.11,
# engine.io-client 6.6.7 and one copy of ws 8.21.3. The lockfile is npm-lock.json here, because npm
# leaves each package-lock.json out of a published tarball. Node 24 operates the TypeScript of the
# programs by type stripping. The harness builds this folder as the context
# (packages/cells/src/socketio.ts).
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /srv
COPY package.json ./
COPY npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY lines.ts client.ts server.ts ./
