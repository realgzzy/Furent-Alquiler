# Script para reiniciar la aplicacion Furent
# Windows PowerShell

# Asegurar entorno JDK para compilacion
if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME\bin\javac.exe")) {
    $ideJdk = "c:\Users\ldtro\.antigravity-ide\extensions\redhat.java-1.58.0-win32-x64\jre\25.0.4.1-win32-x86_64"
    if (Test-Path "$ideJdk\bin\javac.exe") {
        $env:JAVA_HOME = $ideJdk
        $env:Path = "$ideJdk\bin;" + $env:Path
    }
}

# Perfil de desarrollo: activa el asistente virtual y carga application-local.properties
$env:SPRING_PROFILES_ACTIVE = 'dev,local'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Reiniciando Furent" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Buscar y detener procesos de Maven/Java y Optimizador relacionados con Furent
Write-Host "[*] Deteniendo procesos existentes..." -ForegroundColor Yellow

$javaProcesses = Get-Process java -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*furent*" -or $_.CommandLine -like "*spring-boot*"
}

if ($javaProcesses) {
    $javaProcesses | ForEach-Object {
        Write-Host "   Deteniendo proceso Java: $($_.Id)" -ForegroundColor Gray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}

# Detener microservicio Python optimizer si está en puerto 8090
$optPort = Get-NetTCPConnection -LocalPort 8090 -ErrorAction SilentlyContinue
if ($optPort) {
    $optPids = $optPort | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $optPids) {
        if ($p -gt 0) {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
    }
}
Start-Sleep -Seconds 1
Write-Host "[OK] Procesos detenidos" -ForegroundColor Green

Write-Host ""
Write-Host "[*] Limpiando compilacion anterior..." -ForegroundColor Yellow
.\mvnw.cmd clean -q

Write-Host ""
Write-Host "[*] Compilando..." -ForegroundColor Yellow
.\mvnw.cmd compile -DskipTests -q

Write-Host ""
Write-Host "[OK] Rate Limiting: DESHABILITADO (desarrollo)" -ForegroundColor Green
Write-Host "[OK] OAuth2 Google: CONFIGURADO" -ForegroundColor Green

# Iniciar microservicio Python de optimización si no está corriendo
$optRunning = Get-NetTCPConnection -LocalPort 8090 -ErrorAction SilentlyContinue
if (-not $optRunning) {
    Write-Host "[+] Iniciando Optimizador Python (Puerto 8090)..." -ForegroundColor Yellow
    Start-Process py -ArgumentList "-m uvicorn app:app --host 127.0.0.1 --port 8090" -WorkingDirectory "$PSScriptRoot\python\optimizer" -WindowStyle Hidden
    Start-Sleep -Seconds 1
    Write-Host "[OK] Optimizador Python activo" -ForegroundColor Green
} else {
    Write-Host "[OK] Optimizador Python ya activo en puerto 8090" -ForegroundColor Green
}
Write-Host ""

Write-Host "[+] Iniciando aplicacion..." -ForegroundColor Green
Write-Host ""
Write-Host "Una vez iniciada, abre:" -ForegroundColor Yellow
Write-Host "   http://localhost:8080/login" -ForegroundColor Cyan
Write-Host ""
Write-Host "Presiona Ctrl+C para detener" -ForegroundColor Yellow
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Iniciar la aplicacion
.\mvnw.cmd spring-boot:run
