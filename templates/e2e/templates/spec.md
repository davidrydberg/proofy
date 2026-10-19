# Guest checkout

Asked by: the shop owner, 2026-10-20.
A guest buys one product and pays with an offline payment method.

## Requirements

R1. After paying, the guest sees a thank-you page with an order number.
R2. The order with that number has status "processing" and a total of 249.00 SEK including shipping.
R3. The guest receives one confirmation email with the order number.
R4. Stock for the product goes down by one.

## Must never happen

R5. Leaving the payment step without paying creates no order.
R6. The confirmation email goes to anyone but the guest.

## Not covered

- Paying by card inside the provider's own card fields: the sandbox is sealed, so the provider's browser code cannot load.
