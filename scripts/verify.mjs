#!/usr/bin/env node
// 9router × Antigravity fix — end-to-end verify through /v1
//
// Sends one real chat completion per catalog model through the router (not the
// upstream directly) and prints 200 / 404 / 429 / 503. This is the check that
// matters: it proves the patched registry + translator + executor agree.
//
// Usage:
//   node scripts/verify.mjs                              # auto key from DB
//   node scripts/verify.mjs --url http://127.0.0.1:20127 --key sk-9r-...
//   node scripts/verify.mjs --system "You are Claude Code."   # also test the sanitizer
//
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const url = (arg("url") || process.env.ROUTER_URL || "http://127.0.0.1:20127").replace(/\/$/, "");
const catalog = JSON.parse(readFileSync(join(ROOT, "catalog.json"), "utf8"));

async function apiKeyFromDb() {
  const explicit = arg("data-dir") || process.env.DATA_DIR;
  const cands = [explicit, join(process.env.HOME || "", ".9router"), "/home/ubuntu/.9router"].filter(Boolean);
  for (const dir of cands) {
    const db = [join(dir, "db", "data.sqlite"), join(dir, "data.sqlite")].find(existsSync);
    if (!db) continue;
    const { DatabaseSync } = await import("node:sqlite");
    const con = new DatabaseSync(db, { readOnly: true });
    try {
      const row = con.prepare("select key from apiKeys where isActive = 1 limit 1").get();
      // 9router stores only a salted hash (`sha256:sk:...`), so an auto-read key can
      // only be used while the row still holds a plaintext value.
      if (row?.key && !String(row.key).startsWith("sha256:")) return row.key;
      if (row?.key) {
        console.warn("note: 9router stores API keys hashed — copy the plaintext key from the dashboard (API Keys) and pass --key sk-...");
      }
    } finally { con.close(); }
  }
  return null;
}

const key = arg("key") || process.env.ROUTER_KEY || (await apiKeyFromDb());
if (!key) {
  console.error("no API key — pass --key sk-... (dashboard → API Keys)");
  process.exit(1);
}

const systemPrompt = arg("system");
const provider = arg("provider", "ag");

async function call(model) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: "Reply with exactly: OK" });
  const t0 = Date.now();
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: `${provider}/${model}`, stream: false, max_tokens: 16, messages }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.text();
    let msg = "";
    if (res.status !== 200) {
      try { msg = JSON.parse(body)?.error?.message || body; } catch { msg = body; }
    }
    return { status: res.status, ms: Date.now() - t0, msg: String(msg).replace(/\s+/g, " ").slice(0, 120) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, msg: e.message.slice(0, 100) };
  }
}

let ok = 0, bad = 0;
for (const m of catalog.models) {
  const r = await call(m.id);
  if (r.status === 200) ok++; else bad++;
  console.log(`${String(r.status).padStart(3)}  ${m.id.padEnd(28)} ${String(r.ms).padStart(6)}ms  ${r.status === 200 ? "" : r.msg}`);
}

if (systemPrompt) {
  console.log(`\nsanitizer check — system prompt: ${JSON.stringify(systemPrompt)}`);
  for (const m of catalog.models.slice(0, 3)) {
    const r = await call(m.id);
    console.log(`${String(r.status).padStart(3)}  ${m.id.padEnd(28)} ${r.status === 200 ? "200 = rewrite working (429 would mean the trigger leaked through)" : r.msg}`);
  }
}

console.log(`\n${ok} ok / ${bad} failed — ${ok === catalog.models.length ? "catalog matches reality" : "some ids still fail, run scripts/probe.mjs --emit"}`);
process.exit(ok === catalog.models.length ? 0 : 1);
