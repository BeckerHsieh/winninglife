/**
 * yt-private-download.js
 * Usage:
 *   node yt-private-download.js [--list-only] [--browser chrome|edge] <url>
 *   node yt-private-download.js [--list-formats] [--browser chrome|edge] <url>
 *   node yt-private-download.js [--list-only] --cookies-file <path> <url>
 *
 * If --cookies-from-browser fails (Chrome/Edge locked/encrypted), export cookies
 * via Chrome extension 'Get cookies.txt LOCALLY', save as yt-cookies.txt, then:
 *   node yt-private-download.js --cookies-file .\yt-cookies.txt <url>
 */

const path = require('path');
const fs = require('fs-extra');
const { execSync, execFileSync, spawn } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, 'downloads');
const DEFAULT_COOKIES_FILE = path.join(__dirname, '.session', 'yt-cookies.txt');

const args = process.argv.slice(2);
const listOnly = args.includes('--list-only');
const listFormats = args.includes('--list-formats');
const browserIdx = args.indexOf('--browser');
const browser = browserIdx !== -1 ? args[browserIdx + 1] : 'chrome';
const cookiesFileIdx = args.indexOf('--cookies-file');
const cookiesFile = cookiesFileIdx !== -1 ? args[cookiesFileIdx + 1] : null;
const rawUrlArg = args.find((a) => a.startsWith('http'));

function normalizeYouTubeUrl(input) {
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') {
      const videoId = u.pathname.replace(/^\//, '').split('/')[0];
      if (!videoId) return null;
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    if (host.endsWith('youtube.com') && u.pathname === '/watch') {
      const videoId = u.searchParams.get('v');
      if (!videoId) return null;
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return input;
  } catch {
    return null;
  }
}

const urlArg = rawUrlArg ? normalizeYouTubeUrl(rawUrlArg) : null;

if (!urlArg) {
  console.error('Usage: node yt-private-download.js [--list-only|--list-formats] [--browser chrome|edge] [--cookies-file <path>] <url>');
  console.error('Tip: For YouTube, pass a direct video URL like https://www.youtube.com/watch?v=<VIDEO_ID>');
  process.exit(1);
}

function findYtDlp() {
  for (const cmd of ['yt-dlp', 'yt-dlp.exe']) {
    try { execSync(cmd + ' --version', { stdio: 'ignore' }); return { exec: cmd, args: [] }; } catch {}
  }
  for (const py of ['python', 'py']) {
    try { execSync(py + ' -m yt_dlp --version', { stdio: 'ignore' }); return { exec: py, args: ['-m', 'yt_dlp'] }; } catch {}
  }
  return null;
}

function runYtDlp(ytDlp, extraArgs) {
  return new Promise((resolve, reject) => {
    const allArgs = [...ytDlp.args, ...extraArgs];
    console.log('[yt-dlp] ' + ytDlp.exec + ' ' + allArgs.join(' ') + '\n');
    const proc = spawn(ytDlp.exec, allArgs, { stdio: 'inherit' });
    proc.on('close', (code) => { if (code === 0) resolve(); else reject(new Error('yt-dlp exit code: ' + code)); });
    proc.on('error', reject);
  });
}

function findFfmpeg() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch {}

  for (const cmd of ['ffmpeg', 'ffmpeg.exe']) {
    try {
      execSync(cmd + ' -version', { stdio: 'ignore' });
      return cmd;
    } catch {}
  }
  return null;
}

function getMp4Snapshot(dirPath) {
  const map = new Map();
  const files = fs.readdirSync(dirPath);
  for (const name of files) {
    if (!name.toLowerCase().endsWith('.mp4')) continue;
    const fullPath = path.join(dirPath, name);
    const st = fs.statSync(fullPath);
    map.set(fullPath, { size: st.size, mtimeMs: st.mtimeMs });
  }
  return map;
}

function getChangedMp4Files(before, after) {
  const changed = [];
  for (const [filePath, meta] of after.entries()) {
    const oldMeta = before.get(filePath);
    if (!oldMeta || oldMeta.size !== meta.size || oldMeta.mtimeMs !== meta.mtimeMs) {
      changed.push(filePath);
    }
  }
  return changed;
}

function detectContainerType(ffmpegPath, filePath) {
  try {
    const stderr = execFileSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = stderr || '';
    const m = text.match(/Input #0,\s*([^,]+),/i);
    return m ? m[1].trim().toLowerCase() : 'unknown';
  } catch (err) {
    const text = (err && err.stderr ? String(err.stderr) : '') + (err && err.stdout ? String(err.stdout) : '');
    const m = text.match(/Input #0,\s*([^,]+),/i);
    return m ? m[1].trim().toLowerCase() : 'unknown';
  }
}

function remuxToMp4(ffmpegPath, inputPath) {
  const tmpPath = inputPath + '.fixed.mp4';
  execFileSync(ffmpegPath, [
    '-y',
    '-i', inputPath,
    '-map', '0',
    '-c', 'copy',
    '-movflags', '+faststart',
    tmpPath,
  ], { stdio: 'ignore' });

  const backupPath = inputPath + '.bak';
  fs.moveSync(inputPath, backupPath, { overwrite: true });
  fs.moveSync(tmpPath, inputPath, { overwrite: true });
}

function normalizeMp4Containers(changedFiles) {
  if (!changedFiles.length) return;
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    console.warn('[Post] Skip container normalization: ffmpeg not found');
    return;
  }

  for (const filePath of changedFiles) {
    const container = detectContainerType(ffmpegPath, filePath);
    if (container === 'mpegts') {
      console.log('[Post] Remuxing TS-in-MP4 container: ' + path.basename(filePath));
      try {
        remuxToMp4(ffmpegPath, filePath);
        console.log('[Post] Remux done: ' + path.basename(filePath));
      } catch (err) {
        console.warn('[Post] Remux failed: ' + path.basename(filePath) + ' (' + err.message + ')');
      }
    }
  }
}

async function runWithFallbacks(ytDlp, baseArgs, outputTpl, urlArg) {
  const attempts = [
    {
      name: 'progressive mp4 (most player-compatible)',
      args: [
        ...baseArgs,
        '--extractor-args', 'youtube:player_client=web,web_safari,tv,ios',
        '--output', outputTpl,
        '--format', 'best[ext=mp4][vcodec!=none][acodec!=none]/18/best',
        '--remux-video', 'mp4',
        urlArg,
      ],
    },
    {
      name: 'adaptive mp4 merge (higher quality fallback)',
      args: [
        ...baseArgs,
        '--extractor-args', 'youtube:player_client=web,web_safari,ios,tv',
        '--output', outputTpl,
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--remux-video', 'mp4',
        urlArg,
      ],
    },
    {
      name: 'tv/ios client + broad adaptive fallback',
      args: [
        ...baseArgs,
        '--extractor-args', 'youtube:player_client=tv,ios,web_safari',
        '--output', outputTpl,
        '--format', 'bv*+ba/b',
        '--remux-video', 'mp4',
        urlArg,
      ],
    },
    {
      name: 'single-stream fallback',
      args: [
        ...baseArgs,
        '--extractor-args', 'youtube:player_client=tv,ios,web_safari',
        '--output', outputTpl,
        '--format', 'best',
        urlArg,
      ],
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    console.log('[Retry] Trying: ' + attempt.name);
    try {
      await runYtDlp(ytDlp, attempt.args);
      return;
    } catch (err) {
      lastError = err;
      console.error('[Retry] Failed: ' + attempt.name + ' (' + err.message + ')');
    }
  }

  throw lastError || new Error('All download attempts failed');
}

function getCookieArgs() {
  // 優先使用指定的 cookies 檔案
  if (cookiesFile) {
    if (!fs.existsSync(cookiesFile)) {
      console.error('[Error] Cookies file not found: ' + cookiesFile);
      process.exit(1);
    }
    console.log('[Cookie] Using file: ' + cookiesFile);
    return ['--cookies', cookiesFile];
  }
  // 嘗試自動從瀏覽器讀取（Chrome/Edge 需先關閉瀏覽器）
  console.log('[Cookie] Browser: ' + browser + ' (close ' + browser + ' before running if you see a lock error)');
  return ['--cookies-from-browser', browser];
}

(async () => {
  await fs.ensureDir(OUTPUT_DIR);
  await fs.ensureDir(path.join(__dirname, '.session'));

  const ytDlp = findYtDlp();
  if (!ytDlp) {
    console.error('[Error] yt-dlp not found. Run: pip install yt-dlp');
    process.exit(1);
  }
  console.log('[yt-dlp] ' + ytDlp.exec);
  console.log('[Target] ' + urlArg);

  const cookieArgs = getCookieArgs();

  const baseArgs = [
    ...cookieArgs,
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '--no-playlist',
    '--no-playlist-reverse',
    '--progress',
  ];

  try {
    if (listOnly) {
      await runYtDlp(ytDlp, [
        ...baseArgs,
        '--extractor-args', 'youtube:player_client=web,web_safari,ios,tv',
        '--flat-playlist',
        '--print', '%(playlist_index)s\t%(id)s\t%(title)s',
        urlArg,
      ]);
    } else if (listFormats) {
      await runYtDlp(ytDlp, [
        ...baseArgs,
        '--extractor-args', 'youtube:player_client=tv,ios,web_safari,web',
        '--list-formats',
        urlArg,
      ]);
    } else {
      const tpl = path.join(OUTPUT_DIR, '%(playlist_index)s_%(title)s.%(ext)s');
      const beforeSnapshot = getMp4Snapshot(OUTPUT_DIR);
      await runWithFallbacks(ytDlp, baseArgs, tpl, urlArg);
      const afterSnapshot = getMp4Snapshot(OUTPUT_DIR);
      const changedMp4 = getChangedMp4Files(beforeSnapshot, afterSnapshot);
      normalizeMp4Containers(changedMp4);
      console.log('[Done] Downloaded to: ' + OUTPUT_DIR);
    }
  } catch (err) {
    if (!listOnly && !listFormats) {
      console.error('');
      console.error('[Info] Auto listing available formats for diagnostics...');
      try {
        await runYtDlp(ytDlp, [
          ...baseArgs,
          '--extractor-args', 'youtube:player_client=tv,ios,web_safari',
          '--list-formats',
          urlArg,
        ]);
      } catch {
        console.error('[Info] Unable to list formats. This can happen when YouTube challenge blocks all media formats.');
      }
    }

    if (err.message.includes('exit code') && !cookiesFile) {
      console.error('');
      console.error('=== Troubleshooting ===');
      console.error('If Chrome/Edge is locked:');
      console.error('  1. Close all Chrome/Edge windows, then re-run');
      console.error('  2. Or: export cookies using Chrome extension [Get cookies.txt LOCALLY]');
      console.error('     Save to: ' + DEFAULT_COOKIES_FILE);
      console.error('     Then run: node yt-private-download.js --cookies-file .session\\yt-cookies.txt <url>');
      console.error('  3. Update yt-dlp to latest: pip install -U yt-dlp');
      console.error('  4. Ensure Node.js runtime is available in PATH for youtube challenge solving');
    }
    process.exit(1);
  }
})();
