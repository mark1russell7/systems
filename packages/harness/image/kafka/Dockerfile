# The harness's client of Apache Kafka: kafka-clients 4.3.2 on Temurin 21.0.12.1. It runs as a
# container in the client's network namespace, as the harness's own TCP client does. It prints the
# same JSON lines. AdminKafka is the admin of a lab: it makes each topic, reads the state of a
# partition, and reads the whole partition after a run.
# lab.ts stages the build context: this folder, under harness/image/kafka. The build gets each jar
# from Maven Central, else from its Google mirror, and checks its SHA-256 (jars.sha256), thus a build cannot get
# another jar. Central gives 429 to a burst of builds (8 shards at one time), so get() tries again after 15, 30, 60
# and 120 s. The
# jars are kafka-clients and each runtime dependency of its POM.
FROM eclipse-temurin:21.0.12.1_1-jdk-alpine@sha256:0bfc69a4758a86710e5c474032d28400a8bd00874766f9e8b1642ac2fd293159 AS build
WORKDIR /build
COPY harness/image/kafka/jars.sha256 ./
RUN get() { name="${1##*/}"; for wait in 0 15 30 60 120; do sleep "$wait"; for base in https://repo1.maven.org/maven2 https://maven-central.storage-download.googleapis.com/maven2; do rm -f "$name"; wget -q "$base/$1" && return 0; done; done; echo "no mirror gave $1" >&2; return 1; } \
 && get org/apache/kafka/kafka-clients/4.3.2/kafka-clients-4.3.2.jar \
 && get org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar \
 && get com/github/luben/zstd-jni/1.5.6-10/zstd-jni-1.5.6-10.jar \
 && get at/yawk/lz4/lz4-java/1.11.4/lz4-java-1.11.4.jar \
 && get org/xerial/snappy/snappy-java/1.1.10.11/snappy-java-1.1.10.11.jar \
 && sha256sum -c jars.sha256
COPY harness/image/kafka/ClientKafka.java harness/image/kafka/AdminKafka.java harness/image/kafka/ConsumerKafka.java ./
RUN javac --release 21 -cp "kafka-clients-4.3.2.jar:slf4j-api-1.7.36.jar" -d classes ClientKafka.java AdminKafka.java ConsumerKafka.java

FROM eclipse-temurin:21.0.12.1_1-jre-alpine@sha256:51ab5e3302e7141ce665ca3ea85e8b5cd648eafbc3c0c90dd79d6537684e4555
WORKDIR /opt/harness/kafka
COPY --from=build /build/kafka-clients-4.3.2.jar /build/slf4j-api-1.7.36.jar /build/zstd-jni-1.5.6-10.jar /build/lz4-java-1.11.4.jar /build/snappy-java-1.1.10.11.jar ./lib/
COPY --from=build /build/classes ./classes
