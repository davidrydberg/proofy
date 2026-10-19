#!/usr/bin/env node
import { runCli } from "../cli.js";
import { spawnProc } from "../sandbox/docker.js";

process.exitCode = await runCli(
  process.argv.slice(2),
  { cwd: process.cwd(), env: process.env, proc: spawnProc, now: () => new Date(), log: (line) => process.stderr.write(`proofy: ${line}\n`) },
  { write: (text) => process.stdout.write(text), isTTY: process.stdout.isTTY === true, columns: process.stdout.columns },
);
