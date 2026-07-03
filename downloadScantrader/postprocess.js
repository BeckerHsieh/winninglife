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

let tesseractModule = null;

const SLIDE_MAX_FRAMES = Number(process.env.SLIDE_MAX_FRAMES || 300);
const SCENE_THRESHOLD = Number(process.env.SLIDE_SCENE_THRESHOLD || 0.35);
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

    const subtitleMdPath = path.join(videoWorkDir, `${baseName}_字幕文字.md`);
    const lines = [];
    lines.push(`# ${baseName} 字幕文字`);
    lines.push('');
    lines.push(`- 來源影片: ${path.basename(videoPath)}`);
    lines.push(`- 來源方式: ASR (${asrResult.backend})`);
    lines.push(`- Whisper 模型: ${WHISPER_MODEL}`);
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
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    return { ok: false, reason: '找不到 ffmpeg，無法擷取簡報畫面' };
  }

  const tempSlideDir = path.join(videoWorkDir, 'slides_tmp');
  await fs.emptyDir(tempSlideDir);

  const outPattern = path.join(tempSlideDir, 'slide_raw_%05d.jpg');
  const vf = `select='gt(scene,${SCENE_THRESHOLD})',scale=1600:-1`;

  await runFfmpeg(ffmpegPath, [
    '-y',
    '-i', videoPath,
    '-vf', vf,
    '-vsync', 'vfr',
    '-frames:v', String(SLIDE_MAX_FRAMES),
    '-q:v', '3',
    outPattern,
  ]);

  const rawSlides = await listJpgFiles(tempSlideDir);

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
      lines.push(`- 圖片路徑: ${item.imageRelativePath}`);
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

  const subtitle = await generateSubtitleMarkdown(filePath, videoWorkDir, baseName).catch((err) => ({ ok: false, reason: err.message }));
  const slide = await processSlidesAndExtractStocks(filePath, videoWorkDir, baseName).catch((err) => ({ ok: false, reason: err.message, mentions: [] }));

  return {
    videoPath: filePath,
    subtitle,
    slide,
    mentions: (slide && slide.mentions) || [],
  };
}

module.exports = {
  checkAsrPreflight,
  processDownloadedVideo,
  writeStockMarkdowns,
};
