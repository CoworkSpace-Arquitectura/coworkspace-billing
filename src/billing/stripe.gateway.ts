import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

// Monedas sin centavos según Stripe: el monto se envía tal cual
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function toStripeAmount(amount: number, currency: string) {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(amount) : Math.round(amount * 100);
}

export interface CheckoutRequest {
  chargeId: string;
  bookingId: string;
  amount: number;
  currency: string;
  description: string;
}

@Injectable()
export class StripeGateway {
  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');
  private readonly publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3005';
  private readonly frontendUrl = process.env.FRONTEND_URL;

  createCheckout(request: CheckoutRequest) {
    return this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: request.currency.toLowerCase(),
            unit_amount: toStripeAmount(request.amount, request.currency),
            product_data: { name: request.description },
          },
        },
      ],
      client_reference_id: request.bookingId,
      metadata: { chargeId: request.chargeId, bookingId: request.bookingId },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
            success_url: this.frontendUrl
        ? `${this.frontendUrl}/pago/?session_id={CHECKOUT_SESSION_ID}`
        : `${this.publicUrl}/charges/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: this.frontendUrl
        ? `${this.frontendUrl}/pago/?cancelled=${request.chargeId}`
        : `${this.publicUrl}/charges/${request.chargeId}/cancelled`,
    });
  }

  retrieve(sessionId: string) {
    return this.stripe.checkout.sessions.retrieve(sessionId);
  }

  expire(sessionId: string) {
    return this.stripe.checkout.sessions.expire(sessionId);
  }
}