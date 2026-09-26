# Security policy

Stealth Web Search gives whoever can reach it a browser that runs on your machine, and it runs sub-agents that read untrusted web pages. Security reports are welcome.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Older | No |

Fixes are made on the latest release. `curl -s http://127.0.0.1:8931/healthz` shows the version you run (`version`) and the Obscura version (`obscura.version`).

## Reporting a vulnerability

Report vulnerabilities privately through GitHub. Do not open a public issue, discussion or pull request for them.

1. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the private report form](https://github.com/tanishmeh/stealth-web-search/security/advisories/new).
2. Describe the problem and its impact, the version (the `/healthz` output), how you run the server (Docker or npm, and any non-default settings), and the steps to reproduce it. A minimal page or script that triggers it helps most.
3. Leave out real secrets. Replace API keys, tokens, cookies and private addresses with placeholders, and redact logs and transcripts before you attach them: they can contain page content, typed text and URLs. Never attach snapshot files: they hold live sign-ins.

Only you and the maintainers can see the report. The maintainers follow up in the advisory.

## Scope

The server is a remote-control port for a browser. Reports about these areas are in scope:

- **The MCP endpoint and the dashboard.** Reaching `/mcp` or the dashboard without the bearer token when `AUTH_TOKEN` is set, getting around the Host and Origin checks (DNS-rebinding protection), or the dashboard leaking data it should redact.
- **The browser guards.** Opening `file:` or `javascript:` URLs, or reaching private networks (`localhost`, RFC 1918 addresses, `host.docker.internal`) while `ALLOW_PRIVATE_NETWORK` is `false`, through any tool, sub-agent or script.
- **Prompt injection that breaks a boundary.** Pages are untrusted input, and a model can be talked into things by text on a page. That on its own is a known risk (see below). It is in scope when page content makes the server do something its guards should prevent, such as reaching a blocked address, reading another browser's cookies, or escaping a sub-agent's isolated browser.
- **The script sandbox.** Automation scripts run in a QuickJS WebAssembly sandbox with no Node.js APIs and with memory, time and call limits. Any way for a script to reach the file system, the network, processes or the host outside the guarded `browser` object, or to get around those limits, is in scope.
- **Isolation between browsers.** Sub-agent and script browsers seeing the shared browser's tabs or cookies, or each other's. The one intended bridge is a [snapshot](docs/SNAPSHOTS.md) the host passes to `agent_run`: a sign-in reaching a browser nobody passed it to is in scope.
- **Secret redaction.** Passwords, cookie values or credential headers reaching logs, transcripts or the dashboard while `LOG_REDACT_SECRETS` is `true`. Whatever that setting says: the host's `agent_reply` answers reaching the tool or MCP logs, a secret answer (a one-time code) reaching logs, transcripts, results or the dashboard, or snapshot cookie and storage values reaching any of them.
- **Snapshots (saved sign-ins).** Snapshot files readable by other users than the server's, a weakness in their encryption with `SNAPSHOTS_KEY`, a deleted snapshot coming back, or a cross-site request that gets past the checks of `DELETE /api/snapshots/<name>` (the custom `X-SBM-Request` header, the `Origin` check and `Sec-Fetch-Site`).
- **Sub-agent questions.** Page content or the model setting the `asked on` origin of a question (the server reads it from the agent's browser), or an answer reaching another question than the one its `question_id` names. In an `agent_run` job, a click, form submit, or Enter or Space from the browser tools that presses a button labelled as the final step of an order or payment (such as **Place your order** or **Pay now**) before the host answered a `confirm` question, unless the host passed `confirm_purchases: false`.
- **The container.** Anything that breaks the hardening in `compose.yaml` and the `Dockerfile` (non-root user, read-only filesystem, dropped capabilities, `no-new-privileges`, the CDP port staying inside the container).
- **The helper scripts.** For example `npm run lmstudio:setup` writing a token to a file that others can read, or the stdio bridge exposing the server.

### Known limitations (not vulnerabilities)

These are documented and expected. Reports that only restate them are out of scope, but ways to make them worse than described are welcome.

- **Obscura's cross-site cookie handling.** Obscura v0.2.2 does not enforce Chromium's cross-site request protections: it sends `SameSite=Strict`/`Lax` cookies on cross-site requests and treats `application/json` POSTs as simple requests (no CORS preflight). A page the agent visits can make cross-site requests that carry any cookies you gave the browser. This is an Obscura limitation: report changes to it to [Obscura](https://github.com/h4ckf0r0day/obscura).
- **Prompt injection as such.** A model can be manipulated by text on a page. Keep a human in the loop for sensitive accounts.
- **The CDP socket in local development.** Running the server directly (`npm run dev`) exposes an unauthenticated Obscura CDP socket on `127.0.0.1` while it runs. The Docker image keeps it inside the container.
- **Settings that turn protections off.** Publishing the port beyond `127.0.0.1` without `AUTH_TOKEN`, `ALLOW_PRIVATE_NETWORK=true`, `LOG_REDACT_SECRETS=false`, or `allow_evaluate: true` on a run started with a snapshot.
- **Free text in logs.** Task texts, the agent's notes and its transcript are logged as they are. Of the text the agent types, only values typed into password-like fields, and the host's secret answers, are masked. Snapshot descriptions are logged and shown to sub-agents.
- **Secret answers reach the model.** A one-time code the host sends with `agent_reply` is masked in logs, transcripts and on the dashboard, but the sub-agent's model endpoint receives it, because the agent has to type it. Masking works by value: the whole answer and its code-like parts (words of 4 or more characters with a digit, and digit groups), at least 4 characters each. Plain words of a secret answer, and a code the agent rewrites (for example with spaces added), are not masked. A code typed into a page can also show up in what the page itself shows or sends: the live view, and the page's console and network entries.
- **The purchase guard is a second line of defense.** In `agent_run` jobs the server refuses the final order or payment button until the host answered a `confirm` question the agent asked on that page. It recognizes the button by its label, and only for clicks, form submits and Enter or Space from the browser tools. Page scripts and `browser_evaluate`, a checkout URL opened directly, a page's own key handlers, Enter in a form without a submit button, buttons with other wording or no label, `agent_automate` runs and stored scripts are not covered, and any answer to a `confirm` question lifts it for the rest of the run.
- **A snapshot hands over an account.** A browser that loads a snapshot is signed in as that account, and so is every page it opens: with Obscura's cross-site cookie handling (above), a page a signed-in sub-agent visits can make signed-in requests to the site. Snapshots reach a sub-agent only when the host passes one to `agent_run`, and those runs get no `browser_evaluate` unless the host allows it.
- **Restored cookies reach subdomains.** Obscura does not report whether a cookie was host-only, so a snapshot restores every cookie as a domain cookie, which is also sent to the site's subdomains. Report changes to this to Obscura.
- **The end-of-run refresh saves the browser's final sign-in.** A job started with a snapshot saves its browser's cookies back when it succeeds. It is skipped when saved sign-in cookies are missing (a signed-out browser), but a page that signs the agent in to another account under the same cookie names would be saved into the snapshot. `update_snapshot: false` turns the refresh off.
- **Snapshots at rest.** Snapshot state files hold live session cookies. They are private to the server's user (0600 in a 0700 folder) and encrypted only when `SNAPSHOTS_KEY` is set. Anyone who can read the volume, and `.env` if a key is set, can use those sign-ins.
- **Pages in the server's own browsers.** With `ALLOW_PRIVATE_NETWORK=true` and no `AUTH_TOKEN`, a page open in the server's browsers can reach the server itself (`/mcp` and the dashboard), because Obscura does not enforce CORS the way Chromium does. Set `AUTH_TOKEN` when you allow private networks.
- **The health check.** `/healthz` answers without the bearer token and for any Host header, because the Docker health check uses it. It shows the versions, the engine status and arguments (with proxy passwords masked), and the number of tabs and sessions.
- **Engine crashes.** When a page crashes Obscura, the server restarts it and tells the agent its tabs were reset. Report reproducible crashes to Obscura unless they break a boundary listed above.

## Hardening your deployment

A summary of the [Security](README.md#security) section of the README:

- Keep the port on `127.0.0.1`, as `compose.yaml` publishes it. Do not change it to `0.0.0.0` unless you set `AUTH_TOKEN` and put a TLS reverse proxy in front.
- Set `AUTH_TOKEN` if anyone else can reach the port. It protects `/mcp` and the dashboard. Add reverse-proxy hostnames to `ALLOWED_HOSTS`.
- Keep `ALLOW_PRIVATE_NETWORK=false` unless the browser must open sites on your machine or LAN. If you turn it on, set `AUTH_TOKEN`: pages in the server's own browsers can then reach the server.
- Prefer Docker over `npm run dev` on shared or multi-user machines.
- Keep `OBSCURA_SEPARATE_ENGINE=true` (the default), so sub-agent and script browsers run on a second Obscura process: a page that crashes the engine there cannot reset your browser. With `OBSCURA_STORAGE_DIR` the second process is always used, and it never sees the persisted cookies.
- Do not persist sensitive logins with `OBSCURA_STORAGE_DIR`, and clear cookies (`browser_clear_cookies`) before sending the agent to untrusted sites.
- Set `SNAPSHOTS_KEY` so saved sign-ins are encrypted at rest, keep the `snapshots` volume private, and never point `SNAPSHOTS_DIR` into the logs (the server refuses). Pass a snapshot to `agent_run` only for jobs on that site, and keep `allow_evaluate` off. Set `AGENT_SNAPSHOT_SAVE=false` if sub-agents should never save sign-ins. See [Snapshots](docs/SNAPSHOTS.md#security-notes).
- Have your agent relay sub-agent questions that approve a purchase, payment, message or deletion, and requests for sign-in codes, to you, and never send a password with `agent_reply`. Let it pass `confirm_purchases: false` only for a purchase you already approved, with the limits in the TASK. See [Questions from sub-agents](docs/AGENTS.md#questions-from-sub-agents).
- Pass `update_snapshot: false` to jobs started with a snapshot that open pages you do not trust, so the end-of-run refresh cannot save another account into the snapshot.
- Keep `LOG_REDACT_SECRETS=true`, and do not put secrets into sub-agent tasks. If you must, set `AGENT_TRANSCRIPTS=false`, `LOG_FILE_LEVEL=warn` and `LOG_LEVEL=warn`.
- Keep API keys out of the repository: `.env` and `config/models.json` are gitignored, and `config/models.json` can read the key from an environment variable with `${VAR}`.
- Treat every page the agent visits as untrusted, and keep a human in the loop for sensitive accounts.

More detail: [Configuration](docs/CONFIGURATION.md), [Sub-agents](docs/AGENTS.md), [Snapshots](docs/SNAPSHOTS.md) and [Logging](docs/LOGGING.md).
