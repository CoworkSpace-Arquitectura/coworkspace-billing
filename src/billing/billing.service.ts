import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChargeStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsService } from '../events/events.service.js';
import { StripeGateway } from './stripe.gateway.js';

export interface BookingCreatedData {
  bookingId: string;
  memberId: string;
  resourceType: string;
  status: string;
  extraCharge: number;
  currency?: string;
}

export interface MembershipActivatedData {
  subscriptionId: string;
  memberId: string;
  planName: string;
  price: number;
  renewsAt: string;
  renewal: boolean;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly stripe: StripeGateway,
  ) {}

  // Saga, paso 2: una reserva quedó pendiente de pago → se crea el cobro en Stripe
  async handleBookingCreated(data: BookingCreatedData) {
    if (data.status !== 'PENDING_PAYMENT' || data.extraCharge <= 0) {
      return null;
    }

    const existing = await this.prisma.extraCharge.findUnique({ where: { bookingId: data.bookingId } });
    if (existing) {
      this.logger.warn(`El cobro de la reserva ${data.bookingId} ya existe`);
      return existing;
    }

    const currency = data.currency ?? 'COP';
    const reason = `Reserva de ${data.resourceType === 'ROOM' ? 'sala' : 'puesto'} fuera del plan`;
    const charge = await this.prisma.extraCharge.create({
      data: { bookingId: data.bookingId, memberId: data.memberId, amount: data.extraCharge, currency, reason },
    });

    try {
      const session = await this.stripe.createCheckout({
        chargeId: charge.id,
        bookingId: charge.bookingId,
        amount: charge.amount,
        currency: charge.currency,
        description: `CoworkSpace · ${reason}`,
      });
      const updated = await this.prisma.extraCharge.update({
        where: { id: charge.id },
        data: { stripeSessionId: session.id, checkoutUrl: session.url },
      });
      await this.events.publish('billing.payment.requested', {
        chargeId: updated.id,
        bookingId: updated.bookingId,
        memberId: updated.memberId,
        amount: updated.amount,
        currency: updated.currency,
        checkoutUrl: updated.checkoutUrl,
      });
      this.logger.log(`Pago creado en Stripe para la reserva ${updated.bookingId}`);
      return updated;
    } catch (error) {
      await this.markFailed(charge.id, `No se pudo crear el pago en Stripe: ${(error as Error).message}`);
      return null;
    }
  }

  // Le pregunta a Stripe el estado real del pago
  async sync(chargeId: string) {
    const charge = await this.findCharge(chargeId);
    if (charge.status !== ChargeStatus.PENDING || !charge.stripeSessionId) {
      return charge;
    }

    const session = await this.stripe.retrieve(charge.stripeSessionId);
    if (session.payment_status === 'paid') {
      await this.markPaid(charge.id);
    } else if (session.status === 'expired') {
      await this.markFailed(charge.id, 'El pago venció sin completarse');
    }
    return this.findCharge(chargeId);
  }

  async syncBySession(sessionId: string) {
    const charge = await this.prisma.extraCharge.findUnique({ where: { stripeSessionId: sessionId } });
    if (!charge) {
      throw new NotFoundException(`No hay un cobro para la sesión ${sessionId}`);
    }
    return this.sync(charge.id);
  }

  // El usuario abandonó la página de pago → se cancela en Stripe y se libera la reserva
  async cancel(chargeId: string) {
    const charge = await this.sync(chargeId);
    if (charge.status !== ChargeStatus.PENDING) {
      return charge;
    }
    if (charge.stripeSessionId) {
      try {
        await this.stripe.expire(charge.stripeSessionId);
      } catch (error) {
        this.logger.warn(`No se pudo vencer la sesión en Stripe: ${(error as Error).message}`);
      }
    }
    await this.markFailed(charge.id, 'Pago cancelado por el usuario');
    return this.findCharge(chargeId);
  }

  // Reconciliación: cada minuto revisa en Stripe los cobros que siguen pendientes
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcilePending() {
    const pending = await this.prisma.extraCharge.findMany({
      where: { status: ChargeStatus.PENDING, stripeSessionId: { not: null } },
      select: { id: true },
    });
    for (const charge of pending) {
      try {
        await this.sync(charge.id);
      } catch (error) {
        this.logger.warn(`No se pudo reconciliar el cobro ${charge.id}: ${(error as Error).message}`);
      }
    }
    return { checked: pending.length };
  }

  async invoiceMembership(data: MembershipActivatedData) {
    const period = data.renewsAt.slice(0, 10);
    const existing = await this.prisma.invoice.findUnique({
      where: { subscriptionId_period: { subscriptionId: data.subscriptionId, period } },
    });
    if (existing) {
      return existing;
    }
    const invoice = await this.prisma.invoice.create({
      data: {
        memberId: data.memberId,
        subscriptionId: data.subscriptionId,
        planName: data.planName,
        period,
        amount: data.price,
      },
    });
    await this.events.publish('billing.invoice.created', {
      invoiceId: invoice.id,
      memberId: invoice.memberId,
      amount: invoice.amount,
      period: invoice.period,
      renewal: data.renewal,
    });
    return invoice;
  }

  findCharges(memberId?: string) {
    return this.prisma.extraCharge.findMany({ where: { memberId }, orderBy: { createdAt: 'desc' } });
  }

  async findChargeByBooking(bookingId: string) {
    const charge = await this.prisma.extraCharge.findUnique({ where: { bookingId } });
    if (!charge) {
      throw new NotFoundException(`No hay un cobro para la reserva ${bookingId}`);
    }
    return charge;
  }

  findInvoices(memberId?: string) {
    return this.prisma.invoice.findMany({ where: { memberId }, orderBy: { createdAt: 'desc' } });
  }

  private async findCharge(id: string) {
    const charge = await this.prisma.extraCharge.findUnique({ where: { id } });
    if (!charge) {
      throw new NotFoundException(`Cobro ${id} no encontrado`);
    }
    return charge;
  }

  // Saga, paso 3: pago aprobado
  private async markPaid(chargeId: string) {
    const { count } = await this.prisma.extraCharge.updateMany({
      where: { id: chargeId, status: ChargeStatus.PENDING },
      data: { status: ChargeStatus.PAID },
    });
    if (count === 0) {
      return;
    }
    const charge = await this.findCharge(chargeId);
    await this.events.publish('billing.charge.succeeded', {
      chargeId: charge.id,
      bookingId: charge.bookingId,
      memberId: charge.memberId,
      amount: charge.amount,
      currency: charge.currency,
    });
    this.logger.log(`Pago aprobado para la reserva ${charge.bookingId}`);
  }

  // Saga, paso 3: pago fallido → Booking compensará liberando la reserva
  private async markFailed(chargeId: string, reason: string) {
    const { count } = await this.prisma.extraCharge.updateMany({
      where: { id: chargeId, status: ChargeStatus.PENDING },
      data: { status: ChargeStatus.FAILED, failureReason: reason },
    });
    if (count === 0) {
      return;
    }
    const charge = await this.findCharge(chargeId);
    await this.events.publish('billing.charge.failed', {
      chargeId: charge.id,
      bookingId: charge.bookingId,
      memberId: charge.memberId,
      amount: charge.amount,
      currency: charge.currency,
      reason,
    });
    this.logger.log(`Pago fallido para la reserva ${charge.bookingId}: ${reason}`);
  }
}