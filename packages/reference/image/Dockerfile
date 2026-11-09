# The image of the reference service (SYS-93): Node 24.21.0 and the sources of src, with the packages of
# image/package.json from npm. The digest of the image and an npm lockfile pin them. The lockfile has
# the name npm-lock.json, as in the other targets of the cells. The context
# is the folder packages/reference, and the cells build it (packages/cells/src/ladder.ts). Node starts
# src/main.ts by its type stripping, thus the sources have no build step.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /srv
COPY image/package.json ./
COPY image/npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src/main.ts src/procedures.ts src/store.ts src/mongo-store.ts ./src/
CMD ["node", "/srv/src/main.ts"]
