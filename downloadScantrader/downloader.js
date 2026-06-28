/**
 * downloader.js — 下載影片（HLS m3u8 用 ffmpeg，mp4 直連用 axios）
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execFile, execSync } = require('child_process');
const cliProgress = require('cli-progress');

const OUTPUT_DIR = path.join(__dirname, 'downloads');

function resolveUrl(baseUrl, maybeRelative) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative;
  }
}

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

function normalizeMediaUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\//.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function buildRequestHeaders(requestHeaders = {}, cookies = [], url = '') {
  const headers = {};

  for (const [key, value] of Object.entries(requestHeaders || {})) {
    const lowerKey = String(key).toLowerCase();
    if (['content-length', 'connection', 'host', 'accept-encoding'].includes(lowerKey)) continue;
    headers[key] = value;
  }

  const cookieHeader = buildCookieHeader(cookies, url);
  if (cookieHeader && !Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
    headers.Cookie = cookieHeader;
  }

  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'referer')) {
    headers.Referer = 'https://scantrader.com/';
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'origin')) {
    headers.Origin = 'https://scantrader.com';
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = 'Mozilla/5.0';
  }

  return headers;
}

function headersToString(headers = {}) {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('');
}

async function fetchText(url, headers) {
  const res = await axios.get(url, { timeout: 30000, headers, responseType: 'text' });
  return String(res.data || '');
}

function parseMasterPlaylist(playlistText, playlistUrl) {
  const lines = playlistText.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = line.replace('#EXT-X-STREAM-INF:', '');
    const bandwidthMatch = attrs.match(/BANDWIDTH=(\d+)/i);
    const bw = bandwidthMatch ? Number(bandwidthMatch[1]) : 0;
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith('#')) continue;
      uri = resolveUrl(playlistUrl, next);
      break;
    }
    if (uri) variants.push({ bandwidth: bw, url: uri });
  }
  return variants;
}

function parseMediaPlaylist(playlistText, playlistUrl) {
  const lines = playlistText.split(/\r?\n/);
  const segments = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    segments.push(resolveUrl(playlistUrl, line));
  }
  return segments;
}

async function materializeLocalPlaylist(mediaText, mediaPlaylistUrl, tempDir, headers) {
  await fs.ensureDir(tempDir);
  const lines = mediaText.split(/\r?\n/);
  const rewritten = [];
  const segmentFiles = [];

  let segIndex = 0;
  let totalSegments = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) totalSegments++;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      rewritten.push(raw);
      continue;
    }

    segIndex++;
    const segUrl = resolveUrl(mediaPlaylistUrl, line);
    const ext = path.extname(segUrl.split('?')[0]) || '.ts';
    const filename = `seg_${String(segIndex).padStart(5, '0')}${ext}`;
    const filepath = path.join(tempDir, filename);

    const res = await axios.get(segUrl, {
      timeout: 60000,
      headers,
      responseType: 'arraybuffer',
    });
    await fs.writeFile(filepath, Buffer.from(res.data));
    segmentFiles.push(filepath);
    rewritten.push(filename);

    if (segIndex % 20 === 0 || segIndex === totalSegments) {
      console.log(`    [HLS fallback] 片段 ${segIndex}/${totalSegments}`);
    }
  }

  const localPlaylistPath = path.join(tempDir, 'local.m3u8');
  await fs.writeFile(localPlaylistPath, rewritten.join('\n'), 'utf8');
  return { localPlaylistPath, segmentFiles };
}

async function concatSegmentFilesToTs(segmentFiles, tsPath) {
  await fs.remove(tsPath).catch(() => {});
  for (const segFile of segmentFiles) {
    const data = await fs.readFile(segFile);
    await fs.appendFile(tsPath, data);
  }
}

function remuxPlaylistToMp4(localPlaylistPath, outPath) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = findFfmpeg();
    if (!ffmpegPath) {
      reject(new Error('找不到 ffmpeg（本地封裝失敗）'));
      return;
    }

    const attempts = [
      // 先嘗試快速封裝（視訊 copy、音訊轉 AAC）
      [
        '-y',
        '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
        '-allowed_extensions', 'ALL',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-i', localPlaylistPath,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero',
        '-max_interleave_delta', '0', outPath,
      ],
      // 若時間戳仍異常，改全轉碼確保可播放
      [
        '-y',
        '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
        '-allowed_extensions', 'ALL',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-i', localPlaylistPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', outPath,
      ],
    ];

    const tryNext = (idx, lastErr = '') => {
      if (idx >= attempts.length) {
        reject(new Error(`本地封裝失敗：${String(lastErr).slice(-300)}`));
        return;
      }
      execFile(ffmpegPath, attempts[idx], { timeout: 1800000 }, (err, _so, se = '') => {
        if (!err) {
          resolve();
          return;
        }
        tryNext(idx + 1, se);
      });
    };

    tryNext(0);
  });
}

async function downloadHlsViaNode(url, filePath, requestHeaders = {}, cookies = []) {
  const headers = buildRequestHeaders(requestHeaders, cookies, url);
  const masterText = await fetchText(url, headers);

  let mediaPlaylistUrl = url;
  let mediaText = masterText;

  if (masterText.includes('#EXT-X-STREAM-INF')) {
    const variants = parseMasterPlaylist(masterText, url);
    if (!variants.length) throw new Error('主清單無可用變體');
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    mediaPlaylistUrl = variants[0].url;
    mediaText = await fetchText(mediaPlaylistUrl, headers);
  }

  const segments = parseMediaPlaylist(mediaText, mediaPlaylistUrl);
  if (!segments.length) throw new Error('媒體清單無片段');

  const tempDir = path.join(os.tmpdir(), `scantrader_hls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  await fs.remove(tempDir).catch(() => {});
  try {
    const { localPlaylistPath, segmentFiles } = await materializeLocalPlaylist(mediaText, mediaPlaylistUrl, tempDir, headers);
    try {
      await remuxPlaylistToMp4(localPlaylistPath, filePath);
      return filePath;
    } catch (remuxErr) {
      // 若 mp4 封裝失敗，退而求其次保留完整 TS，避免整次下載失敗
      const tsPath = await uniqueFilePath(path.dirname(filePath), path.parse(filePath).name, 'ts');
      console.log(`    [HLS fallback] MP4 封裝失敗，改輸出 TS：${path.basename(tsPath)}`);
      await concatSegmentFilesToTs(segmentFiles, tsPath);
      return tsPath;
    }
  } finally {
    await fs.remove(tempDir).catch(() => {});
  }
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
async function downloadMp4(url, filePath, requestHeaders = {}, cookies = []) {
  const writer = fs.createWriteStream(filePath);
  const headers = buildRequestHeaders(requestHeaders, cookies, url);

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
function downloadHls(url, filePath, requestHeaders = {}, cookies = []) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = findFfmpeg();
    if (!ffmpegPath) {
      reject(new Error('找不到 ffmpeg！請確認已安裝或執行 npm run install-browser'));
      return;
    }
    console.log(`    [ffmpeg] ${ffmpegPath}`);

    const normalizedUrl = normalizeMediaUrl(url);
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      reject(new Error(`無效的 HLS URL：${url}`));
      return;
    }

    const headerStr = headersToString(buildRequestHeaders(requestHeaders, cookies, normalizedUrl));

    // 嘗試順序：針對 JWPlayer HLS 時間戳記問題（+igndts 忽略無效 DTS）
    const attempts = [
      // 1. 忽略無效 DTS + 修正時間戳記 + faststart
      ['-y', '-fflags', '+discardcorrupt+genpts+igndts',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', normalizedUrl, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative',
        '-max_interleave_delta', '0', '-movflags', '+faststart', filePath],
      // 2. 同上但不加 faststart（避免二次 seek 失敗）
      ['-y', '-fflags', '+discardcorrupt+genpts+igndts',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', normalizedUrl, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative',
        '-max_interleave_delta', '0', filePath],
      // 3. 重新編碼音視訊（最後手段，確保相容性）
      ['-y', '-fflags', '+discardcorrupt+igndts',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', normalizedUrl, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
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

function probeDurationSeconds(filePath, ffmpegPath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', filePath], { timeout: 30000 }, (_err, _so, se = '') => {
      const text = String(se || '');
      const m = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
      if (!m) {
        resolve(null);
        return;
      }
      const h = Number(m[1]);
      const min = Number(m[2]);
      const s = Number(m[3]);
      resolve(h * 3600 + min * 60 + s);
    });
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

  const video = typeof videoUrl === 'string' ? { url: videoUrl, headers: {} } : (videoUrl || {});
  const normalizedVideoUrl = normalizeMediaUrl(video.url);
  const requestHeaders = video.headers || {};

  const isHls = isHlsUrl(normalizedVideoUrl);
  const ext = isHls ? 'mp4' : (['mp4','mov','webm','m4v'].find(
    (e) => normalizedVideoUrl.split('?')[0].toLowerCase().endsWith(`.${e}`)
  ) || 'mp4');

  // 前綴 + 安全標題（截斷到 80 字元，後綴已在 articleTitle 裡）
  const prefix = String(index).padStart(4, '0');
  const safeName = safeFilename(articleTitle).slice(0, 100);
  const basename = `${prefix}_${safeName}`;

  // 確保唯一檔名，永不略過
  const filePath = await uniqueFilePath(OUTPUT_DIR, basename, ext);
  let outputPath = filePath;
  console.log(`  [下載] ${path.basename(filePath)}`);

  try {
    if (isHls) {
      try {
        await downloadHls(normalizedVideoUrl, filePath, requestHeaders, cookies);
      } catch (hlsErr) {
        console.log(`    [HLS fallback] 啟用 Node 片段下載：${hlsErr.message}`);
        outputPath = await downloadHlsViaNode(normalizedVideoUrl, filePath, requestHeaders, cookies);
      }
    } else {
      await downloadMp4(normalizedVideoUrl, filePath, requestHeaders, cookies);
    }

    const stat = await fs.stat(outputPath);
    if (stat.size < 1024 * 1024) {
      await fs.remove(outputPath);
      throw new Error(`檔案過小（${stat.size} bytes），可能認證失敗`);
    }

    const ffmpegPath = findFfmpeg();
    let durationText = '';
    if (ffmpegPath) {
      const sec = await probeDurationSeconds(outputPath, ffmpegPath);
      if (typeof sec === 'number' && Number.isFinite(sec)) {
        const mins = Math.floor(sec / 60);
        const secs = Math.round(sec % 60).toString().padStart(2, '0');
        durationText = `, ${mins}:${secs}`;
      }
    }

    console.log(`  [完成] ${path.basename(outputPath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB${durationText})`);
    return { skipped: false, filePath: outputPath };
  } catch (err) {
    console.error(`  [錯誤] ${err.message}`);
    await fs.remove(outputPath).catch(() => {});
    await fs.remove(filePath).catch(() => {});
    return { skipped: false, filePath: null, error: err.message };
  }
}

module.exports = { downloadVideo, OUTPUT_DIR };
