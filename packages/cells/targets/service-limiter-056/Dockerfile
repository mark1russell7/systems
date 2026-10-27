# The target of the cells of the keyed limiter: the http.Server of Node 24.21.0 over the keyed
# limiter of @mark1russell7/service 0.5.6, from npm. The digest of the image and an npm lockfile pin
# them. The lockfile is npm-lock.json here, because npm leaves each package-lock.json out of a
# published tarball. The harness builds this folder as the context (packages/cells/src/limiter.ts).
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /srv
COPY package.json ./
COPY npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs ./
