# The image of a kind cell: the service on @mark1russell7/service, its clients (HTTP and grpc-js),
# the agent of each node and the watcher of the API, on Node 24.21.0. The base is pinned by digest,
# and npm-lock.json pins the packages from npm. The packages of the workspace come as the tarballs
# that pnpm packs, and the build unpacks them over node_modules, as npm would install them. image.ts
# stages the context and tags the image by its content.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /opt/lab
COPY package.json ./
COPY npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY workspace/ /tmp/workspace/
RUN for name in quantity algebra service; do \
      mkdir -p "node_modules/@mark1russell7/$name" \
      && tar -xzf /tmp/workspace/mark1russell7-$name-*.tgz -C "node_modules/@mark1russell7/$name" --strip-components=1; \
    done \
 && rm -rf /tmp/workspace
COPY app.mjs client.mjs client-grpc.mjs agent.mjs watch.mjs compose.ts backends.ts conntrack.ts drops.ts eds.ts lds.ts client-lines.ts ./
CMD ["node", "app.mjs"]
