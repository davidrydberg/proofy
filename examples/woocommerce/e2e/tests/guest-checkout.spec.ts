// Requirements: e2e/specs/guest-checkout.md
import { claim, exec, mail, shot, tag, test } from "@davidrydberg/proofy/test";

interface Order {
  number: string;
  status: string;
  total: string;
  currency: string;
  payment_method: string;
  customer_id: number;
  billing: { email: string };
  line_items: Array<{ sku: string; quantity: number }>;
}

const wc = async <T>(...args: string[]): Promise<T> => JSON.parse(await exec("wp", ["wc", ...args, "--user=admin", "--format=json"])) as T;

test("guest checkout with cash on delivery", async ({ page }) => {
  const guest = { first: "Guest", last: tag(), email: `guest-${tag()}@example.test` };
  const [coffee] = await wc<Array<{ id: number; stock_quantity: number }>>("product", "list", "--sku=COFFEE", "--fields=id,stock_quantity");
  const stockBefore = coffee!.stock_quantity;

  await page.goto("/product/coffee/");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("alert").or(page.locator(".woocommerce-message")).first().waitFor();
  await shot("coffee added to the basket");

  await page.goto("/checkout/");
  await page.locator("#billing_first_name").fill(guest.first);
  await page.locator("#billing_last_name").fill(guest.last);
  await page.locator("#billing_address_1").fill("Storgatan 2");
  await page.locator("#billing_postcode").fill("211 22");
  await page.locator("#billing_city").fill("Malmo");
  await page.locator("#billing_phone").fill("0701234567");
  await page.locator("#billing_email").fill(guest.email);
  await shot("checkout filled in");
  await page.locator("#place_order").click();
  await page.waitForURL(/order-received\/\d+/);
  await shot("order confirmation");

  // The address holds the order's ID; the number shown to people is stored on the order and can differ.
  const id = /order-received\/(\d+)/.exec(page.url())?.[1] ?? "0";
  const order = await wc<Order>("shop_order", "get", id);
  const number = order.number;
  const pageText = await page.locator("main").innerText();
  const onPage = new RegExp(`Order\\s*(#|number)?:?\\s*${number}\\b`, "i").test(pageText);
  claim({ spec: "R1", did: "placed the order and read the stored order", expected: `confirmation page showing order ${number}`, actual: onPage ? `shows order ${number}` : `page does not show ${number}`, ok: onPage && /received/i.test(pageText) });

  const line = order.line_items[0];
  claim({
    spec: "R2",
    did: `read order ${number} with wp-cli`,
    expected: `processing, cod, 1 x COFFEE, 120.00 SEK, billed to ${guest.email}, no account`,
    actual: `${order.status}, ${order.payment_method}, ${order.line_items.map((item) => `${item.quantity} x ${item.sku}`).join(" + ")}, ${order.total} ${order.currency}, billed to ${order.billing.email}, customer ${order.customer_id}`,
    ok:
      order.status === "processing" &&
      order.payment_method === "cod" &&
      order.line_items.length === 1 &&
      line?.sku === "COFFEE" &&
      line.quantity === 1 &&
      Number(order.total) === 120 &&
      order.currency === "SEK" &&
      order.billing.email === guest.email &&
      order.customer_id === 0,
    evidence: { status: order.status, payment_method: order.payment_method, line_items: order.line_items, total: order.total, currency: order.currency, billing_email: order.billing.email, customer_id: order.customer_id },
  });

  // Wait 30 seconds at most, then 5 more seconds of quiet, so a late second email is counted.
  const mine = await mail.for(guest.email, { timeoutMs: 30_000, settleMs: 5_000 });
  const hasNumber = new RegExp(`(#|order\\s*(number)?:?\\s*)${number}\\b`, "i");
  claim({
    spec: "R3",
    did: `read ${guest.email}'s mail`,
    expected: `exactly one email showing order ${number}`,
    actual: `${mine.length} email(s): ${mine.map((m) => m.subject).join(" | ")}`,
    ok: mine.length === 1 && hasNumber.test(`${mine[0]!.subject}\n${mine[0]!.text}`),
  });

  const { stock_quantity: stockAfter } = await wc<{ stock_quantity: number }>("product", "get", String(coffee!.id), "--fields=stock_quantity");
  claim({ spec: "R4", did: "read the coffee's stock before and after", expected: `${stockBefore - 1}`, actual: `${stockAfter}`, ok: stockAfter === stockBefore - 1 });

  // The guest's last name is this test's tag(), so these searches only find this order's emails.
  const about = [...(await mail.search(guest.last, { atLeast: 2, settleMs: 3_000 })), ...(await mail.search(`"${number}"`, { atLeast: 0 }))];
  const recipients = [...new Set(about.flatMap((m) => [...m.to, ...m.cc, ...m.bcc]))].sort();
  claim({
    spec: "R5",
    did: "found every email naming the guest or the order, with cc and bcc",
    expected: `only ${guest.email} and owner@shop.test`,
    actual: recipients.join(", ") || "no emails",
    ok: recipients.length > 0 && recipients.every((to) => to === guest.email || to === "owner@shop.test"),
  });
});
