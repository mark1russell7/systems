# The harness's client of HikariCP 7.1.0 over pgjdbc 42.7.13, on Temurin 21.0.12.1. It runs as a
# container in the client's network namespace, as the harness's own TCP client does. It prints the
# same JSON lines, with the state of the pool beside them.
# lab.ts stages the build context: this folder, under harness/image/hikari. The build gets each jar
# from Maven Central and checks its SHA-256 (jars.sha256), thus a build cannot get another jar.
FROM eclipse-temurin:21.0.12.1_1-jdk-alpine@sha256:0bfc69a4758a86710e5c474032d28400a8bd00874766f9e8b1642ac2fd293159 AS build
WORKDIR /build
COPY harness/image/hikari/jars.sha256 ./
RUN wget -q https://repo1.maven.org/maven2/com/zaxxer/HikariCP/7.1.0/HikariCP-7.1.0.jar \
 && wget -q https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.13/postgresql-42.7.13.jar \
 && wget -q https://repo1.maven.org/maven2/org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar \
 && sha256sum -c jars.sha256
COPY harness/image/hikari/ClientHikari.java ./
RUN javac --release 21 -cp "HikariCP-7.1.0.jar:postgresql-42.7.13.jar:slf4j-api-2.0.17.jar" -d classes ClientHikari.java

FROM eclipse-temurin:21.0.12.1_1-jre-alpine@sha256:51ab5e3302e7141ce665ca3ea85e8b5cd648eafbc3c0c90dd79d6537684e4555
WORKDIR /opt/harness/hikari
COPY --from=build /build/HikariCP-7.1.0.jar /build/postgresql-42.7.13.jar /build/slf4j-api-2.0.17.jar ./lib/
COPY --from=build /build/classes ./classes
