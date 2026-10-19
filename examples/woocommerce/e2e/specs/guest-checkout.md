# Guest checkout

Asked by: the shop owner.
A guest buys one bag of coffee and pays cash on delivery.

## Requirements

R1. After placing the order, the guest sees a confirmation page showing the stored order's number.
R2. The order is stored with status "processing", payment method cash on delivery, one line of one coffee, a total of 120.00 SEK, the guest's email as billing email, and no customer account.
R3. Within 30 seconds the guest receives exactly one email, and it shows the order number.
R4. Stock for the coffee goes down by exactly one.

## Must never happen

R5. No email that names the guest or the order number goes to anyone but the guest or the shop (owner@shop.test), not even as a copy (cc or bcc).

## Not covered

- Paying by card inside a payment provider's own fields: the sandbox is sealed, so the provider's browser code cannot load.
