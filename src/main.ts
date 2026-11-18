import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './setup-app.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3005);
}
void bootstrap();
