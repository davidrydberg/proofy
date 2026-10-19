// Requirements: e2e/specs/guest-checkout.md
import { claim, exec, mail, notCovered, shot, tag, test } from "@davidrydberg/proofy/test";

test("guest checkout", async ({ page }) => {
  const guest = { name: `Guest ${tag()}`, email: `guest-${tag()}@example.test` };

  await page.goto("/product/coffee/");
  await page.getByRole("button", { name: "Add to basket" }).click();
  await shot("coffee in the basket");

  await page.goto("/checkout/");
  await page.getByLabel("Email").fill(guest.email);
  await page.getByLabel("First name").fill(guest.name);
  await page.getByRole("button", { name: "Place order" }).click();
  await shot("thank-you page");

  const orderNumber = (await page.getByTestId("order-number").textContent())?.trim() ?? "";
  claim({ spec: "R1", did: "placed the order as a guest", expected: "an order number on the thank-you page", actual: orderNumber, ok: /^\d+$/.test(orderNumber) });

  // Read the stored order, not the screen: the page can say "thank you" while nothing was saved.
  const order = JSON.parse(await exec("order", [orderNumber])) as { status: string; total: string };
  claim({ spec: "R2", did: `read order ${orderNumber}`, expected: "processing, 249.00", actual: `${order.status}, ${order.total}`, ok: order.status === "processing" && order.total === "249.00", evidence: order });

  const messages = await mail.for(guest.email);
  claim({ spec: "R3", did: `read ${guest.email}'s mail`, expected: "one email with the order number", actual: `${messages.length} emails`, ok: messages.length === 1 && messages[0]!.text.includes(orderNumber) });

  notCovered("R4", "example only: read the stock count with exec() before and after");
});
