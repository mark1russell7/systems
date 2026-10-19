# The gRPC server of the harness: a server of grpc-go v1.84.0, built with Go 1.27.2, at the defaults of
# grpc-go with the settings of a cell over them. It runs as the target of a cell.
# go mod tidy resolves the modules of grpc-go at its tag by the go.mod of each module, and the go
# command checks each module against the checksum database of Go (sum.golang.org). The build log
# prints the go.sum that it gets.
# lab.ts stages the build context: this folder, under harness/image/grpc-go.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY harness/image/grpc-go/go.mod harness/image/grpc-go/main.go ./
RUN go mod tidy && cat go.sum
# the format and the vet of the source come first, as for the Go client of the harness
RUN test -z "$(gofmt -l .)" || { gofmt -d .; exit 1; }
RUN CGO_ENABLED=0 go vet ./... && CGO_ENABLED=0 go build -trimpath -o /grpc-go-server .

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
COPY --from=build /grpc-go-server /usr/local/bin/grpc-go-server
