# Snapshots (saved sign-ins)

A **snapshot** is a named, described copy of a browser's sign-in for chosen sites: its cookies for those sites, plus the site storage (`localStorage` and `sessionStorage`) of the page that was open when it was saved. A browser that loads a snapshot starts signed in, so your agent, or a sub-agent, does not have to sign in again.

Snapshots are not page snapshots. `browser_snapshot` reads the text of the open page; a snapshot saves a sign-in. The tool texts say so too, so small models do not mix them up.

| Tool | What it does |
|---|---|
| [`snapshot_list`](TOOLS.md#snapshot_list) | Lists the saved snapshots: name, description, sites, cookie counts, version and where each one is loaded. Never cookie names or values |
| [`snapshot_save`](TOOLS.md#snapshot_save) | Saves this browser's sign-in: creates a new snapshot, refreshes the one loaded in this browser, or (with `replace: true`) overwrites one after you signed in again by hand |
| [`snapshot_describe`](TOOLS.md#snapshot_describe) | Changes a snapshot's description, and nothing else |
| [`snapshot_load`](TOOLS.md#snapshot_load) | Loads a snapshot into this browser: its saved cookies replace the browser's cookies for those sites, and its site storage is restored on every page load |
| [`snapshot_delete`](TOOLS.md#snapshot_delete) | Deletes a snapshot for good. Only when your user asks for it |
| [`agent_run`](TOOLS.md#agent_run) with `snapshot` | Starts a sub-agent whose private browser is already signed in, and refreshes the snapshot from it when the run succeeds |
| `save_sign_in` (a sub-agent tool) | Lets a sub-agent save a sign-in it made during its job, so the next job starts signed in |

The five `snapshot_*` tools are the `snapshots` group. The default `TOOLSETS=all` includes it; with a custom list, add `snapshots`. They work without a model. Only `agent_run` and `save_sign_in` need the [sub-agents](AGENTS.md).

## How it works

```text
your browser (main): you sign in, then
snapshot_save {"name": "amazon", "description": "Amazon — personal account (Prime)"}
        │
        ▼
SNAPSHOTS_DIR   amazon.json    description, sites, counts (no secrets)
                amazon.state   cookies and site storage (encrypted with SNAPSHOTS_KEY)
        │
        ├──▶ snapshot_load {"name": "amazon"}
        │      your browser is signed in
        │
        └──▶ agent_run {"snapshot": "amazon", …}
               the sub-agent's private browser starts signed in;
               a successful run saves the renewed sign-in back
```

Every browser keeps its own cookies, so a snapshot moves a sign-in between browsers only when an agent asks for it. Loading a snapshot into your own browser never reaches sub-agents, and a sub-agent's browser starts empty unless the host passes `snapshot` to `agent_run`.

## Choosing a snapshot

The host agent calls `snapshot_list` and picks a snapshot by its description:

```text
2 snapshot(s) (saved sign-ins):
- amazon — Amazon — personal account (Prime) · 14 cookies for amazon.com (1 expired) · storage for 1 site · v3, updated 2 h ago by sub-agent run r4c1d2e9 · loaded in: this browser (active)
- shop-work — Example Shop — work account · 6 cookies for shop.example.com · v1, updated 5 days ago by lmstudio-mcp-server-session 1.0.0

Use one: snapshot_load {"name": "amazon"} signs your browser in; agent_run {"snapshot": "amazon", …} starts a sub-agent signed in.
```

The description is what tells two snapshots of the same site apart, so keep it current: when your user says the `amazon` snapshot is really the family account, the host calls `snapshot_describe {"name": "amazon", "description": "Amazon — family account"}`. A description holds up to 500 characters. Never put a password or a code into it: descriptions are logged, shown on the dashboard, and shown to sub-agents.

`structuredContent` has the same list: every snapshot's allowlisted metadata (`name`, `description`, `version`, `domains`, `cookie_count`, `cookie_domains`, `expired_count`, `next_expiry`, `origins` with item counts, `loaded_in`, …), `loaded_here` (the snapshots loaded in the calling browser) and `active_here` (the one it loaded or saved last).

## Saving a sign-in

### Create a snapshot

Sign in to the site in your browser, with your user's help: they give the host the password or a code to type. Values typed into password and one-time-code fields are masked in the logs (`LOG_REDACT_SECRETS`). Then, with a page of that site open:

```json
{ "name": "amazon", "description": "Amazon — personal account (Prime)" }
```

```text
Created snapshot "amazon" (v1, "Amazon — personal account (Prime)"): 14 cookies for amazon.com, and the site storage of https://www.amazon.com. It is loaded in this browser. To start a sub-agent signed in, call agent_run with {"snapshot": "amazon"}.
```

- **The name** is trimmed and lowercased, spaces become `-`, and it must then be 1 to 64 lowercase letters, digits, `-` or `_`, starting with a letter or digit (`Amazon Work` becomes `amazon-work`). Results always show the stored name.
- **A new snapshot needs a description**: which site and which account, for example `Amazon — personal account (Prime)`.
- **`domains`** chooses the sites. Left out, it is the site of the active tab (its host without `www.`). See [Domain filters](#domain-filters).
- A name that is already taken is never overwritten by accident: saving under it refreshes or replaces that snapshot, as described below.

### Refresh the snapshot loaded in this browser

Sites renew their sign-in cookies. To save the current ones, call `snapshot_save` with the name of a snapshot that is loaded in this browser. It keeps the snapshot's sites, saves this browser's cookies for them as a new version (v2, v3, …), and merges the site storage of the open page into the storage saved before. `description` is optional here and replaces the old one; `domains` is ignored.

### Replace a snapshot after signing in again

A refresh is refused when the snapshot is not loaded in this browser, or when another browser saved a newer version after this one loaded it:

```text
Snapshot "amazon" changed after this browser loaded it: sub-agent run r4c1d2e9 saved v4 after this browser loaded v3. If you signed in by hand to the account this snapshot is for, call again with replace: true to overwrite it; otherwise load it first with snapshot_load, or save under a new name.
```

This keeps one browser from overwriting a sign-in that another one just renewed. When the saved sign-in has expired and you signed in again by hand to the same account, overwrite it:

```json
{ "name": "amazon", "replace": true }
```

`replace` keeps the snapshot's sites unless you pass `domains`, and saves only the site storage of the open page.

### What every save refuses

- **No sign-in cookies.** `This browser has no sign-in cookies for amazon.com; snapshot not changed.` Nothing is saved when the browser has no unexpired cookies for the snapshot's sites, so an empty browser never overwrites a working sign-in.
- **A deleted snapshot.** An update never creates: if the snapshot was deleted meanwhile, the save fails.
- **Mixing accounts.** A snapshot saved with `domains: ["*"]` takes every cookie of the browser. Saving into it is refused while another snapshot is loaded in the same browser, because that snapshot's sign-in would end up in it.
- **Too much.** A snapshot holds at most 5 MB of cookies and storage, and the server keeps at most 500 snapshots. The limit error asks the agent to ask you which snapshot to delete; agents never delete one on their own.

## Loading a snapshot into your browser

```json
{ "name": "amazon" }
```

```text
Loaded snapshot "amazon" (v3, "Amazon — personal account (Prime)") into this browser: restored 13 of 14 cookies for amazon.com (skipped 1 expired cookies for amazon.com).
Site storage of https://www.amazon.com is restored on every page load.
Open the site (browser_navigate): this browser should be signed in. Other sites' sign-ins in this browser were not changed.
```

`snapshot_load`:

1. Deletes this browser's own cookies for the snapshot's sites (every cookie, for a `["*"]` snapshot), so two accounts never mix.
2. Sets the saved cookies. Expired ones are skipped and reported by domain and count, never by name.
3. Restores the saved site storage on every page load of its origins, and on the open page at once if it is on one of them.
4. Marks the snapshot as loaded (and active) in this browser at that version, which is what a later refresh checks.

Several snapshots for different sites can be loaded in one browser. The last one loaded or saved is the browser's **active** snapshot. Cookies of other sites stay as they are.

When `OBSCURA_STORAGE_DIR` is set, the main engine also keeps the loaded cookies in its own cookie store, and the tool result says so.

If the engine restarts (a page crashed it), the browser loses its cookies. The next tool result in the main browser says `The snapshot "amazon" loaded in this browser was lost; load it again with snapshot_load.`

## Sub-agents and snapshots

`agent_run` takes three parameters for signed-in jobs:

| Parameter | Default | Meaning |
|---|---|---|
| `snapshot` | — | Name of a snapshot to start the agent's private browser with. An unknown name returns an error that lists the saved names, before anything starts |
| `update_snapshot` | `true` | When the run completes successfully, save the agent's renewed sign-in back into the snapshot |
| `allow_evaluate` | `false` | Runs started with a snapshot get no `browser_evaluate` (page scripts could read the signed-in cookies and storage) unless this is `true` |

What happens during the run:

- **At the start** the server loads the snapshot into the new browser (the dashboard shows `loading snapshot amazon`). If it cannot, because the snapshot was deleted or `SNAPSHOTS_KEY` changed after `agent_run` was called, the run fails with that reason.
- **The agent is told** in its task message which saved sign-in it has: the name, the description (as quoted data) and the cookie domains. It is told to check whether it is signed in before signing in, never to read, copy, output or send cookie or storage values, and to stay on those sites and the sites the TASK names while signed in.
- **If the isolated engine restarts** during the run, the server loads the snapshot into the new connection before the agent continues, and tells the agent `The browser was reset; your saved sign-in "amazon" was re-applied; open the page again.`
- **At the end**, when the run completed with `success: true` and `update_snapshot` is not `false`, the server saves the agent's cookies back into the snapshot. The result says `Saved sign-in "amazon" was refreshed from the agent's browser (v4).` The refresh is skipped, and the result says why, when another browser saved a newer version meanwhile, when your user deleted the snapshot during the run, when the browser was reset during the run, or when the agent's browser had no sign-in cookies for the site at the end. `structuredContent` has `snapshot: {name, version}` and `snapshot_saved: {name, version, action, reason?}`.

`agent_automate` and `agent_find` do not take snapshots. Automation scripts replay in fresh, empty browsers.

### `save_sign_in`: a sub-agent saves its sign-in

When the `snapshots` tools are enabled (`TOOLSETS`) and `AGENT_SNAPSHOT_SAVE` is on (the default), `agent_run` agents also get `save_sign_in {name?, description?}`. The agent calls it after it signed in during the job, for example with a one-time code the host gave it, and only to the account the TASK or the host named:

- If the run started with a snapshot (and `update_snapshot` is on), it refreshes that snapshot. The agent cannot change its description.
- Otherwise it creates a new snapshot for the site of the open page, with the name and description the agent gives. A job creates at most one snapshot, and a taken name is refused.
- It never saves a snapshot your user deleted during the run: `The user deleted snapshot "amazon"; do not save it again.`

The run's result reports a new snapshot: `The agent saved its sign-in as snapshot "example-shop" (v1): pass {"snapshot": "example-shop"} to agent_run to start a later job signed in.` Set `AGENT_SNAPSHOT_SAVE=false` to keep sub-agents from saving sign-ins at all.

## Example: an order, end to end

Your user asks the host agent: *"Order a 2 m USB-C cable on Amazon, under $15, and tell me the order number."*

**1. Find or make the sign-in.** The host calls `snapshot_list`. There is no Amazon snapshot yet, so it opens `https://www.amazon.com` in its own browser and signs in with your user's help, then saves it:

```json
{ "name": "amazon", "description": "Amazon — personal account (Prime)" }
```

**2. Hand over the job.** The host starts a sub-agent that is signed in from the start:

```json
{
  "task": "On https://www.amazon.com, find a USB-C to USB-C cable, 2 m, under $15 with Prime delivery, and order it to the default address with the default payment method.",
  "output": "The order number, the item, the total and the delivery date.",
  "snapshot": "amazon"
}
```

**3. The agent asks before it orders.** It searches, picks a cable, and goes to the checkout. Before it presses **Place your order**, it asks the host (reason `confirm`), and `agent_run` returns at once:

```text
Run r5b8e21f is waiting for your answer (question q3c9a01, asked on https://www.amazon.com):

Place the order for "USB-C to USB-C cable, 2 m, 100 W" at $11.99, total $12.87 with tax, delivery Thursday to the default address in Berlin, paid with the saved Visa card?

Options: Yes, place the order | No

This asks you to approve a step that cannot be undone: ask your user unless they already approved exactly this.

The run is paused and keeps its browser. Answer with agent_reply {"run_id": "r5b8e21f", "question_id": "q3c9a01", "answer": "..."}
Unanswered after 30 min it continues without an answer; agent_cancel stops it. Do not end your turn while it waits.
```

`asked on` is the page the agent's browser had open, read by the server, not text the model wrote.

**4. The host relays it.** Your user has not approved this exact order yet, so the host asks them. They say yes, and the host answers:

```json
{ "run_id": "r5b8e21f", "question_id": "q3c9a01", "answer": "Yes, place the order." }
```

**5. The run finishes.** The agent places the order, reads the confirmation and calls `finish`. `agent_reply` waits for that and returns:

```text
Answer delivered to run r5b8e21f (question q3c9a01).
Agent run r5b8e21f (agentic) completed — success. 14 steps, 2 min 41 s.

OUTPUT:
Order 112-4455667-8899001: USB-C to USB-C cable, 2 m, 100 W; total $12.87; arriving Thursday.

Questions the agent asked you (paused 48 s in total):
- q3c9a01 (confirm, answered): Place the order for "USB-C to USB-C cable, 2 m, 100 W" at $11.99, total $12.87 with tax, delivery Thursday to the default address in Berlin, paid with the saved Visa card? → "Yes, place the order."

Saved sign-in "amazon" was refreshed from the agent's browser (v2).
```

Had your user said no, the host would answer `"No, do not place the order."` and the agent would finish without ordering.

**Variations:**

- **Approved ahead of time.** If your user already said *"go ahead if it is under $15"*, the host writes that into the TASK (`approved up to $15; do not ask`). The agent then orders without asking when the checkout total is within it, and asks again if anything differs from what was approved.
- **A one-time code.** When the saved sign-in is old, the site may send a code to your user's phone. The agent asks with reason `sign_in`; such questions are secret by default, so the reply arguments include `"secret": true`. The host tells your user which site asks, and relays the code. The code is masked in logs, transcripts, results and on the dashboard, the agent types it, and the refresh at the end keeps the renewed sign-in.
- **No snapshot at all.** Without `snapshot`, the agent starts signed out. It never types a password the TASK did not give it, so it finishes with `success: false` and says which site needs a sign-in. The host then signs in in its own browser, saves a snapshot, and starts the job again with it.

Everything about questions and answers is in [Sub-agents](AGENTS.md#questions-from-sub-agents).

## Domain filters

A snapshot's `domains` decide which cookies it saves and replaces, and which site storage it keeps:

- `"amazon.com"` covers cookies for `amazon.com` and all its subdomains (`www.amazon.com`, `smile.amazon.com`).
- It also covers cookies of parent domains that a browser would send to that site: a filter `"www.example.com"` keeps the cookies set for `example.com`, which are often the session cookies. A bare top-level domain such as `com` never matches.
- Site storage is matched the same way, by the page's host.
- Entries are normalized: `https://www.example.com/login` becomes `www.example.com`, and letters are lowercased.
- `["*"]` means every cookie of the browser. It is never the default: pass it explicitly. Loading such a snapshot first deletes every cookie of the browser.

Sites that sign in across several domains need all of them, for example `["example.com", "example-login.com"]`. The default, the site of the open page, fits most sites.

## Limits of Obscura's storage

- **Cookies are the reliable part.** All of the browser's cookies for the chosen sites are saved, including `HttpOnly` ones and session cookies without an expiry. Expired cookies are skipped when a snapshot is loaded, and `snapshot_list` and the dashboard count them. The site may still have ended a session on its side, or ask again when it sees a new device or address.
- **Site storage is saved for the open page only.** In Obscura v0.2.2, `localStorage` and `sessionStorage` do not survive a navigation or a reload, and the browser can only read the storage of the page that is open. A save captures the storage of the active tab's origin (when it is one of the snapshot's sites), and a refresh merges it with the storage saved before for other origins.
- **Storage is restored on every page load.** A loaded snapshot registers a small script that writes the saved values into each new page of its origins, so pages find them after every navigation. The values go straight to the browser and are never logged.
- **Not saved:** IndexedDB, Cache Storage and service workers.
- **Engine restarts** lose the browser's cookies. The main browser must load the snapshot again; a sub-agent's browser gets it back by itself.

## Where snapshots are stored

`SNAPSHOTS_DIR` holds two files per snapshot:

| File | Contents |
|---|---|
| `<name>.json` | Metadata, no secrets: description, version, who saved it and when, the domain filter, cookie count, cookie domains, cookie expiry times, storage origins with item counts, how often it was loaded |
| `<name>.state` | The cookies and site storage: a live sign-in. Encrypted when `SNAPSHOTS_KEY` is set |

- In Docker, the folder is `/data/snapshots` on the `snapshots` named volume, which survives rebuilds and restarts. Running the server without Docker, it is `./data/snapshots` (gitignored). See [Configuration](CONFIGURATION.md#snapshots-saved-sign-ins).
- The folder is created owner-only (mode 0700) and the files 0600. Writes go through a temporary file that is then renamed, and symbolic links are refused.
- `SNAPSHOTS_DIR` must not be inside `LOG_DIR` (log folders are shared and downloadable) or be `SCRIPTS_DIR`: the server refuses to start.
- If the folder is not writable, the server logs an error at startup with a hint (`sudo chown -R 1000:1000` on a host folder) and keeps running; only the snapshot tools fail.
- A state file without valid metadata, left by a crash or a hand edit, is listed as `incomplete`. It cannot be loaded, and is never removed automatically: delete it when your user agrees.

To see the files:

```bash
docker compose exec stealth-web-search ls -l /data/snapshots
```

## Encryption at rest

Set `SNAPSHOTS_KEY` in `.env` to any secret string, and run `docker compose up -d`:

```ini
SNAPSHOTS_KEY=a-long-random-string-only-this-server-knows
```

- State files are then encrypted with AES-256-GCM. The key for each file is derived from `SNAPSHOTS_KEY` with scrypt and a random salt, and the snapshot's name is bound to the encrypted data, so a file renamed to another snapshot does not decrypt. Metadata files stay readable; they hold no secrets.
- Snapshots saved before the key was set are encrypted at the next start. The log lists how many and which.
- A changed or missing key makes the older snapshots unreadable: loading one fails with `cannot decrypt snapshot "amazon": SNAPSHOTS_KEY is missing or differs from the one used to save it`. Sign in again and save with `replace: true`, or delete them when your user agrees.
- The key is never logged. The startup line says `configured` or `none`, `config:check` says `set` or `none`, and the dashboard's Snapshots tab says whether snapshots are encrypted and counts the ones that are not.

Encryption protects copies of the volume, such as backups. It does not protect against someone who can read both `.env` and the volume.

## Deleting snapshots

Agents delete a snapshot only when your user explicitly asks for it: never to clean up, rename or make room. The server instructions and the tool description say so, and no error message suggests deleting one.

Delete with `snapshot_delete {"name": "amazon"}`, or on the dashboard. Deleting:

- removes both files for good;
- removes its site storage from every browser that loaded it, and its loaded markers;
- stops running jobs from saving it again: `save_sign_in` refuses, and the end-of-run refresh is skipped.

Cookies the snapshot already put into a browser stay there until they are cleared (`browser_clear_cookies`) or the browser closes. Sub-agent browsers are discarded when their run ends. With `OBSCURA_STORAGE_DIR`, the main engine keeps those cookies in its own store until they are cleared.

## The Snapshots tab

The dashboard (`http://127.0.0.1:8931/`) has a **Snapshots** tab next to **Agents**. It lists every snapshot with its name, description, cookie count (marked when some cookies expired or the entry is incomplete), cookie domains, where it is loaded (the main browser or a sub-agent run), and its version with who updated it and when. The footer shows the folder, whether snapshots are encrypted, and a warning for snapshots saved without encryption. The list updates live.

**Delete** asks for confirmation in the row, and says when a running sub-agent uses the snapshot. Escape cancels.

The tab uses two API routes:

| Route | What it does |
|---|---|
| `GET /api/snapshots` | The metadata of every snapshot, where each one is loaded, the folder and the encryption state. Never cookie names or values |
| `DELETE /api/snapshots/<name>` | Deletes a snapshot. The dashboard's only request that changes anything |

The delete route refuses a request (HTTP 403) unless it carries the header `X-SBM-Request: 1` and an `Origin` header naming this server (the `Host` header, a name in `ALLOWED_HOSTS`, or the host of `PUBLIC_URL`), and, when the browser sends `Sec-Fetch-Site`, that header is `same-origin` or `none`. Another website open in your browser therefore cannot delete snapshots. With `AUTH_TOKEN` set, the token is needed too. From a script:

```bash
curl -s -X DELETE http://127.0.0.1:8931/api/snapshots/amazon \
  -H 'X-SBM-Request: 1' -H 'Origin: http://127.0.0.1:8931'
```

## Security notes

- **A snapshot is a live sign-in.** Anyone who can read its state file, and the key if one is set, can act as that account. Keep the `snapshots` volume private, set `SNAPSHOTS_KEY`, and never share the folder.
- **Whoever can reach the server can use every snapshot.** Any MCP client can load a snapshot into the main browser or start a sub-agent with it. Set `AUTH_TOKEN` if anyone else can reach port 8931.
- **A signed-in sub-agent, and every page it opens, can act as that account.** Obscura v0.2.2 sends cookies on cross-site requests (it does not enforce `SameSite`), so a page the agent visits can make requests to the signed-in site with its cookies. Pass a snapshot only for jobs on that site, and keep the TASK specific. The agent is told to stay on the snapshot's sites and the sites the TASK names, and it gets no `browser_evaluate` unless you pass `allow_evaluate: true`.
- **The browsers stay isolated otherwise.** A sub-agent's browser starts empty unless the host passes `snapshot` to `agent_run`, and what you load into your own browser never reaches sub-agents.
- **Values never reach the logs.** The browser commands that read and write snapshot cookies and storage are never logged, whatever `LOG_REDACT_SECRETS` says, and tool results, the dashboard and transcripts carry names, domains and counts only. Descriptions are logged and shown: keep secrets out of them.
- **Sub-agents save sign-ins only through `save_sign_in`.** A page could try to get an agent to sign in to an account the page controls; the tool tells the agent to save only after signing in to the account the TASK or the host named. `AGENT_SNAPSHOT_SAVE=false` turns it off.

More in [SECURITY.md](../SECURITY.md) and [Troubleshooting](TROUBLESHOOTING.md#snapshots).
