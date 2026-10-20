#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCli } from "../cli.js";
import { spawnProc } from "../sandbox/docker.js";

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController();
  prompt.on("SIGINT", () => cancel.abort());
  try {
    return await prompt.question(question, { signal: cancel.signal });
  } catch {
    // Ctrl+C or a closed terminal: no answer.
    return "";
  } finally {
    prompt.close();
  }
}

const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;

process.exitCode = await runCli(
  process.argv.slice(2),
  { cwd: process.cwd(), env: process.env, proc: spawnProc, now: () => new Date(), log: (line) => process.stderr.write(`proofy: ${line}\n`), ...(terminal ? { ask } : {}) },
  { write: (text) => process.stdout.write(text), isTTY: process.stdout.isTTY === true, columns: process.stdout.columns },
);
