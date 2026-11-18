import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/setup-app.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { BillingService } from '../../src/billing/billing.service.js';
import { StripeGateway } from '../../src/billing/stripe.gateway.js';

/**
 * Integración de la Saga de pago con PostgreSQL real:
 * llega booking.created → se crea el cobro con su enlace de pago → se confirma el pago.
 * Stripe (servicio externo) se sustituye por un doble que simula la pasarela.
 */
describe('Cobros (integración con la base de datos)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const bookingId = randomUUID();
  const memberId = randomUUID();
  let paid = false;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeGateway)
      .useValue({
        createCheckout: () => Promise.resolve({ id: 'cs_test_integracion', url: 'https://checkout.stripe.com/c/pay/cs_test_integracion' }),
        retrieve: () => Promise.resolve(paid ? { payment_status: 'paid', status: 'complete' } : { payment_status: 'unpaid', status: 'open' }),
        expire: () => Promise.resolve({}),
        refund: () => Promise.resolve({ id: 're_test' }),
      })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.extraCharge.deleteMany({ where: { bookingId } });
    await app.close();
  });

  it('crea el cobro de una reserva pendiente de pago y lo expone por la API', async () => {
    // Lo que hace el listener al recibir el evento booking.created
    await app.get(BillingService).handleBookingCreated({
      bookingId,
      memberId,
      resourceType: 'ROOM',
      status: 'PENDING_PAYMENT',
      extraCharge: 60000,
      currency: 'COP',
    });

    const res = await request(app.getHttpServer()).get(`/charges/booking/${bookingId}`).expect(200);
    expect(res.body).toMatchObject({ bookingId, memberId, amount: 60000, currency: 'COP', status: 'PENDING' });
    expect(res.body.checkoutUrl).toContain('checkout.stripe.com');
  });

  it('al confirmar Stripe el pago, el cobro queda PAGADO en la base de datos', async () => {
    paid = true;
    const charge = await prisma.extraCharge.findUniqueOrThrow({ where: { bookingId } });

    const res = await request(app.getHttpServer()).post(`/charges/${charge.id}/sync`).expect(201);
    expect(res.body.status).toBe('PAID');

    const stored = await prisma.extraCharge.findUniqueOrThrow({ where: { bookingId } });
    expect(stored.paidAt).not.toBeNull();
  });
});
