# === Stage 1: Build Java Application ===
FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app

COPY mvnw pom.xml ./
COPY .mvn .mvn
RUN chmod +x mvnw && ./mvnw dependency:resolve -B

COPY src src
RUN ./mvnw package -DskipTests -B

# === Stage 2: Production Unified Runtime (Java + Python Optimizer) ===
FROM eclipse-temurin:17-jre-alpine
WORKDIR /app

# Instalar Python 3 y herramientas base
RUN apk add --no-cache python3 py3-pip bash

# Crear usuario seguro
RUN addgroup -S furent && adduser -S furent -G furent

# Copiar el artefacto Java
COPY --from=build /app/target/*.jar app.jar

# Copiar el microservicio de optimización en Python e instalar dependencias
COPY python/optimizer /app/python/optimizer
RUN pip install --no-cache-dir --break-system-packages -r /app/python/optimizer/requirements.txt

# Script de arranque
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

RUN mkdir -p /app/uploads && chown -R furent:furent /app
USER furent

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
