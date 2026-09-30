#!/usr/bin/env node

/**
 * curate-key-slides.js — 從 runDownload.bat/runSlides.bat 產生的原始 slide 幀
 * 篩選出「重點」slide，並（可選）寫入 Obsidian 個人筆記 vault。
 *
 * --report-only（預設）：去重 + OCR 評分，輸出候選報告，不動 vault。
 * --apply：讀取候選報告（或重新計算），複製圖片到 vault、更新大盤.md 與對應個股檔。
 */

const fs = require('fs-extra');
const path = require('path');

function parseCliArgs(argv) {
  const args = [...argv];
  const result = {
    folder: '',
    date: '',
    mode: null,
    vault: '',
    topN: null,
    minScore: null,
    ssimThreshold: null,
    scaleWidth: null,
    fromReport: '',
    forceRecompute: false,
    dryRun: false,
    backup: false,
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      if (!result.folder) result.folder = token;
      continue;
    }

    if (token === '--report-only') { result.mode = 'report-only'; continue; }
    if (token === '--apply') { result.mode = 'apply'; continue; }
    if (token === '--dry-run') { result.dryRun = true; continue; }
    if (token === '--force-recompute') { result.forceRecompute = true; continue; }
    if (token === '--backup') { result.backup = true; continue; }

    const next = args[i + 1];
    if (token === '--date' && next) { result.date = next; i++; continue; }
    if (token === '--vault' && next) { result.vault = next; i++; continue; }
    if (token === '--top-n' && next) { result.topN = Number(next); i++; continue; }
    if (token === '--min-score' && next) { result.minScore = Number(next); i++; continue; }
    if (token === '--ssim-threshold' && next) { result.ssimThreshold = Number(next); i++; continue; }
    if (token === '--scale-width' && next) { result.scaleWidth = Number(next); i++; continue; }
    if (token === '--from-report' && next) { result.fromReport = next; i++; continue; }
  }

  if (!result.mode) result.mode = 'report-only';
  return result;
}

function resolveVaultPath(cliVault) {
  const vault = cliVault || process.env.SCANTRADER_VAULT_PATH;
  if (!vault) {
    throw new Error(
      "未指定 vault 路徑。請用 --vault <path>，或設定環境變數 SCANTRADER_VAULT_PATH " +
      "(PowerShell 範例: $env:SCANTRADER_VAULT_PATH = 'D:\\...\\stock')"
    );
  }
  return path.resolve(vault);
}

function buildSelectOpts(cli) {
  const opts = {};
  if (Number.isFinite(cli.ssimThreshold)) opts.threshold = cli.ssimThreshold;
  if (Number.isFinite(cli.scaleWidth)) opts.scaleWidth = cli.scaleWidth;
  if (Number.isFinite(cli.minScore)) opts.minScore = cli.minScore;
  if (Number.isFinite(cli.topN)) opts.topN = cli.topN;
  return opts;
}

async function runReportOnly(cli) {
  const { selectKeySlides, writeCandidateReport } = require('./postprocess');
  const folder = path.resolve(cli.folder);
  if (!(await fs.pathExists(folder))) {
    throw new Error(`找不到資料夾: ${folder}`);
  }

  console.log(`分析資料夾: ${folder}`);
  const startedAt = Date.now();
  const selection = await selectKeySlides(folder, buildSelectOpts(cli));
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  const { jsonPath, mdPath } = await writeCandidateReport(selection, folder);

  console.log(`原始幀數: ${selection.totalRawFrames}`);
  console.log(`去重後段落數: ${selection.totalRuns}`);
  console.log(`入選候選數: ${selection.candidates.length}`);
  console.log(`OCR 錯誤數: ${selection.ocrErrors.length}`);
  console.log(`SSIM 比對警告數: ${selection.warnings.length}`);
  console.log(`耗時: ${elapsedSec} 秒`);
  console.log(`報告已輸出: ${mdPath}`);
  console.log(`（完整資料: ${jsonPath}）`);
}

async function runApply(cli) {
  const { selectKeySlides, writeCandidateReport } = require('./postprocess');
  const {
    findDailyBlockRange,
    insertImagesAndWikilinks,
    findStockFileByCode,
    prependStockEntry,
    copyImagesToVaultSlides,
  } = require('./vault-writer');

  const vaultPath = resolveVaultPath(cli.vault);
  const daPanPath = path.join(vaultPath, '0000_2026大盤.md');
  const slidesDir = path.join(vaultPath, 'slides');

  if (!(await fs.pathExists(vaultPath))) throw new Error(`找不到 vault 路徑: ${vaultPath}`);
  if (!(await fs.pathExists(daPanPath))) throw new Error(`找不到大盤日誌: ${daPanPath}`);
  await fs.ensureDir(slidesDir);

  const daPanText = await fs.readFile(daPanPath, 'utf8');
  const range = findDailyBlockRange(daPanText, cli.date);
  if (!range.ok) {
    if (range.reason === 'date-not-found') {
      throw new Error(`找不到日期 ${cli.date} 的條目。附近可用日期: ${(range.suggestions || []).join(', ')}`);
    }
    throw new Error(`日期 ${cli.date} 比對到多筆區塊，請手動確認 0000_2026大盤.md`);
  }
  const headerLine = range.lines[range.headerLineIndex];
  const tagText = headerLine
    .replace(new RegExp(`^#\\s+${cli.date.replace(/\./g, '\\.')}\\s*`), '')
    .trim();

  const folder = path.resolve(cli.folder);
  const reportPath = cli.fromReport ? path.resolve(cli.fromReport) : path.join(folder, 'curate-report.json');

  let selection;
  if (!cli.forceRecompute && (await fs.pathExists(reportPath))) {
    console.log(`讀取既有候選報告: ${reportPath}`);
    selection = await fs.readJson(reportPath);
  } else {
    console.log('重新計算候選 slide（去重 + OCR 評分）...');
    selection = await selectKeySlides(folder, buildSelectOpts(cli));
    await writeCandidateReport(selection, folder);
  }

  if (!selection.candidates || selection.candidates.length === 0) {
    console.log('沒有符合條件的候選 slide，不做任何寫入。');
    return;
  }

  const candidateFiles = selection.candidates.map((c) => c.file);
  console.log(`複製 ${candidateFiles.length} 張候選圖片到 vault slides 資料夾...`);
  const copyResult = cli.dryRun
    ? { resultFilenames: candidateFiles, copied: [], skipped: candidateFiles, renamed: [] }
    : await copyImagesToVaultSlides(candidateFiles, folder, slidesDir);

  if (copyResult.renamed.length > 0) {
    console.log('以下圖片檔名衝突，已改名：');
    for (const r of copyResult.renamed) console.log(`  ${r.from} -> ${r.to}`);
  }

  const stockPlan = [];
  selection.candidates.forEach((c, i) => {
    const resultFilename = copyResult.resultFilenames[i];
    for (const s of c.stocks) {
      const key = `${s.code}${s.name}`;
      let entry = stockPlan.find((e) => e.key === key);
      if (!entry) {
        entry = { key, code: s.code, name: s.name, filenames: [] };
        stockPlan.push(entry);
      }
      if (!entry.filenames.includes(resultFilename)) entry.filenames.push(resultFilename);
    }
  });

  console.log(`更新 0000_2026大盤.md 的 # ${cli.date} 區塊...`);
  const insertResult = await insertImagesAndWikilinks(
    daPanPath,
    cli.date,
    { filenames: copyResult.resultFilenames, wikilinks: stockPlan.map((e) => e.key) },
    { dryRun: cli.dryRun, backup: cli.backup }
  );

  if (!insertResult.ok) {
    throw new Error(`寫入大盤.md 失敗: ${insertResult.reason}`);
  }
  console.log(`  新增圖片: ${insertResult.insertedImages.length} 張, 新增 wikilink: ${insertResult.insertedWikilinks.length} 個`);
  if (insertResult.backupPath) console.log(`  備份: ${insertResult.backupPath}`);

  for (const entry of stockPlan) {
    const found = await findStockFileByCode(vaultPath, entry.code);
    if (!found.ok) {
      console.log(`  股票代碼 ${entry.code}${entry.name} 找不到對應個股檔，略過個股同步（${found.reason}）`);
      continue;
    }
    console.log(`同步更新個股檔: ${found.file}`);
    const stockResult = await prependStockEntry(found.path, cli.date, tagText, entry.filenames, {
      dryRun: cli.dryRun,
      backup: cli.backup,
    });
    if (!stockResult.ok) {
      console.log(`  更新失敗: ${stockResult.reason}`);
      continue;
    }
    console.log(`  新增圖片: ${stockResult.inserted.length} 張${stockResult.skipped ? '（皆已存在，略過）' : ''}`);
  }

  console.log('\n完成。');
}

(async () => {
  const cli = parseCliArgs(process.argv.slice(2));
  try {
    if (!cli.folder || !cli.date) {
      console.error(
        '用法: node curate-key-slides.js <slides資料夾> --date YYYY.MMDD [--report-only|--apply] ' +
        '[--vault <path>] [--top-n N] [--min-score N] [--ssim-threshold 0.92] [--dry-run]'
      );
      process.exit(1);
    }
    if (!/^\d{4}\.\d{4}$/.test(cli.date)) {
      console.error(`--date 格式錯誤，需為 YYYY.MMDD（例如 2026.0915），實際輸入: ${cli.date}`);
      process.exit(1);
    }

    if (cli.mode === 'apply') {
      await runApply(cli);
    } else {
      await runReportOnly(cli);
    }
  } catch (err) {
    console.error('執行失敗:');
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
})();
