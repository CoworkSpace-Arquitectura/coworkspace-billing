import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { StripeGateway } from './stripe.gateway.js';
import { BillingEventsListener } from './billing-events.listener.js';

@Module({
  controllers: [BillingController],
  providers: [BillingService, StripeGateway, BillingEventsListener],
})
export class BillingModule {}