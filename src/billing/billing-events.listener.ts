import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { BillingService } from './billing.service.js';
import type { BookingCreatedData, MembershipActivatedData } from './billing.service.js';

interface IncomingEvent<T> {
  event: string;
  data: T;
}

@Injectable()
export class BillingEventsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingEventsListener.name);
  private subscriber?: Redis;

  constructor(private readonly billing: BillingService) {}

  onModuleInit() {
    if (!process.env.REDIS_URL) {
      this.logger.warn('REDIS_URL no está configurado: no se escucharán eventos');
      return;
    }
    this.subscriber = new Redis(process.env.REDIS_URL);
    this.subscriber.on('message', (channel: string, message: string) => {
      void this.handle(channel, message);
    });
    this.subscriber
      .subscribe('booking.created', 'membership.activated')
      .then(() => this.logger.log('Escuchando booking.created y membership.activated'))
      .catch((error: Error) => this.logger.error(`No se pudo suscribir: ${error.message}`));
  }

  private async handle(channel: string, message: string) {
    try {
      if (channel === 'booking.created') {
        const event = JSON.parse(message) as IncomingEvent<BookingCreatedData>;
        await this.billing.handleBookingCreated(event.data);
      } else if (channel === 'membership.activated') {
        const event = JSON.parse(message) as IncomingEvent<MembershipActivatedData>;
        await this.billing.invoiceMembership(event.data);
      }
    } catch (error) {
      this.logger.error(`Error procesando ${channel}: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.subscriber?.quit();
  }
}