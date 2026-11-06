# The target of the watch cells (SYS-74): etcd v3.6.15 and its client etcdctl, from the image of etcd,
# unchanged and pinned by digest, under a small program on Node.js. The program holds no client of
# its own: each write, compaction and watch is a real etcdctl, thus the watcher is clientv3.
# The harness builds this folder as the context (packages/cells/src/etcd-watch.ts).
FROM quay.io/coreos/etcd:v3.6.15@sha256:7cf6622cb09b111289eed8a0cce3478e4f01d5048b0e0a1ed208299f3419334d AS etcd

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
COPY --from=etcd /usr/local/bin/etcd /usr/local/bin/etcdctl /usr/local/bin/
WORKDIR /srv
COPY watch.ts ./
# A file of Node.js is a module by its package.json, and this image has no other one.
RUN echo '{"type":"module"}' > package.json
