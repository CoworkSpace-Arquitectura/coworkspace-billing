import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly redis = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: 3 });

  async publish(event: string, data: Record<string, unknown>) {
    const message = JSON.stringify({ event, occurredAt: new Date().toISOString(), data });
    try {
      await this.redis.publish(event, message);
      this.logger.log(`Evento publicado: ${event}`);
    } catch (error) {
      this.logger.error(`No se pudo publicar ${event}: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}