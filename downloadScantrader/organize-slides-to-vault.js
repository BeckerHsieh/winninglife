#!/usr/bin/env node

/**
 * organize-slides-to-vault.js — 依「整理計畫 JSON」把人工/AI 檢視後的 slides_* 摘要寫入 Obsidian vault。
 *
 * 與 curate-key-slides.js 的差別：curate 只用 OCR 分數自動挑圖；本腳本寫入的是已逐張檢視過的
 * 分段摘要（講者段落 + 圖片 + 重點條列 + 摘要來源）與個股檔圖片，可重複執行（冪等）。
 *
 * 用法：
 *   node organize-slides-to-vault.js --init <slides資料夾> --date YYYY.MMDD [--out plan.json]
 *       依 curate-report.json（沒有就列出資料夾內 jpg）產生計畫骨架，供填寫 sections / bullets / source
 *   node organize-slides-to-vault.js <plan.json> [--vault <path>] [--dry-run] [--backup]
 *       依計畫寫入 vault（預設不備份；--backup 才產生 .bak-<timestamp>）
 *
 * 計畫 JSON 欄位：
 *   date          YYYY.MMDD，對應 0000_2026大盤.md 的 "# YYYY.MMDD" 標題
 *   folder        slides 資料夾（相對於計畫檔所在目錄）
 *   sections[]    { title, images[], bullets[] } — 依序寫入該日區塊
 *   stockEntries[]{ code, tag, images[] }       — 以 4 位數代碼比對個股檔並在最前面插入該日圖片
 *   noteEntries[] { file, tag, images[] }       — 非個股檔（如 0000貴金屬.md）的同類插入
 *   source        「摘要來源」文字（必填，Obsidian 規範）
 *
 * bullets 內可用 [[@6488]] 或 [[@6488|環球晶]]，執行時會依 vault 內檔名轉成
 * [[6488環球晶]] / [[6488環球晶|環球晶]]；找不到個股檔則退回純文字。
 */

const fs = require('fs-extra');
const path = require('path');
const {
  findDailyBlockRange,
  findStockFileByCode,
  prependStockEntry,
  copyImagesToVaultSlides,
} = require('./vault-writer');

function parseCliArgs(argv) {
  const r = { plan: '', init: '', date: '', out: '', vault: '', dryRun: false, backup: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = argv[i + 1];
    if (t === '--init' && next) { r.init = next; i++; continue; }
    if (t === '--date' && next) { r.date = next; i++; continue; }
    if (t === '--out' && next) { r.out = next; i++; continue; }
    if (t === '--vault' && next) { r.vault = next; i++; continue; }
    if (t === '--dry-run') { r.dryRun = true; continue; }
    if (t === '--backup') { r.backup = true; continue; }
    if (!t.startsWith('--') && !r.plan) r.plan = t;
  }
  return r;
}

function detectEol(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n';
}

function markers(date) {
  return {
    start: `<!-- slides-organizer:${date} -->`,
    end: `<!-- /slides-organizer:${date} -->`,
  };
}

async function writeAtomic(filePath, text, backup) {
  if (backup) await fs.copy(filePath, `${filePath}.bak-${Date.now()}`);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.move(tmp, filePath, { overwrite: true });
}

async function runInit(cli) {
  if (!/^\d{4}\.\d{4}$/.test(cli.date)) throw new Error('--init 需搭配 --date YYYY.MMDD');
  const folder = path.resolve(cli.init);
  if (!(await fs.pathExists(folder))) throw new Error(`找不到資料夾: ${folder}`);

  let images;
  const reportPath = path.join(folder, 'curate-report.json');
  if (await fs.pathExists(reportPath)) {
    const report = await fs.readJson(reportPath);
    images = (report.candidates || []).map((c) => c.file);
  } else {
    images = (await fs.readdir(folder)).filter((f) => /\.(jpe?g|png)$/i.test(f));
  }
  images.sort();

  const out = path.resolve(cli.out || path.join(__dirname, 'plans', `${path.basename(folder)}.json`));
  if (await fs.pathExists(out)) throw new Error(`計畫檔已存在，不覆寫: ${out}`);
  const plan = {
    date: cli.date,
    folder: path.relative(path.dirname(out), folder).replace(/\\/g, '/'),
    sections: [{ title: '講者（職稱）：主題', images, bullets: [] }],
    stockEntries: [],
    noteEntries: [],
    source: '《節目名稱》YYYY.MMDD 節目（單元），依 slides_MMDD 逐張檢視投影片畫面整理，非逐字稿。',
  };
  await fs.ensureDir(path.dirname(out));
  await fs.writeJson(out, plan, { spaces: 2 });
  console.log(`已產生計畫骨架: ${out}`);
  console.log(`圖片 ${images.length} 張；請逐張檢視後拆成 sections、填寫 bullets / stockEntries / source，再執行寫入。`);
}

async function resolveWikilinks(text, vaultPath, cache) {
  const re = /\[\[@(\d{4})(?:\|([^\]]+))?\]\]/g;
  const codes = [...new Set([...text.matchAll(re)].map((m) => m[1]))];
  for (const code of codes) {
    if (!cache.has(code)) {
      const found = await findStockFileByCode(vaultPath, code);
      cache.set(code, found.ok ? path.basename(found.file, '.md') : null);
    }
  }
  return text.replace(re, (_, code, display) => {
    const base = cache.get(code);
    if (!base) return display ? `${display}（${code}，尚無個股檔）` : `${code}（尚無個股檔）`;
    return display ? `[[${base}|${display}]]` : `[[${base}]]`;
  });
}

function validatePlan(plan, folder) {
  if (!/^\d{4}\.\d{4}$/.test(plan.date || '')) throw new Error('計畫 date 格式需為 YYYY.MMDD');
  if (!plan.source || !String(plan.source).trim()) throw new Error('計畫缺少 source（摘要來源為必填）');
  if (!Array.isArray(plan.sections) || plan.sections.length === 0) throw new Error('計畫沒有 sections');
  const all = new Set();
  for (const s of plan.sections) (s.images || []).forEach((f) => all.add(f));
  for (const e of [...(plan.stockEntries || []), ...(plan.noteEntries || [])]) (e.images || []).forEach((f) => all.add(f));
  const missing = [...all].filter((f) => !fs.pathExistsSync(path.join(folder, f)));
  if (missing.length) throw new Error(`下列圖片不存在於 ${folder}: ${missing.join(', ')}`);
  return [...all];
}

async function runApply(cli) {
  const planPath = path.resolve(cli.plan);
  const plan = await fs.readJson(planPath);
  const folder = path.resolve(path.dirname(planPath), plan.folder || '.');
  const allImages = validatePlan(plan, folder);

  const vaultArg = cli.vault || process.env.SCANTRADER_VAULT_PATH;
  if (!vaultArg) {
    throw new Error('未指定 vault 路徑。請用 --vault <path>，或設定環境變數 SCANTRADER_VAULT_PATH');
  }
  const vaultPath = path.resolve(vaultArg);
  const daPanPath = path.join(vaultPath, '0000_2026大盤.md');
  if (!(await fs.pathExists(daPanPath))) throw new Error(`找不到大盤日誌: ${daPanPath}`);

  // 先確認日期區塊存在，再做任何寫入
  const probe = findDailyBlockRange(await fs.readFile(daPanPath, 'utf8'), plan.date);
  if (!probe.ok) {
    throw new Error(
      probe.reason === 'date-not-found'
        ? `找不到日期 ${plan.date} 的條目。附近可用日期: ${(probe.suggestions || []).join(', ')}`
        : `日期 ${plan.date} 比對到多筆區塊，請手動確認 0000_2026大盤.md`
    );
  }
  const tagText = probe.lines[probe.headerLineIndex].replace(/^#\s+\d{4}\.\d{4}\s*/, '').trim();

  // 圖片：複製到 vault\slides，衝突時改名並用改名後的檔名
  const slidesDir = path.join(vaultPath, 'slides');
  const copy = cli.dryRun
    ? { resultFilenames: allImages, copied: [], skipped: allImages, renamed: [] }
    : await copyImagesToVaultSlides(allImages, folder, slidesDir);
  const nameMap = new Map(allImages.map((f, i) => [f, copy.resultFilenames[i]]));
  const vaultName = (f) => nameMap.get(f);
  if (!cli.dryRun) console.log(`圖片：新複製 ${copy.copied.length}、已存在 ${copy.skipped.length}、改名 ${copy.renamed.length}`);
  copy.renamed.forEach((r) => console.log(`  ${r.from} -> ${r.to}`));

  // 組出日期區塊內容
  const cache = new Map();
  const bodyLines = [];
  for (const sec of plan.sections) {
    bodyLines.push(`**${sec.title}**`);
    (sec.images || []).forEach((f) => bodyLines.push(`![[${vaultName(f)}]]`));
    for (const b of sec.bullets || []) bodyLines.push(`- ${await resolveWikilinks(b, vaultPath, cache)}`);
    bodyLines.push('');
  }
  bodyLines.push(`**摘要來源**：${await resolveWikilinks(plan.source, vaultPath, cache)}`);
  const mk = markers(plan.date);
  const blockBody = [mk.start, ...bodyLines, mk.end];

  // 重新讀取大盤檔（使用者可能正在 Obsidian 編輯），只動標記範圍或區塊末尾
  const original = await fs.readFile(daPanPath, 'utf8');
  const eol = detectEol(original);
  const range = findDailyBlockRange(original, plan.date);
  if (!range.ok) throw new Error('寫入前重讀大盤檔時找不到日期區塊，已中止');
  const lines = range.lines.slice();

  const s = lines.findIndex((l, i) => i > range.headerLineIndex && i < range.blockEndLineIndex && l.trim() === mk.start);
  const e = lines.findIndex((l, i) => i > range.headerLineIndex && i < range.blockEndLineIndex && l.trim() === mk.end);
  let newLines;
  if (s !== -1 && e > s) {
    newLines = [...lines.slice(0, s), ...blockBody, ...lines.slice(e + 1)];
    console.log('大盤.md：取代既有整理區塊');
  } else {
    // 插在日期區塊最後一個非空白行之後，保留與下一個日期之間的空行
    let last = range.blockEndLineIndex - 1;
    while (last > range.headerLineIndex && lines[last].trim() === '') last--;
    newLines = [...lines.slice(0, last + 1), '', ...blockBody, ...lines.slice(last + 1)];
    console.log('大盤.md：新增整理區塊');
  }

  if (cli.dryRun) {
    console.log('\n[dry-run] 區塊內容預覽：\n');
    console.log(blockBody.join('\n'));
  } else {
    await writeAtomic(daPanPath, newLines.join(eol), cli.backup);
  }

  // 個股檔與其他筆記檔
  const targets = [];
  for (const en of plan.stockEntries || []) {
    const found = await findStockFileByCode(vaultPath, en.code);
    if (!found.ok) {
      console.log(`個股 ${en.code} 找不到個股檔（${found.reason}），略過`);
      continue;
    }
    targets.push({ label: found.file, p: found.path, en });
  }
  for (const en of plan.noteEntries || []) {
    const p = path.join(vaultPath, en.file);
    if (!(await fs.pathExists(p))) {
      console.log(`筆記 ${en.file} 不存在，略過`);
      continue;
    }
    targets.push({ label: en.file, p, en });
  }
  for (const t of targets) {
    const r = await prependStockEntry(
      t.p,
      plan.date,
      t.en.tag || tagText,
      (t.en.images || []).map(vaultName),
      { dryRun: cli.dryRun, backup: cli.backup }
    );
    console.log(`${t.label}：${r.ok ? (r.skipped ? '圖片皆已存在，略過' : `新增 ${r.inserted.length} 張`) : `失敗 ${r.reason}`}`);
  }
  console.log(cli.dryRun ? '\n[dry-run] 完成，未寫入任何 vault 檔案。' : '\n完成。');
}

(async () => {
  const cli = parseCliArgs(process.argv.slice(2));
  try {
    if (cli.init) await runInit(cli);
    else if (cli.plan) await runApply(cli);
    else {
      console.error('用法: node organize-slides-to-vault.js <plan.json> [--vault <path>] [--dry-run] [--backup]\n' +
        '      node organize-slides-to-vault.js --init <slides資料夾> --date YYYY.MMDD [--out plan.json]');
      process.exit(1);
    }
  } catch (err) {
    console.error('執行失敗:');
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
})();
