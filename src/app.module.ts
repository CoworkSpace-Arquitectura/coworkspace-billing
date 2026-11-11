import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { EventsModule } from './events/events.module.js';
import { BillingModule } from './billing/billing.module.js';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, EventsModule, BillingModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}