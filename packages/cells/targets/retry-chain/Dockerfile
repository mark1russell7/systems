# The target of the retry count (SYS-67): a chain of listeners in one process, each with a real
# retry client toward the next one. The clients are the RetryAgent of undici 8.12.2 and retry() of
# @mark1russell7/service 0.6.5, from npm. The digest of the image and an npm lockfile pin them.
# The harness builds this folder as the context (packages/cells/src/retries.ts).
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /srv
COPY package.json ./
COPY npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY chain.mjs ./
