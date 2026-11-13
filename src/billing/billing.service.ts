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

export interface BookingCancelledData {
  bookingId: string;
  startTime: string;
  reason: string;
}

export interface MembershipExpiredData {
  subscriptionId: string;
  reason: string;
}

/** Política de reembolsos de CoworkSpace */
export const BOOKING_REFUND_HOURS = 24;
export const PLAN_GUARANTEE_DAYS = 7;
const HOUR = 60 * 60 * 1000;

/**
 * Una reserva pagada se reembolsa completa si se cancela con 24 h o más de anticipación.
 * Si la cancela el personal de la sede, siempre se reembolsa (no es culpa del cliente).
 */
export function isBookingRefundable(startTime: Date, now: Date, reason: string) {
  return reason === 'CANCELLED_BY_STAFF' || startTime.getTime() - now.getTime() >= BOOKING_REFUND_HOURS * HOUR;
}

/** Garantía de satisfacción: el plan se reembolsa si se cancela en los 7 días siguientes al pago. */
export function isPlanRefundable(paidAt: Date, now: Date) {
  return now.getTime() - paidAt.getTime() <= PLAN_GUARANTEE_DAYS * 24 * HOUR;
}

export interface MembershipPaymentRequestedData {
  subscriptionId: string;
  memberId: string;
  planName: string;
  price: number;
  currency?: string;
}

type Charge = {
  id: string;
  bookingId: string | null;
  subscriptionId: string | null;
  memberId: string;
  amount: number;
  currency: string;
  checkoutUrl: string | null;
  stripeSessionId?: string | null;
};

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
    return this.openCheckout(charge, reason);
  }

  // Saga del plan, paso 2: Membership pidió cobrar el primer mes → se crea el pago en Stripe
  async handleMembershipPaymentRequested(data: MembershipPaymentRequestedData) {
    if (data.price <= 0) {
      return null;
    }
    const existing = await this.prisma.extraCharge.findUnique({ where: { subscriptionId: data.subscriptionId } });
    if (existing) {
      this.logger.warn(`El cobro de la suscripción ${data.subscriptionId} ya existe`);
      return existing;
    }
    const reason = `Plan ${data.planName}, primer mes`;
    const charge = await this.prisma.extraCharge.create({
      data: {
        subscriptionId: data.subscriptionId,
        memberId: data.memberId,
        amount: data.price,
        currency: data.currency ?? 'COP',
        reason,
      },
    });
    return this.openCheckout(charge, reason);
  }

  /** Crea la sesión de pago en Stripe para un cobro ya registrado (reserva o plan). */
  private async openCheckout(charge: Charge, reason: string) {
    try {
      const session = await this.stripe.createCheckout({
        chargeId: charge.id,
        reference: charge.bookingId ?? charge.subscriptionId ?? charge.id,
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
        subscriptionId: updated.subscriptionId,
        memberId: updated.memberId,
        amount: updated.amount,
        currency: updated.currency,
        checkoutUrl: updated.checkoutUrl,
      });
      this.logger.log(`Pago creado en Stripe: ${reason}`);
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

  // Compensación de un pago ya hecho: se canceló una reserva pagada
  async handleBookingCancelled(data: BookingCancelledData, now = new Date()) {
    if (data.reason === 'PAYMENT_REJECTED') {
      return null; // nunca se pagó: no hay nada que devolver
    }
    const charge = await this.prisma.extraCharge.findUnique({ where: { bookingId: data.bookingId } });
    if (charge?.status === ChargeStatus.PENDING) {
      // Se canceló antes de pagar: se cierra el enlace de Stripe para que no se pueda pagar algo cancelado
      return this.cancel(charge.id);
    }
    if (!charge || charge.status !== ChargeStatus.PAID) {
      return null;
    }
    if (!isBookingRefundable(new Date(data.startTime), now, data.reason)) {
      this.logger.log(`Reserva ${data.bookingId} cancelada con menos de ${BOOKING_REFUND_HOURS} h: sin reembolso`);
      return null;
    }
    return this.refund(charge, 'Reserva cancelada a tiempo');
  }

  // Compensación de un pago ya hecho: se canceló un plan dentro de la garantía
  async handleMembershipExpired(data: MembershipExpiredData, now = new Date()) {
    if (data.reason !== 'CANCELLED') {
      return null; // un plan que vence solo no se reembolsa
    }
    const charge = await this.prisma.extraCharge.findUnique({ where: { subscriptionId: data.subscriptionId } });
    if (!charge || charge.status !== ChargeStatus.PAID || !charge.paidAt) {
      return null;
    }
    if (!isPlanRefundable(charge.paidAt, now)) {
      this.logger.log(`Plan ${data.subscriptionId} cancelado después de ${PLAN_GUARANTEE_DAYS} días: sin reembolso`);
      return null;
    }
    const refunded = await this.refund(charge, `Garantía de ${PLAN_GUARANTEE_DAYS} días`);
    if (refunded) {
      // La factura del mes reembolsado deja de contar como ingreso
      await this.prisma.invoice.updateMany({
        where: { subscriptionId: data.subscriptionId, refundedAt: null },
        data: { refundedAt: now },
      });
    }
    return refunded;
  }

  /** Pide el reembolso a Stripe y deja el cobro en REFUNDED. Idempotente. */
  private async refund(charge: Charge, reason: string) {
    if (!charge.stripeSessionId) {
      return null;
    }
    try {
      const refund = await this.stripe.refund(charge.stripeSessionId, charge.id);
      const { count } = await this.prisma.extraCharge.updateMany({
        where: { id: charge.id, status: ChargeStatus.PAID },
        data: { status: ChargeStatus.REFUNDED, refundedAt: new Date(), stripeRefundId: refund.id },
      });
      if (count === 0) {
        return null; // otro proceso ya lo reembolsó
      }
      await this.events.publish('billing.charge.refunded', {
        chargeId: charge.id,
        bookingId: charge.bookingId,
        subscriptionId: charge.subscriptionId,
        memberId: charge.memberId,
        amount: charge.amount,
        currency: charge.currency,
        reason,
      });
      this.logger.log(`Reembolso de ${charge.amount} ${charge.currency} (${reason})`);
      return this.findCharge(charge.id);
    } catch (error) {
      this.logger.error(`No se pudo reembolsar el cobro ${charge.id}: ${(error as Error).message}`);
      return null;
    }
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

  /**
   * Cargos adicionales de reservas. Los pagos de planes no se listan aquí porque
   * ya aparecen como facturas (así Analytics no cuenta dos veces el mismo dinero).
   */
  findCharges(memberId?: string) {
    return this.prisma.extraCharge.findMany({
      where: { memberId, bookingId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findChargeBySubscription(subscriptionId: string) {
    const charge = await this.prisma.extraCharge.findUnique({ where: { subscriptionId } });
    if (!charge) {
      throw new NotFoundException(`No hay un cobro para la suscripción ${subscriptionId}`);
    }
    return charge;
  }

  async findChargeByBooking(bookingId: string) {
    const charge = await this.prisma.extraCharge.findUnique({ where: { bookingId } });
    if (!charge) {
      throw new NotFoundException(`No hay un cobro para la reserva ${bookingId}`);
    }
    return charge;
  }

  /** Facturas vigentes: las de planes reembolsados no cuentan como ingreso. */
  findInvoices(memberId?: string) {
    return this.prisma.invoice.findMany({ where: { memberId, refundedAt: null }, orderBy: { createdAt: 'desc' } });
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
      data: { status: ChargeStatus.PAID, paidAt: new Date() },
    });
    if (count === 0) {
      return;
    }
    const charge = await this.findCharge(chargeId);
    if (charge.subscriptionId) {
      // Pago de un plan: Membership lo escucha y activa la suscripción
      await this.events.publish('billing.subscription.paid', {
        chargeId: charge.id,
        subscriptionId: charge.subscriptionId,
        memberId: charge.memberId,
        amount: charge.amount,
        currency: charge.currency,
      });
      this.logger.log(`Pago aprobado para la suscripción ${charge.subscriptionId}`);
      return;
    }
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
    if (charge.subscriptionId) {
      // Pago de un plan: Membership descarta la suscripción pendiente (compensación)
      await this.events.publish('billing.subscription.failed', {
        chargeId: charge.id,
        subscriptionId: charge.subscriptionId,
        memberId: charge.memberId,
        amount: charge.amount,
        currency: charge.currency,
        reason,
      });
      this.logger.log(`Pago fallido para la suscripción ${charge.subscriptionId}: ${reason}`);
      return;
    }
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