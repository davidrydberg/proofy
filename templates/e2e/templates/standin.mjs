// Fake for api.example-payments.com.
// Written from the provider's public docs: https://docs.example-payments.com/api/payments
// Never from what this app sends: a fake that copies the app agrees with every bug in it.
// Save as e2e/standins/<host>.mjs and list the host as "fake" in e2e/proofy.json.

/**
 * Called for every request to this host. proofy records every request before calling it.
 * @param {{ method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: string, json: unknown }} req
 * @param {{ state: Map<string, unknown> }} ctx state lives for one run, shared by every request to this host
 * @returns {{ status: number, json?: unknown, body?: string, headers?: Record<string, string> }}
 */
export default function handle(req, ctx) {
  if (req.method === "POST" && req.path === "/v1/payments") {
    const amount = req.json?.amount;
    // Reject what the real service rejects, as its docs describe, so a wrong request from the app shows up as red.
    if (!Number.isInteger(amount) || amount <= 0) {
      return { status: 400, json: { error: { code: "amount_invalid", message: "amount must be a positive integer in minor units" } } };
    }
    const id = `pay_${ctx.state.size + 1}`;
    const payment = { id, amount, currency: req.json.currency, status: "succeeded" };
    ctx.state.set(id, payment);
    return { status: 201, json: payment };
  }
  if (req.method === "GET" && req.path.startsWith("/v1/payments/")) {
    const payment = ctx.state.get(req.path.slice("/v1/payments/".length));
    return payment ? { status: 200, json: payment } : { status: 404, json: { error: { code: "not_found" } } };
  }
  return { status: 404, json: { error: { code: "not_faked", message: `${req.method} ${req.path} is not in this fake` } } };
}
