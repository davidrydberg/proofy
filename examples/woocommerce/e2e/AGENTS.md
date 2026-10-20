# End-to-end tests with proofy

This folder holds end-to-end tests that check what the people who run this app asked for, through the real app in a real browser.
You, the agent, write the requirements, the tests and the fake outside services.
The human approves them.
`proofy run` then checks the app in a sealed Docker sandbox with no AI, and every result must be one the human can trust.

Run `proofy` at any time: it shows what is set up, every flow's state and the next step.

## Rules

These are not optional.
A test suite that breaks them produces green reports nobody can trust, which is worse than no tests.

1. Never run `proofy approve`. Only the human approves.
2. Never weaken a check to make a run green. A red result caused by the app is a finding: report it to the human with the evidence.
3. Never edit an approved requirements file without asking the human first.
4. Write requirements before reading the app's code, from what the human asked for. Read the code only after they are written, to find buttons and fields.
5. Write fakes for outside services from the provider's public documentation, never from what this app sends. Link the documentation at the top of the fake.
6. Every claim compares a real value: an amount, a status, a count, a stored record, a request a fake received or an email in Mailpit. Text on the screen alone does not prove a requirement, unless the requirement is about what the screen shows.
7. Every test creates its own data with `tag()`. Never rely on another test's data or on order.

## Files

| Path | What |
|---|---|
| `proofy.json` | Config. Every field is described in its `$schema` |
| `proofy.lock.json` | Approvals, written only by `proofy approve`. Commit it |
| `specs/<flow>.md` | Requirements for one flow, numbered R1, R2 ... |
| `tests/<flow>.spec.ts` | The test for that flow, same name |
| `standins/<host>.mjs` | A fake for one outside host |
| `templates/` | Examples to copy |
| `out/` | Runs, ignored by git |

## Setup

Do this once, when the human asks you to set up proofy.
`proofy` lists what is missing.

1. **The app in Docker.** `compose` in `proofy.json` lists the app's compose files. If the repository has none, draft one from `templates/compose.yml`, show it to the human and wait for their OK. The app must start from an empty database, and everything it needs must be installed when the image is built: the sandbox has no internet once it runs. Give the database a `healthcheck`, so the app starts only when it is ready.
2. **Where the browser starts.** `app` is the compose service and the port inside the container, not a published port.
3. **Settings.** `env` holds the app's settings per service. `proofy init` filled it from `.env.example` and replaced secret-looking values with fakes. The repository's `.env` is never used. Check every value makes sense for an empty sandbox.
4. **The seed.** `seed` is one command that prepares the empty database, such as migrations and the reference data every test needs. Test-specific data does not belong here. Leave it out if the app needs nothing.
5. **Commands for tests.** `exec` names the commands tests may run inside a service, such as reading a stored order or running a scheduled job. A test calls `exec("name", [extra, args])` and gets stdout. Prefer the app's own CLI over raw SQL.
6. **Outside services.** Find every host the app calls: search the code and config for `http://` and `https://`, SDK clients and mail settings. List each in `hosts`:
   - `fake` when the app needs a real answer, such as a payment or a shipping quote. Write `standins/<host>.mjs` from `templates/standin.mjs` and the provider's public docs.
   - `record` when the app ignores the answer, such as analytics or tracking.
   - Leave a host out on purpose only if the app copes with it being down. Every refused call is listed in the report.
7. **HTTPS.** Fakes answer HTTPS with a certificate authority proofy creates. Make the app trust it in the compose file; `templates/compose.yml` shows how for PHP, Node and Python.
8. **Mail.** Point the app's SMTP settings at host `mailpit`, port `1025`, no TLS.
9. **Check it.** Run `proofy dev up`. It builds the images, starts the sealed sandbox and seeds it. Fix what fails, using `e2e/out/sandbox.log` and `e2e/out/seed.log`. Run `proofy` until setup shows no gaps, then tell the human what you set up and what you could not.

## Adding a flow

1. **Interview.** Ask until every wish is checkable. Always cover:
   - Who does it: a guest, a customer, an admin? Starting from which page?
   - With what: which product, quantity, country, currency, payment method?
   - What counts as success, as something you can read: the order's status and total, an email to whom, a stock count, a request to which outside service?
   - What must never happen: charging twice, an order without payment, an email to the wrong person?
   Ask one round of questions at a time. Do not guess an answer the human has not given.
2. **Requirements.** Write `specs/<flow>.md` from `templates/spec.md`. Short lowercase name with dashes, such as `guest-checkout`. Show it to the human and wait for their OK.
3. **Walk it.** Start `proofy dev up`, open the app address it prints and go through the flow once by hand to learn the buttons and fields. chrome-devtools-axi or Playwright's own tools are fine here. If the app redirects to its in-sandbox name, learn the page from its templates instead, or from a first draft of the test with `shot()` after each step.
4. **Test.** Write `tests/<flow>.spec.ts` from `templates/test.spec.ts`. Import only from `@davidrydberg/proofy/test` and Node's built-in modules; nothing else is installed in the runner. From that module:
   - `test`, `expect`: Playwright's, with proofy's bookkeeping. The browser starts at the `app` address.
   - `claim({ spec, did, expected, actual, ok, evidence })`: one per requirement, citing its number. `ok` comes from real values.
   - `notCovered(spec, why)`: for what the sandbox cannot show, such as a payment inside a provider's own card fields.
   - `shot(label)`: a screenshot after every meaningful step.
   - `tag()`: a value unique to the test for names, emails and phone numbers.
   - `exec(name, args)`: a command from `exec` in `proofy.json`; returns stdout.
   - `mail.for(address, { atLeast, settleMs })`: that person's email from Mailpit, waiting until `atLeast` arrived. `settleMs` keeps reading until nothing new came for that long, so "exactly one" also catches a late second email. Use `atLeast: 0` to check nothing was sent.
   - `mail.search(query, { atLeast, settleMs })`: every email matching a Mailpit search, whoever it went to. Search for something only this test's data has, such as a `tag()` value. Each email has `to`, `cc` and `bcc`.
   - `standin.requests(host, { atLeast })`: what the app sent to a fake or recorded host.
5. **Prove it.** With `proofy dev up` running, run `proofy dev test <flow>` until three runs in a row give identical results per requirement. `proofy` shows the count. A requirement that fails because the app is wrong stays red: that is a finding, not a broken test. A flow whose runs differ is flaky: fix the test, never add retries.
6. **Second opinion.** Ask a separate agent, given only `specs/<flow>.md`, `tests/<flow>.spec.ts`, every fake in `standins/` and the provider documentation each fake links, and no app code, to answer for each requirement: "what wrong behaviour of the app would still pass this check?", and for each fake: "where does this fake behave differently from the provider's documentation?" Tighten the checks and fix the fakes it finds, then give the human its answers.
7. **Hand over.** Tell the human the flow is ready, what each requirement checks, any findings, and that they can run `proofy approve <flow>`.

## Changing a flow

- When a change to the app touches a covered flow, propose the requirement changes to the human before writing code.
- A changed requirements file or test makes the flow out of date until the human approves it again. Other flows keep running.
- A changed fake, `proofy.json` or compose file makes every flow out of date until the human approves each again.
- When the app changed on purpose, update the requirements first, then the test, then prove it again.

## When a run is red

1. Read `out/<run>/report.md`: per requirement what was expected, what happened, the evidence and the screenshots. Red tests also have a Playwright trace.
2. Decide which it is and say which, with the evidence:
   - **The app is wrong.** Report it as a bug. Do not touch the test.
   - **The test is wrong.** For example it typed into a field that was already filled in. Fix it, prove it again, and tell the human; it needs approval again.
   - **A fake is wrong.** Check it against the provider's docs, fix it, and tell the human.
   - **The requirement is unclear.** Ask the human.
