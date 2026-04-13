# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in
`civic-awareness-mcp`, please **do not open a public issue**. Instead,
report it through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/julianken/civic-awareness-mcp/security)
2. Click **Report a vulnerability**
3. Describe the issue, including reproduction steps and affected version

You can expect an initial acknowledgement within 72 hours.

## Scope

This MCP server runs locally as a subprocess of an MCP client
(typically Claude Desktop). It does not expose network services, does
not handle user credentials, and reads only public civic data. The
security surface is small:

- **Input validation** on the 8 MCP tool handlers (zod-validated)
- **SQLite query construction** — all user input is bound as parameters
  with `LIKE ... ESCAPE '\'` on wildcard-bearing queries
- **Outbound HTTP** to three fixed base URLs (`v3.openstates.org`,
  `api.congress.gov`, `api.open.fec.gov`) with `redirect: "error"`
- **Secrets** — API keys live only in the operator's local
  `.env.local` or `claude_desktop_config.json`; never committed to
  the repo

## Out of scope

- **Upstream API behaviour.** We don't mediate OpenStates, Congress.gov,
  or OpenFEC data quality — if they change a field name, our nightly
  drift workflow catches it; if they return bad data, it flows through.
- **Claude Desktop client.** The host process manages the tool invocation
  lifecycle; reports about it belong with Anthropic.
- **Operator responsibility.** Your `CIVIC_AWARENESS_DB_PATH`,
  `OPENSTATES_API_KEY`, and `API_DATA_GOV_KEY` are yours to
  protect.

## Pre-public security audit

Before the repo was made public, a security audit was conducted against
the full codebase. Findings are tracked in the commit history. Key
hardening applied:

- Third-party GitHub Actions are pinned to full commit SHAs (not
  mutable tags)
- SQL `LIKE` patterns escape user-supplied `%` and `_` characters
- Outbound `fetch` calls reject redirects rather than following them
- `.gitignore` excludes `.env*`, `*.db`, and `data/` directories
- All MCP tool handlers `.parse()` their input through zod before
  touching SQL, filesystem, or fetch

If you discover a regression of any of the above — or anything else
that looks off — please report it via the channel above.
