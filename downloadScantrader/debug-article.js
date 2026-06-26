/**
 * debug-article.js — 診斷單篇文章的影片 URL（含登入流程）
 *
 * 用法：node debug-article.js [articleUrl]
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs-extra');
const readlineSync = require('readline-sync');
const { login } = require('./login');

const SESSION_FILE = path.join(__dirname, '.session', 'auth.json');
const articleUrl = process.argv[2] || 'https://scantrader.com/article/019efe1021b30000122cdd000000000000';

(async () => {
  console.log('=== Scantrader 影片診斷工具 ===');
  console.log('目標文章：', articleUrl);

  // 取得登入憑證
  const email = process.env.SCANTRADER_EMAIL || readlineSync.question('LINE 登入 Email: ');
  const password =
    process.env.SCANTRADER_PASSWORD ||
    readlineSync.question('LINE 登入密碼: ', { hideEchoBack: true });

  // 登入
  let browser, context, page;
  try {
    ({ browser, context, page } = await login(email, password, false /* 顯示視窗 */));
  } catch (err) {
    console.error('[錯誤] 登入失敗：', err.message);
    process.exit(1);
  }

  // ── 攔截所有網路請求 ──────────────────────────────────────────────────────
  const allRequests = [];
  const mediaResponses = [];

  page.on('request', (req) => {
    allRequests.push({ method: req.method(), url: req.url(), resourceType: req.resourceType() });
  });

  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    if (
      ct.includes('video') ||
      ct.includes('mpegurl') ||
      ct.includes('octet-stream') ||
      url.includes('.m3u8') ||
      url.includes('.mp4') ||
      url.includes('.ts') ||
      url.includes('stream') ||
      url.includes('/video/') ||
      url.includes('vod.') ||
      url.includes('/media/')
    ) {
      console.log('[media]', res.status(), ct.padEnd(30), url.slice(0, 120));
      mediaResponses.push({ status: res.status(), contentType: ct, url });
    }
  });

  // ── 前往文章頁 ────────────────────────────────────────────────────────────
  console.log('\n[step] 前往文章頁...');
  await page.goto(articleUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(__dirname, 'debug-article.png') });
  console.log('[info] 截圖：debug-article.png');
  console.log('[info] URL：', page.url());

  // ── 找 video 元素 ─────────────────────────────────────────────────────────
  const videoEls = await page.$$eval(
    'video, iframe, [class*="player"], [class*="video"]',
    (els) => els.map((el) => ({
      tag: el.tagName,
      src: el.src || el.getAttribute('src') || '',
      dataSrc: el.getAttribute('data-src') || '',
      class: el.className?.slice(0, 80) || '',
      id: el.id || '',
      html: el.outerHTML?.slice(0, 300) || '',
    }))
  );
  console.log('\n[video elements]:', videoEls.length);
  videoEls.forEach((v, i) => console.log(`  [${i}]`, v.tag, v.src || v.dataSrc || v.html));

  // ── 滾動到播放器區域並嘗試點擊 ────────────────────────────────────────────
  console.log('\n[step] 滾動到播放器...');
  const playerEl = await page.$('[class*="viewer-player"], [class*="player"], video');
  if (playerEl) {
    await playerEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(__dirname, 'debug-player.png') });
    console.log('[info] 截圖：debug-player.png');

    try {
      await playerEl.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch {
      console.log('[info] 播放器點擊 timeout（可能是播放按鈕覆蓋）');
      // 嘗試點擊播放覆蓋層
      const overlay = await page.$('[class*="overlay"], [class*="play-btn"], [class*="play-icon"]');
      if (overlay) {
        try { await overlay.click({ timeout: 3000, force: true }); } catch {}
        await page.waitForTimeout(3000);
      }
    }
  }

  // ── 掃描 script 標籤中的影片 URL ─────────────────────────────────────────
  console.log('\n[step] 掃描 JS...');
  const jsVars = await page.evaluate(() => {
    const result = {};
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    result._mediaScripts = scripts
      .map((s) => s.textContent)
      .filter((t) => t.includes('.m3u8') || t.includes('.mp4') || t.includes('stream') || t.includes('videoUrl'))
      .map((t) => t.slice(0, 800));
    // 找全域播放器變數
    for (const key of ['jwplayer', 'videojs', '_playerConfig', 'videoConfig', 'streamUrl', 'videoUrl', 'hlsUrl']) {
      if (window[key]) result[key] = typeof window[key] === 'string' ? window[key] : JSON.stringify(window[key]).slice(0, 300);
    }
    return result;
  });
  console.log('[JS mediaScripts count]:', jsVars._mediaScripts?.length || 0);
  if (jsVars._mediaScripts?.length) {
    jsVars._mediaScripts.forEach((s, i) => console.log(`  script[${i}]:`, s.slice(0, 200)));
  }

  // ── 彙整所有 API 請求 ──────────────────────────────────────────────────────
  console.log('\n[all XHR/Fetch requests]:');
  allRequests
    .filter((r) => r.resourceType === 'xhr' || r.resourceType === 'fetch')
    .forEach((r) => console.log(' ', r.method, r.url.slice(0, 120)));

  console.log('\n[media requests]:');
  const mediaReqs = allRequests.filter(
    (r) => r.resourceType === 'media' || r.url.includes('.m3u8') || r.url.includes('.mp4')
  );
  if (mediaReqs.length) {
    mediaReqs.forEach((r) => console.log(' ', r.method, r.url));
  } else {
    console.log('  (無媒體請求)');
  }

  // 存報告
  const report = { articleUrl, videoEls, jsVars, allRequests: allRequests.slice(-100), mediaResponses };
  await fs.writeJson(path.join(__dirname, 'debug-report.json'), report, { spaces: 2 });
  console.log('\n[info] 報告已存：debug-report.json');

  // 儲存 session
  await fs.ensureDir(path.dirname(SESSION_FILE));
  await context.storageState({ path: SESSION_FILE });

  console.log('\n按 Enter 關閉瀏覽器...');
  readlineSync.question('');
  await browser.close();
})();

