#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { summarizeSrtToMarkdown } = require('./postprocess');

async function collectSrtFiles(targetPath) {
  const abs = path.resolve(targetPath);
  const stat = await fs.stat(abs);

  if (stat.isFile()) {
    if (!/\.srt$/i.test(abs)) throw new Error(`不是 .srt 檔案: ${abs}`);
    return [abs];
  }

  if (!stat.isDirectory()) {
    throw new Error(`無效路徑: ${abs}`);
  }

  const all = await fs.readdir(abs);
  const files = [];
  for (const item of all) {
    const full = path.join(abs, item);
    const itemStat = await fs.stat(full);
    if (itemStat.isDirectory()) {
      const nested = await collectSrtFiles(full);
      files.push(...nested);
      continue;
    }
    if (/\.srt$/i.test(full)) files.push(full);
  }
  return files;
}

(async () => {
  const inputPath = process.argv[2];
  const outputMd = process.argv[3] || null;

  if (!inputPath) {
    console.error('用法: node summarize-srt.js <srt檔案或資料夾> [輸出md檔]');
    process.exit(1);
  }

  const srtFiles = await collectSrtFiles(inputPath);
  if (srtFiles.length === 0) {
    console.log('找不到任何 .srt 檔案');
    return;
  }

  let success = 0;
  for (let i = 0; i < srtFiles.length; i++) {
    const srtPath = srtFiles[i];
    const singleOutput = outputMd && srtFiles.length === 1 ? outputMd : null;
    try {
      const result = await summarizeSrtToMarkdown(srtPath, singleOutput);
      success++;
      console.log(`[${i + 1}/${srtFiles.length}] 完成: ${path.basename(result.mdPath)} (摘要 ${result.summaryCount} 條)`);
    } catch (err) {
      console.error(`[${i + 1}/${srtFiles.length}] 失敗: ${srtPath}`);
      console.error(`  ${err.message}`);
    }
  }

  console.log(`\nSRT 彙整完成: ${success}/${srtFiles.length}`);
})();
