import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Histogram, register } from 'prom-client';

/**
 * Métricas para Prometheus (las "señales doradas"):
 * - Tráfico:      http_requests_total            (peticiones por ruta, método y código)
 * - Errores:      http_requests_total{status_code=~"5.."}
 * - Latencia:     http_request_duration_seconds  (histograma de tiempos de respuesta)
 * - Saturación:   process_* y nodejs_*           (CPU, memoria, event loop)
 * - Disponibilidad la calcula Prometheus con la métrica "up" al consultar /metrics.
 */
const requests = new Counter({
  name: 'http_requests_total',
  help: 'Peticiones HTTP recibidas',
  labelNames: ['method', 'route', 'status_code'] as const,
});

const duration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Tiempo de respuesta de las peticiones HTTP, en segundos',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ruta "plantilla" para no crear una serie por cada id: /locations/:id en vez de /locations/7f3c…
 * Si Express no resolvió la ruta (por ejemplo en los proxies del Gateway), se normaliza la URL.
 */
export function routeLabel(req: Pick<Request, 'baseUrl' | 'originalUrl'> & { route?: { path?: unknown } }) {
  if (typeof req.route?.path === 'string') {
    return `${req.baseUrl}${req.route.path}` || '/';
  }
  // originalUrl conserva la URL completa aunque un proxy montado en un prefijo la haya recortado
  const segments = req.originalUrl
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => (UUID.test(s) || /^\d+$/.test(s) ? ':id' : s));
  return `/${segments.join('/')}`;
}

/**
 * Activa las métricas en la aplicación: mide cada petición y publica GET /metrics.
 * Se registra directamente en Express, antes que las rutas de Nest y los proxies.
 */
export function setupMetrics(app: INestApplication, service: string) {
  register.setDefaultLabels({ service });
  collectDefaultMetrics();

  const express = app.getHttpAdapter().getInstance() as {
    use(fn: (req: Request, res: Response, next: NextFunction) => void): void;
    get(path: string, fn: (req: Request, res: Response) => void): void;
  };

  express.use((req, res, next) => {
    if (req.originalUrl.split('?')[0] === '/metrics') {
      next();
      return;
    }
    const stop = duration.startTimer();
    res.on('finish', () => {
      const labels = { method: req.method, route: routeLabel(req), status_code: String(res.statusCode) };
      requests.inc(labels);
      stop(labels);
    });
    next();
  });

  express.get('/metrics', (_req, res) => {
    register
      .metrics()
      .then((body) => {
        res.setHeader('Content-Type', register.contentType);
        res.end(body);
      })
      .catch((error: Error) => {
        res.status(500).end(error.message);
      });
  });
}

/** Contador de negocio (por ejemplo, reservas creadas o pagos). Si ya existe, lo reutiliza. */
export function businessCounter<L extends string>(name: string, help: string, labelNames: readonly L[]) {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing as Counter<L>;
  }
  return new Counter({ name, help, labelNames });
}
