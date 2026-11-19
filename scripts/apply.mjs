#!/usr/bin/env node
// 9router × Antigravity fix — apply the verified model catalog + prompt sanitizer
//
// Two edits, both idempotent (safe to re-run, safe on a second run after a
// `git pull` from upstream):
//
//   1. open-sse/config/appConstants.js
//      → ANTIGRAVITY_PROMPT_REWRITES gets the agent-identity rules that stop
//        Google answering a FAKE 429 RESOURCE_EXHAUSTED for prompts that say
//        "You are Claude Code" / "You are Hermes Agent" / "You are Cline".
//
//   2. open-sse/providers/registry/antigravity.js
//      → models[] is replaced by catalog.json: only ids that answered 200 on a
//        real account. Dead ids (3.5/3.6/3.7 legacy, claude-5.5, pro-agent,
//        2.5-pro) are gone, so the dashboard stops offering them and the router
//        stops locking connections on 404.
//
// Usage:
//   node scripts/apply.mjs --repo ~/9router                 # patch only
//   node scripts/apply.mjs --repo ~/9router --dry-run       # show what changes
//   node scripts/apply.mjs --repo ~/9router --build --restart 9router-pro
//
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MARK_RW = "AG-FIX:rewrites";
const MARK_CAT = "AG-FIX:catalog";
// Accept any previously written marker (older releases used a different prefix) so
// re-running over an already-patched checkout upgrades the block instead of adding a
// second one.
const MARK_ANY = "[A-Z0-9-]+";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

if (flag("help") || argv.length === 0) {
  console.log(`9router × Antigravity fix — apply working catalog + prompt sanitizer

  node scripts/apply.mjs --repo ~/9router [--dry-run] [--build] [--restart <unit>]
  node scripts/probe.mjs [--data-dir ~/.9router] [--emit] [--models a,b,c]
  node scripts/verify.mjs [--url http://127.0.0.1:20127] [--key sk-...] [--system "You are Claude Code."]

Patches two files in the 9router checkout (idempotent, backups written):
  open-sse/config/appConstants.js              → ANTIGRAVITY_PROMPT_REWRITES
  open-sse/providers/registry/antigravity.js   → models[] from catalog.json

Full guide: README.md`);
  process.exit(0);
}

// ── locate the 9router checkout ─────────────────────────────────────────────
function findRepo(explicit) {
  const candidates = [
    explicit,
    process.env.ROUTER_REPO,
    process.cwd(),
    join(process.env.HOME || "/root", "9router"),
    join(process.env.HOME || "/root", "9router-pro"),
    "/home/ubuntu/ai-stack/9router-pro",
    "/opt/9router",
  ].filter(Boolean);
  for (const c of candidates) {
    const p = resolve(c);
    if (existsSync(join(p, "open-sse/providers/registry/antigravity.js")) &&
        existsSync(join(p, "open-sse/config/appConstants.js"))) return p;
  }
  throw new Error("9router checkout not found — pass --repo /path/to/9router");
}

const repo = findRepo(arg("repo"));
const catalog = JSON.parse(readFileSync(join(ROOT, "catalog.json"), "utf8"));
const dryRun = flag("dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

// ── prompt-identity rules ───────────────────────────────────────────────────
// Verified 2026-11-19 against a healthy account: these exact sentences answer
// 429 RESOURCE_EXHAUSTED (bare body, no details) while neutral text answers 200.
const REWRITE_BLOCK = `  // ─── ${MARK_RW} (managed by 9router-antigravity-fix) ───
  // Google answers a FAKE 429 RESOURCE_EXHAUSTED (no details, looks like quota)
  // when systemInstruction carries a competing agent's identity line. Bisected
  // live 2026-11-19: "You are Claude Code" / "You are Hermes Agent" / "You are
  // Cline" / "You are OpenCode" → 429; "You are a helpful assistant." → 200.
  // Only systemInstruction is gated — the same text in a user turn is fine.
  { from: /^[ \\t]*You are Hermes Agent, built by Nous Research\\.[^\\n]*/gm, to: "You are an AI assistant." },
  { from: /^[ \\t]*You are (?:Claude Code|Cline|OpenCode)\\b[^\\n]*/gim, to: "You are an AI assistant." },
  { from: /You are Hermes Agent\\b[^.\\n]*\\.?/gi, to: "You are an AI assistant." },
  { from: /You are Claude Code\\b[^.\\n]*\\.?/gi, to: "You are an AI assistant." },
  { from: /You are Cline\\b[^.\\n]*\\.?/gi, to: "You are an AI assistant." },
  // ─── /${MARK_RW} ───`;

// ── catalog block ───────────────────────────────────────────────────────────
function modelLine(m) {
  const props = [
    `id: ${JSON.stringify(m.id)}`,
    `name: ${JSON.stringify(m.name)}`,
  ];
  if (m.upstreamModelId) props.push(`upstreamModelId: ${JSON.stringify(m.upstreamModelId)}`);
  if (m.kind) props.push(`kind: ${JSON.stringify(m.kind)}`);
  if (m.imageGen) props.push(`imageGen: true`);
  if (m.capabilities) props.push(`capabilities: ${JSON.stringify(m.capabilities)}`);
  return `    { ${props.join(", ")} },`;
}

function catalogBlock() {
  const dead = catalog.dead.map(d => d.id).join(", ");
  const lines = [
    `    // ─── ${MARK_CAT} (managed by 9router-antigravity-fix) ───`,
    `    // Verified live ${catalog.verifiedAt} against ${catalog.verifiedOn.join(", ")}: every id below`,
    `    // answered 200 through /v1. Removed because they answer 404 NOT_FOUND on every`,
    `    // account (absent from fetchAvailableModels) or MODEL_CAPACITY_EXHAUSTED:`,
    `    // ${dead}.`,
    `    // Re-add an id only after fetchAvailableModels lists it AND a /v1 call returns 200.`,
    ...catalog.models.map(modelLine),
    `    // ─── /${MARK_CAT} ───`,
  ];
  return lines.join("\n");
}

// ── patch helpers ───────────────────────────────────────────────────────────
function patchFile(rel, transform) {
  const p = join(repo, rel);
  const before = readFileSync(p, "utf8");
  const after = transform(before);
  if (after === before) {
    console.log(`  = ${rel} already applied`);
    return false;
  }
  if (dryRun) {
    console.log(`  ~ ${rel} WOULD change (${before.length} → ${after.length} bytes)`);
    return true;
  }
  copyFileSync(p, `${p}.bak-${stamp}`);
  writeFileSync(p, after);
  console.log(`  + ${rel} patched (backup: .bak-${stamp})`);
  return true;
}

function applyRewrites(src) {
  if (new RegExp(`─── ${MARK_ANY}:rewrites`).test(src)) {
    return src.replace(
      new RegExp(`  // ─── ${MARK_ANY}:rewrites[\\s\\S]*?// ─── /${MARK_ANY}:rewrites ───`),
      REWRITE_BLOCK,
    );
  }
  const anchor = "export const ANTIGRAVITY_PROMPT_REWRITES = [";
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error("ANTIGRAVITY_PROMPT_REWRITES not found — upstream layout changed");
  const at = i + anchor.length;
  return src.slice(0, at) + "\n" + REWRITE_BLOCK + src.slice(at);
}

function applyCatalog(src) {
  if (!src.includes('id: "antigravity"')) throw new Error("not the antigravity registry file");
  const re = /(\n  models: \[\n)([\s\S]*?)(\n  \],)/;
  if (!re.test(src)) throw new Error("models[] array not found — upstream layout changed");
  return src.replace(re, (_m, head, _body, tail) => `${head}${catalogBlock()}\n${tail}`);
}

console.log(`9router × Antigravity fix`);
console.log(`repo: ${repo}${dryRun ? "  [dry-run]" : ""}\n`);

let changed = false;
changed = patchFile("open-sse/config/appConstants.js", applyRewrites) || changed;
changed = patchFile("open-sse/providers/registry/antigravity.js", applyCatalog) || changed;

if (!changed) {
  console.log("\nnothing to do — already patched.");
  process.exit(0);
}
if (dryRun) {
  console.log("\ndry-run: no files written.");
  process.exit(0);
}

// ── optional build + restart ────────────────────────────────────────────────
const unit = arg("restart");
if (flag("build")) {
  console.log("\nbuilding (next build)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", "build"], { cwd: repo, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  console.log("build ok");
}
if (unit) {
  console.log(`\nrestarting ${unit}…`);
  execFileSync("sudo", ["systemctl", "restart", unit], { stdio: "inherit" });
  execFileSync("systemctl", ["is-active", unit], { stdio: "inherit" });
}

console.log(`
next steps
  1. ${flag("build") ? "build done — " : "rebuild:  npm run build\n     "}restart the service${unit ? "" : ":  systemctl restart <your-9router-unit>"}
  2. verify:  node scripts/verify.mjs --url http://127.0.0.1:20127
  3. re-list what your accounts actually serve:  node scripts/probe.mjs --emit
`);
