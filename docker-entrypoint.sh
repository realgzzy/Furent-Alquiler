#!/bin/sh
set -e

echo "[+] Iniciando Optimizador Python en segundo plano (puerto 8090)..."
if [ -d "/app/python/optimizer" ]; then
    cd /app/python/optimizer
    python3 -m uvicorn app:app --host 127.0.0.1 --port 8090 --log-level warning &
    cd /app
fi

echo "[+] Esperando inicializacion de servicios..."
sleep 1

echo "[+] Iniciando aplicacion Furent (Spring Boot 4)..."
exec java -Djava.security.egd=file:/dev/./urandom -jar /app/app.jar
