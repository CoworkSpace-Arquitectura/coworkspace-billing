import { Global, Module } from '@nestjs/common';
import { EventsService } from './events.service.js';

@Global()
@Module({
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}