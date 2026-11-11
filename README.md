# CoworkSpace · Billing Service

![CI-CD](https://github.com/CoworkSpace-Arquitectura/coworkspace-billing/actions/workflows/deploy.yml/badge.svg)

Microservicio de cobros y facturación. Escucha `booking.created`, crea el pago en Stripe Checkout (modo de prueba), verifica el resultado con Stripe y publica `billing.charge.succeeded` o `billing.charge.failed` para completar la Saga con Booking. Escucha `membership.activated` para registrar las facturas mensuales.

- **Endpoints:** `/charges`, `/charges/booking/:bookingId`, `/charges/return`, `/charges/:id/cancelled`, `/invoices`
- **Puerto local:** 3005
- **Reconciliación:** cada minuto revisa en Stripe los cobros pendientes
- **Tarjeta de prueba:** 4242 4242 4242 4242, cualquier fecha futura y CVC