/**
 * postprocess.js — 下載後產物處理
 *
 * 功能：
 * 1) 產生「字幕文字 .md」：透過 ASR（Whisper）辨識語音，輸出時間軸文字
 * 2) 擷取簡報換頁畫面為 .jpg，並從畫面文字抽取股票代碼+名稱
 */

const fs = require('fs-extra');
const path = require('path');
const { execFile, execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

let tesseractModule = null;

const SLIDE_MAX_FRAMES = Number(process.env.SLIDE_MAX_FRAMES || 300);
const SLIDE_MIN_FRAMES = Number(process.env.SLIDE_MIN_FRAMES || 200);
const SLIDE_FALLBACK_INTERVAL_SECONDS = Number(process.env.SLIDE_FALLBACK_INTERVAL_SECONDS || 5);
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'zh';

function findFfmpeg() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch {}
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {}
  return null;
}

function runFfmpeg(ffmpegPath, args, timeout = 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        const hint = String(stderr || stdout || err.message || '').slice(-1000);
        reject(new Error(`ffmpeg 執行失敗: ${hint}`));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function runCommand(command, args, timeout = 60 * 60 * 1000, options = {}) {
  return new Promise((resolve, reject) => {
    const env = options.env ? { ...process.env, ...options.env } : process.env;
    execFile(command, args, { timeout, env }, (err, stdout, stderr) => {
      if (err) {
        const hint = String(stderr || stdout || err.message || '').slice(-1200);
        reject(new Error(hint || `${command} failed`));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function buildAsrEnv() {
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath || ffmpegPath === 'ffmpeg') return null;

  const ffmpegDir = path.dirname(ffmpegPath);
  const sep = process.platform === 'win32' ? ';' : ':';
  const currentPath = process.env.PATH || process.env.Path || '';
  const merged = currentPath ? `${ffmpegDir}${sep}${currentPath}` : ffmpegDir;
  return {
    PATH: merged,
    Path: merged,
  };
}

async function commandExists(command, args = ['--help']) {
  try {
    await runCommand(command, args, 20000);
    return true;
  } catch {
    return false;
  }
}

async function getPythonRuntimeCandidates() {
  const candidates = [];

  if (await commandExists('py', ['-3', '--version'])) {
    candidates.push({
      label: 'py -3',
      command: 'py',
      baseArgs: ['-3'],
    });
  }

  if (await commandExists('python', ['--version'])) {
    candidates.push({
      label: 'python',
      command: 'python',
      baseArgs: [],
    });
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const versionCandidates = ['Python313', 'Python312', 'Python311', 'Python310'];
  for (const ver of versionCandidates) {
    const absPy = path.join(localAppData, 'Programs', 'Python', ver, 'python.exe');
    if (await fs.pathExists(absPy)) {
      candidates.push({
        label: absPy,
        command: absPy,
        baseArgs: [],
      });
    }
  }

  // 去重（同 command+args 組合只保留一次）
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    const key = `${c.command}::${c.baseArgs.join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  return deduped;
}

async function findGeneratedSrt(asrDir, preferredBase = '') {
  if (!(await fs.pathExists(asrDir))) return null;
  const files = await fs.readdir(asrDir);
  const srtFiles = files.filter((f) => /\.srt$/i.test(f));
  if (srtFiles.length === 0) return null;

  // 優先選擇與音訊基底名相近者
  const preferred = srtFiles.find((f) => preferredBase && f.toLowerCase().includes(preferredBase.toLowerCase()));
  if (preferred) return path.join(asrDir, preferred);

  // 否則選最新檔案
  const withStat = await Promise.all(
    srtFiles.map(async (f) => {
      const p = path.join(asrDir, f);
      const st = await fs.stat(p);
      return { path: p, mtimeMs: st.mtimeMs };
    })
  );
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStat[0].path;
}

function getDateStamp() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function getTodaySlideStartIndex(slidesDir, dateStamp) {
  if (!(await fs.pathExists(slidesDir))) return 1;
  const files = await fs.readdir(slidesDir);
  let maxSeq = 0;
  for (const f of files) {
    const m = f.match(new RegExp(`^${dateStamp}_(\\d{5})\\.jpg$`, 'i'));
    if (!m) continue;
    const seq = Number(m[1]);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }
  return maxSeq + 1;
}

async function ensureTesseract() {
  if (tesseractModule) return tesseractModule;
  tesseractModule = require('tesseract.js');
  return tesseractModule;
}

function formatTimestamp(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function probeVideoDurationSeconds(filePath, ffmpegPath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', filePath], { timeout: 30000 }, (_err, stdout = '', stderr = '') => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      const m = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
      if (!m) {
        resolve(null);
        return;
      }

      const h = Number(m[1]);
      const min = Number(m[2]);
      const sec = Number(m[3]);
      resolve(h * 3600 + min * 60 + sec);
    });
  });
}

function parseSrtToTimeline(srtText) {
  const blocks = String(srtText || '')
    .replace(/\r/g, '')
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean);

  const timeline = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const timeLineIdx = lines[0].includes('-->') ? 0 : 1;
    const timeLine = lines[timeLineIdx] || '';
    const textLines = lines.slice(timeLineIdx + 1);
    if (!timeLine.includes('-->') || textLines.length === 0) continue;

    const startRaw = timeLine.split('-->')[0].trim();
    const start = startRaw.replace(',', '.');
    const text = normalizeOcrText(textLines.join(' '));
    if (!text) continue;

    timeline.push({ t: start, text });
  }

  return timeline;
}

function normalizeSummaryKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s`~!@#$%^&*()_+\-=\[\]{};:'"\\|,.<>/?，。！？；：（）【】《》、]/g, '')
    .trim();
}

function buildSubtitleSummary(timeline, maxItems = 8) {
  if (!Array.isArray(timeline) || timeline.length === 0) return [];

  const keywordRe = /(重點|結論|注意|風險|機會|觀察|趨勢|反彈|轉弱|壓力|支撐|買點|賣點|停損|估值|營收|獲利|通膨|利率|美元|台積電|半導體|指數|大盤|資金|籌碼|法說|財報)/;
  const minLen = 10;

  const candidates = timeline
    .map((item, idx) => ({ idx, t: item.t, text: normalizeOcrText(item.text) }))
    .filter((item) => item.text.length >= minLen)
    .map((item) => {
      const lenScore = Math.min(6, Math.floor(item.text.length / 12));
      const keywordScore = keywordRe.test(item.text) ? 4 : 0;
      return {
        ...item,
        score: lenScore + keywordScore,
      };
    })
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const selected = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = normalizeSummaryKey(c.text);
    if (!key) continue;

    // 避免大量重複台詞灌滿摘要
    let duplicated = false;
    for (const existing of seen) {
      if (key.includes(existing) || existing.includes(key)) {
        duplicated = true;
        break;
      }
    }
    if (duplicated) continue;

    seen.add(key);
    selected.push(c);
    if (selected.length >= maxItems) break;
  }

  return selected
    .sort((a, b) => a.idx - b.idx)
    .map((item) => ({
      t: item.t,
      text: item.text,
    }));
}

async function runWhisperAsr(audioPath, asrDir) {
  const baseName = path.parse(audioPath).name;
  const expectedSrt = path.join(asrDir, `${baseName}.srt`);
  await fs.ensureDir(asrDir);

  const diagnostics = [];
  const asrEnv = buildAsrEnv();

  const tryBackend = async (label, command, args, checkArgs) => {
    const exists = await commandExists(command, checkArgs);
    if (!exists) {
      diagnostics.push(`${label}: command not found`);
      return null;
    }

    try {
      await runCommand(command, args, 2 * 60 * 60 * 1000, { env: asrEnv || undefined });
      if (await fs.pathExists(expectedSrt)) {
        return { backend: label, srtPath: expectedSrt };
      }
      const discovered = await findGeneratedSrt(asrDir, baseName);
      if (discovered) {
        return { backend: label, srtPath: discovered };
      }
      diagnostics.push(`${label}: finished but no srt generated`);
      return null;
    } catch (err) {
      diagnostics.push(`${label}: ${String(err.message || err).slice(-500)}`);
      return null;
    }
  };

  // backend 1: whisper CLI
  {
    const result = await tryBackend(
      'whisper',
      'whisper',
      [
        audioPath,
        '--model', WHISPER_MODEL,
        '--language', WHISPER_LANGUAGE,
        '--task', 'transcribe',
        '--output_format', 'srt',
        '--output_dir', asrDir,
        '--fp16', 'False',
      ],
      ['--help']
    );
    if (result) return result;
  }

  // backend 2+: python runtime candidates（py/python/絕對路徑）
  const pyCandidates = await getPythonRuntimeCandidates();
  for (const py of pyCandidates) {
    const result = await tryBackend(
      `${py.label} -m whisper`,
      py.command,
      [
        ...py.baseArgs,
        '-m', 'whisper',
        audioPath,
        '--model', WHISPER_MODEL,
        '--language', WHISPER_LANGUAGE,
        '--task', 'transcribe',
        '--output_format', 'srt',
        '--output_dir', asrDir,
        '--fp16', 'False',
      ],
      [...py.baseArgs, '--version']
    );
    if (result) return result;
  }

  throw new Error(`ASR 失敗：${diagnostics.join(' | ') || 'no backend available'}`);
}

async function checkAsrPreflight() {
  const details = [];
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    return {
      ok: false,
      backend: null,
      message: '找不到 ffmpeg',
      details: ['ffmpeg: command not found'],
    };
  }
  details.push(`ffmpeg: ${ffmpegPath}`);
  const asrEnv = buildAsrEnv();

  // 1) whisper CLI
  if (await commandExists('whisper', ['--help'])) {
    return {
      ok: true,
      backend: 'whisper',
      message: 'ASR 環境可用',
      details: [...details, 'whisper: ok'],
    };
  }
  details.push('whisper: command not found');

  const pyCandidates = await getPythonRuntimeCandidates();
  if (pyCandidates.length === 0) {
    details.push('python runtime: not found');
  }
  for (const py of pyCandidates) {
    try {
      const probe = await runCommand(
        py.command,
        [
          ...py.baseArgs,
          '-c',
          'import whisper, shutil; print("ok"); print(shutil.which("ffmpeg") or "")',
        ],
        30000,
        { env: asrEnv || undefined }
      );
      const out = String(probe.stdout || '');
      if (!out.includes('ok')) {
        throw new Error('whisper import probe failed');
      }
      const ffmpegLine = out.split(/\r?\n/).map((x) => x.trim()).find((x) => x.toLowerCase().includes('ffmpeg'));
      if (!ffmpegLine) {
        throw new Error('python whisper 找不到 ffmpeg');
      }
      return {
        ok: true,
        backend: `${py.label} -m whisper`,
        message: 'ASR 環境可用',
        details: [...details, `${py.label}: whisper module ok`, `${py.label}: ffmpeg=${ffmpegLine}`],
      };
    } catch (err) {
      details.push(`${py.label}: ${String(err.message || err).slice(-200)}`);
    }
  }

  return {
    ok: false,
    backend: null,
    message: '找不到可用的 Whisper 執行方式',
    details,
  };
}

async function writeSubtitleFailureArtifacts(videoPath, videoWorkDir, baseName, reason) {
  const asrDir = path.join(videoWorkDir, 'asr');
  await fs.ensureDir(asrDir);

  const errorLogPath = path.join(asrDir, 'asr_error.log');
  await fs.writeFile(errorLogPath, `${String(reason || 'unknown error')}\n`, 'utf8');

  const subtitleMdPath = path.join(videoWorkDir, `${baseName}_字幕文字.md`);
  const lines = [];
  lines.push(`# ${baseName} 字幕文字`);
  lines.push('');
  lines.push(`- 來源影片: ${path.basename(videoPath)}`);
  lines.push('- 來源方式: ASR');
  lines.push('- 狀態: 失敗');
  lines.push(`- 錯誤記錄: asr/asr_error.log`);
  lines.push('');
  lines.push('> ASR 未成功，請查看 asr_error.log。');
  lines.push('');
  lines.push('```text');
  lines.push(String(reason || 'unknown error'));
  lines.push('```');

  await fs.writeFile(subtitleMdPath, `${lines.join('\n')}\n`, 'utf8');
  return { subtitleMdPath, errorLogPath };
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/[\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keepLikelySubtitle(text) {
  if (!text) return '';
  const cleaned = normalizeOcrText(text);
  if (!cleaned) return '';

  const hasCjk = /[\u4e00-\u9fff]/.test(cleaned);
  const hasEnough = cleaned.length >= 4;
  if (!hasCjk || !hasEnough) return '';

  // 避免把浮水印或 UI 英文資訊當字幕
  if (/scantrader|jwplayer|loading|subscribe/i.test(cleaned)) return '';
  return cleaned;
}

async function listJpgFiles(dir) {
  if (!(await fs.pathExists(dir))) return [];
  const files = await fs.readdir(dir);
  return files
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

async function waitForVideoReady(page) {
  await page.locator('video').evaluate(async (video) => {
    if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) return;

    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('video load failed'));
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onReady, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  });
}

async function seekVideoTo(page, timeSeconds) {
  await page.locator('video').evaluate(async (video, time) => {
    const targetTime = Math.max(0, Number(time) || 0);
    video.pause();

    if (Math.abs((Number(video.currentTime) || 0) - targetTime) < 0.05) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return;
    }

    await new Promise((resolve, reject) => {
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('seek failed'));
      };
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.currentTime = targetTime;
    });

    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, timeSeconds);
}

async function runOcrLines(imagePaths, lang = 'chi_tra+eng') {
  if (imagePaths.length === 0) return [];
  const { createWorker } = await ensureTesseract();
  const worker = await createWorker(lang);
  const lines = [];

  try {
    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i];
      const { data } = await worker.recognize(imagePath);
      lines.push(normalizeOcrText(data && data.text));
    }
  } finally {
    await worker.terminate();
  }

  return lines;
}

async function ensureBrowserPreviewVideo(videoPath, videoWorkDir) {
  const ext = path.extname(videoPath).toLowerCase();
  if (ext !== '.ts') return videoPath;

  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    throw new Error('找不到 ffmpeg，無法將 TS 轉為瀏覽器可 seek 的預覽檔');
  }

  const previewPath = path.join(videoWorkDir, 'browser_preview.mp4');
  if (await fs.pathExists(previewPath)) {
    const stat = await fs.stat(previewPath).catch(() => null);
    if (stat && stat.size > 1024 * 1024) return previewPath;
  }

  const attempts = [
    [
      '-y',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', videoPath,
      '-map', '0:v:0?',
      '-an',
      '-c:v', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-max_interleave_delta', '0',
      '-movflags', '+faststart',
      previewPath,
    ],
    [
      '-y',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', videoPath,
      '-map', '0:v:0?',
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-avoid_negative_ts', 'make_zero',
      '-max_interleave_delta', '0',
      '-movflags', '+faststart',
      previewPath,
    ],
    [
      '-y',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', videoPath,
      '-map', '0:v:0?',
      '-an',
      '-vf', 'setpts=N/FRAME_RATE/TB',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      previewPath,
    ],
  ];

  let lastError = null;
  for (const args of attempts) {
    try {
      await runFfmpeg(ffmpegPath, args, 2 * 60 * 60 * 1000);
      const stat = await fs.stat(previewPath).catch(() => null);
      if (stat && stat.size > 1024 * 1024) return previewPath;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`TS 預覽轉檔失敗: ${String((lastError && lastError.message) || lastError || 'unknown error')}`);
}

async function extractSlidesViaFfmpeg(videoPath, tempSlideDir) {
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    throw new Error('找不到 ffmpeg，無法使用備援簡報擷取');
  }

  const interval = Math.max(1, SLIDE_FALLBACK_INTERVAL_SECONDS);
  const durationSec = await probeVideoDurationSeconds(videoPath, ffmpegPath);

  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
    const outPattern = path.join(tempSlideDir, 'slide_raw_%05d.jpg');
    await runFfmpeg(ffmpegPath, [
      '-y',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', videoPath,
      '-map', '0:v:0?',
      '-an',
      '-vf', `fps=1/${interval},scale=1600:-1`,
      '-vsync', 'vfr',
      '-frames:v', String(SLIDE_MAX_FRAMES),
      '-q:v', '3',
      outPattern,
    ], 2 * 60 * 60 * 1000);

    const files = await listJpgFiles(tempSlideDir);
    console.log(`    [簡報擷取] ffmpeg fallback(single): ${files.length} 張`);
    return files;
  }

  const chunkSeconds = 5 * 60;
  let written = 0;
  const chunkCount = Math.max(1, Math.ceil(durationSec / chunkSeconds));

  for (let chunkIndex = 0; chunkIndex < chunkCount && written < SLIDE_MAX_FRAMES; chunkIndex++) {
    const startSec = chunkIndex * chunkSeconds;
    const remainingBudget = SLIDE_MAX_FRAMES - written;
    const thisChunkSeconds = Math.min(chunkSeconds, Math.max(1, durationSec - startSec));
    const chunkFrameBudget = Math.max(1, Math.min(remainingBudget, Math.ceil(thisChunkSeconds / interval) + 2));
    const outPattern = path.join(tempSlideDir, `slide_raw_${String(chunkIndex + 1).padStart(3, '0')}_%05d.jpg`);

    try {
      await runFfmpeg(ffmpegPath, [
        '-y',
        '-ss', String(startSec),
        '-t', String(thisChunkSeconds),
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-i', videoPath,
        '-map', '0:v:0?',
        '-an',
        '-vf', `fps=1/${interval},scale=1600:-1`,
        '-vsync', 'vfr',
        '-frames:v', String(chunkFrameBudget),
        '-q:v', '3',
        outPattern,
      ], 2 * 60 * 60 * 1000);
    } catch (err) {
      console.log(`    [簡報擷取] ffmpeg chunk ${chunkIndex + 1}/${chunkCount} 失敗：${String(err.message || err).slice(-240)}`);
    }

    const currentFiles = await listJpgFiles(tempSlideDir);
    written = currentFiles.length;
    console.log(`    [簡報擷取] ffmpeg chunk ${chunkIndex + 1}/${chunkCount}: ${written} 張`);
  }

  const files = await listJpgFiles(tempSlideDir);
  console.log(`    [簡報擷取] ffmpeg fallback: ${files.length} 張`);
  return files;
}

async function generateSubtitleMarkdown(videoPath, videoWorkDir, baseName) {
  try {
    const ffmpegPath = findFfmpeg();
    if (!ffmpegPath) {
      throw new Error('找不到 ffmpeg，無法產生字幕文字檔');
    }

    const asrDir = path.join(videoWorkDir, 'asr');
    await fs.emptyDir(asrDir);

    const audioPath = path.join(asrDir, 'asr_audio.wav');
    await runFfmpeg(ffmpegPath, [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      audioPath,
    ]);

    const asrResult = await runWhisperAsr(audioPath, asrDir);
    const srtText = await fs.readFile(asrResult.srtPath, 'utf8');
    const timeline = parseSrtToTimeline(srtText);
    const summary = buildSubtitleSummary(timeline);

    const subtitleMdPath = path.join(videoWorkDir, `${baseName}_字幕文字.md`);
    const lines = [];
    lines.push(`# ${baseName} 字幕文字`);
    lines.push('');
    lines.push(`- 來源影片: ${path.basename(videoPath)}`);
    lines.push(`- 來源方式: ASR (${asrResult.backend})`);
    lines.push(`- Whisper 模型: ${WHISPER_MODEL}`);
    lines.push(`- 字幕來源檔: asr/${path.basename(asrResult.srtPath)}`);
    lines.push('');

    lines.push('## 重點摘要');
    lines.push('');

    if (summary.length === 0) {
      lines.push('- （未能從字幕中提取重點，請參考下方完整時間軸）');
    } else {
      for (const item of summary) {
        lines.push(`- [${item.t}] ${item.text}`);
      }
    }

    lines.push('');
    lines.push('## 完整時間軸');
    lines.push('');

    if (timeline.length === 0) {
      lines.push('> ASR 已執行，但未辨識到可用字幕文字。');
    } else {
      for (const item of timeline) {
        lines.push(`- [${item.t}] ${item.text}`);
      }
    }

    await fs.writeFile(subtitleMdPath, `${lines.join('\n')}\n`, 'utf8');
    return { ok: true, subtitleMdPath, count: timeline.length };
  } catch (err) {
    const reason = String(err && err.message ? err.message : err);
    const artifacts = await writeSubtitleFailureArtifacts(videoPath, videoWorkDir, baseName, reason);
    return {
      ok: false,
      reason,
      subtitleMdPath: artifacts.subtitleMdPath,
      errorLogPath: artifacts.errorLogPath,
    };
  }
}

function cleanStockName(name) {
  return String(name || '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
    .trim();
}

function extractStocksFromText(text) {
  const found = [];
  const src = normalizeOcrText(text);
  if (!src) return found;

  // 型態一：2330 台積電
  const reCodeName = /(^|[^\d])([1-9]\d{3})\s*([\u4e00-\u9fffA-Za-z]{2,12})/g;
  let m1;
  while ((m1 = reCodeName.exec(src)) !== null) {
    const code = m1[2];
    const name = cleanStockName(m1[3]);
    if (!/[\u4e00-\u9fff]/.test(name)) continue;
    found.push({ code, name });
  }

  // 型態二：台積電 2330
  const reNameCode = /([\u4e00-\u9fffA-Za-z]{2,12})\s*([1-9]\d{3})([^\d]|$)/g;
  let m2;
  while ((m2 = reNameCode.exec(src)) !== null) {
    const code = m2[2];
    const name = cleanStockName(m2[1]);
    if (!/[\u4e00-\u9fff]/.test(name)) continue;
    found.push({ code, name });
  }

  // 去重
  const uniq = new Map();
  for (const item of found) {
    const key = `${item.code}${item.name}`;
    if (!uniq.has(key)) uniq.set(key, item);
  }
  return Array.from(uniq.values());
}

async function extractSlideFrames(videoPath, videoWorkDir, outputDir) {
  const tempSlideDir = path.join(videoWorkDir, 'slides_tmp');
  await fs.emptyDir(tempSlideDir);

  let browserVideoPath = videoPath;
  try {
    browserVideoPath = await ensureBrowserPreviewVideo(videoPath, videoWorkDir);
  } catch (err) {
    console.log(`    [簡報擷取] browser 預覽轉檔失敗，改用 ffmpeg 備援：${String(err && err.message ? err.message : err)}`);
    try {
      const rawSlides = await extractSlidesViaFfmpeg(videoPath, tempSlideDir);

      const globalSlideDir = path.join(outputDir, 'slides');
      await fs.ensureDir(globalSlideDir);
      const dateStamp = getDateStamp();
      let seq = await getTodaySlideStartIndex(globalSlideDir, dateStamp);

      const slides = [];
      for (const rawFile of rawSlides) {
        const finalName = `${dateStamp}_${String(seq).padStart(5, '0')}.jpg`;
        const fromPath = path.join(tempSlideDir, rawFile);
        const toPath = path.join(globalSlideDir, finalName);
        await fs.move(fromPath, toPath, { overwrite: false });
        slides.push(finalName);
        seq++;
      }

      await fs.remove(tempSlideDir).catch(() => {});
      return { ok: true, slideDir: globalSlideDir, slides };
    } catch (fallbackErr) {
      return { ok: false, reason: String(fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr) };
    }
  }

  const previewHtmlPath = path.join(videoWorkDir, 'slides_preview.html');
  const videoFileUrl = pathToFileURL(browserVideoPath).href;
  const previewHtml = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 1600px;
      height: 900px;
      background: #000;
      overflow: hidden;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    video {
      width: 1600px;
      height: 900px;
      object-fit: contain;
      background: #000;
      display: block;
    }
  </style>
</head>
<body>
  <video id="video" src="${videoFileUrl}" preload="auto" muted playsinline></video>
</body>
</html>`;
  await fs.writeFile(previewHtmlPath, previewHtml, 'utf8');

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--allow-file-access-from-files'],
    });
    context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
    });
    page = await context.newPage();

    await page.goto(pathToFileURL(previewHtmlPath).href, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('video', { timeout: 30000 });
    await waitForVideoReady(page);

    const videoDuration = await page.locator('video').evaluate((video) => Number(video.duration) || 0);
    if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
      throw new Error('無法取得影片長度，無法擷取瀏覽器截圖');
    }

    const targetFrames = Math.max(1, Math.min(SLIDE_MAX_FRAMES, SLIDE_MIN_FRAMES));
    const idealInterval = Math.max(1, Math.min(SLIDE_FALLBACK_INTERVAL_SECONDS, Math.ceil(videoDuration / targetFrames)));
    const captureCount = Math.min(
      SLIDE_MAX_FRAMES,
      Math.max(targetFrames, Math.ceil(videoDuration / idealInterval) + 1)
    );
    const captureTimes = Array.from({ length: captureCount }, (_v, i) => {
      if (captureCount === 1) return 0;
      return (videoDuration * i) / (captureCount - 1);
    });

    const videoLocator = page.locator('video');
    const rawSlides = [];
    for (let i = 0; i < captureTimes.length; i++) {
      const time = captureTimes[i];
      await seekVideoTo(page, time);
      await page.waitForTimeout(250);

      const filename = `slide_raw_${String(i + 1).padStart(5, '0')}.jpg`;
      const filePath = path.join(tempSlideDir, filename);
      await videoLocator.screenshot({ path: filePath });
      rawSlides.push(filename);
      console.log(`    [簡報擷取] browser ${formatTimestamp(time)}: ${rawSlides.length} 張`);
    }

    const globalSlideDir = path.join(outputDir, 'slides');
    await fs.ensureDir(globalSlideDir);
    const dateStamp = getDateStamp();
    let seq = await getTodaySlideStartIndex(globalSlideDir, dateStamp);

    const slides = [];
    for (const rawFile of rawSlides) {
      const finalName = `${dateStamp}_${String(seq).padStart(5, '0')}.jpg`;
      const fromPath = path.join(tempSlideDir, rawFile);
      const toPath = path.join(globalSlideDir, finalName);
      await fs.move(fromPath, toPath, { overwrite: false });
      slides.push(finalName);
      seq++;
    }

    await fs.remove(tempSlideDir).catch(() => {});
    return { ok: true, slideDir: globalSlideDir, slides };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await fs.remove(previewHtmlPath).catch(() => {});
    if (browserVideoPath && browserVideoPath !== videoPath) {
      await fs.remove(browserVideoPath).catch(() => {});
    }
  }
}

async function processSlidesAndExtractStocks(videoPath, videoWorkDir, baseName) {
  const extracted = await extractSlideFrames(videoPath, videoWorkDir, path.dirname(videoPath));
  if (!extracted.ok) return { ok: false, reason: extracted.reason, mentions: [] };

  const { slideDir, slides } = extracted;
  if (slides.length === 0) {
    return { ok: true, mentions: [], slideDir, slideCount: 0 };
  }

  const absPaths = slides.map((f) => path.join(slideDir, f));
  const ocrTexts = await runOcrLines(absPaths, 'chi_tra+eng');
  const mentions = [];

  for (let i = 0; i < slides.length; i++) {
    const imageFile = slides[i];
    const text = ocrTexts[i] || '';
    const stocks = extractStocksFromText(text);
    if (stocks.length === 0) continue;

    for (const stock of stocks) {
      mentions.push({
        code: stock.code,
        name: stock.name,
        video: path.basename(videoPath),
        imageFile,
        imagePath: path.join(slideDir, imageFile),
        imageRelativePath: path.join('slides', imageFile).replace(/\\/g, '/'),
        contextText: text,
      });
    }
  }

  return { ok: true, mentions, slideDir, slideCount: slides.length };
}

function groupByStock(mentions) {
  const grouped = new Map();
  for (const item of mentions) {
    const key = `${item.code}${item.name}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

async function writeStockMarkdowns(allMentions, outputDir) {
  const stocksDir = path.join(outputDir, 'stocks');
  await fs.ensureDir(stocksDir);

  const grouped = groupByStock(allMentions);
  const written = [];

  for (const [stockKey, items] of grouped.entries()) {
    const mdPath = path.join(stocksDir, `${stockKey}.md`);
    const lines = [];

    lines.push(`# ${stockKey}`);
    lines.push('');
    lines.push(`- 畫面數量: ${items.length}`);
    lines.push('');

    const seenImage = new Set();
    for (const item of items) {
      const imageUniq = `${item.video}|${item.imageFile}`;
      if (seenImage.has(imageUniq)) continue;
      seenImage.add(imageUniq);

      lines.push(`## ${item.video}`);
      lines.push(`- 畫面: ${item.imageFile}`);
      lines.push(`- 圖片: ![${item.imageFile}](${item.imageRelativePath})`);
      if (item.contextText) {
        lines.push(`- OCR: ${item.contextText.slice(0, 300)}`);
      }
      lines.push('');
    }

    await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');
    written.push(mdPath);
  }

  return { stocksDir, files: written, stockCount: written.length };
}

async function processDownloadedVideo(filePath) {
  const outputDir = path.dirname(filePath);
  const baseName = path.parse(filePath).name;
  const videoWorkDir = path.join(outputDir, baseName);
  await fs.ensureDir(videoWorkDir);

  try {
    const subtitle = await generateSubtitleMarkdown(filePath, videoWorkDir, baseName).catch((err) => ({ ok: false, reason: err.message }));
    const slide = await processSlidesAndExtractStocks(filePath, videoWorkDir, baseName).catch((err) => ({ ok: false, reason: err.message, mentions: [] }));

    return {
      videoPath: filePath,
      subtitle,
      slide,
      mentions: (slide && slide.mentions) || [],
    };
  } finally {
    await fs.remove(filePath).catch(() => {});
  }
}

async function summarizeSrtToMarkdown(srtPath, outputMdPath = null) {
  const absSrtPath = path.resolve(String(srtPath || ''));
  if (!(await fs.pathExists(absSrtPath))) {
    throw new Error(`找不到 SRT 檔案: ${absSrtPath}`);
  }

  const srtText = await fs.readFile(absSrtPath, 'utf8');
  const timeline = parseSrtToTimeline(srtText);
  const summary = buildSubtitleSummary(timeline);

  const defaultMdPath = path.join(
    path.dirname(absSrtPath),
    `${path.parse(absSrtPath).name}_彙整.md`
  );
  const mdPath = outputMdPath ? path.resolve(outputMdPath) : defaultMdPath;

  const lines = [];
  lines.push(`# ${path.parse(absSrtPath).name} 字幕彙整`);
  lines.push('');
  lines.push(`- 來源 SRT: ${path.basename(absSrtPath)}`);
  lines.push(`- 條目數: ${timeline.length}`);
  lines.push('');
  lines.push('## 重點摘要');
  lines.push('');

  if (summary.length === 0) {
    lines.push('- （未能從字幕中提取重點，請參考下方完整時間軸）');
  } else {
    for (const item of summary) {
      lines.push(`- [${item.t}] ${item.text}`);
    }
  }

  lines.push('');
  lines.push('## 完整時間軸');
  lines.push('');

  if (timeline.length === 0) {
    lines.push('> 未能解析出有效字幕時間軸。');
  } else {
    for (const item of timeline) {
      lines.push(`- [${item.t}] ${item.text}`);
    }
  }

  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return { srtPath: absSrtPath, mdPath, timelineCount: timeline.length, summaryCount: summary.length };
}

async function extractSlidesOnly(videoPath) {
  const absVideoPath = path.resolve(String(videoPath || ''));
  if (!(await fs.pathExists(absVideoPath))) {
    throw new Error(`找不到影片檔案: ${absVideoPath}`);
  }

  const outputDir = path.dirname(absVideoPath);
  const baseName = path.parse(absVideoPath).name;
  const videoWorkDir = path.join(outputDir, baseName);
  await fs.ensureDir(videoWorkDir);

  const result = await extractSlideFrames(absVideoPath, videoWorkDir, outputDir);
  if (!result.ok) {
    throw new Error(result.reason || '簡報擷取失敗');
  }

  return {
    videoPath: absVideoPath,
    slideDir: result.slideDir,
    slideCount: (result.slides || []).length,
    slides: result.slides || [],
  };
}

module.exports = {
  checkAsrPreflight,
  processDownloadedVideo,
  writeStockMarkdowns,
  summarizeSrtToMarkdown,
  extractSlidesOnly,
};
