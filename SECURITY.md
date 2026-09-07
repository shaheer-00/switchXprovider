# Security Policy

## Supported versions

Only the latest tagged release (`vX.Y.Z` on the [releases page](https://github.com/shaheer-00/switchXprovider/releases)) receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Please use GitHub's private vulnerability reporting instead:

1. Go to the [repo Security tab](https://github.com/shaheer-00/switchXprovider/security)
2. Click **Report a vulnerability**

Or email the maintainer via the GitHub profile (shaheer-00).

Include what you can: steps to reproduce, affected code paths (`server/`, `scripts/`, dashboard), and impact. You should get a response within a few days.

## Scope notes

Things worth knowing when assessing this project:

- The proxy binds to **127.0.0.1 only** — it is not reachable from the network by design.
- API keys are stored in plaintext in `~/.claude/switchx/config.json`, same trust level as your `~/.claude` directory. This is documented and intentional; a local-file disclosure that reads this is out of scope.
- Reports about the local trust boundary (another local process reading config, or hitting the proxy on localhost) are still welcome and will be triaged — but they inherit the trust level of your user account.
