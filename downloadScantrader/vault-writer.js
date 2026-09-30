/**
 * vault-writer.js — 將重點 slide 寫入 Obsidian 個人筆記 vault
 *
 * 純處理 vault 端既有 markdown 檔案的字串定位與插入邏輯，不含 OCR/ffmpeg。
 * 預設不備份（可用 opts.backup=true 才備份成 .bak-<timestamp>），寫入採「寫暫存檔→原子性 rename」，
 * 避免寫入中斷造成 vault 檔案損毀；找不到對應區塊時不做任何寫入。
 */

const fs = require('fs-extra');
const path = require('path');

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectEol(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

function buildEmbedLine(filename) {
  return `![[${filename}]]`;
}

/**
 * 在 0000_2026大盤.md 這類日誌 markdown 裡，定位指定日期（YYYY.MMDD）的區塊範圍，
 * 並找出「最後一張既有圖片」所在行，作為新圖片/wikilink 的插入點。
 */
function findDailyBlockRange(mdText, dateDotted) {
  const eol = detectEol(mdText);
  const lines = String(mdText || '').split(/\r\n|\n/);
  const headerRe = new RegExp(`^#\\s+${escapeRegExp(dateDotted)}(?!\\d)`);
  const anyHeaderRe = /^#\s+\d{4}\.\d{4}\b/;

  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) matches.push(i);
  }

  if (matches.length === 0) {
    const suggestions = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#\s+(\d{4}\.\d{4})\b/);
      if (m) suggestions.push(m[1]);
    }
    return { ok: false, reason: 'date-not-found', suggestions: suggestions.slice(0, 10) };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous-date', matches };
  }

  const headerLineIndex = matches[0];
  let blockEndLineIndex = lines.length;
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    if (anyHeaderRe.test(lines[i])) {
      blockEndLineIndex = i;
      break;
    }
  }

  const imageLineRe = /^!\[\[.+\]\]$/;
  let insertionLineIndex = -1;
  for (let i = blockEndLineIndex - 1; i > headerLineIndex; i--) {
    if (imageLineRe.test(lines[i].trim())) {
      insertionLineIndex = i;
      break;
    }
  }

  if (insertionLineIndex === -1) {
    // 區塊內完全沒有既有圖片：插在來源連結之後（若有），否則插在標題之後
    let idx = headerLineIndex;
    const linkLineRe = /^(\[.*\]\(https?:\/\/.*\)|https?:\/\/\S+)$/;
    if (headerLineIndex + 1 < blockEndLineIndex && linkLineRe.test(lines[headerLineIndex + 1].trim())) {
      idx = headerLineIndex + 1;
    }
    insertionLineIndex = idx;
  }

  return {
    ok: true,
    headerLineIndex,
    blockEndLineIndex,
    insertionLineIndex,
    lines,
    eol,
    blockText: lines.slice(headerLineIndex, blockEndLineIndex).join('\n'),
  };
}

/**
 * 在指定日期區塊插入新的 ![[image]] 與 [[wikilink]] 行。
 * 已存在的圖片/wikilink 會自動跳過，確保重跑不會重複新增。
 */
async function insertImagesAndWikilinks(mdPath, dateDotted, { filenames = [], wikilinks = [] } = {}, opts = {}) {
  const original = await fs.readFile(mdPath, 'utf8');
  const range = findDailyBlockRange(original, dateDotted);
  if (!range.ok) return { ok: false, reason: range.reason, suggestions: range.suggestions };

  const { lines, eol, insertionLineIndex, blockText } = range;

  const insertedImages = filenames.filter((f) => !blockText.includes(buildEmbedLine(f)));
  const insertedWikilinks = wikilinks.filter((w) => !blockText.includes(`[[${w}]]`));

  if (insertedImages.length === 0 && insertedWikilinks.length === 0) {
    return { ok: true, insertedImages: [], insertedWikilinks: [], skipped: true };
  }

  if (opts.dryRun) {
    return { ok: true, insertedImages, insertedWikilinks, dryRun: true };
  }

  let backupPath = null;
  if (opts.backup === true) {
    backupPath = `${mdPath}.bak-${Date.now()}`;
    await fs.copy(mdPath, backupPath);
  }

  const insertLines = [
    ...insertedImages.map(buildEmbedLine),
    ...insertedWikilinks.map((w) => `[[${w}]]`),
  ];
  const newLines = [
    ...lines.slice(0, insertionLineIndex + 1),
    ...insertLines,
    ...lines.slice(insertionLineIndex + 1),
  ];

  const tmpPath = `${mdPath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, newLines.join(eol), 'utf8');
  await fs.move(tmpPath, mdPath, { overwrite: true });

  return { ok: true, insertedImages, insertedWikilinks, backupPath };
}

/** 以 4 位數股票代碼比對既有的個股 markdown 檔（避免用 OCR 中文名稱誤判）。 */
async function findStockFileByCode(vaultStockDir, code) {
  const files = await fs.readdir(vaultStockDir);
  const matches = files.filter((f) => f.startsWith(String(code)) && f.toLowerCase().endsWith('.md'));
  if (matches.length === 0) return { ok: false, reason: 'not-found' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  return { ok: true, file: matches[0], path: path.join(vaultStockDir, matches[0]) };
}

/** 在個股 markdown 檔最前面插入新區塊（新→舊排序），已存在的圖片會自動跳過。 */
async function prependStockEntry(stockMdPath, dateDotted, tagText, filenames = [], opts = {}) {
  const exists = await fs.pathExists(stockMdPath);
  const original = exists ? await fs.readFile(stockMdPath, 'utf8') : '';
  const eol = detectEol(original) || '\n';

  const inserted = filenames.filter((f) => !original.includes(buildEmbedLine(f)));
  if (inserted.length === 0) {
    return { ok: true, inserted: [], skipped: true };
  }

  if (opts.dryRun) {
    return { ok: true, inserted, dryRun: true };
  }

  let backupPath = null;
  if (exists && opts.backup === true) {
    backupPath = `${stockMdPath}.bak-${Date.now()}`;
    await fs.copy(stockMdPath, backupPath);
  }

  const headerSuffix = tagText ? ` ${tagText}` : '';
  const blockLines = [`# ${dateDotted}${headerSuffix}`, ...inserted.map(buildEmbedLine), ''];
  const newContent = original
    ? `${blockLines.join(eol)}${eol}${original}`
    : `${blockLines.join(eol)}${eol}`;

  const tmpPath = `${stockMdPath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, newContent, 'utf8');
  await fs.move(tmpPath, stockMdPath, { overwrite: true });

  return { ok: true, inserted, backupPath };
}

async function filesIdentical(pathA, pathB) {
  const [bufA, bufB] = await Promise.all([fs.readFile(pathA), fs.readFile(pathB)]);
  return bufA.equals(bufB);
}

/**
 * 複製圖片到 vault 的 stock\slides\。同名但內容不同才視為真衝突並改名，
 * 回傳實際使用的檔名，供後續 markdown 插入時使用（避免連結到錯誤的圖）。
 */
async function copyImagesToVaultSlides(candidateFiles, sourceDir, vaultSlidesDir) {
  await fs.ensureDir(vaultSlidesDir);
  const copied = [];
  const skipped = [];
  const renamed = [];
  const resultFilenames = [];

  for (const filename of candidateFiles) {
    const src = path.join(sourceDir, filename);
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);

    let destFilename = filename;
    let dest = path.join(vaultSlidesDir, destFilename);
    let counter = 0;
    let reuseExisting = false;

    while (await fs.pathExists(dest)) {
      if (await filesIdentical(src, dest)) {
        reuseExisting = true;
        break;
      }
      counter += 1;
      destFilename = `${base}_c${counter}${ext}`;
      dest = path.join(vaultSlidesDir, destFilename);
    }

    if (reuseExisting) {
      skipped.push(destFilename);
      resultFilenames.push(destFilename);
      continue;
    }

    if (destFilename !== filename) {
      renamed.push({ from: filename, to: destFilename });
    }
    await fs.copy(src, dest);
    copied.push(destFilename);
    resultFilenames.push(destFilename);
  }

  return { copied, skipped, renamed, resultFilenames };
}

module.exports = {
  findDailyBlockRange,
  buildEmbedLine,
  insertImagesAndWikilinks,
  findStockFileByCode,
  prependStockEntry,
  copyImagesToVaultSlides,
};
