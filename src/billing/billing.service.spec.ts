import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.service.js';
import { toStripeAmount } from './stripe.gateway.js';
import { isBookingRefundable, isPlanRefundable } from './billing.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EventsService } from '../events/events.service.js';
import type { StripeGateway } from './stripe.gateway.js';

describe('BillingService', () => {
  const prisma = {
    extraCharge: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    invoice: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  };
  const events = { publish: vi.fn() };
  const stripe = { createCheckout: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() };
  let service: BillingService;

  const bookingEvent = {
    bookingId: 'booking-1',
    memberId: 'member-1',
    resourceType: 'ROOM',
    status: 'PENDING_PAYMENT',
    extraCharge: 60000,
    currency: 'COP',
  };
  const pendingCharge = {
    id: 'charge-1',
    bookingId: 'booking-1',
    memberId: 'member-1',
    amount: 60000,
    currency: 'COP',
    status: 'PENDING',
    stripeSessionId: 'cs_test_1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BillingService(
      prisma as unknown as PrismaService,
      events as unknown as EventsService,
      stripe as unknown as StripeGateway,
    );
  });

  it('no cobra reservas que no están pendientes de pago', async () => {
    const result = await service.handleBookingCreated({ ...bookingEvent, status: 'CONFIRMED', extraCharge: 0 });

    expect(result).toBeNull();
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it('crea el pago en Stripe y publica billing.payment.requested', async () => {
    prisma.extraCharge.findUnique.mockResolvedValue(null);
    prisma.extraCharge.create.mockResolvedValue({ ...pendingCharge, stripeSessionId: null });
    stripe.createCheckout.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    prisma.extraCharge.update.mockResolvedValue({
      ...pendingCharge,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });

    await service.handleBookingCreated(bookingEvent);

    expect(stripe.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'booking-1', amount: 60000, currency: 'COP' }),
    );
    expect(events.publish).toHaveBeenCalledWith(
      'billing.payment.requested',
      expect.objectContaining({ bookingId: 'booking-1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    );
  });

  it('no crea un segundo cobro si el evento llega repetido', async () => {
    prisma.extraCharge.findUnique.mockResolvedValue(pendingCharge);

    await service.handleBookingCreated(bookingEvent);

    expect(prisma.extraCharge.create).not.toHaveBeenCalled();
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it('marca el cobro como pagado cuando Stripe confirma el pago', async () => {
    prisma.extraCharge.findUnique.mockResolvedValue(pendingCharge);
    stripe.retrieve.mockResolvedValue({ payment_status: 'paid', status: 'complete' });
    prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

    await service.sync('charge-1');

    expect(prisma.extraCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'charge-1', status: 'PENDING' },
      data: { status: 'PAID', paidAt: expect.any(Date) },
    });
    expect(events.publish).toHaveBeenCalledWith(
      'billing.charge.succeeded',
      expect.objectContaining({ bookingId: 'booking-1' }),
    );
  });

  it('publica billing.charge.failed cuando el pago vence en Stripe', async () => {
    prisma.extraCharge.findUnique.mockResolvedValue(pendingCharge);
    stripe.retrieve.mockResolvedValue({ payment_status: 'unpaid', status: 'expired' });
    prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

    await service.sync('charge-1');

    expect(events.publish).toHaveBeenCalledWith(
      'billing.charge.failed',
      expect.objectContaining({ bookingId: 'booking-1', reason: 'El pago venció sin completarse' }),
    );
  });

  it('no publica dos veces si el cobro ya no estaba pendiente', async () => {
    prisma.extraCharge.findUnique.mockResolvedValue(pendingCharge);
    stripe.retrieve.mockResolvedValue({ payment_status: 'paid', status: 'complete' });
    prisma.extraCharge.updateMany.mockResolvedValue({ count: 0 });

    await service.sync('charge-1');

    expect(events.publish).not.toHaveBeenCalled();
  });

  it('libera la reserva si Stripe no puede crear el pago', async () => {
    prisma.extraCharge.findUnique.mockResolvedValueOnce(null).mockResolvedValue(pendingCharge);
    prisma.extraCharge.create.mockResolvedValue({ ...pendingCharge, stripeSessionId: null });
    stripe.createCheckout.mockRejectedValue(new Error('Stripe no disponible'));
    prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

    await service.handleBookingCreated(bookingEvent);

    expect(events.publish).toHaveBeenCalledWith(
      'billing.charge.failed',
      expect.objectContaining({ bookingId: 'booking-1' }),
    );
  });

  it('convierte montos a la unidad mínima que usa Stripe', () => {
    expect(toStripeAmount(60000, 'COP')).toBe(6000000);
    expect(toStripeAmount(350, 'MXN')).toBe(35000);
    expect(toStripeAmount(5000, 'CLP')).toBe(5000);
  });

  describe('pago del plan (Saga de la membresía)', () => {
    const planEvent = { subscriptionId: 'sub-1', memberId: 'member-1', planName: 'Flex', price: 250000, currency: 'COP' };
    const planCharge = { ...pendingCharge, id: 'charge-9', bookingId: null, subscriptionId: 'sub-1', amount: 250000 };

    it('crea el pago del primer mes en Stripe', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue(null);
      prisma.extraCharge.create.mockResolvedValue({ ...planCharge, stripeSessionId: null });
      stripe.createCheckout.mockResolvedValue({ id: 'cs_test_9', url: 'https://checkout.stripe.com/c/pay/cs_test_9' });
      prisma.extraCharge.update.mockResolvedValue({ ...planCharge, checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_9' });

      await service.handleMembershipPaymentRequested(planEvent);

      expect(prisma.extraCharge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ subscriptionId: 'sub-1', amount: 250000, reason: 'Plan Flex, primer mes' }),
      });
      expect(stripe.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ reference: 'sub-1', amount: 250000 }));
    });

    it('no crea un segundo cobro si el evento del plan llega repetido', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue(planCharge);

      await service.handleMembershipPaymentRequested(planEvent);

      expect(prisma.extraCharge.create).not.toHaveBeenCalled();
    });

    it('avisa billing.subscription.paid (no billing.charge.succeeded) cuando se paga un plan', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue(planCharge);
      stripe.retrieve.mockResolvedValue({ payment_status: 'paid', status: 'complete' });
      prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

      await service.sync('charge-9');

      expect(events.publish).toHaveBeenCalledWith(
        'billing.subscription.paid',
        expect.objectContaining({ subscriptionId: 'sub-1' }),
      );
      expect(events.publish).not.toHaveBeenCalledWith('billing.charge.succeeded', expect.anything());
    });

    it('avisa billing.subscription.failed cuando el pago del plan se cancela', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue(planCharge);
      stripe.retrieve.mockResolvedValue({ payment_status: 'unpaid', status: 'open' });
      prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel('charge-9');

      expect(events.publish).toHaveBeenCalledWith(
        'billing.subscription.failed',
        expect.objectContaining({ subscriptionId: 'sub-1', reason: 'Pago cancelado por el usuario' }),
      );
    });
  });

  describe('reembolsos', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    // Reserva hecha (cobro creado) 10 h antes de "ahora"
    const paidBooking = {
      ...pendingCharge,
      status: 'PAID',
      createdAt: new Date('2026-11-20T02:00:00Z'),
      paidAt: new Date('2026-11-20T02:05:00Z'),
      subscriptionId: null,
    };
    const paidPlan = { ...pendingCharge, id: 'charge-9', bookingId: null, subscriptionId: 'sub-1', status: 'PAID', amount: 250000 };

    it('política de reservas: arrepentimiento de 24 h desde que se reservó; el personal siempre reembolsa', () => {
      expect(isBookingRefundable(new Date('2026-11-19T12:00:00Z'), now, 'CANCELLED_BY_MEMBER')).toBe(true);
      expect(isBookingRefundable(new Date('2026-11-19T11:59:00Z'), now, 'CANCELLED_BY_MEMBER')).toBe(false);
      expect(isBookingRefundable(new Date('2026-11-01T12:00:00Z'), now, 'CANCELLED_BY_STAFF')).toBe(true);
    });

    it('política de planes: garantía de 7 días desde el pago', () => {
      expect(isPlanRefundable(new Date('2026-11-14T12:00:00Z'), now)).toBe(true);
      expect(isPlanRefundable(new Date('2026-11-12T12:00:00Z'), now)).toBe(false);
    });

    it('reembolsa una reserva pagada cancelada dentro de las 24 h y publica billing.charge.refunded', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue(paidBooking);
      stripe.refund.mockResolvedValue({ id: 're_1' });
      prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

      await service.handleBookingCancelled(
        { bookingId: 'booking-1', startTime: '2026-11-22T14:00:00Z', reason: 'CANCELLED_BY_MEMBER' },
        now,
      );

      expect(stripe.refund).toHaveBeenCalledWith('cs_test_1', 'charge-1');
      expect(prisma.extraCharge.updateMany).toHaveBeenCalledWith({
        where: { id: 'charge-1', status: 'PAID' },
        data: expect.objectContaining({ status: 'REFUNDED', stripeRefundId: 're_1' }),
      });
      expect(events.publish).toHaveBeenCalledWith(
        'billing.charge.refunded',
        expect.objectContaining({ bookingId: 'booking-1', amount: 60000 }),
      );
    });

    it('no reembolsa si se cancela más de 24 h después de reservar', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue({ ...paidBooking, createdAt: new Date('2026-11-18T12:00:00Z') });

      await service.handleBookingCancelled(
        { bookingId: 'booking-1', startTime: '2026-11-20T20:00:00Z', reason: 'CANCELLED_BY_MEMBER' },
        now,
      );

      expect(stripe.refund).not.toHaveBeenCalled();
    });

    it('no publica dos veces si el evento de cancelación llega repetido', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue(paidBooking);
      stripe.refund.mockResolvedValue({ id: 're_1' });
      prisma.extraCharge.updateMany.mockResolvedValue({ count: 0 });

      await service.handleBookingCancelled(
        { bookingId: 'booking-1', startTime: '2026-11-22T14:00:00Z', reason: 'CANCELLED_BY_MEMBER' },
        now,
      );

      expect(events.publish).not.toHaveBeenCalled();
    });

    it('reembolsa el plan cancelado dentro de 7 días y anula su factura', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue({ ...paidPlan, paidAt: new Date('2026-11-17T12:00:00Z') });
      stripe.refund.mockResolvedValue({ id: 're_2' });
      prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

      await service.handleMembershipExpired({ subscriptionId: 'sub-1', reason: 'CANCELLED' }, now);

      expect(stripe.refund).toHaveBeenCalledWith('cs_test_1', 'charge-9');
      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: { subscriptionId: 'sub-1', refundedAt: null },
        data: { refundedAt: now },
      });
    });

    it('si la reserva se cancela antes de pagar, cierra el enlace de Stripe', async () => {
      prisma.extraCharge.findUnique.mockResolvedValue(pendingCharge);
      stripe.retrieve.mockResolvedValue({ payment_status: 'unpaid', status: 'open' });
      prisma.extraCharge.updateMany.mockResolvedValue({ count: 1 });

      await service.handleBookingCancelled(
        { bookingId: 'booking-1', startTime: '2026-11-22T14:00:00Z', reason: 'CANCELLED_BY_MEMBER' },
        now,
      );

      expect(stripe.expire).toHaveBeenCalledWith('cs_test_1');
      expect(stripe.refund).not.toHaveBeenCalled();
    });

    it('no reembolsa un plan que simplemente venció', async () => {
      await service.handleMembershipExpired({ subscriptionId: 'sub-1', reason: 'NOT_RENEWED' }, now);

      expect(prisma.extraCharge.findUnique).not.toHaveBeenCalled();
      expect(stripe.refund).not.toHaveBeenCalled();
    });
  });
});
