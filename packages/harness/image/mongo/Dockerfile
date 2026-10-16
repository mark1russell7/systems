# The harness's MongoDB client: the driver mongodb 7.7.0 on Node 24.21.0. It runs as a container
# in the client's network namespace, as the harness's own TCP client does, and prints the same JSON
# lines, with the driver's own events beside them. The same image sends a planned step-down.
# lab.ts stages the build context: this folder, under harness/image/mongo. The lockfile is
# npm-lock.json here, because npm leaves each package-lock.json out of a published tarball.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /opt/harness/mongo
COPY harness/image/mongo/package.json ./
COPY harness/image/mongo/npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY harness/image/mongo/client-mongo.mjs harness/image/mongo/stepdown-mongo.mjs ./
