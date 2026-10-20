# proofy

`proofy` gives your app end-to-end tests you can trust, written by your coding agent and approved by you.
You describe what to test in plain words.
Your agent follows the instructions proofy puts in your repo to write numbered requirements, a Playwright test and fakes for outside services.
You approve them, and every `proofy run` checks the app in a sealed Docker sandbox, with no AI, and reports per requirement what was asked, what happened and the evidence, with screenshots.

The sandbox has no way out.
Every outside call to a hostname goes to a fake the agent wrote from the provider's docs, gets recorded, or is refused.
The report lists every HTTP and HTTPS call, and every name the app looked up without calling it over HTTP; calls to a raw IP address reach nothing and are not listed.
The app's settings come only from `e2e/proofy.json` and the compose files, never from your shell's environment or a `.env` file.
proofy refuses a compose variable that would be blank where it reaches the app, and any use of a variable docker itself needs (`PATH`, `HOME`, `DOCKER_*`, `XDG_RUNTIME_DIR`), even with a default.
proofy refuses to start a service whose compose settings would break the seal: `network_mode`, `privileged`, `cap_add`, a host `pid`, `ipc`, `uts` or `userns_mode`, `devices`, `build.ssh`, `build.secrets`, `build.privileged`, `build.entitlements`, a build context or `build.additional_contexts` folder outside the repository, a volume with `driver_opts` or a `driver` other than `local`, or a mount of the Docker or containerd socket, also as a secret or config file.

![How proofy works: you describe a test, your agent writes requirements, a test and fakes, you approve, every run is sealed in Docker, and the report shows evidence per requirement](docs/overview.gif)

## How it works

![The proofy flow: you describe it, AI writes the tests, you approve, proofy runs them with Playwright in sealed Docker, and the result lands on your PR](docs/flow.png)

## Install

```sh
npm i -g @davidrydberg/proofy
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

An approval covers the flow's requirements, its test and every other file in `e2e/tests/` but other flows' tests, every file in `e2e/standins/`, `e2e/proofy.json`, and the compose files it lists with the files they include or extend.
A change to any of them makes the flow out of date until you approve it again, and `proofy` and the run report say what changed.

Only you run `proofy approve`: it works only in an interactive terminal and asks you to type the flow name.
That stops an agent that follows its instructions, not a determined one with shell access, which can fake a terminal or write `e2e/proofy.lock.json` itself.
So `proofy run --pr` lists every flow whose approval changed in the pull request, and you check each one in review.
For a stronger gate, add a CODEOWNERS entry for `e2e/proofy.lock.json`.

## License

MIT
