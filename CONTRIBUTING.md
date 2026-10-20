# Contributing

Issues and pull requests are welcome.
For anything bigger than a fix, open an issue first so we can agree on the shape.

## Setup

```sh
npm ci
npm test              # unit tests: real temp git repos, a fake process runner, no Docker
npm run typecheck
npm run lint
npm run test:docker   # real sealed runs against the tiny-shop fixture; needs Docker
```

Node 24 or newer.

## Where things live

| Path | What |
|---|---|
| `src/bin/proofy.ts` | Entry point. Wires real dependencies into `runCli` |
| `src/cli.ts` | Dispatch, output modes (`--pretty`, `--toon`, `--json`), help, exit codes |
| `src/commands/` | One file per command. Each returns data plus next-step hints |
| `src/config.ts` | The config schema (zod). `schema/proofy.schema.json` is generated from it |
| `src/sandbox/policy.ts` | Every compose setting proofy refuses |
| `src/sandbox/compose.ts` | Rewrites the app's compose model into the sealed sandbox |
| `src/sandbox/sandbox.ts` | Docker steps: prepare, install, start and seed, run, teardown, the exec bridge |
| `src/sandbox/contract.ts` | Names, ports and paths shared by the host and the containers |
| `src/standin/` | Runs inside the fake-service container: DNS, HTTP(S) fakes, the CA. Node built-ins only |
| `src/test/` | `@davidrydberg/proofy/test`, imported by users' Playwright tests |
| `src/run/` | Planning, results, the report, fingerprints, approvals and run history |
| `src/github.ts` | `--pr` and `--post`, all through `gh` |
| `templates/e2e/` | Copied into a user's repo by `proofy init` |

## Ground rules

- **The seal is the product.** Changes to `policy.ts` or `compose.ts` need unit tests and a green `npm run test:docker`.
- **Exit codes are a contract:** 0 pass, 1 a requirement failed, 2 usage or config, 3 environment, 4 not approved. A crash is 3, never 1.
- **No prompts** except `proofy approve`, which needs a real terminal. Everything else is an argument, a flag or config.
- **The bare `proofy` command** runs from session-start hooks: files only, no Docker, fast, always exit 0.
- **The TOON output shape** is read by agents. Change it on purpose, with its tests and the README.
- **`init` never overwrites** a user's file.
- **proofy never calls an AI model,** and never reads or stores a GitHub token (`gh` owns auth).
- `templates/e2e/AGENTS.md` is as much the product as the code. Changes there go to `examples/woocommerce/e2e/` too.
