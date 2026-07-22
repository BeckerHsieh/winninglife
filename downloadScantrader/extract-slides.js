#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { extractSlidesOnly } = require('./postprocess');

async function collectVideoFiles(targetPath) {
  const abs = path.resolve(targetPath);
  const stat = await fs.stat(abs);

  if (stat.isFile()) {
    if (!/\.(mp4|ts)$/i.test(abs)) throw new Error(`不是 mp4/ts 檔案: ${abs}`);
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
    if (itemStat.isDirectory()) continue;
    if (/\.(mp4|ts)$/i.test(full)) files.push(full);
  }
  return files;
}

(async () => {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('用法: node extract-slides.js <mp4/ts檔案或資料夾>');
    process.exit(1);
  }

  const videoFiles = await collectVideoFiles(inputPath);
  if (videoFiles.length === 0) {
    console.log('找不到任何 mp4/ts 檔案');
    return;
  }

  let success = 0;
  for (let i = 0; i < videoFiles.length; i++) {
    const videoPath = videoFiles[i];
    try {
      const result = await extractSlidesOnly(videoPath);
      success++;
      console.log(`[${i + 1}/${videoFiles.length}] 完成: ${path.basename(videoPath)} -> ${result.slideCount} 張`);
      console.log(`  輸出資料夾: ${result.slideDir}`);
    } catch (err) {
      console.error(`[${i + 1}/${videoFiles.length}] 失敗: ${videoPath}`);
      console.error(`  ${err.message}`);
    }
  }

  console.log(`\n簡報擷取完成: ${success}/${videoFiles.length}`);
})();
