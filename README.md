# CoworkSpace · Billing Service

![CI-CD](https://github.com/CoworkSpace-Arquitectura/coworkspace-billing/actions/workflows/deploy.yml/badge.svg)

Microservicio de cobros, facturas y pagos con Stripe Checkout (modo de prueba). Reembolsa reservas canceladas dentro de 24 horas y planes dentro de 7 días, y concilia cada minuto los pagos pendientes con Stripe.

- **Despliegue:** https://coworkspace-billing.onrender.com
- **Documentación de la API (Swagger):** https://coworkspace-billing.onrender.com/docs
- **Puerto local:** 3005
- **Reconciliación:** cada minuto revisa en Stripe los cobros pendientes
- **Tarjeta de prueba:** 4242 4242 4242 4242, cualquier fecha futura y CVC

## Tecnologías

TypeScript, NestJS 12 y Node.js 24, Prisma 6 y PostgreSQL, Redis (ioredis) para eventos, Vitest y Supertest para pruebas, prom-client para métricas y @nestjs/swagger para la documentación. Se empaqueta con Docker.

## Instalación y ejecución local

```bash
npm install
cp .env.example .env        # en Windows: copy .env.example .env
npx prisma migrate dev          # crea las tablas en tu base local
npm run start:dev           # http://localhost:3005
```

Producción: `npm run build` y `node dist/main.js` (o la imagen Docker del `Dockerfile`).

## Variables de entorno

Están en `.env.example`. El archivo `.env` real no se sube al repositorio (está en `.gitignore`); en Render se configuran como variables de entorno y en GitHub Actions como *secrets*.

| Variable | Para qué sirve | Ejemplo |
| --- | --- | --- |
| `DATABASE_URL` | Base de datos PostgreSQL del servicio (en producción: Neon) | `postgresql://postgres:postgres@localhost:5432/coworkspace_billing` |
| `PORT` | Puerto HTTP | `3005` |
| `REDIS_URL` | Bus de eventos (en producción: Upstash Redis) | `redis://localhost:6379` |
| `STRIPE_SECRET_KEY` | Stripe en modo de prueba: usa una llave sk_test_ de tu panel de Stripe | `sk_test_reemplazar` |
| `FRONTEND_URL` | Dirección del sitio (a donde vuelve el usuario después de pagar) | `http://localhost:3010` |
| `PUBLIC_URL` | Dirección pública de este servicio | `http://localhost:3005` |

## Base de datos

- PostgreSQL propio del servicio (en producción, una base en Neon). Ningún otro servicio accede a ella.
- Esquema en `prisma/schema.prisma` y 3 migraciones versionadas en `prisma/migrations/`.
- Las migraciones se aplican solas al arrancar el contenedor (`npx prisma migrate deploy`); en local: `npx prisma migrate dev`.
- Datos de ejemplo: las peticiones de `billing.http` (extensión REST Client de VS Code) crean datos de prueba.
- Respaldo: Neon permite restaurar la base a un punto anterior desde su panel.

## Endpoints

| Método | Ruta |
| --- | --- |
| GET | `/charges` |
| GET | `/charges/return` |
| GET | `/charges/booking/:bookingId` |
| GET | `/charges/subscription/:subscriptionId` |
| GET | `/charges/:id/cancelled` |
| POST | `/charges/:id/sync` |
| GET | `/invoices` |
| GET | `/metrics` (métricas para Prometheus) |
| GET | `/docs` (Swagger UI) |

## Eventos (Redis Pub/Sub)

- **Publica:** `billing.payment.requested`, `billing.charge.succeeded`, `billing.charge.failed`, `billing.charge.refunded`, `billing.invoice.created`, `billing.subscription.paid`, `billing.subscription.failed`
- **Escucha:** `booking.created`, `booking.cancelled`, `membership.payment.requested`, `membership.activated`, `membership.expired`

## Pruebas

Pruebas unitarias en `src/**/*.spec.ts` (con mocks de la base, de otros servicios y de las APIs externas) y una prueba de integración en `test/integration/` contra un PostgreSQL y un Redis reales.

```bash
npx vitest run --exclude "test/**"   # solo unitarias, sin base de datos
npm test                              # unitarias + integración (requiere DATABASE_URL y REDIS_URL)
npm run test:cov                      # con reporte de cobertura (carpeta coverage/)
```

En GitHub Actions las pruebas corren contra PostgreSQL 16 y Redis 7 reales, y el reporte de cobertura queda como artefacto `cobertura-billing`.

## CI/CD

`.github/workflows/deploy.yml` se ejecuta en cada push y pull request a `main` y llama al workflow reutilizable de [coworkspace-pipelines](https://github.com/CoworkSpace-Arquitectura/coworkspace-pipelines): lint, build, pruebas con cobertura → imagen Docker en GHCR → despliegue en Render. Si una prueba falla, no se construye la imagen ni se despliega. Los pull requests solo corren las pruebas.

## Monitoreo

`GET /metrics` expone métricas para Prometheus (peticiones por ruta y código, histograma de tiempos de respuesta y métricas del proceso). La configuración de Prometheus y el dashboard de Grafana están en `coworkspace-pipelines/monitoring`.
