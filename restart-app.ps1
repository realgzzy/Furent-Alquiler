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

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Reiniciando Furent" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Buscar y detener procesos de Maven/Java relacionados con Furent
Write-Host "[*] Deteniendo procesos existentes..." -ForegroundColor Yellow

$javaProcesses = Get-Process java -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*furent*" -or $_.CommandLine -like "*spring-boot*"
}

if ($javaProcesses) {
    $javaProcesses | ForEach-Object {
        Write-Host "   Deteniendo proceso: $($_.Id)" -ForegroundColor Gray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Write-Host "[OK] Procesos detenidos" -ForegroundColor Green
} else {
    Write-Host "   No hay procesos corriendo" -ForegroundColor Gray
}

Write-Host ""
Write-Host "[*] Limpiando compilacion anterior..." -ForegroundColor Yellow
.\mvnw.cmd clean -q

Write-Host ""
Write-Host "[*] Compilando..." -ForegroundColor Yellow
.\mvnw.cmd compile -DskipTests -q

Write-Host ""
Write-Host "[OK] Rate Limiting: DESHABILITADO (desarrollo)" -ForegroundColor Green
Write-Host "[OK] OAuth2 Google: CONFIGURADO" -ForegroundColor Green
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
