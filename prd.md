# proofy - spec

## Problem

End-to-end tests are the only tests that check what the user actually asked for: "a guest can check out and gets a confirmation email".
They are also the tests nobody keeps up to date, because writing them is slow and running them is fragile.
Coding agents can now write the tests, but an agent that writes the requirement, the test and the fake services by itself marks its own homework.
A green run then proves nothing.

## Goal

A local, sealed test lab for any web app that gives a result you can trust.
You describe what to test in plain words.
Your coding agent turns that into numbered requirements, a test and fake outside services, guided by instructions that live in the repo.
You approve them, and from then on `proofy run` checks the app in a sealed Docker sandbox, with no AI, and reports per requirement what was asked, what happened and the evidence, with screenshots.

Validation is the point.
Every design choice below exists so that green means the requirement held, and red means something worth reading.

## Users

- People who run an app, an online shop first, and want the same flows checked after every change.
- Coding agents, which write the requirements and tests through `e2e/AGENTS.md` and run `proofy` before and after a change.

## Non-goals

- AI inside the tool. proofy never calls a model. All AI work happens in the user's own agent.
- Anything specific to one kind of app. The engine knows nothing about baskets or payments; shops get examples, not code.
- Hosted runs, a web UI or GitHub Actions in v1. Runs happen on the user's machine.
- Live outside services in v1. Every run is sealed.
- Pixel-by-pixel screenshot comparison in v1. Screenshots are evidence, not checks.
- Windows in v1.

## How a flow is made

1. `proofy init` writes `e2e/`: the agent instructions `e2e/AGENTS.md`, templates and an empty config. It adds one line to the repo's root `AGENTS.md` pointing to them. No AI.
2. The user asks their agent in plain words, for example "add a test for checkout".
3. The agent follows `e2e/AGENTS.md`: it interviews the user until every wish is checkable, then writes `e2e/specs/<flow>.md` with numbered requirements (R1, R2 ...) and a "must never happen" section. It writes them before reading the app's code.
4. The agent walks the flow once in `proofy dev up`, then writes `e2e/tests/<flow>.spec.ts`. Every requirement becomes one `claim()` that compares a real value: an amount, a status, a count in the app or in a fake service. Text on the screen alone is not proof.
5. The agent runs the flow until three runs in a row give identical results per requirement.
6. A second agent, which sees only the requirements and the test and never the app code, answers per requirement: "what wrong app behaviour would still pass this?". The user reads that before approving.
7. The user runs `proofy approve <flow>`. It records fingerprints of the requirements, the test and the fakes the flow used.

A flow is in one of these states:

| State | Meaning | Next step |
|---|---|---|
| draft | Requirements written, no test yet | Write the test |
| unproven | Test exists, fewer than 3 runs | Run it |
| unstable | The last 3 runs differed | Fix the test |
| ready | 3 identical runs | The human runs `proofy approve` |
| approved | Fingerprints match | Part of `proofy run --all` |
| out of date | Requirements, test or a fake it used changed after approval | Update and approve again |

The agent never runs `proofy approve` and never edits approved requirements without asking.
That is a rule in `e2e/AGENTS.md`, not a lock, and the README says so.

## The sandbox

- The app must start from a `docker compose` file the project already has. If it has none, the agent drafts one during setup and the user approves it.
- proofy wraps that file with its own: a sealed network, the fake-service container, Mailpit and a Playwright runner.
- Two phases. Building and installing have internet. The run happens on a network with no way out.
- Every run is its own throwaway compose project with no saved volumes, so the database starts empty. One seed command from the config runs before the tests.
- Each test creates its own data with a unique tag, so tests run side by side and a red test is always its own.
- The app's settings come only from the config's `env` block. The user's `.env` is never read.
- The browser runs inside the sealed network, in Playwright's official image at the same version as the package. `dev up` also opens ports to the host, so a person or chrome-devtools-axi can look at the app.

## Outside services

Inside the sandbox every hostname resolves to the fake-service container, so no call can slip out and every call is seen.
Each outside host has one mode in the config:

| Mode | What happens |
|---|---|
| `fake` | `e2e/standins/<host>.mjs` answers like the real service and rejects what the real one rejects |
| `record` | Accepts every request and answers `200 {}`. For services whose answer the app ignores, such as tracking |
| not listed | Recorded and refused. The report lists every refused call, so a missing fake is one clear line, not "could not resolve host" |

Every request to every host is recorded: method, path, headers and body, with `Authorization` and other secret-looking headers redacted.
Tests read them with `standin.requests(host)`.

Fakes are written from the provider's public documentation, never from the app's code.
They are fingerprinted and approved like tests, so the agent cannot quietly make a fake agree with the app.
Every report row names the fakes its evidence depended on, because a fake can drift from the real service until the v2 live lane exists.

HTTPS: proofy generates a certificate authority per project.
The fake-service container serves every host with it.
Making the app trust it is a setup step in the compose file, because PHP, Node and Python trust certificates differently.

Third-party code loaded by the browser, such as card fields from Stripe, PayPal buttons or reCAPTCHA, cannot work in a sealed run.
Static files, such as fonts and libraries from a CDN, can be listed in the config, downloaded during the install phase and served by the fake-service container.
Paying inside a provider's own fields is out of reach in v1 and the README says so.

Email goes to Mailpit, built into every sandbox. Tests read one person's mail with `mail.for(address)`.

## Commands

| Command | Does |
|---|---|
| `proofy` | Hook-safe status for the repo you are in: config, flows by state, fakes, last run, next steps. Under one second, never starts Docker |
| `proofy init [--no-agents-md]` | Writes `e2e/`, the agent instructions and templates; adds a pointer to the root `AGENTS.md`. Never overwrites a file |
| `proofy run [flow ...] [--all] [--pr <n>] [--post] [--keep]` | One sealed run. `--all` runs every approved flow; named flows run whatever their state, and an unapproved flow's result is marked not trusted |
| `proofy approve <flow>` | Records fingerprints, only after 3 identical runs |
| `proofy dev up\|test\|down` | A sealed sandbox that stays up while tests are written; `test` takes Playwright arguments after `--`. Dev runs count toward the 3 identical runs |
| `proofy report [run]` | Shows a past run |
| `--help`, `-h`, `help`, `<command> --help`, `-v` | Help with commands, flags, output modes and examples; version |

`run` takes the app from the current working tree, uncommitted changes included, and says so in the report.
With `--pr <n>` it fetches the PR's code into a cache folder and never touches the working copy.
Flows whose files the PR changed count as not approved, so a PR cannot weaken its own test.

## Results

Each run writes `e2e/out/<run>/`: `report.md`, `report.json`, numbered screenshots per flow and Playwright traces for red tests.
The last 20 runs are kept; `e2e/out/` is git-ignored.
Sandboxes are always torn down, also after a crash, unless `--keep` is given.

A report row per requirement: what was asked, what the test did, what was expected, what happened, the evidence, and the fakes it relied on.
No retries: a flow that differs between runs is marked unstable.

`--post` keeps one comment per pull request, updated in place, with screenshots on a `proofy-reports` branch that holds the last 20 runs and is replaced on every push, so the repository never grows.
Everything goes through `gh`; proofy never reads or stores a token.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every requirement of every approved flow that ran held |
| 1 | A requirement of an approved flow did not hold: a finding about the app |
| 2 | Usage error: a bad flag, an unknown flow, an invalid config |
| 3 | Environment failure: Docker missing, the sandbox did not start, the seed failed, a time limit. Says nothing about the app |
| 4 | Not trusted: some flows that ran are not approved or out of date, and no approved flow failed |

Errors print `error`, `code` and `help` lines.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope | Any web app; shops are the pitch and the demo | The engine stays small; the audience is larger |
| AI | Only in the user's agent, through `e2e/AGENTS.md` | Runs are free, repeatable and give the same answer every time |
| Agent instructions | One plain Markdown file in the repo, no harness-specific skill in v1 | Claude Code, Codex and Cursor all read `AGENTS.md`; one copy cannot drift |
| Requirements | Markdown, one file per flow, numbered | Easy for people to write and for agents to cite |
| Approval | Fingerprints of requirements, test and fakes, after 3 identical runs | A flaky or changed test cannot pass as trusted |
| Independent review | A second agent sees only requirements and test | Catches checks that pass when the app is wrong |
| Fakes | Written from public docs, approved, named in every report row | The agent cannot make the fake agree with the app; the report does not overclaim |
| Sandbox | The project's own compose file, wrapped | Works with any stack without templates per stack |
| Network | Online install, sealed run, every hostname to the fake-service container | Nothing slips out and every call is seen |
| Data | Throwaway database per run, own data per test | Tests run side by side; red is always the test's own |
| Retries | None | A retry hides a flaky test |
| Limits | Sandbox start 10 min, 5 min per test, no run limit, 4 flows in parallel; all configurable | Catch hangs without capping big apps |
| Where | Local, macOS and Linux with Docker | No CI minutes, no secrets in CI |
| Output | Human view on a terminal, TOON when piped, `--json`; `help` lines | Same contract as mergeq |
| Distribution | `npm i -g @davidrydberg/proofy`, command `proofy`, MIT | One-command install |

## Where proofy works

The project is the nearest folder, from where proofy runs upwards within the repository, that has `e2e/proofy.json`; otherwise the repository root.
`init` sets up the folder you are in when it has a compose file, so an app in a monorepo subfolder works.
Relative paths in compose files resolve against the first file's folder, as when the app is started by hand.

## Runtime details

- The fake-service container and the browser container run as the user who runs proofy, so files they write stay deletable on Linux.
- Every test step that waits for something gives up after 30 seconds with the locator it waited for; navigation after 60 seconds.
- Tests talk to the host for `exec()` through request files in a shared folder. The runner container never gets access to Docker.
- `mail.for` and `mail.search` take `settleMs`, which keeps reading until no new mail came for that long, so "exactly one email" also catches a late second one.

## Files in a project

```
e2e/
  AGENTS.md              instructions for the agent
  proofy.json            config
  proofy.lock.json       approvals: fingerprints per flow and per fake
  specs/<flow>.md        requirements
  tests/<flow>.spec.ts   tests
  standins/<host>.mjs    fakes
  templates/             examples the agent copies
  out/                   runs, git-ignored
```

## Build order

1. Command-line skeleton: dispatcher, output modes, config with a schema, `init`, bare status.
2. Sealed sandbox: wrap the compose file, two phases, runner container, sealed network, seed, teardown.
3. Test helpers and the report: `claim({spec, did, expected, actual, ok, evidence})`, `notCovered`, `shot`, `tag`, exit codes.
4. Fake services, catch-all DNS, `record` mode, Mailpit, `exec(name, args)` for the commands named in the config.
5. Fingerprints, the six states and `approve`.
6. `--pr` and `--post`.
7. The agent instructions in full, and the WooCommerce demo in `examples/woocommerce/` written through them.

## Later

- A live lane: chosen flows against real test modes of outside services, to catch fakes that drift.
- Apps split across several repositories.
- Opt-in screenshot comparison.
- A thin Claude Code skill that points to `e2e/AGENTS.md`.
