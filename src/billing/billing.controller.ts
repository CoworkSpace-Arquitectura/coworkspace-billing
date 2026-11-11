import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ChargeStatus } from '@prisma/client';
import { BillingService } from './billing.service.js';

const MESSAGES: Record<ChargeStatus, string> = {
  PAID: 'Pago aprobado. Tu reserva quedó confirmada.',
  PENDING: 'Estamos confirmando tu pago con Stripe. Revisa en unos segundos.',
  FAILED: 'El pago no se completó. La reserva fue liberada.',
};

@Controller()
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('charges')
  findCharges(@Query('memberId') memberId?: string) {
    return this.billingService.findCharges(memberId);
  }

  // Stripe devuelve aquí al usuario después de pagar
  @Get('charges/return')
  async paymentReturn(@Query('session_id') sessionId: string) {
    const charge = await this.billingService.syncBySession(sessionId);
    return { message: MESSAGES[charge.status], charge };
  }

  @Get('charges/booking/:bookingId')
  findChargeByBooking(@Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.billingService.findChargeByBooking(bookingId);
  }

  // Stripe devuelve aquí al usuario si abandona la página de pago
  @Get('charges/:id/cancelled')
  async paymentCancelled(@Param('id', ParseUUIDPipe) id: string) {
    const charge = await this.billingService.cancel(id);
    return { message: MESSAGES[charge.status], charge };
  }

  @Post('charges/:id/sync')
  sync(@Param('id', ParseUUIDPipe) id: string) {
    return this.billingService.sync(id);
  }

  @Get('invoices')
  findInvoices(@Query('memberId') memberId?: string) {
    return this.billingService.findInvoices(memberId);
  }
}