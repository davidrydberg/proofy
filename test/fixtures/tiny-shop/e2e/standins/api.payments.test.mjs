// Fake payment provider for the fixture, from its (imaginary) public docs.
export default function handle(req, ctx) {
  if (req.method === "POST" && req.path === "/v1/payments") {
    if (!Number.isInteger(req.json?.amount) || req.json.amount <= 0) return { status: 400, json: { error: "amount_invalid" } };
    const id = `pay_${ctx.state.size + 1}`;
    ctx.state.set(id, req.json);
    return { status: 201, json: { id, status: "succeeded" } };
  }
  return { status: 404, json: { error: "not_faked" } };
}
