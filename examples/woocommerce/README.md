# WooCommerce demo

A coffee shop on WordPress and WooCommerce, tested with proofy in a sealed sandbox.
Everything under `e2e/` was written by an agent following `e2e/AGENTS.md`: requirements first, then the test, then three identical runs, then a second opinion.

## Run it

```sh
cd examples/woocommerce
proofy                                    # setup and the two flows: guest-checkout, basket-quantity
proofy run guest-checkout basket-quantity # one sealed run, about 35 seconds after the first build
proofy approve guest-checkout             # you, not an agent, once you agree with e2e/specs/guest-checkout.md
proofy run --all
```

The first run builds the shop image, which downloads WordPress, WooCommerce and wp-cli.
After that the sandbox has no internet.

## What is here

| File | What |
|---|---|
| `compose.yml`, `Dockerfile` | The shop: WordPress 7 with WooCommerce, MariaDB on tmpfs, mail sent to Mailpit |
| `seed.sh` | Prepares the empty database: store settings, cash on delivery, one coffee with stock 10 |
| `e2e/proofy.json` | Where the browser starts, the seed, and `wp` for tests to read orders and stock |
| `e2e/specs/` | The requirements, in plain words |
| `e2e/tests/` | The tests, one claim per requirement, checked against stored orders, stock and Mailpit |

## What the second opinion changed

A separate agent read only the requirements and tests and answered, per requirement, "what wrong behaviour would still pass?".
That led to these changes:

- The order number is read from the stored order, not from the page address.
- The stored order must use cash on delivery, hold exactly one coffee and have no customer account.
- "Exactly one email" waits for quiet, so a late second email is caught.
- The privacy check searches by this test's unique name and includes cc and bcc.
- The basket checks the starting quantity, the item itself, and that the page shows the empty basket.

The flows are left unapproved on purpose: approving is your call.
