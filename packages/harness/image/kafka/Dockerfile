# The harness's client of Apache Kafka: kafka-clients 4.3.2 on Temurin 21.0.12.1. It runs as a
# container in the client's network namespace, as the harness's own TCP client does. It prints the
# same JSON lines. AdminKafka is the admin of a lab: it makes each topic, reads the state of a
# partition, and reads the whole partition after a run.
# lab.ts stages the build context: this folder, under harness/image/kafka. The build gets each jar
# from Maven Central and checks its SHA-256 (jars.sha256), thus a build cannot get another jar. The
# jars are kafka-clients and each runtime dependency of its POM.
FROM eclipse-temurin:21.0.12.1_1-jdk-alpine@sha256:0bfc69a4758a86710e5c474032d28400a8bd00874766f9e8b1642ac2fd293159 AS build
WORKDIR /build
COPY harness/image/kafka/jars.sha256 ./
RUN wget -q https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/4.3.2/kafka-clients-4.3.2.jar \
 && wget -q https://repo1.maven.org/maven2/org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar \
 && wget -q https://repo1.maven.org/maven2/com/github/luben/zstd-jni/1.5.6-10/zstd-jni-1.5.6-10.jar \
 && wget -q https://repo1.maven.org/maven2/at/yawk/lz4/lz4-java/1.11.4/lz4-java-1.11.4.jar \
 && wget -q https://repo1.maven.org/maven2/org/xerial/snappy/snappy-java/1.1.10.11/snappy-java-1.1.10.11.jar \
 && sha256sum -c jars.sha256
COPY harness/image/kafka/ClientKafka.java harness/image/kafka/AdminKafka.java ./
RUN javac --release 21 -cp "kafka-clients-4.3.2.jar:slf4j-api-1.7.36.jar" -d classes ClientKafka.java AdminKafka.java

FROM eclipse-temurin:21.0.12.1_1-jre-alpine@sha256:51ab5e3302e7141ce665ca3ea85e8b5cd648eafbc3c0c90dd79d6537684e4555
WORKDIR /opt/harness/kafka
COPY --from=build /build/kafka-clients-4.3.2.jar /build/slf4j-api-1.7.36.jar /build/zstd-jni-1.5.6-10.jar /build/lz4-java-1.11.4.jar /build/snappy-java-1.1.10.11.jar ./lib/
COPY --from=build /build/classes ./classes
