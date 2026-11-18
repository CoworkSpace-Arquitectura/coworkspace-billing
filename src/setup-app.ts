import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { setupMetrics } from './metrics.js';
import { setupSwagger } from './swagger.js';

/** Configuración común de la app: la usan main.ts y las pruebas de integración. */
export function configureApp(app: INestApplication) {
  setupMetrics(app, 'billing');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  setupSwagger(app);
  return app;
}
