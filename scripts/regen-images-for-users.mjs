#!/usr/bin/env node
// One-shot image regen for users whose dashscope image_url
// has expired (24h pre-signed OSS, all 403). Independent of the D1
// blob persistence path. Does NOT modify worker code; only updates menu_pool rows
// via wrangler d1 execute.
//
// Usage:
//   node scripts/regen-images-for-users.mjs \
//     --users alice,bob,carol \
//     --iso-weeks 2026-W19,2026-W20 \
//     [--dry-run] [--resume] [--limit N] [--concurrency 1]
//
// Auth / env:
//   DASHSCOPE_API_KEY   required (image gen)
//   IMAGE_MODEL         optional, default 'wan2.7-image-pro' (matches wrangler.toml vars)
//   D1_DATABASE         optional, default 'health_db'
//   WRANGLER_BIN        optional, default 'npx wrangler'
//
// Output: prints progress per row, writes /tmp/regen-failed.tsv on failures,
// final summary { scanned, updated, skipped, failed }.
//
// Rate limit: 1 image / 1.5s (configurable via --rate-ms).
// Retry: 1 retry on failure with 3s backoff.

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

// ─── arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    users: [], isoWeeks: [], dryRun: false, resume: false,
    limit: 0, concurrency: 1, rateMs: 1500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--users':       args.users = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--iso-weeks':   args.isoWeeks = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--dry-run':     args.dryRun = true; break;
      case '--resume':      args.resume = true; break;
      case '--limit':       args.limit = parseInt(next(), 10) || 0; break;
      case '--concurrency': args.concurrency = parseInt(next(), 10) || 1; break;
      case '--rate-ms':     args.rateMs = parseInt(next(), 10) || 1500; break;
      case '--help': case '-h':
        console.log('Usage: regen-images-for-users.mjs --users a,b --iso-weeks 2026-W19 [--dry-run] [--resume]');
        process.exit(0);
    }
  }
  return args;
}

// ─── env / wrangler helpers ──────────────────────────────────────────────
const ENV = {
  apiKey: process.env.DASHSCOPE_API_KEY,
  imageModel: process.env.IMAGE_MODEL || 'wan2.7-image-pro',
  database: process.env.D1_DATABASE || 'health_db',
  wranglerBin: process.env.WRANGLER_BIN || 'npx wrangler',
};

const IMG_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const IMG_TIMEOUT_MS = 60_000;
const RESUME_WINDOW_MS = 12 * 3600_000;
const FAILED_TSV = '/tmp/regen-failed.tsv';

/** SQL escape: single-quote a string literal. */
function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Run wrangler d1 execute --remote --json and return parsed result rows. */
function d1Query(sql) {
  const cmd = ENV.wranglerBin.split(/\s+/);
  const args = [...cmd.slice(1), 'd1', 'execute', ENV.database, '--remote', '--json', '--command', sql];
  const out = spawnSync(cmd[0], args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) {
    throw new Error(`wrangler d1 execute failed: ${out.stderr || out.stdout}`);
  }
  // wrangler returns an array of result groups; we run a single statement.
  const parsed = JSON.parse(out.stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first?.results) ?? [];
}

// ─── prompt builder (inlined from src/lib/menu-gen.ts buildImagePrompt) ──
function buildImagePrompt(content) {
  const topIngredients = (content.ingredients || []).slice(0, 3).map(i => i.name).join(', ');
  return `${content.name}, ingredients: ${topIngredients}, photographed top-down on a warm wooden table, soft natural daylight, Melbourne home kitchen, no text, no logos, photorealistic, shallow depth of field`;
}

// ─── dashscope image gen ──────────────────────────────────────────────────
async function generateImageUrl(prompt) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMG_TIMEOUT_MS);
  try {
    const res = await fetch(IMG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENV.apiKey}` },
      body: JSON.stringify({
        model: ENV.imageModel,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters: { watermark: false },
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const imgUrl = data?.output?.choices?.[0]?.message?.content?.[0]?.image ?? '';
    if (!imgUrl) throw new Error('empty image URL');
    return imgUrl;
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithRetry(prompt) {
  try {
    return await generateImageUrl(prompt);
  } catch (err) {
    await new Promise(r => setTimeout(r, 3000));
    return await generateImageUrl(prompt); // 1 retry, throw on second failure
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── main ─────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.users.length || !args.isoWeeks.length) {
    console.error('error: --users and --iso-weeks required (see --help)');
    process.exit(2);
  }
  if (!args.dryRun && !ENV.apiKey) {
    console.error('error: DASHSCOPE_API_KEY required for non-dry-run');
    process.exit(2);
  }

  const usersList = args.users.map(sqlStr).join(',');
  const weeksList = args.isoWeeks.map(sqlStr).join(',');
  const resumeCutoff = Date.now() - RESUME_WINDOW_MS;

  // 1. resolve usernames → user_ids
  const userRows = d1Query(`SELECT id, username FROM users WHERE username IN (${usersList})`);
  if (!userRows.length) {
    console.error(`no users matched: ${args.users.join(',')}`);
    process.exit(2);
  }
  const userIds = userRows.map(r => r.id);
  console.log(`[regen] resolved ${userRows.length} users:`, userRows.map(r => `${r.username}=${r.id}`).join(' '));

  // 2. scan rows. seq=0 only (image is per meal-cell, not per pool variant).
  //    Image_blob is checked NULL (else we already have D1 blob) and image_url
  //    must be non-empty (else there's nothing to regen — empty cells are a
  //    different bug class).
  const idsList = userIds.join(',');
  const resumeClause = args.resume
    ? `AND (image_url_generated_at IS NULL OR image_url_generated_at < ${resumeCutoff})`
    : '';
  const limitClause = args.limit > 0 ? `LIMIT ${args.limit}` : '';
  const sql = `
    SELECT id, user_id, iso_week, day, meal, content
      FROM menu_pool
     WHERE user_id IN (${idsList})
       AND iso_week IN (${weeksList})
       AND seq = 0
       AND image_blob IS NULL
       AND image_url IS NOT NULL
       ${resumeClause}
     ORDER BY user_id, iso_week, day, meal
     ${limitClause}
  `.trim();

  const rows = d1Query(sql);
  console.log(`[regen] candidate rows: ${rows.length}`);

  // Per-user × per-week tally for the report.
  const tally = {};
  for (const r of rows) {
    const u = userRows.find(x => x.id === r.user_id)?.username ?? `id:${r.user_id}`;
    const k = `${u} ${r.iso_week}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log('[regen] per (user, iso_week):');
  for (const [k, n] of Object.entries(tally)) console.log(`  ${k}: ${n}`);

  if (args.dryRun) {
    console.log(`[regen] DRY-RUN done. would process ${rows.length} rows.`);
    return;
  }

  // 3. iterate, regen, UPDATE.
  let updated = 0, skipped = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tag = `[regen ${i + 1}/${rows.length} u=${row.user_id} ${row.iso_week} ${row.day}/${row.meal}]`;
    let content;
    try {
      content = JSON.parse(row.content);
    } catch (e) {
      console.warn(`${tag} skip — content not parseable`);
      skipped++; continue;
    }
    const prompt = buildImagePrompt(content);
    try {
      const url = await generateWithRetry(prompt);
      const now = Date.now();
      // UPDATE via wrangler. URL-escape for SQL literal; dashscope URLs do
      // contain `&` and `=` which are fine in single-quoted literals.
      const upd = `UPDATE menu_pool SET image_url=${sqlStr(url)}, image_url_generated_at=${now} WHERE id=${row.id}`;
      d1Query(upd);
      updated++;
      console.log(`${tag} ok`);
    } catch (err) {
      failed++;
      const msg = err?.message || String(err);
      failures.push([row.id, row.user_id, row.iso_week, row.day, row.meal, msg].join('\t'));
      console.error(`${tag} FAIL ${msg}`);
    }
    if (i < rows.length - 1) await sleep(args.rateMs);
  }

  if (failures.length) {
    writeFileSync(FAILED_TSV, 'pool_id\tuser_id\tiso_week\tday\tmeal\terror\n' + failures.join('\n') + '\n');
    console.log(`[regen] failures written to ${FAILED_TSV}`);
  }

  console.log(`[regen] DONE scanned=${rows.length} updated=${updated} skipped=${skipped} failed=${failed}`);
}

main().catch(err => {
  console.error('[regen] FATAL', err);
  process.exit(1);
});
