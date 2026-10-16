# The Go HTTP client of the harness: the http.Transport of Go 1.27.2 at its defaults, with the
# settings of a cell over them. It runs as a container in the client's network namespace, as the
# harness's own TCP client does, and prints the same JSON lines. The program uses the standard
# library only, thus the digest of the builder pins all of its code.
# lab.ts stages the build context: this folder, under harness/image/go-http.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY harness/image/go-http/go.mod harness/image/go-http/main.go ./
# the format and the vet of the source come first, as the cargo test of the harness image does
RUN test -z "$(gofmt -l .)" || { gofmt -d .; exit 1; }
RUN CGO_ENABLED=0 go vet ./... && CGO_ENABLED=0 go build -trimpath -o /client-go .

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
COPY --from=build /client-go /opt/harness/client-go
