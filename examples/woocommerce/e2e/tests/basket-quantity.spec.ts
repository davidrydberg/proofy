// Requirements: e2e/specs/basket-quantity.md
import { claim, shot, test } from "@davidrydberg/proofy/test";

interface Cart {
  items_count: number;
  items: Array<{ sku: string; quantity: number }>;
  totals: { total_price: string; currency_code: string; currency_minor_unit: number };
}

test("change the basket quantity", async ({ page }) => {
  // The shop's own cart API, read in the same browser session: the stored basket, not just what the page says.
  const cart = async (): Promise<Cart> => (await (await page.request.get("/wp-json/wc/store/v1/cart")).json()) as Cart;
  const amount = (c: Cart) => Number(c.totals.total_price) / 10 ** c.totals.currency_minor_unit;

  await page.goto("/product/coffee/");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("alert").or(page.locator(".woocommerce-message")).first().waitFor();

  await page.goto("/cart/");
  const one = await cart();
  // Updating the basket posts the cart form and redraws it; wait for that answer, not for a notice.
  const update = async (quantity: string) => {
    await page.locator("input.qty").fill(quantity);
    await Promise.all([page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/cart")), page.locator("button[name=update_cart]").click()]);
    await page.waitForLoadState("networkidle");
  };
  await update("3");
  await shot("three bags in the basket");
  const three = await cart();
  const shown = ((await page.locator(".cart_totals .order-total .amount").textContent()) ?? "").trim();
  claim({
    spec: "R1",
    did: "set the quantity to 3 and updated the basket",
    expected: "1 coffee before; then 3 x COFFEE, 360.00 SEK stored and shown",
    actual: `before ${one.items_count}; then ${three.items.map((item) => `${item.quantity} x ${item.sku}`).join(" + ")}, stored ${amount(three)} ${three.totals.currency_code}; shown "${shown}"`,
    ok:
      one.items_count === 1 &&
      three.items.length === 1 &&
      three.items[0]!.sku === "COFFEE" &&
      three.items[0]!.quantity === 3 &&
      amount(three) === 360 &&
      three.totals.currency_code === "SEK" &&
      shown.replace(/[^\d.]/g, "") === "360.00",
    evidence: three.totals,
  });

  await update("0");
  await shot("basket emptied");
  const empty = await cart();
  const emptyShown = await page.getByText("Your cart is currently empty").first().isVisible();
  const rows = await page.locator("input.qty").count();
  claim({
    spec: "R2",
    did: "set the quantity to 0 and updated the basket",
    expected: "0 items stored, the empty-basket notice shown, no item rows",
    actual: `${empty.items_count} items stored, notice ${emptyShown ? "shown" : "missing"}, ${rows} item rows`,
    ok: empty.items_count === 0 && emptyShown && rows === 0,
  });
});
