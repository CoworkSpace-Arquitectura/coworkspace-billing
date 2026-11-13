import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.service.js';
import { toStripeAmount } from './stripe.gateway.js';
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
    invoice: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  };
  const events = { publish: vi.fn() };
  const stripe = { createCheckout: vi.fn(), retrieve: vi.fn(), expire: vi.fn() };
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
      data: { status: 'PAID' },
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
});
