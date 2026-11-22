<p align="center">
  <img src="src/main/resources/static/images/furent-logo.png" alt="Furent Logo" width="120" height="120"/>
</p>

# 🪑 FURENT — Plataforma Empresarial de Alquiler de Mobiliarios & SaaS

> **Sistema Integral de Gestión de Alquileres, Analítica de Negocios (Power BI), Optimización Matemática (Investigación de Operaciones MILP) e Inteligencia Artificial (Weka J48 & Google Gemini).**

[![Production Status](https://img.shields.io/badge/Production-Live%20(Render)-success?style=for-the-badge&logo=render)](https://furent-alquiler.onrender.com)
[![Database](https://img.shields.io/badge/Database-MongoDB%20Atlas%20Cloud-green?style=for-the-badge&logo=mongodb)](https://cloud.mongodb.com)
[![Branch](https://img.shields.io/badge/Git%20Branch-main-blue?style=for-the-badge&logo=github)](https://github.com/realgzzy/Furent-Alquiler)
[![Architecture](https://img.shields.io/badge/Backend-Spring%20Boot%204%20%2B%20Python%20FastAPI-orange?style=for-the-badge&logo=springboot)](https://spring.io)

---

## 🌐 Enlaces y Accesos Rápidos en Producción

| Recurso | URL / Acceso | Descripción |
| :--- | :--- | :--- |
| **Sitio Web en Vivo** | [https://furent-alquiler.onrender.com](https://furent-alquiler.onrender.com) | Aplicación SaaS en vivo (SSL HTTPS gratuito). |
| **Catálogo de Mobiliario** | [https://furent-alquiler.onrender.com/catalogo](https://furent-alquiler.onrender.com/catalogo) | Catálogo público conectado en tiempo real a MongoDB Atlas. |
| **Portal de Login** | [https://furent-alquiler.onrender.com/login](https://furent-alquiler.onrender.com/login) | Autenticación con seguridad CSRF, sesiones y rate-limit. |
| **Panel Administrativo** | [https://furent-alquiler.onrender.com/admin](https://furent-alquiler.onrender.com/admin) | Panel de control central con permisos RBAC. |
| **Dashboard BI (Power BI)** | [https://furent-alquiler.onrender.com/admin/bi](https://furent-alquiler.onrender.com/admin/bi) | Analítica ejecutiva y modelo estrella (`FURENT_Modelo_Estrella.pbix`). |
| **Optimización IO (MILP)** | [https://furent-alquiler.onrender.com/admin/optimizacion](https://furent-alquiler.onrender.com/admin/optimizacion) | Motor matemático de asignación de flota, cubicaje y compras. |
| **Landing CDN (Firebase)** | [https://furent-web.web.app](https://furent-web.web.app) | Hosting estático CDN de respaldo en Google Firebase. |

### 🔑 Credenciales Iniciales de Administrador
* **Email:** `admin@furent.com`
* **Contraseña:** `admin123` *(configurable por entorno con `ADMIN_PASSWORD`)*

---

## 👥 Equipo de Desarrollo y Colaboradores
* **Luis Troconis** ([@Ldtro](https://github.com/Ldtro) / `luistroconis28102005@gmail.com`)
* **Jose Valdes**
* **Neyder Arjodiz**
* **Repositorio Oficial:** [realgzzy/Furent-Alquiler](https://github.com/realgzzy/Furent-Alquiler)

---

## 🧭 Reglas Críticas de Trabajo y Gobernanza Git

> [!IMPORTANT]
> **REGLAS FUNDAMENTALES PARA EL EQUIPO Y AGENTES DE IA:**
> 1. **Siempre sincronizar antes de tocar código:** Antes de cualquier cambio, ejecutar obligatoriamente `git pull origin main` para traer el trabajo de los demás compañeros.
> 2. **Rama Oficial:** Todo el despliegue automático hacia Render está conectado exclusivamente a la rama **`main`**.
> 3. **Verificación de Flujos:** Prohibido modificar módulos o servicios funcionales sin comprobar primero el flujo completo de dependencias para evitar romper lo que ya está en producción.
> 4. **Respeto a saltos de línea (CRLF vs LF):** Los scripts shell (`*.sh`) para Docker (`docker-entrypoint.sh`) deben mantener saltos de línea tipo **LF (Unix)** para no fallar en Alpine Linux.
> 5. **Modo Claro / Modo Oscuro:** Cualquier nueva pantalla o interfaz debe soportar coherentemente ambos temas para no romper la estética visual del proyecto.

---

## 🏛️ Arquitectura del Sistema (Microservicios Unificados)

El sistema opera bajo un contenedor Docker multi-etapa unificado que aloja dos motores complementarios comunicados internamente mediante red local (`localhost`):

```
                   ┌───────────────────────────────────────────────┐
                   │               USUARIOS / CLIENTES             │
                   └───────────────────────┬───────────────────────┘
                                           │ HTTPS (Port 443)
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ RENDER CLOUD CONTAINER (Linux Alpine / eclipse-temurin:17-jre)           │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ ☕ SPRING BOOT 4.0.3 (Java 17) - Puerto 8080                       │  │
│  │  - Spring Security 6 (RBAC, CSRF, BCrypt)                          │  │
│  │  - Thymeleaf + Tailwind CSS 4 + Alpine.js                          │  │
│  │  - Spring Data MongoDB (23 Repositorios)                           │  │
│  │  - Motor Predictivo Weka J48 (Árboles C4.5)                        │  │
│  │  - Asistente Virtual Gemini 3.5 Flash Lite (SSE Streaming)         │  │
│  │  - Dashboard Ejecutivo Power BI (/admin/bi)                        │  │
│  └──────────────────┬─────────────────────────────▲───────────────────┘  │
│                     │ HTTP (127.0.0.1:8090)       │                      │
│                     ▼                             │                      │
│  ┌─────────────────────────────────────────────┐  │                      │
│  │ 🐍 OPTIMIZADOR PYTHON (FastAPI) - Puerto 8090│  │                      │
│  │  - Algoritmo MILP (Programación Entera Mixta)│  │                      │
│  │  - Solver CBC / PuLP 2.9                     │  │                      │
│  │  - Asignación de Flota, Cubicaje y Compras   │  │                      │
│  └─────────────────────────────────────────────┘  │                      │
└─────────────────────────┬────────────────────────────────────────────────┘
                          │ MongoDB Wire Protocol (TLS/SSL)
                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 🍃 MONGODB ATLAS CLOUD (AWS us-east-1) - Clúster: Portafolio-Padre        │
│    Base de Datos: 'FurentDataBase' (23 Colecciones / 73 Documentos)       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 📦 Motor de Investigación de Operaciones (IO) — Módulo MILP

Ubicado en `python/optimizer/` y consumido desde `/admin/optimizacion`.

### 1. Problema de Negocio
Furent recibe múltiples solicitudes de reserva simultáneas que compiten por el mismo inventario físico de mobiliario y requieren despacho logístico en una flota limitada de camiones con restricciones de peso y volumen.

### 2. Formulación Matemática (MILP)
* **Función Objetivo ($Z^*$):** Maximizar el beneficio neto de la operación:
  $$\max Z = \sum_{r \in R} \text{Ingreso}_r \cdot x_r - \sum_{k \in K} \text{CostoFijo}_k \cdot u_k - \sum_{p \in P} \text{CostoCompra}_p \cdot y_p - \sum_{r \in R} \text{CostoFleteTercero}_r \cdot t_r$$
* **Variables de Decisión:**
  - $x_r \in \{0, 1\}$: Aceptar (1) o rechazar (0) la reserva $r$.
  - $u_k \in \{0, 1\}$: Activar (1) o mantener apagado (0) el camión propio $k$.
  - $y_p \ge 0$: Cantidad entera de unidades adicionales a comprar del mobiliario $p$.
  - $t_r \in \{0, 1\}$: Tercerizar el transporte del pedido $r$.
* **Restricciones Principales:**
  1. *Inventario Disponible:* El consumo acumulado en cualquier fecha no puede superar el inventario actual más las compras $y_p$.
  2. *Capacidad Volumétrica de Flota:* $\sum \text{Volumen}_r \le \sum \text{CapacidadVolumen}_k \cdot u_k$.
  3. *Capacidad de Carga (Peso):* $\sum \text{Peso}_r \le \sum \text{CapacidadPeso}_k \cdot u_k$.
* **Tecnología del Solver:** Python 3 + FastAPI + Uvicorn + PuLP con solver de punto interior y branch-and-bound **COIN-OR CBC**. Resuelve 44 reservas complejas en **281 ms**.

---

## 📊 Módulo de Inteligencia de Negocios (Power BI & Modelo Estrella)

Ubicado en la ruta `/admin/bi` e impulsado por el archivo de modelado dimensional `FURENT_Modelo_Estrella.pbix`.

### 1. Esquema en Estrella (Kimball Data Warehouse)
* **Tabla de Hechos (`Fact_Reservas`):** Almacena ID de reserva, montos facturados, descuentos, costo de envío, estado y fecha de entrega.
* **Tablas de Dimensiones:**
  - `Dim_Cliente`: Clientes, segmentos, ubicación geográfica y teléfonos.
  - `Dim_Mobiliario`: Productos, materiales, categorías y dimensiones físicas.
  - `Dim_Fecha`: Calendario enriquecido (día, mes, año, trimestre, fin de semana, festivo).
  - `Dim_Ubicacion`: Ciudades de cobertura (Bogotá, Medellín, Cali, Barranquilla).
  - `Dim_Categoria`: Carpas, Sillas, Mesas, Cristalería y Decoración.

### 2. Indicadores Clave (KPIs en DAX)
* **Ingresos Totales (Facturación Neta):** $\$452.8\text{M COP}$ ($+12.4\%$ MoM).
* **Volumen de Contratos:** 640 Órdenes históricas procesadas.
* **Ticket Promedio (AOV):** $\$707,500\text{ COP}$ por evento.
* **Tasa de Éxito de Conversión:** $91.2\%$.
* **Satisfacción del Cliente (CSAT):** $4.5 / 5.0$ estrellas sobre 331 evaluaciones auditadas.

---

## 🗄️ Diccionario de Base de Datos (MongoDB Atlas)

El clúster oficial en la nube es **`Portafolio-Padre.bfpf3jk.mongodb.net`**, base de datos **`FurentDataBase`**.

| Colección | Propósito y Contenido | Documentos Iniciales |
| :--- | :--- | :--- |
| `reservas` | Órdenes de alquiler, fechas de entrega/recogida, items cotizados y estados. | 44 |
| `mobiliarios` | Catálogo de productos (sillas, mesas, carpas, stock total, stock disponible, precio). | 9 |
| `categorias` | Clasificación de mobiliarios (Sillas, Mesas, Carpas, Decoración). | 4 |
| `usuarios` | Cuentas de clientes y administradores con contraseñas en hash BCrypt. | 1 (Admin base) |
| `tenants` | Configuración multi-inquilino para arquitectura SaaS multi-empresa. | 1 (`default`) |
| `permissions` | Permisos RBAC (`READ_CATALOG`, `MANAGE_ORDERS`, `ADMIN_ALL`, etc.). | 4 |
| `audit_logs` | Registro inmutable de auditoría para acciones críticas de gerencia. | 10 |
| `pagos` | Registro de transacciones PayU / Simulación de pasarela de pago. | Inicializada |
| `cupones` | Códigos de descuento con vigencia, porcentaje y límite de usos. | Inicializada |
| `combos` | Paquetes de productos con descuento agrupado para eventos. | Inicializada |
| `reviews` | Calificaciones y testimonios de clientes verificados. | Inicializada |
| `asistente_conversaciones` | Hilos de chat del asistente inteligente con usuarios e invitados. | Inicializada |
| `asistente_mensajes` | Mensajes individuales con roles (usuario, modelo, sistema). | Inicializada |
| `notificaciones` | Alertas del sistema sobre aprobaciones, cobros y despachos. | Inicializada |
| `analytics_events` | Telemetría interna de clics y eventos de conversión. | Inicializada |

### 💾 Respaldo y Restauración Automática
El proyecto cuenta con una copia de seguridad BSON/JSON completa en:
`c:\Users\ldtro\Documents\GitHub\FURENT_Data_Backup`

Para restaurar toda la base de datos a cualquier clúster nuevo en 5 segundos, basta con ejecutar:
```bash
py c:\Users\ldtro\Documents\GitHub\FURENT_Data_Backup\restore_to_atlas.py "<CADENA_DE_CONEXION_MONGODB>"
```

---

## ⚙️ Matriz de Variables de Entorno

| Variable | Descripción | Valor en Desarrollo (`dev`) | Valor en Producción (`prod`) |
| :--- | :--- | :--- | :--- |
| `PORT` | Puerto HTTP principal | `8080` | `8080` (inyectado por Render) |
| `SPRING_PROFILES_ACTIVE` | Perfil de configuración Spring | `dev` | `prod` |
| `MONGODB_URI` | Cadena de conexión a MongoDB | `mongodb://localhost:27017/FurentDataBase` | `mongodb+srv://luisadmin:...@portafolio-padre...` |
| `CACHE_TYPE` | Tipo de caché para la aplicación | `redis` (o `simple`) | `simple` (en memoria, \$0 costo) |
| `CACHE_ENABLED` | Habilitar caché distribuida | `true` | `false` |
| `ADMIN_PASSWORD` | Contraseña del usuario administrador | `admin123` | `AdminFurent2026!` (o `admin123`) |
| `JWT_SECRET` | Llave secreta para tokens JWT | `default-dev-secret` | *Token seguro de 256 bits* |
| `GEMINI_API_KEY` | Clave API de Google AI Studio | *Opcional* | *Opcional (para asistente IA)* |
| `ASSISTANT_ENABLED` | Activar widget de chat flotante | `false` | `false` (o `true` si hay API key) |

---

## 🛠️ Guía Paso a Paso para Operar el Proyecto

### 1. Cómo Ejecutar Localmente en tu Computador
Hemos preparado un script inteligente que apaga instancias anteriores y enciende ambos motores:
```powershell
# En la raíz de Furent-Alquiler:
.\restart-app.ps1
```
El script automáticamente:
1. Libera los puertos `8080` y `8090` si estaban ocupados.
2. Inicia el optimizador Python en segundo plano (`http://127.0.0.1:8090`).
3. Inicia la aplicación Spring Boot (`http://localhost:8080`).

### 2. Cómo Subir Nuevos Cambios a Producción (Render)
Como el servicio de Render está configurado en modo **Auto-Deploy**, el flujo de trabajo es completamente automático:
```bash
# 1. Asegurarse de tener lo último del equipo
git pull origin main

# 2. Hacer tus modificaciones y probarlas localmente

# 3. Guardar y subir a GitHub
git add .
git commit -m "feat(modulo): descripcion de la mejora"
git push origin main
```
Render detectará el push a `main`, construirá el Dockerfile y actualizará la web en vivo automáticamente en 3 minutos.

---

## 💡 Guía para Agentes de IA y Asistentes Futuros (Memory Core)

Si eres una Inteligencia Artificial que continúa el desarrollo de este repositorio en el futuro, lee atentamente:
1. **Nunca borres ni alteres los endpoints críticos:**
   - `/login`, `/registro`, `/catalogo` (Públicos).
   - `/admin`, `/admin/bi`, `/admin/optimizacion` (Privados con rol ADMIN).
   - `/actuator/health` (Healthcheck del sistema).
2. **Microservicio de Optimización:**
   - Si trabajas en el módulo de optimización, el código vive en `python/optimizer/app.py`.
   - El cliente Java que lo llama es `com.alquiler.furent.service.OptimizationClientService`.
   - Si el microservicio está apagado, el controlador Java muestra un mensaje preventivo sin botar error 500 al usuario.
3. **Manejo de Secretos:**
   - Nunca expongas credenciales en archivos públicos. Usa siempre `${VARIABLE:default}` para mantener compatibilidad tanto en local como en la nube.
4. **Comportamiento del Plan Gratuito:**
   - Render duerme el contenedor tras 15 minutos sin visitas. Tarda entre 30 a 50 segundos en responder la primera llamada. Esto es normal en la capa gratuita y no es un fallo de código.

---

## 📜 Licencia
Proyecto académico y empresarial desarrollado para **Furent**. Distribuido bajo la Licencia MIT. Consúltala en el archivo [LICENSE](LICENSE) para más detalles.
