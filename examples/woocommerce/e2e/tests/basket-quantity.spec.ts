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
    expected: { before: 1, items: [{ sku: "COFFEE", quantity: 3 }], stored: 360, currency: "SEK", shown: "360.00" },
    actual: {
      before: one.items_count,
      items: three.items.map(({ sku, quantity }) => ({ sku, quantity })),
      stored: amount(three),
      currency: three.totals.currency_code,
      shown: shown.replace(/[^\d.]/g, ""),
    },
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
    expected: { itemsStored: 0, emptyNotice: "shown", itemRows: 0 },
    actual: { itemsStored: empty.items_count, emptyNotice: emptyShown ? "shown" : "missing", itemRows: rows },
  });
});
