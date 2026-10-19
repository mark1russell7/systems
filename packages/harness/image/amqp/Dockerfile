# The harness's RabbitMQ client: amqplib 2.2.0 on Node 24.21.0. It runs as a container in the client's
# network namespace, as the harness's own TCP client does, and prints the same JSON lines, with the
# events of the connection beside them.
# lab.ts stages the build context: this folder, under harness/image/amqp. The lockfile is
# npm-lock.json here, because npm leaves each package-lock.json out of a published tarball.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /opt/harness/amqp
COPY harness/image/amqp/package.json ./
COPY harness/image/amqp/npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY harness/image/amqp/client-amqp.mjs ./
