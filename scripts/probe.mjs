#!/usr/bin/env node
// 9router × Antigravity fix — probe what your accounts really serve
//
// Reads the antigravity OAuth connections straight out of 9router's SQLite DB
// (read-only), refreshes each token, then asks Google three questions:
//
//   loadCodeAssist      → which tier is this account on (free-tier / standard-tier)
//   fetchAvailableModels→ the authoritative model catalog for the account
//   generateContent     → does a real call return 200, or 404/429 and why
//
// Usage:
//   node scripts/probe.mjs                          # table, no writes
//   node scripts/probe.mjs --emit                    # rewrite catalog.json from live result
//   node scripts/probe.mjs --data-dir /home/u/.9router
//   node scripts/probe.mjs --models gemini-3.8-flash-medium,gemini-4-hydrogen-sonar
//
// Requires Node ≥ 22.5 (node:sqlite). Nothing is ever written to 9router's DB.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

// OAuth client: never hardcoded here. It is read from YOUR 9router checkout (the
// registry file ships the public Antigravity CLI client), or from env:
//   AG_CLIENT_ID / AG_CLIENT_SECRET   AG_CLIENT_UA
const UA = process.env.AG_CLIENT_UA || "antigravity/hub/2.24.0 darwin/arm64";
const BASE = "https://daily-cloudcode-pa.googleapis.com";
const PROJECT = "aicode-consumers";

function findRouterRepo() {
  const cands = [arg("repo"), process.env.ROUTER_REPO, process.cwd(),
    join(process.env.HOME || "", "9router"), join(process.env.HOME || "", "9router-pro"),
    "/home/ubuntu/ai-stack/9router-pro", "/opt/9router"].filter(Boolean);
  for (const c of cands) {
    const p = resolve(c);
    if (existsSync(join(p, "open-sse/providers/registry/antigravity.js"))) return p;
  }
  return null;
}

function oauthClient() {
  if (process.env.AG_CLIENT_ID && process.env.AG_CLIENT_SECRET) {
    return { id: process.env.AG_CLIENT_ID, secret: process.env.AG_CLIENT_SECRET };
  }
  const repo = findRouterRepo();
  if (!repo) {
    throw new Error("cannot find the 9router checkout to read the OAuth client — pass --repo /path/to/9router or set AG_CLIENT_ID/AG_CLIENT_SECRET");
  }
  const src = readFileSync(join(repo, "open-sse/providers/registry/antigravity.js"), "utf8");
  const id = src.match(/(\d{10,}-[a-z0-9]+\.apps\.googleusercontent\.com)/)?.[1];
  const secret = src.match(/(GOCSPX-[A-Za-z0-9_-]{10,})/)?.[1];
  if (!id || !secret) throw new Error(`no OAuth client found in ${repo}/open-sse/providers/registry/antigravity.js`);
  return { id, secret };
}

const CLIENT = oauthClient();

function dataDir() {
  const explicit = arg("data-dir") || process.env.DATA_DIR;
  if (explicit) {
    if (!existsSync(join(explicit, "db", "data.sqlite")) && !existsSync(join(explicit, "data.sqlite"))) {
      throw new Error(`no data.sqlite under ${explicit} — check --data-dir`);
    }
    return explicit;
  }
  const cands = [join(process.env.HOME || "", ".9router"), "/home/ubuntu/.9router", "/root/.9router"].filter(Boolean);
  for (const c of cands) {
    if (existsSync(join(c, "db", "data.sqlite")) || existsSync(join(c, "data.sqlite"))) return c;
  }
  throw new Error("9router data dir not found — pass --data-dir ~/.9router");
}

function dbPath(dir) {
  const a = join(dir, "db", "data.sqlite");
  return existsSync(a) ? a : join(dir, "data.sqlite");
}

async function connections(db) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("node:sqlite unavailable — Node ≥ 22.5 required (node -v)");
  }
  const con = new DatabaseSync(db, { readOnly: true });
  try {
    return con.prepare(
      "select id, email, name, isActive, priority, data from providerConnections where provider = 'antigravity' order by priority"
    ).all().map(r => ({ ...r, data: JSON.parse(r.data || "{}") }));
  } finally {
    con.close();
  }
}

async function post(url, body, token, { form = false } = {}) {
  const headers = { "User-Agent": UA };
  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body).toString();
  } else {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

async function refresh(conn) {
  const rt = conn.data?.refreshToken;
  if (!rt) return { error: "no refreshToken on this connection" };
  const r = await post("https://oauth2.googleapis.com/token", {
    grant_type: "refresh_token", refresh_token: rt,
    client_id: CLIENT.id, client_secret: CLIENT.secret,
  }, null, { form: true });
  if (r.status !== 200) return { error: `refresh HTTP ${r.status}: ${r.text.slice(0, 120)}` };
  return { accessToken: r.json.access_token };
}

async function generate(accessToken, model) {
  const bare = model.replace(/\([^()]+\)\s*$/, "");
  const r = await post(`${BASE}/v1internal:generateContent`, {
    model: bare,
    project: PROJECT,
    userAgent: "antigravity",
    requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
    request: {
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
      generationConfig: { maxOutputTokens: 16 },
      sessionId: crypto.randomUUID(),
    },
  }, accessToken);
  const err = r.json?.error || {};
  const reason = (err.details || []).find(d => d.reason)?.reason || "";
  return { status: r.status, message: (err.message || "").replace(/\s+/g, " ").slice(0, 110), reason };
}

// ── main ────────────────────────────────────────────────────────────────────
const dir = dataDir();
const conns = await connections(dbPath(dir));
if (!conns.length) {
  console.log("no antigravity connections in this DB — add the account in the 9router dashboard first");
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(join(ROOT, "catalog.json"), "utf8"));
const modelArg = arg("models");
const wanted = modelArg ? modelArg.split(",").map(s => s.trim()).filter(Boolean) : null;
// A catalog id is the *client-facing* name; upstreamModelId is what Google expects
// (e.g. gemini-3.8-flash → gemini-3.8-flash-medium(medium)). Always call the upstream id.
const entries = catalog.models
  .filter(m => !wanted || wanted.includes(m.id))
  .map(m => ({ id: m.id, upstream: (m.upstreamModelId || m.id).replace(/\([^()]+\)\s*$/, "") }));
for (const w of wanted || []) {
  if (!entries.some(e => e.id === w)) entries.push({ id: w, upstream: w.replace(/\([^()]+\)\s*$/, "") });
}
const ids = entries.map(e => e.id);

const results = new Map(); // `${email}|${id}` → status
for (const conn of conns) {
  console.log(`\n=== ${conn.email}  (active=${conn.isActive}, priority=${conn.priority})`);
  const t = await refresh(conn);
  if (t.error) { console.log(`  ! ${t.error}`); continue; }
  const at = t.accessToken;

  const lca = await post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    { metadata: { ideType: 9, platform: 2, pluginType: 2 } }, at);
  const tier = lca.json?.currentTier;
  const ineligible = lca.json?.ineligibleTiers;
  console.log(`  tier: ${tier?.id || "?"}${ineligible?.length ? "  | ineligible: " + JSON.stringify(ineligible).slice(0, 160) : ""}`);

  const quota = await post(`${BASE}/v1internal:retrieveUserQuotaSummary`, {}, at);
  for (const g of quota.json?.groups || []) {
    for (const b of g.buckets || []) {
      console.log(`  quota: ${g.displayName} · ${b.displayName} · ${(Number(b.remainingFraction) * 100).toFixed(2)}% left · reset ${b.resetTime || "?"}`);
    }
  }

  const avail = await post(`${BASE}/v1internal:fetchAvailableModels`, { project: PROJECT }, at);
  const served = Object.keys(avail.json?.models || {});
  console.log(`  fetchAvailableModels: ${served.length} entries`);
  const missing = entries.filter(e => !served.includes(e.upstream)).map(e => e.upstream);
  if (missing.length) console.log(`  ! not in this account's catalog: ${missing.join(", ")}`);

  for (const { id, upstream } of entries) {
    const g = await generate(at, upstream);
    const verdict = g.status === 200 ? "OK  " : g.reason || (g.status === 429 ? "QUOTA" : String(g.status));
    const label = upstream === id ? id : `${id} → ${upstream}`;
    console.log(`  ${String(g.status).padStart(3)} ${label.padEnd(42)} ${verdict}${g.message && g.status !== 200 ? " — " + g.message : ""}`);
    const key = `${conn.email}|${id}`;
    if (!results.has(key)) results.set(key, g.status);
    await new Promise(r => setTimeout(r, 400));
  }
}

// ── aggregate ───────────────────────────────────────────────────────────────
const alive = ids.filter(id => conns.every(c => results.get(`${c.email}|${id}`) === 200));
const dead = ids.filter(id => !alive.includes(id));
console.log(`\nalive on every account (${alive.length}): ${alive.join(", ") || "-"}`);
console.log(`not usable      (${dead.length}): ${dead.join(", ") || "-"}`);

if (flag("emit")) {
  const names = new Map(catalog.models.map(m => [m.id, m]));
  const known = new Map(catalog.dead.map(d => [d.id, d.reason]));
  catalog.models = alive.map(id => names.get(id) || { id, name: id });
  catalog.dead = dead.map(id => ({ id, reason: known.get(id) || "did not answer 200 on every account during probe" }));
  catalog.verifiedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(join(ROOT, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  console.log(`\ncatalog.json rewritten: ${alive.length} alive / ${dead.length} dead`);
  console.log("now run: node scripts/apply.mjs --repo <path-to-9router> --build");
}
