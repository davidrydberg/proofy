// A tiny shop for proofy's own Docker test: one page, one order endpoint, a payment provider, tracking and mail.
import { createServer } from "node:http";
import { connect } from "node:net";

const orders = new Map();

function sendMail(to, subject, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(1025, process.env.SMTP_HOST);
    const lines = ["HELO shop", "MAIL FROM:<shop@tiny.test>", `RCPT TO:<${to}>`, "DATA", `Subject: ${subject}\r\nTo: ${to}\r\nFrom: shop@tiny.test\r\n\r\n${text}\r\n.`, "QUIT"];
    socket.on("data", () => {
      const line = lines.shift();
      if (line) socket.write(`${line}\r\n`);
    });
    socket.on("close", resolve);
    socket.on("error", reject);
  });
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Tiny shop</title><h1>Coffee, 120 SEK</h1>
<form method="post" action="/order"><label>Email <input name="email" type="email"></label><button>Buy</button></form>`);
    return;
  }
  if (req.method === "POST" && req.url === "/order") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const email = new URLSearchParams(body).get("email") ?? "";
    const payment = await fetch("https://api.payments.test/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk_sandbox" },
      body: JSON.stringify({ amount: 12000, currency: "SEK" }),
    }).then((r) => r.json());
    await fetch("http://tracker.example.com/event", { method: "POST", body: JSON.stringify({ event: "order" }) });
    await fetch("https://cdn.unlisted.example.org/pixel").catch(() => undefined);
    const id = String(orders.size + 1001);
    orders.set(id, { id, email, status: payment.status === "succeeded" ? "paid" : "failed", total: 120 });
    await sendMail(email, `Order ${id}`, `Thanks for order ${id}.`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><h1>Thank you</h1><p data-testid="order">${id}</p>`);
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/orders/")) {
    const order = orders.get(req.url.split("/").pop());
    res.writeHead(order ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(order ?? { error: "not found" }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(3000);
