# Security

proofy promises that a run is sealed: the app under test can't reach the internet, the host, or the evidence the tests collect.
A way around that is a security bug, and I want to hear about it.

## Reporting

Please report privately through [GitHub's private vulnerability reporting](https://github.com/davidrydberg/proofy/security/advisories/new) rather than a public issue.
Include the compose file or config that gets out, and what it reaches.

I aim to reply within a week and credit you in the release notes unless you'd rather not.

## In scope

- An app service reaching the network outside the sandbox, the host's files outside the repository, or the Docker socket.
- An app service reading or changing the recorded requests, mail, or claims.
- A change to an approved flow's files that leaves it showing as approved.
- Settings from the shell or a `.env` file reaching the app.

## Known limits

These are documented in the README and are not bugs:

- Calls to a raw IP address are blocked but not listed in the report.
- The image build has internet access, like any `docker build`.
- `proofy approve` stops an agent that follows its instructions, not one determined to fake a terminal. Review changes to `e2e/proofy.lock.json` in pull requests.
