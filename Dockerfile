# === Stage 1: Build Java Application ===
FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app

COPY mvnw pom.xml ./
COPY .mvn .mvn
RUN chmod +x mvnw && ./mvnw dependency:resolve -B

COPY src src
RUN ./mvnw package -DskipTests -B

# === Stage 2: Production Unified Runtime (Java + Python Optimizer) ===
FROM eclipse-temurin:17-jre-jammy
WORKDIR /app

# Instalar Python 3, pip y solver CBC nativo (coinor-cbc)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip coinor-cbc curl bash \
    && rm -rf /var/lib/apt/lists/*

# Crear usuario seguro
RUN useradd -m -s /bin/bash furent

# Copiar el artefacto Java
COPY --from=build /app/target/*.jar app.jar

# Copiar el microservicio de optimización en Python e instalar dependencias
COPY python/optimizer /app/python/optimizer
RUN pip3 install --no-cache-dir --break-system-packages -r /app/python/optimizer/requirements.txt || \
    pip3 install --no-cache-dir -r /app/python/optimizer/requirements.txt

# Script de arranque
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i -e 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

RUN mkdir -p /app/uploads && chown -R furent:furent /app
USER furent

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8080/login || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
