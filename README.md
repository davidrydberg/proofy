# proofy

`proofy` gives your app end-to-end tests you can trust, written by your coding agent and approved by you.
You describe what to test in plain words.
Your agent follows the instructions proofy puts in your repo to write numbered requirements, a Playwright test and fakes for outside services.
You approve them, and every `proofy run` checks the app in a sealed Docker sandbox, with no AI, and reports per requirement what was asked, what happened and the evidence, with screenshots.

The sandbox has no way out.
Every outside call goes to a fake the agent wrote from the provider's docs, gets recorded, or is refused and listed in the report.

## Install

```sh
npm i -g @davidrydberg/proofy
```

From source:

```sh
git clone https://github.com/davidrydberg/proofy && cd proofy && npm ci && npm run build && npm link
```

## Requirements

- Node 24 or newer
- Docker on macOS or Linux (Docker Desktop, OrbStack or Docker Engine)
- An app that starts with `docker compose`; your agent can draft the compose file
- The [GitHub CLI](https://cli.github.com), only to test pull requests or post reports on them

## Usage

```sh
proofy init     # adds e2e/ with agent instructions, templates and a config filled from your repo
```

Then tell your agent: "set up proofy", and after that what to test: "add a proofy test: a guest can buy a product and gets a confirmation email".
The agent interviews you, writes `e2e/specs/<flow>.md` and the test, and runs it until three runs agree.

```sh
proofy                      # setup, every flow's state and the next step; safe for a session-start hook
proofy approve guest-checkout   # you, after reading the requirements and the agent's notes
proofy run --all            # every approved flow in a fresh sealed sandbox
proofy run --all --pr 42 --post   # a pull request's code, report posted on the PR
```

```
PASS  every requirement of every approved flow held
run 20261020-091512  e2e/out/20261020-091512

guest-checkout  passed
  ✓ R1   After placing the order, the guest sees a confirmation page showing the stored order's number.
  ✓ R2   The order is stored with status "processing", payment method cash on delivery, ...
  ✓ R3   Within 30 seconds the guest receives exactly one email, and it shows the order number.
  ✓ R4   Stock for the coffee goes down by exactly one.
  ✓ R5   No email that names the guest or the order number goes to anyone but the guest or the shop ...
```

Exit codes: 0 pass, 1 an approved flow failed, 2 usage or config, 3 the sandbox failed, 4 not approved.
`examples/woocommerce` is a complete shop with two flows, and [pull request 1](https://github.com/davidrydberg/proofy/pull/1) shows a report posted with `--post`.
`prd.md` has the full design.

The agent instructions say only you run `proofy approve`.
That is a rule your agent follows, not a lock.

## License

MIT
