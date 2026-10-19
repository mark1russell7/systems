# docker-proxy of Docker Engine 29.1.5, the userland proxy of a published port, as a proxy hop.
# The static bundle of Docker holds the binary. The build checks the SHA-256 of the bundle.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS fetch
RUN wget -q -O /docker.tgz https://download.docker.com/linux/static/stable/x86_64/docker-29.1.5.tgz \
 && echo "882bb03f3fd36ad565b1362f5bbb5d5af5f2410a5c10cae3f9d3d54e2540adc2  /docker.tgz" | sha256sum -c - \
 && tar -xzf /docker.tgz -C / docker/docker-proxy

# docker-proxy writes its status to the pipe of its parent on fd 3. With no parent, a cell gives it
# /dev/null there: `exec docker-proxy ... 3>/dev/null` (cmd/docker-proxy/main_linux.go:17-28, :47-55)
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
COPY --from=fetch /docker/docker-proxy /usr/local/bin/docker-proxy
