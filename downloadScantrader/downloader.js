/**
 * downloader.js — 下載影片（HLS m3u8 用 ffmpeg，mp4 直連用 axios）
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { execFile, execSync } = require('child_process');
const cliProgress = require('cli-progress');

const OUTPUT_DIR = path.join(__dirname, 'downloads');

// ── 尋找 ffmpeg（優先 ffmpeg-static，其次系統）───────────────────────────────
function findFfmpeg() {
  // 1. ffmpeg-static（npm 套件，完整支援 HTTP/HTTPS）
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch {}
  // 2. 系統安裝的 ffmpeg
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {}
  return null;
}

// ── 是否為 HLS 串流（URL 含 .m3u8 或 JWPlayer manifest 路徑）────────────────
function isHlsUrl(url) {
  if (url.includes('.m3u8')) return true;
  if (url.includes('cdn.jwplayer.com/manifests/')) return true;
  if (url.includes('/manifest.ism/')) return true;
  return false;
}

// ── Cookie header ────────────────────────────────────────────────────────────
function buildCookieHeader(cookies, url) {
  if (!cookies || cookies.length === 0) return '';
  try {
    const domain = new URL(url).hostname;
    return cookies
      .filter((c) => domain.includes(c.domain.replace(/^\./, '')))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

// ── 產生唯一檔名（若已存在加計數器 _2, _3...）────────────────────────────────
async function uniqueFilePath(dir, basename, ext) {
  let candidate = path.join(dir, `${basename}.${ext}`);
  if (!(await fs.pathExists(candidate))) return candidate;
  for (let i = 2; i < 9999; i++) {
    candidate = path.join(dir, `${basename}_${i}.${ext}`);
    if (!(await fs.pathExists(candidate))) return candidate;
  }
  return candidate;
}

// ── 安全檔名（最多 80 字元，保留後綴空間）────────────────────────────────────
// 注意：截斷在呼叫端（index.js）的 title 而非整個 basename，避免切掉 -1/-2 後綴
function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

// ── 下載 mp4 直連 ────────────────────────────────────────────────────────────
async function downloadMp4(url, filePath, cookieHeader) {
  const writer = fs.createWriteStream(filePath);
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://scantrader.com/' };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const response = await axios.get(url, { responseType: 'stream', timeout: 120000, headers });

  const ct = response.headers['content-type'] || '';
  if (ct.includes('text/') || ct.includes('javascript') || ct.includes('html')) {
    writer.destroy();
    throw new Error(`非影片內容（${ct}）`);
  }

  const total = parseInt(response.headers['content-length'] || '0', 10);
  const bar = new cliProgress.SingleBar(
    { format: '    [{bar}] {percentage}% | {value}/{total} bytes' },
    cliProgress.Presets.shades_classic
  );
  if (total > 0) bar.start(total, 0);

  let downloaded = 0;
  response.data.on('data', (chunk) => { downloaded += chunk.length; if (total > 0) bar.update(downloaded); });
  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  if (total > 0) bar.stop();
}

// ── 下載 HLS m3u8（ffmpeg，-map 0 包含所有音視訊 track）────────────────────
function downloadHls(url, filePath, cookieHeader) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = findFfmpeg();
    if (!ffmpegPath) {
      reject(new Error('找不到 ffmpeg！請確認已安裝或執行 npm run install-browser'));
      return;
    }
    console.log(`    [ffmpeg] ${ffmpegPath}`);

    const headerStr = cookieHeader
      ? `Cookie: ${cookieHeader}\r\nReferer: https://scantrader.com/\r\n`
      : null;

    // 嘗試順序：針對 JWPlayer HLS 時間戳記問題（+igndts 忽略無效 DTS）
    const attempts = [
      // 1. 忽略無效 DTS + 修正時間戳記 + faststart
      ['-y', '-fflags', '+discardcorrupt+genpts+igndts',
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', url, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative',
        '-max_interleave_delta', '0', '-movflags', '+faststart', filePath],
      // 2. 同上但不加 faststart（避免二次 seek 失敗）
      ['-y', '-fflags', '+discardcorrupt+genpts+igndts',
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', url, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative',
        '-max_interleave_delta', '0', filePath],
      // 3. 重新編碼音視訊（最後手段，確保相容性）
      ['-y', '-fflags', '+discardcorrupt+igndts',
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', url, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-max_interleave_delta', '0', filePath],
    ];

    const tryNext = (idx) => {
      if (idx >= attempts.length) {
        reject(new Error('ffmpeg 所有嘗試均失敗'));
        return;
      }
      const args = attempts[idx];
      console.log(`    [ffmpeg] 嘗試 #${idx + 1}...`);
      execFile(ffmpegPath, args, { timeout: 600000 }, (err, _so, se) => {
        if (!err) { resolve(); return; }
        const hint = se.slice(-200).replace(/\s+/g, ' ').trim();
        console.log(`    [ffmpeg] #${idx + 1} 失敗：${hint}`);
        tryNext(idx + 1);
      });
    };
    tryNext(0);
  });
}

// ── 主下載函式 ───────────────────────────────────────────────────────────────
/**
 * @param {string} videoUrl
 * @param {string} articleTitle  已包含 -1/-2 後綴
 * @param {number} index         文章序號（四位數前綴用）
 * @param {Array}  cookies       Playwright context.cookies()
 */
async function downloadVideo(videoUrl, articleTitle, index, cookies = []) {
  await fs.ensureDir(OUTPUT_DIR);

  const isHls = isHlsUrl(videoUrl);
  const ext = isHls ? 'mp4' : (['mp4','mov','webm','m4v'].find(
    (e) => videoUrl.split('?')[0].toLowerCase().endsWith(`.${e}`)
  ) || 'mp4');

  // 前綴 + 安全標題（截斷到 80 字元，後綴已在 articleTitle 裡）
  const prefix = String(index).padStart(4, '0');
  const safeName = safeFilename(articleTitle).slice(0, 100);
  const basename = `${prefix}_${safeName}`;

  // 確保唯一檔名，永不略過
  const filePath = await uniqueFilePath(OUTPUT_DIR, basename, ext);
  console.log(`  [下載] ${path.basename(filePath)}`);

  const cookieHeader = buildCookieHeader(cookies, videoUrl);

  try {
    if (isHls) {
      await downloadHls(videoUrl, filePath, cookieHeader);
    } else {
      await downloadMp4(videoUrl, filePath, cookieHeader);
    }

    const stat = await fs.stat(filePath);
    if (stat.size < 1000) {
      await fs.remove(filePath);
      throw new Error(`檔案過小（${stat.size} bytes），可能認證失敗`);
    }

    console.log(`  [完成] ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    return { skipped: false, filePath };
  } catch (err) {
    console.error(`  [錯誤] ${err.message}`);
    await fs.remove(filePath).catch(() => {});
    return { skipped: false, filePath: null, error: err.message };
  }
}

module.exports = { downloadVideo, OUTPUT_DIR };
