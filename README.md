# 9router × Antigravity fix

**Make Google Antigravity in [9router](https://github.com/decolua/9router) stop erroring and only offer models that actually work.**

9router ships an Antigravity model list that drifts from what Google really serves, so the dashboard offers models that answer `404 NOT_FOUND`, and the router keeps a *fake* `429 RESOURCE_EXHAUSTED` for perfectly healthy accounts whenever a client sends an agent-style system prompt. Both failures look like "this account is broken" — they are not.

This repo is the exact patch that fixed it on a live 9router-pro instance (2 Google accounts, free/Plus/Pro), turned into a reproducible tool:

| symptom | real cause | fix |
|---|---|---|
| `404 Requested entity was not found` | model id no longer served by any account (`gemini-3.6/3.7-flash-*`, `claude-*-5-5-*`, `gemini-pro-agent`, …) | `models[]` replaced with the verified catalog |
| `429 Resource has been exhausted (e.g. check quota)` while quota is ~99% | Google gates the `systemInstruction` text: `You are Claude Code` / `You are Hermes Agent` / `You are Cline` / `You are OpenCode` → fake 429 | prompt rewrites neutralize the identity line |
| `503 upstream error` on `gemini-2.5-pro` | per-model `MODEL_CAPACITY_EXHAUSTED` (error 2010), not account quota | id dropped from the catalog |

Everything is data-driven from [`catalog.json`](catalog.json), which was produced by probing real accounts — not by copying a model list from a screenshot.

---

## Quick start

```bash
git clone https://github.com/<you>/9router-antigravity-fix.git
cd 9router-antigravity-fix

# 1. see what would change
node scripts/apply.mjs --repo ~/9router --dry-run

# 2. patch (backs up each file to *.bak-<timestamp>)
node scripts/apply.mjs --repo ~/9router

# 3. rebuild + restart your 9router
cd ~/9router && npm run build && sudo systemctl restart 9router
#   ...or let the script do it:
#   node ~/9router-antigravity-fix/scripts/apply.mjs --repo ~/9router --build --restart 9router

# 4. prove it through /v1 (one real call per model)
node scripts/verify.mjs --url http://127.0.0.1:20127
```

Expected tail of step 4:

```
200  gemini-3.8-flash-medium         1421ms
200  gemini-4-hydrogen-sonar         2310ms
...
16 ok / 0 failed — catalog matches reality
```

Requirements: Node ≥ 22.5 (uses `node:sqlite` to read 9router's DB read-only), a working 9router with at least one Antigravity OAuth connection, and the ability to rebuild it (`npm run build`).

---

## What exactly gets patched

Only two files. Both edits are idempotent — re-running, or running after `git pull`, replaces the managed block instead of duplicating it.

### 1. `open-sse/config/appConstants.js`

Adds rules inside `ANTIGRAVITY_PROMPT_REWRITES` (they run in `open-sse/executors/antigravity.js` right before the request goes upstream, and only touch `systemInstruction.parts`):

```js
{ from: /^[ \t]*You are Hermes Agent, built by Nous Research\.[^\n]*/gm, to: "You are an AI assistant." },
{ from: /^[ \t]*You are (?:Claude Code|Cline|OpenCode)\b[^\n]*/gim, to: "You are an AI assistant." },
{ from: /You are Hermes Agent\b[^.\n]*\.?/gi, to: "You are an AI assistant." },
{ from: /You are Claude Code\b[^.\n]*\.?/gi, to: "You are an AI assistant." },
{ from: /You are Cline\b[^.\n]*\.?/gi, to: "You are an AI assistant." },
```

### 2. `open-sse/providers/registry/antigravity.js`

Replaces `models: [ … ]` with the verified list from `catalog.json`:

```
gemini-4-hydrogen-sonar
gemini-3.8-flash-high / -medium / -low / bare / -tiered
gemini-3.5-flash-lite · gemini-3.1-flash-lite · gemini-3-flash
gemini-2.5-flash · -flash-lite · -flash-thinking
claude-sonnet-4-6 · claude-opus-4-6-thinking · gpt-oss-120b-medium
gemini-3.1-flash-image (image)
```

Removed because they **404 on every account** (absent from `fetchAvailableModels`):
`gemini-3.6-flash-{high,medium,low}`, `gemini-3.7-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}`,
`gemini-pro-agent`, `claude-sonnet-5-5{,-low,-medium,-high}`, `claude-opus-5-5{,-low,-medium,-high}`,
`gemini-4-{argon,carbon,neon}*`.
Removed because it **cannot generate on these accounts** (per-model capacity gate):
`gemini-2.5-pro`.

> Why removing matters even though the router would just fail: every 404/429 locks that **connection for that model** for ~2 minutes, then falls over to the next account, which fails the same way. One dead id turns into a wall of errors and a slow request.

---

## The evidence

### Fake 429 — bisected live, two accounts, same result

| `systemInstruction` | status |
|---|---|
| absent · `""` · `You are a helpful assistant.` · any neutral text | **200** |
| `You are Claude Code` (even without the full stop) | **429** |
| `You are Claude Code, Anthropic's official CLI for Claude.` | **429** |
| `You are Hermes Agent` / `You are Hermes Agent, built by Nous Research. Be direct…` | **429** |
| `You are Cline, an AI coding agent.` | **429** |
| `You are OpenCode.` | **429** |
| `You are Hermes` · bare `Claude Code` · `You are Cursor/Codex/Windsurf/Gemini CLI` | 200 |
| the same sentence placed in a **user** turn | 200 |

Notes:
- The response body is a bare `429 RESOURCE_EXHAUSTED` with **no `details`** — that is why it looks like quota exhaustion. Account quota at the same moment: 99.9% remaining.
- It is not length- or token-based: a 250-char neutral prompt passes. It is substring matching on a handful of agent identities.
- It is not per-plan: a Google AI Pro account, a Google AI Plus account and a free account behave identically. If you were told "my Pro account doesn't work but my other one does", the difference was the client/prompt — not the subscription.

### Model catalog — authoritative, per account

`fetchAvailableModels` returned the *same 22 entries* for both accounts (6 of them `-disabled` or internal `tab_*`), and every live-tier account reports `currentTier: free-tier`. Ids outside that set are 404 for everyone, no matter what the subscription is.

---

## Re-generating the catalog later

Google rotates this catalog every few weeks. When you see `404` or `429` again, don't guess — ask the accounts:

```bash
node scripts/probe.mjs --repo ~/9router --data-dir ~/.9router          # tier, quota, per-model status
node scripts/probe.mjs --repo ~/9router --data-dir ~/.9router --emit   # rewrite catalog.json from the result
node scripts/apply.mjs  --repo ~/9router --build --restart 9router
node scripts/verify.mjs --key sk-...
```

`probe.mjs` never writes to 9router's database: it opens SQLite read-only, refreshes the OAuth token of each `antigravity` connection, then calls `loadCodeAssist`, `retrieveUserQuotaSummary`, `fetchAvailableModels` and a real `generateContent` per model. The OAuth client it uses to refresh is read from **your** 9router checkout (`--repo`, or `AG_CLIENT_ID`/`AG_CLIENT_SECRET` env) — this repo stores no credentials.

`verify.mjs` needs an API key for `/v1`: pass `--key sk-...` from the dashboard (API Keys). It can only auto-read one from the DB while 9router still keeps it in plaintext — current builds store only a `sha256:` hash, so passing `--key` is the normal case.

Probe result is what `catalog.json` should contain — a model is only "alive" if **every** account answers `200`.

---

## Manual install (no scripts)

1. Open `open-sse/config/appConstants.js`, find `export const ANTIGRAVITY_PROMPT_REWRITES = [` and paste the five rules from the section above as the first entries.
2. Open `open-sse/providers/registry/antigravity.js`, replace the whole `models: [ … ]` array with the entries from [`catalog.json`](catalog.json) (`id` → `id`, `name` → `name`, `upstreamModelId` → same).
3. `npm run build` in the 9router checkout (must run as the user that owns `.next`), then restart the service.
4. `curl` a model through `/v1/chat/completions` and check for `200`.

---

## Troubleshooting

| what you see | what it means |
|---|---|
| still `404` after the patch | your client hardcodes a removed id (e.g. `gemini-3.7-flash-low` in a Claude Code profile). Switch it to `gemini-3.8-flash-medium` / `-high`. |
| `503 upstream error` with a `[429]` inside | all accounts are locked for that *model*. 9router always answers 503 in that branch (`src/sse/handlers/chat.js`), the inner message is the truth. |
| `429` on a model that `verify.mjs` says is 200 | the account's weekly/5-hour bucket ran out — check `node scripts/probe.mjs` quota lines and wait for `resetTime`. |
| `fetchAvailableModels: 0 entries` | the OAuth grant died or the account needs verification → reconnect the account in the dashboard. |
| build fails with EACCES on `.next` | you built as root over a checkout owned by another user — `sudo -u <service-user> npm run build`. |
| `git pull` wiped the patch | re-run `node scripts/apply.mjs --repo ~/9router` (idempotent), then rebuild. |

---

## Scope & disclaimers

- This patches **your local 9router checkout**. It is not an upstream PR; 9router updates can overwrite the managed blocks (re-run `apply.mjs`).
- It does not bypass Google's quotas, verification (`VALIDATION_REQUIRED`) or capacity gates — it only stops 9router from offering broken ids and from tripping a prompt-signature gate. Accounts still need to be eligible on Google's side.
- Related upstream discussion: [decolua/9router#5695](https://github.com/decolua/9router/issues/5695) (fake-429 root-cause bisect), PRs [#5745](https://github.com/decolua/9router/pull/5745) / [#5738](https://github.com/decolua/9router/pull/5738) / [#5703](https://github.com/decolua/9router/pull/5703) (Hermes/OpenClaw prompt lines), [#2225](https://github.com/decolua/9router/issues/2225) (the old "Pro account fails" report — it was a translator bug, not the plan).
- Use it on accounts you own. You are responsible for how you use the upstream service.

MIT — do whatever, no warranty.
