import { claim, exec, standin, test } from "@davidrydberg/proofy/test";

test("sealed", async () => {
  let reached: string;
  try {
    await exec("reach", ["http://1.1.1.1/"]);
    reached = "yes";
  } catch (error) {
    reached = `no: ${(error as Error).message.slice(0, 80)}`;
  }
  claim({ spec: "R1", did: "fetched http://1.1.1.1/ from the app container", expected: "no connection", actual: reached, ok: reached.startsWith("no") });

  let answer: string;
  try {
    answer = await exec("reach", ["http://example.com/"]);
  } catch (error) {
    answer = (error as Error).message;
  }
  const seen = await standin.requests("example.com", { atLeast: 1 });
  claim({ spec: "R2", did: "fetched http://example.com/ from the app container", expected: "refused by the fake-service container", actual: `${seen.map((r) => r.handledAs).join(", ")}: ${answer.slice(0, 80)}`, ok: seen.length > 0 && seen.every((r) => r.handledAs === "refused") });
});
