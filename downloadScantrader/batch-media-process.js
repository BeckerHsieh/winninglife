#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { extractSlidesOnly, summarizeSrtToMarkdown } = require('./postprocess');

async function collectFilesRecursive(targetPath, matcher) {
  const abs = path.resolve(targetPath);
  const stat = await fs.stat(abs);

  if (stat.isFile()) {
    return matcher(abs) ? [abs] : [];
  }

  if (!stat.isDirectory()) {
    throw new Error(`無效路徑: ${abs}`);
  }

  const all = await fs.readdir(abs);
  const files = [];
  for (const item of all) {
    const full = path.join(abs, item);
    const nested = await collectFilesRecursive(full, matcher);
    files.push(...nested);
  }
  return files;
}

function normalizeToken(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function findBestMatchingSrt(videoPath, srtFiles) {
  if (!Array.isArray(srtFiles) || srtFiles.length === 0) return null;

  const videoDir = path.dirname(videoPath);
  const baseName = path.parse(videoPath).name;
  const workDir = path.join(videoDir, baseName);
  const baseToken = normalizeToken(baseName);

  let best = null;
  let bestScore = -1;

  for (const srtPath of srtFiles) {
    const srtDir = path.dirname(srtPath);
    const srtBase = path.parse(srtPath).name;
    const srtToken = normalizeToken(srtBase);
    let score = 0;

    if (srtPath === path.join(workDir, 'asr', 'asr_audio.srt')) score += 130;
    if (srtDir === path.join(workDir, 'asr')) score += 120;
    if (srtDir === workDir) score += 90;
    if (srtDir === videoDir) score += 70;

    if (srtBase === baseName) score += 100;
    if (baseToken && srtToken === baseToken) score += 95;
    if (baseToken && srtToken.includes(baseToken)) score += 80;
    if (baseToken && baseToken.includes(srtToken) && srtToken.length >= 6) score += 50;

    if (score > bestScore) {
      bestScore = score;
      best = srtPath;
    }
  }

  return bestScore > 0 ? best : null;
}

function toRelative(baseDir, targetPath) {
  return path.relative(baseDir, targetPath).replace(/\\/g, '/');
}

async function writeIndexMarkdown(indexPath, rootDir, rows) {
  const now = new Date();
  const lines = [];

  const total = rows.length;
  const slideOk = rows.filter((r) => r.slide.ok).length;
  const summaryOk = rows.filter((r) => r.summary.ok).length;

  lines.push('# 批次處理總索引');
  lines.push('');
  lines.push(`- 產生時間: ${now.toISOString()}`);
  lines.push(`- 處理資料夾: ${rootDir}`);
  lines.push(`- 影片總數: ${total}`);
  lines.push(`- 簡報擷取成功: ${slideOk}/${total}`);
  lines.push(`- SRT 彙整成功: ${summaryOk}/${total}`);
  lines.push('');
  lines.push('| 影片 | 簡報擷取 | 張數 | SRT 彙整 | 輸出 | 備註 |');
  lines.push('|---|---:|---:|---:|---|---|');

  for (const row of rows) {
    const videoRel = toRelative(rootDir, row.videoPath);
    const slideStatus = row.slide.ok ? 'OK' : 'FAIL';
    const slideCount = row.slide.ok ? String(row.slide.slideCount) : '0';
    const summaryStatus = row.summary.ok ? 'OK' : 'SKIP/FAIL';

    let output = '-';
    if (row.summary.mdPath) {
      output = toRelative(rootDir, row.summary.mdPath);
    } else if (row.slide.slideDir) {
      output = toRelative(rootDir, row.slide.slideDir);
    }

    const notes = [];
    if (row.slide.error) notes.push(`簡報: ${row.slide.error}`);
    if (row.summary.error) notes.push(`SRT: ${row.summary.error}`);
    if (!row.summary.matchedSrt) notes.push('未找到對應 SRT');

    lines.push(`| ${videoRel} | ${slideStatus} | ${slideCount} | ${summaryStatus} | ${output} | ${notes.join(' / ')} |`);
  }

  await fs.writeFile(indexPath, `${lines.join('\n')}\n`, 'utf8');
}

(async () => {
  const inputPath = process.argv[2];
  const indexOutputArg = process.argv[3] || '';

  if (!inputPath) {
    console.error('用法: node batch-media-process.js <資料夾或影片檔> [索引md輸出路徑]');
    process.exit(1);
  }

  const rootPath = path.resolve(inputPath);
  const rootStat = await fs.stat(rootPath);
  const rootDir = rootStat.isDirectory() ? rootPath : path.dirname(rootPath);

  const videoFiles = await collectFilesRecursive(rootPath, (p) => /\.(mp4|ts)$/i.test(p));
  if (videoFiles.length === 0) {
    console.log('找不到任何 mp4/ts 檔案');
    return;
  }

  const srtFiles = await collectFilesRecursive(rootDir, (p) => /\.srt$/i.test(p));
  const rows = [];

  for (let i = 0; i < videoFiles.length; i++) {
    const videoPath = videoFiles[i];
    console.log(`\n[${i + 1}/${videoFiles.length}] 處理影片: ${videoPath}`);

    const row = {
      videoPath,
      slide: { ok: false, slideCount: 0, slideDir: null, error: '' },
      summary: { ok: false, matchedSrt: null, mdPath: null, error: '' },
    };

    try {
      const slideResult = await extractSlidesOnly(videoPath);
      row.slide.ok = true;
      row.slide.slideCount = slideResult.slideCount;
      row.slide.slideDir = slideResult.slideDir;
      console.log(`  [簡報] 完成: ${slideResult.slideCount} 張`);
    } catch (err) {
      row.slide.error = err.message || String(err);
      console.log(`  [簡報] 失敗: ${row.slide.error}`);
    }

    const matchedSrt = findBestMatchingSrt(videoPath, srtFiles);
    if (!matchedSrt) {
      row.summary.error = '未找到對應 SRT';
      console.log('  [SRT] 略過: 未找到對應 SRT');
      rows.push(row);
      continue;
    }

    row.summary.matchedSrt = matchedSrt;
    try {
      const baseName = path.parse(videoPath).name;
      const workDir = path.join(path.dirname(videoPath), baseName);
      await fs.ensureDir(workDir);

      const mdPath = path.join(workDir, `${baseName}_字幕彙整.md`);
      const summaryResult = await summarizeSrtToMarkdown(matchedSrt, mdPath);
      row.summary.ok = true;
      row.summary.mdPath = summaryResult.mdPath;
      console.log(`  [SRT] 完成: ${summaryResult.mdPath}`);
    } catch (err) {
      row.summary.error = err.message || String(err);
      console.log(`  [SRT] 失敗: ${row.summary.error}`);
    }

    rows.push(row);
  }

  const indexPath = indexOutputArg
    ? path.resolve(indexOutputArg)
    : path.join(rootDir, '批次處理總索引.md');

  await writeIndexMarkdown(indexPath, rootDir, rows);

  const slideOk = rows.filter((r) => r.slide.ok).length;
  const summaryOk = rows.filter((r) => r.summary.ok).length;
  console.log(`\n批次完成: 影片 ${rows.length} 支, 簡報成功 ${slideOk}, SRT 彙整成功 ${summaryOk}`);
  console.log(`總索引: ${indexPath}`);
})();
