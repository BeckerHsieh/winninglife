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

function getJwplayerManifestId(url) {
  const normalized = normalizeMediaUrl(url);
  const m = normalized.match(/cdn\.jwplayer\.com\/manifests\/([^/?#]+)\.m3u8/i);
  return m ? m[1] : null;
}

function toCanonicalManifestUrl(url) {
  const id = getJwplayerManifestId(url);
  if (!id) return normalizeMediaUrl(url);
  return `https://cdn.jwplayer.com/manifests/${id}.m3u8`;
}

function isSignedJwManifest(url) {
  const normalized = normalizeMediaUrl(url);
  return /cdn\.jwplayer\.com\/manifests\/[^/?#]+\.m3u8/i.test(normalized)
    && /[?&](exp|sig)=/i.test(normalized);
}

function isHttp403Error(err) {
  if (!err) return false;
  const status = err.response && err.response.status;
  if (status === 403) return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('status code 403') || msg.includes('403 forbidden') || msg.includes('access denied');
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
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'accept')) {
    headers.Accept = '*/*';
  }

  return headers;
}

async function downloadWithBrowserFallback(page, url, filePath, headers = {}) {
  if (!page || !page.request) return null;

  try {
    const response = await page.request.get(url, {
      headers,
      maxRedirects: 10,
      timeout: 120000,
    });

    if (!response.ok()) {
      throw new Error(`browser request failed with ${response.status()}`);
    }

    const buffer = await response.body();
    if (!Buffer.isBuffer(buffer) && typeof buffer !== 'string') {
      throw new Error('browser request returned non-buffer payload');
    }

    await fs.writeFile(filePath, Buffer.from(buffer));
    return filePath;
  } catch (err) {
    console.log(`    [下載 fallback] browser fetch 失敗：${String(err.message || err)}`);
    return null;
  }
}

function headersToString(headers = {}) {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('');
}

function upsertHeaderCaseInsensitive(headers = {}, key, value) {
  if (!key) return headers;
  const out = { ...headers };
  const hit = Object.keys(out).find((k) => k.toLowerCase() === String(key).toLowerCase());
  if (hit) out[hit] = value;
  else out[key] = value;
  return out;
}

function deriveHeadersForResource(baseHeaders = {}, refererUrl = '') {
  let out = { ...baseHeaders };
  if (!refererUrl) return out;

  out = upsertHeaderCaseInsensitive(out, 'Referer', refererUrl);
  try {
    const u = new URL(refererUrl);
    out = upsertHeaderCaseInsensitive(out, 'Origin', `${u.protocol}//${u.host}`);
  } catch {}
  return out;
}

async function fetchText(url, headers) {
  const res = await axios.get(url, { timeout: 30000, headers, responseType: 'text' });
  return String(res.data || '');
}

async function getJwMediaSources(url, headers) {
  const id = getJwplayerManifestId(url);
  if (!id) return [];

  try {
    const apiUrl = `https://cdn.jwplayer.com/v2/media/${id}`;
    const apiHeaders = upsertHeaderCaseInsensitive(headers, 'Accept', 'application/json,text/plain,*/*');
    const res = await axios.get(apiUrl, { timeout: 30000, headers: apiHeaders, responseType: 'json' });
    const data = res && res.data ? res.data : {};

    const sources = [];
    if (Array.isArray(data.sources)) sources.push(...data.sources);
    if (Array.isArray(data.playlist) && data.playlist[0] && Array.isArray(data.playlist[0].sources)) {
      sources.push(...data.playlist[0].sources);
    }
    return sources;
  } catch {
    return [];
  }
}

async function getJwSignedManifestCandidate(url, headers) {
  try {
    const sources = await getJwMediaSources(url, headers);
    const candidates = sources
      .map((s) => (s && typeof s.file === 'string' ? normalizeMediaUrl(s.file) : ''))
      .filter((u) => /\.m3u8(\?|$)/i.test(u));

    if (candidates.length === 0) return null;
    const scored = candidates
      .map((u) => ({
        url: u,
        score: (/[?&](exp|sig)=/i.test(u) ? 100 : 0) + (u.includes('/manifests/') ? 10 : 0),
      }))
      .sort((a, b) => b.score - a.score);
    return scored[0].url || null;
  } catch {
    return null;
  }
}

async function getJwProgressiveMp4Candidates(url, headers) {
  const sources = await getJwMediaSources(url, headers);
  if (!sources.length) return [];

  const mapped = sources
    .map((s) => {
      const file = s && typeof s.file === 'string' ? normalizeMediaUrl(s.file) : '';
      if (!file) return null;
      const type = String((s && s.type) || '').toLowerCase();
      const isMp4 = type.includes('video/mp4') || /\.mp4(\?|$)/i.test(file);
      if (!isMp4) return null;
      return {
        url: file,
        width: Number((s && s.width) || 0),
        height: Number((s && s.height) || 0),
      };
    })
    .filter(Boolean);

  mapped.sort((a, b) => {
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    return areaB - areaA;
  });

  const deduped = [];
  const seen = new Set();
  for (const item of mapped) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    deduped.push(item.url);
  }
  return deduped;
}

async function downloadJwProgressiveFallback(page, url, filePath, requestHeaders = {}, cookies = [], preferredCandidates = []) {
  const headers = buildRequestHeaders(requestHeaders, cookies, url);
  const apiCandidates = await getJwProgressiveMp4Candidates(url, headers);
  const candidates = [];
  for (const c of preferredCandidates || []) {
    const normalized = normalizeMediaUrl(c);
    if (normalized && /\.mp4(\?|$)/i.test(normalized)) candidates.push(normalized);
  }
  for (const c of apiCandidates) candidates.push(c);

  const orderedCandidates = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    orderedCandidates.push(c);
  }

  if (!orderedCandidates.length) {
    throw new Error('找不到可用的 JWPlayer MP4 來源');
  }

  let lastError = null;
  for (let i = 0; i < orderedCandidates.length; i++) {
    const candidate = orderedCandidates[i];
    try {
      console.log(`    [HLS fallback] 改抓 MP4 候選 #${i + 1}: ${candidate}`);
      await fs.remove(filePath).catch(() => {});
      try {
        await downloadMp4(candidate, filePath, headers, cookies);
        return filePath;
      } catch (err) {
        if (err && err.message && /403/i.test(err.message)) {
          const viaBrowser = await downloadWithBrowserFallback(page, candidate, filePath, headers);
          if (viaBrowser) return viaBrowser;
        }
        throw err;
      }
    } catch (err) {
      lastError = err;
      console.log(`    [HLS fallback] MP4 候選失敗：${err.message}`);
    }
  }

  throw lastError || new Error('MP4 fallback 失敗');
}

async function buildManifestCandidates(url, headers, extraCandidates = []) {
  const normalized = normalizeMediaUrl(url);
  const candidates = [normalized];

  for (const c of extraCandidates || []) {
    const normalizedExtra = normalizeMediaUrl(c);
    if (!normalizedExtra) continue;
    if (!/\.m3u8(\?|$)/i.test(normalizedExtra)) continue;
    candidates.push(normalizedExtra);
  }

  const canonical = toCanonicalManifestUrl(normalized);
  if (canonical && canonical !== normalized) candidates.push(canonical);

  const freshSigned = await getJwSignedManifestCandidate(normalized, headers);
  if (freshSigned) candidates.push(freshSigned);

  const deduped = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    deduped.push(c);
  }
  return deduped;
}

async function fetchTextWithJwFallback(url, headers) {
  const normalized = normalizeMediaUrl(url);
  const candidates = [normalized];

  const canonical = toCanonicalManifestUrl(normalized);
  if (canonical !== normalized) candidates.push(canonical);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const text = await fetchText(candidate, headers);
      return { text, resolvedUrl: candidate };
    } catch (err) {
      lastError = err;
      if (!(err && err.response && err.response.status === 403)) {
        throw err;
      }
    }
  }

  throw lastError || new Error('fetch manifest failed');
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

    const segmentHeaders = deriveHeadersForResource(headers, mediaPlaylistUrl);
    const res = await axios.get(segUrl, {
      timeout: 60000,
      headers: segmentHeaders,
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

async function materializeWithSegmentRetry(mediaText, mediaPlaylistUrl, tempDir, headers) {
  try {
    return await materializeLocalPlaylist(mediaText, mediaPlaylistUrl, tempDir, headers);
  } catch (err) {
    const status = err && err.response && err.response.status;
    if (status !== 403) throw err;

    // 某些簽名片段會短時過期，重抓同一 media playlist 後再試一次。
    const refreshedMediaHeaders = deriveHeadersForResource(headers, mediaPlaylistUrl);
    const refreshedMediaText = await fetchText(mediaPlaylistUrl, refreshedMediaHeaders);
    return materializeLocalPlaylist(refreshedMediaText, mediaPlaylistUrl, tempDir, headers);
  }
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
      // maxBuffer 需夠大：JWPlayer HLS 串流常見大量非致命的「Invalid timestamps」
      // 警告灌爆 stderr，若超過 Node 預設 1MB 上限，execFile 會誤判並強制砍掉
      // ffmpeg 進程（看起來像下載中斷，實際上下載本身是正常的）。
      execFile(ffmpegPath, attempts[idx], { timeout: 1800000, maxBuffer: 200 * 1024 * 1024 }, (err, _so, se = '') => {
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

async function downloadHlsViaNode(page, url, filePath, requestHeaders = {}, cookies = [], extraManifestCandidates = []) {
  const headers = buildRequestHeaders(requestHeaders, cookies, url);
  const manifestCandidates = await buildManifestCandidates(url, headers, extraManifestCandidates);
  let lastError = null;

  for (let ci = 0; ci < manifestCandidates.length; ci++) {
    const candidate = manifestCandidates[ci];
    const from = normalizeMediaUrl(url);
    if (candidate !== from) {
      console.log(`    [HLS fallback] 改用候選 manifest #${ci + 1}: ${candidate}`);
    }

    const tempDir = path.join(os.tmpdir(), `scantrader_hls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await fs.remove(tempDir).catch(() => {});
    try {
      const masterHeaders = deriveHeadersForResource(headers, 'https://scantrader.com/');
      try {
        const masterText = await fetchText(candidate, masterHeaders);

        let mediaPlaylistUrl = candidate;
        let mediaText = masterText;

        if (masterText.includes('#EXT-X-STREAM-INF')) {
          const variants = parseMasterPlaylist(masterText, mediaPlaylistUrl);
          if (!variants.length) throw new Error('主清單無可用變體');
          variants.sort((a, b) => b.bandwidth - a.bandwidth);
          mediaPlaylistUrl = variants[0].url;
          const mediaHeaders = deriveHeadersForResource(headers, candidate);
          mediaText = await fetchText(mediaPlaylistUrl, mediaHeaders);
        }

        const segments = parseMediaPlaylist(mediaText, mediaPlaylistUrl);
        if (!segments.length) throw new Error('媒體清單無片段');

        const { localPlaylistPath, segmentFiles } = await materializeWithSegmentRetry(mediaText, mediaPlaylistUrl, tempDir, headers);
        try {
          await remuxPlaylistToMp4(localPlaylistPath, filePath);
          return filePath;
        } catch (remuxErr) {
          const tsPath = await uniqueFilePath(path.dirname(filePath), path.parse(filePath).name, 'ts');
          console.log(`    [HLS fallback] MP4 封裝失敗，改輸出 TS：${path.basename(tsPath)}`);
          await concatSegmentFilesToTs(segmentFiles, tsPath);
          return tsPath;
        }
      } catch (fetchErr) {
        if (isHttp403Error(fetchErr) && page && page.request) {
          const viaBrowser = await downloadWithBrowserFallback(page, candidate, filePath, masterHeaders);
          if (viaBrowser) return viaBrowser;
        }
        throw fetchErr;
      }
    } catch (err) {
      lastError = err;
      if (!isHttp403Error(err)) throw err;
      console.log(`    [HLS fallback] 候選 manifest 403：${candidate}`);
    } finally {
      await fs.remove(tempDir).catch(() => {});
    }
  }

  throw lastError || new Error('HLS Node fallback 失敗');
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    // 網路「無回應」逾時（微秒）：偵測真正的連線卡死，而非長片下載耗時較久。
    // 可用 FFMPEG_RW_TIMEOUT_MS 環境變數覆寫（毫秒）。
    const rwTimeoutMs = Number(process.env.FFMPEG_RW_TIMEOUT_MS) || 30000;
    const rwTimeoutArgs = ['-rw_timeout', String(rwTimeoutMs * 1000)];

    // 整體下載逾時（毫秒）：長片（1~2 小時節目）以正常位元率下載可能耗時遠超過 10 分鐘，
    // 若逾時值過短，ffmpeg 會在尚未寫出完整檔案（含 moov atom）前被強制中止，
    // 造成「partial 輸出已損壞」的假性失敗，並因反覆重試觸發 CDN 403。
    // 可用 FFMPEG_TIMEOUT_MS 環境變數覆寫。
    const execTimeoutMs = Number(process.env.FFMPEG_TIMEOUT_MS) || 1800000; // 預設 30 分鐘

    // 嘗試順序：針對 JWPlayer HLS 時間戳記問題（+igndts 忽略無效 DTS）
    const attempts = [
      // 1. 忽略無效 DTS + 修正時間戳記 + faststart
      ['-y', '-fflags', '+discardcorrupt+genpts+igndts',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...rwTimeoutArgs,
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', normalizedUrl, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative',
        '-max_interleave_delta', '0', '-movflags', '+faststart', filePath],
      // 2. 同上但不加 faststart（避免二次 seek 失敗）
      ['-y', '-fflags', '+discardcorrupt+genpts+igndts',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...rwTimeoutArgs,
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', normalizedUrl, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative',
        '-max_interleave_delta', '0', filePath],
      // 3. 重新編碼音視訊（最後手段，確保相容性）
      ['-y', '-fflags', '+discardcorrupt+igndts',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...rwTimeoutArgs,
        ...(headerStr ? ['-headers', headerStr] : []),
        '-i', normalizedUrl, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-max_interleave_delta', '0', filePath],
    ];

    // 若因串流末端時間戳記損毀而失敗，但已寫出足量資料，直接採用該部分輸出，
    // 避免整段重新拉流反覆命中 CDN 而觸發 403（簽名 URL 可能有請求次數限制）。
    const PARTIAL_MIN_BYTES = 15 * 1024 * 1024;
    const isAuthFailure = (text) => /403|forbidden|access denied|401|unauthorized/i.test(text);

    const tryNext = (idx) => {
      if (idx >= attempts.length) {
        reject(new Error('ffmpeg 所有嘗試均失敗'));
        return;
      }
      const args = attempts[idx];
      console.log(`    [ffmpeg] 嘗試 #${idx + 1}...`);
      execFile(ffmpegPath, args, { timeout: execTimeoutMs, maxBuffer: 200 * 1024 * 1024 }, async (err, _so, se) => {
        if (err && err.killed) {
          console.log(`    [ffmpeg] #${idx + 1} 逾時被中止（超過 ${(execTimeoutMs / 60000).toFixed(0)} 分鐘），可調整 FFMPEG_TIMEOUT_MS 環境變數`);
        }
        if (!err) {
          try {
            const duration = await probeDurationSeconds(filePath, ffmpegPath);
            if (Number.isFinite(duration) && duration > 0) {
              resolve();
              return;
            }
          } catch {
            // ignore and continue to next fallback path
          }
          console.log(`    [ffmpeg] 產出檔案無法被解析，嘗試後續回退`);
          tryNext(idx + 1);
          return;
        }
        const hint = se.slice(-200).replace(/\s+/g, ' ').trim();
        console.log(`    [ffmpeg] #${idx + 1} 失敗：${hint}`);

        if (!isAuthFailure(hint) && fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size;
          if (size >= PARTIAL_MIN_BYTES) {
            try {
              const duration = await probeDurationSeconds(filePath, ffmpegPath);
              if (Number.isFinite(duration) && duration > 0) {
                console.log(`    [ffmpeg] 使用有效 partial 輸出（${(size / 1024 / 1024).toFixed(1)} MB，${duration.toFixed(1)}s）`);
                resolve();
                return;
              }
            } catch {
              // fall through to retry fallback when partial output is invalid
            }
            console.log(`    [ffmpeg] partial 輸出已損壞或不可解析（${(size / 1024 / 1024).toFixed(1)} MB），不接受為成功結果`);
          }
        }
        tryNext(idx + 1);
      });
    };
    tryNext(0);
  });
}

function probeDurationSeconds(filePath, ffmpegPath) {
  return new Promise((resolve) => {
    // 注意：僅用 `-i` 不指定輸出，讓 ffmpeg 在開檔後立即印出
    // 「Input #0 ... Duration: ...」再因缺少輸出而失敗結束（可忽略此錯誤）。
    // 這樣不需完整解碼整支影片，速度快且不受 `-v error`（會壓制 Duration
    // 這行 INFO 等級訊息，導致永遠偵測不到時長）或大量警告訊息灌爆
    // stderr 緩衝區影響。
    execFile(ffmpegPath, ['-i', filePath], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (_err, _so, se = '') => {
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
async function downloadVideo(videoUrl, articleTitle, index, cookies = [], page = null) {
  await fs.ensureDir(OUTPUT_DIR);

  const video = typeof videoUrl === 'string' ? { url: videoUrl, headers: {} } : (videoUrl || {});
  const normalizedVideoUrl = normalizeMediaUrl(video.url);
  const requestHeaders = video.headers || {};
  const alternateItems = Array.isArray(video.alternates) ? video.alternates : [];
  const alternateManifestCandidates = alternateItems
    .map((item) => (item && typeof item.url === 'string' ? normalizeMediaUrl(item.url) : ''))
    .filter((u) => /\.m3u8(\?|$)/i.test(u));
  const alternateMp4Candidates = alternateItems
    .map((item) => (item && typeof item.url === 'string' ? normalizeMediaUrl(item.url) : ''))
    .filter((u) => /\.mp4(\?|$)/i.test(u));

  const isHls = isHlsUrl(normalizedVideoUrl);
  const ext = isHls ? 'mp4' : (['mp4','mov','webm','m4v'].find(
    (e) => normalizedVideoUrl.split('?')[0].toLowerCase().endsWith(`.${e}`)
  ) || 'mp4');

  const prefix = String(index).padStart(4, '0');
  const safeName = safeFilename(articleTitle).slice(0, 100);
  const basename = `${prefix}_${safeName}`;
  const filePath = await uniqueFilePath(OUTPUT_DIR, basename, ext);
  const tempPath = await uniqueFilePath(OUTPUT_DIR, `${basename}_tmp`, ext);
  let outputPath = tempPath;
  console.log(`  [下載] ${path.basename(filePath)}`);

  try {
    if (isHls) {
      try {
        await downloadHls(normalizedVideoUrl, tempPath, requestHeaders, cookies);
      } catch (hlsErr) {
        try {
          const canonicalManifest = toCanonicalManifestUrl(normalizedVideoUrl);

          if (
            isSignedJwManifest(normalizedVideoUrl)
            && canonicalManifest
            && canonicalManifest !== normalizedVideoUrl
          ) {
            await delay(3000);
            try {
              console.log(`    [HLS fallback] 先嘗試 Node 片段下載（signed）：${normalizedVideoUrl}`);
              outputPath = await downloadHlsViaNode(page, normalizedVideoUrl, tempPath, requestHeaders, cookies, alternateManifestCandidates);
            } catch (signedNodeErr) {
              if (!isHttp403Error(signedNodeErr)) throw signedNodeErr;

              console.log(`    [HLS retry] signed URL 403，改用 canonical manifest：${canonicalManifest}`);
              try {
                await downloadHls(canonicalManifest, tempPath, requestHeaders, cookies);
              } catch (canonicalErr) {
                console.log(`    [HLS retry] canonical ffmpeg 失敗：${canonicalErr.message}`);
                console.log(`    [HLS fallback] 啟用 Node 片段下載（canonical）：${canonicalManifest}`);
                outputPath = await downloadHlsViaNode(page, canonicalManifest, tempPath, requestHeaders, cookies, alternateManifestCandidates);
              }
            }
          } else {
            console.log(`    [HLS fallback] 啟用 Node 片段下載：${hlsErr.message}`);
            outputPath = await downloadHlsViaNode(page, normalizedVideoUrl, tempPath, requestHeaders, cookies, alternateManifestCandidates);
          }
        } catch (fallbackErr) {
          console.log(`    [HLS fallback] HLS 路徑失敗，嘗試 MP4 來源：${fallbackErr.message}`);
          outputPath = await downloadJwProgressiveFallback(page, normalizedVideoUrl, tempPath, requestHeaders, cookies, alternateMp4Candidates);
        }
      }
    } else {
      await downloadMp4(normalizedVideoUrl, tempPath, requestHeaders, cookies);
    }

    const stat = await fs.stat(outputPath);
    if (stat.size < 1024 * 1024) {
      await fs.remove(outputPath);
      throw new Error(`檔案過小（${stat.size} bytes），可能認證失敗`);
    }

    const ffmpegPath = findFfmpeg();
    let durationSec = null;
    if (ffmpegPath) {
      durationSec = await probeDurationSeconds(outputPath, ffmpegPath);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        await fs.remove(outputPath).catch(() => {});
        throw new Error(`影片檔案無法被 ffmpeg 解析，可能是下載中斷或檔案損壞：${path.basename(outputPath)}`);
      }
    }

    await fs.move(outputPath, filePath, { overwrite: true });
    outputPath = filePath;

    let durationText = '';
    if (typeof durationSec === 'number' && Number.isFinite(durationSec)) {
      const mins = Math.floor(durationSec / 60);
      const secs = Math.round(durationSec % 60).toString().padStart(2, '0');
      durationText = `, ${mins}:${secs}`;
    }

    const finalStat = await fs.stat(outputPath);
    console.log(`  [完成] ${path.basename(outputPath)} (${(finalStat.size / 1024 / 1024).toFixed(1)} MB${durationText})`);
    return { skipped: false, filePath: outputPath, autoPostprocess: true };
  } catch (err) {
    console.error(`  [錯誤] ${err.message}`);
    await fs.remove(outputPath).catch(() => {});
    await fs.remove(filePath).catch(() => {});
    return { skipped: false, filePath: null, error: err.message };
  }
}

module.exports = { downloadVideo, OUTPUT_DIR };
