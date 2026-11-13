import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ChargeStatus } from '@prisma/client';
import { BillingService } from './billing.service.js';

const BOOKING_MESSAGES: Record<ChargeStatus, string> = {
  PAID: 'Pago aprobado. Tu reserva quedó confirmada.',
  PENDING: 'Estamos confirmando tu pago con Stripe. Revisa en unos segundos.',
  FAILED: 'El pago no se completó. La reserva fue liberada.',
};

const PLAN_MESSAGES: Record<ChargeStatus, string> = {
  PAID: 'Pago aprobado. Tu plan quedó activo: ya puedes reservar y generar tu credencial.',
  PENDING: 'Estamos confirmando tu pago con Stripe. Revisa en unos segundos.',
  FAILED: 'El pago no se completó. Tu plan no se activó; puedes intentarlo de nuevo.',
};

const messageFor = (charge: { status: ChargeStatus; subscriptionId: string | null }) =>
  (charge.subscriptionId ? PLAN_MESSAGES : BOOKING_MESSAGES)[charge.status];

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
    return { message: messageFor(charge), charge };
  }

  @Get('charges/booking/:bookingId')
  findChargeByBooking(@Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.billingService.findChargeByBooking(bookingId);
  }

  @Get('charges/subscription/:subscriptionId')
  findChargeBySubscription(@Param('subscriptionId', ParseUUIDPipe) subscriptionId: string) {
    return this.billingService.findChargeBySubscription(subscriptionId);
  }

  // Stripe devuelve aquí al usuario si abandona la página de pago
  @Get('charges/:id/cancelled')
  async paymentCancelled(@Param('id', ParseUUIDPipe) id: string) {
    const charge = await this.billingService.cancel(id);
    return { message: messageFor(charge), charge };
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