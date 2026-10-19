import { claim, exec, mail, notCovered, shot, standin, tag, test } from "@davidrydberg/proofy/test";

test("buy coffee", async ({ page }) => {
  const email = `buyer-${tag()}@example.test`;
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await shot("email filled in");
  await page.getByRole("button", { name: "Buy" }).click();
  const id = ((await page.getByTestId("order").textContent()) ?? "").trim();
  await shot("thank you");
  claim({ spec: "R1", did: "bought one coffee", expected: "an order number", actual: id, ok: /^\d+$/.test(id) });

  const order = JSON.parse(await exec("order", [`http://localhost:3000/api/orders/${id}`])) as { status: string; total: number };
  claim({ spec: "R2", did: `read order ${id}`, expected: "paid, 120", actual: `${order.status}, ${order.total}`, ok: order.status === "paid" && order.total === 120, evidence: order });

  const payments = await standin.requests("api.payments.test", { atLeast: 1 });
  const sent = payments.map((request) => JSON.parse(request.body) as { amount: number; currency: string });
  claim({ spec: "R3", did: "read the requests the provider received", expected: "one charge of 12000 SEK", actual: sent, ok: sent.some((p) => p.amount === 12000 && p.currency === "SEK") });

  const messages = await mail.for(email);
  claim({ spec: "R4", did: `read ${email}'s mail`, expected: "one email with the order number", actual: `${messages.length} emails`, ok: messages.length === 1 && messages[0]!.text.includes(id) });

  notCovered("R5", "the provider's own page cannot load in the sealed sandbox");
});
