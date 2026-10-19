import { connect, createServer } from "node:net";

// Opens ports of the sealed sandbox to the host for `proofy dev up`. This container is the only one with a
// second network; the app itself stays on the sealed one. Arguments: listenPort=host:port ...
for (const pair of process.argv.slice(2)) {
  const [listen = "", target = ""] = pair.split("=");
  const [host = "", port = ""] = target.split(":");
  createServer((client) => {
    const upstream = connect(Number(port), host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  }).listen(Number(listen));
}
