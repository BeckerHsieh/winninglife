#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');

function parseCliArgs(argv) {
  const args = [...argv];
  const result = {
    inputPath: '',
    maxFrames: null,
    minFrames: null,
    interval: null,
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      if (!result.inputPath) result.inputPath = token;
      continue;
    }

    const next = args[i + 1];
    if (token === '--max-frames' && next) {
      result.maxFrames = Number(next);
      i++;
      continue;
    }
    if (token === '--min-frames' && next) {
      result.minFrames = Number(next);
      i++;
      continue;
    }
    if (token === '--interval' && next) {
      result.interval = Number(next);
      i++;
      continue;
    }
  }

  return result;
}

function applySlideEnv(options) {
  if (Number.isFinite(options.maxFrames) && options.maxFrames > 0) {
    process.env.SLIDE_MAX_FRAMES = String(Math.floor(options.maxFrames));
  }
  if (Number.isFinite(options.minFrames) && options.minFrames > 0) {
    process.env.SLIDE_MIN_FRAMES = String(Math.floor(options.minFrames));
  }
  if (Number.isFinite(options.interval) && options.interval > 0) {
    process.env.SLIDE_FALLBACK_INTERVAL_SECONDS = String(Math.floor(options.interval));
  }
}

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

async function collectNearbyMediaCandidates(inputPath) {
  const abs = path.resolve(String(inputPath || ''));
  const candidates = [];
  const seen = new Set();

  const roots = [
    path.dirname(abs),
    path.join(__dirname, 'downloads'),
  ];

  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    if (!(await fs.pathExists(root))) continue;

    let names = [];
    try {
      names = await fs.readdir(root);
    } catch {
      continue;
    }

    for (const name of names) {
      const full = path.join(root, name);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!/\.(mp4|ts)$/i.test(name)) continue;
      candidates.push(full);
    }
  }

  return candidates.slice(0, 20);
}

async function printMissingPathHint(inputPath, err) {
  const message = String((err && err.message) || err || '');
  const isMissing = /ENOENT|找不到|no such file/i.test(message);
  if (!isMissing) return;

  const nearby = await collectNearbyMediaCandidates(inputPath);
  if (nearby.length === 0) {
    console.error('提示: 目前附近找不到可用的 mp4/ts 檔案。');
    return;
  }

  console.error('提示: 你指定的檔案不存在，可改用以下路徑之一：');
  for (const p of nearby) {
    console.error(`  - ${p}`);
  }
}

(async () => {
  const cli = parseCliArgs(process.argv.slice(2));
  try {
    applySlideEnv(cli);

    const { extractSlidesOnly } = require('./postprocess');
    const inputPath = cli.inputPath;
    if (!inputPath) {
      console.error('用法: node extract-slides.js <mp4/ts檔案或資料夾> [--max-frames N] [--min-frames N] [--interval 秒]');
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
  } catch (err) {
    console.error('執行失敗:');
    console.error(`  ${err && err.message ? err.message : err}`);
    await printMissingPathHint(cli.inputPath, err);
    process.exit(1);
  }
})();
