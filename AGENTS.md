# proofy

CLI for sealed end-to-end tests that a coding agent writes and a person approves.
`prd.md` is the spec.
Read it before changing behaviour, and change it in the same commit when a decision changes.

## Layout

| Path | What it is |
|---|---|
| `src/bin/proofy.ts` | Executable entry. Wires real dependencies into `runCli` |
| `src/cli.ts` | Dispatcher: output mode (`--pretty`, `--toon`, `--json`, TTY detection), one help text per command, errors and exit codes |
| `src/commands/` | `home` (hook-safe status and onboarding steps), `init`, `run`, `dev`, `approve`, `report`. Each returns data plus help lines |
| `src/config.ts` | The config schema (zod). The one source of truth: types and `schema/proofy.schema.json` come from it |
| `src/detect.ts` | Reads the user's compose file and `.env.example` to fill the config at init |
| `src/project.ts` | Project root, `e2e/` paths, flow names |
| `src/sandbox/compose.ts` | Pure rewrite of the app's normalized compose model into the sealed sandbox. The seal lives here |
| `src/sandbox/sandbox.ts` | Docker steps: prepare, install phase, start and seed, run tests, logs, teardown, the exec bridge |
| `src/sandbox/contract.ts` | Names, ports and mount paths shared by the host and the containers |
| `src/standin/` | Runs inside the fake-service container: catch-all DNS, HTTP and HTTPS fakes, the certificate authority, the dev port forwarder. Node built-ins only |
| `src/test/` | `@davidrydberg/proofy/test`, imported by users' tests in the runner container: `claim`, `shot`, `exec`, `mail`, `standin` |
| `src/run/` | Planning, results from the run folder, the report, fingerprints, approvals, run history and flow states |
| `src/github.ts` | `--pr` export and `--post` comment plus the screenshots branch, all through `gh` |
| `templates/e2e/` | Copied into the user's repo by `init`: `AGENTS.md` for their agent, plus example spec, test, fake and compose file |
| `docker/standin.Dockerfile` | The fake-service image: Node plus openssl |
| `examples/woocommerce/` | A complete demo shop with two flows written through the agent instructions |
| `scripts/schema.mjs` | Generates `schema/proofy.schema.json` from the built config schema |
| `test/` | Vitest with real temporary git repos and a fake `Proc`; no Docker, no network |
| `test/docker/`, `test/fixtures/tiny-shop/` | `npm run test:docker`: real sealed runs on the local Docker daemon |

## Rules

- proofy never calls an AI model. AI work happens in the user's agent, guided by `templates/e2e/AGENTS.md`.
- `templates/e2e/AGENTS.md` is the product as much as the code. Changes to the flow, states, helpers or rules go there and in `prd.md` together, and are copied to `examples/woocommerce/e2e/`.
- The seal is the product's promise: every service on one internal network, every lookup answered by the fake-service container, no published ports except through the dev forwarder. Change `src/sandbox/compose.ts` only with its tests and the Docker test.
- Never prompt. Every input is an argument, a flag or the config.
- `init` never overwrites a user's file.
- The bare command runs from session-start hooks: files only, no Docker, under a second, always exit 0.
- Exit codes are a contract: 0 pass, 1 a requirement failed, 2 usage or config, 3 environment, 4 not approved. An unexpected crash is 3, never 1.
- Agents depend on the TOON shape. Change it only on purpose and update its tests and the README in the same commit.
- The human view fits the terminal width and reads correctly with `NO_COLOR`. Glyphs stay as `\u` escapes in source.
- `gh` owns GitHub authentication. proofy never reads, passes or stores a token.
- No client or company names in tracked files. Examples use generic shops.

## Commands

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:docker   # needs Docker; builds first
```
