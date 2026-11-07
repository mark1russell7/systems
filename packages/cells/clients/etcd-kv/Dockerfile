# The commander of the read cells of etcd (SYS-75): the client etcd-kv on clientv3 of etcd v3.6.15,
# the checker of linearizability on Porcupine v1.3.1, and etcdctl of the image of etcd. Go 1.27.2
# builds the two programs.
# The client and the checker each build from their go.mod and go.sum, with -mod=readonly. Thus a
# module that is not in go.sum, or that has a different checksum, stops the build.
# The context is the cells package: this folder, under clients/etcd-kv, and the checker, under
# checkers/linearizability.
FROM quay.io/coreos/etcd:v3.6.15@sha256:7cf6622cb09b111289eed8a0cce3478e4f01d5048b0e0a1ed208299f3419334d AS etcd

FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS checker
WORKDIR /src
COPY checkers/linearizability/go.mod checkers/linearizability/go.sum checkers/linearizability/history.go checkers/linearizability/main.go ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /linearizability .

FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS client
WORKDIR /src
COPY clients/etcd-kv/go.mod clients/etcd-kv/go.sum clients/etcd-kv/main.go ./
# the format and the vet of the source come first, as for the Go client of the harness
RUN test -z "$(gofmt -l .)" || { gofmt -d .; exit 1; }
RUN CGO_ENABLED=0 go vet -mod=readonly ./... && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /etcd-kv .

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
COPY --from=etcd /usr/local/bin/etcdctl /usr/local/bin/
COPY --from=checker /linearizability /usr/local/bin/
COPY --from=client /etcd-kv /usr/local/bin/
