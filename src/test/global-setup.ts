// Runs once in the runner container before any test: waits until the app answers, so a slow boot is reported
// as an environment problem instead of as failed requirements.
export default async function globalSetup(): Promise<void> {
  const url = process.env.PROOFY_BASE_URL ?? "";
  const deadline = Date.now() + Number(process.env.PROOFY_START_MS ?? 600_000);
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`proofy: the app at ${url} did not answer in time (last: ${last})`);
}
