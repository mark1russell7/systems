# The etcd target of the harness: etcd v3.6.15 from its image, pinned by digest, on Alpine. The image of
# etcd is distroless: it has no shell. A cell holds the server as the child of a shell, thus a `fin`
# can stop it with SIGKILL while the container stays up, and a sidecar can freeze it by its name.
# The binaries are the ones of the image of etcd, unchanged.
# lab.ts stages the build context: this folder, under harness/image/etcd.
FROM quay.io/coreos/etcd:v3.6.15@sha256:7cf6622cb09b111289eed8a0cce3478e4f01d5048b0e0a1ed208299f3419334d AS etcd

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
COPY --from=etcd /usr/local/bin/etcd /usr/local/bin/etcdctl /usr/local/bin/
