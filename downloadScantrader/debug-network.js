/**
 * debug-network.js — 詳細記錄文章頁所有網路請求，找出影片 API
 *
 * 用法：node debug-network.js
 */

const readlineSync = require('readline-sync');
const { login } = require('./login');
const fs = require('fs-extra');
const path = require('path');

const ARTICLE_URL = 'https://scantrader.com/article/019efe1021b30000122cdd000000000000';

(async () => {
  const email = process.env.SCANTRADER_EMAIL || readlineSync.question('LINE Email: ');
  const password = process.env.SCANTRADER_PASSWORD || readlineSync.question('LINE 密碼: ', { hideEchoBack: true });

  let browser, context, page;
  try {
    ({ browser, context, page } = await login(email, password, false));
  } catch (err) {
    console.error('[錯誤]', err.message);
    process.exit(1);
  }

  const requests = [];

  // 攔截所有請求 & 回應
  page.on('request', (req) => {
    requests.push({
      time: Date.now(),
      method: req.method(),
      url: req.url(),
      type: req.resourceType(),
    });
  });

  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    const status = res.status();

    // 記錄所有 scantrader API 回應
    if (url.includes('scantrader.com') && (ct.includes('json') || ct.includes('video') || ct.includes('mpegurl'))) {
      let body = '';
      try { body = await res.text(); } catch {}
      const entry = requests.find((r) => r.url === url);
      if (entry) entry.response = { status, ct, body: body.slice(0, 2000) };
      console.log(`[api] ${status} ${ct.split(';')[0]} ${url}`);
      if (body && body.length < 3000) console.log('  body:', body.slice(0, 500));
    }

    // 任何影片相關
    if (ct.includes('video') || ct.includes('mpegurl') || url.match(/\.(m3u8|mp4|mov|webm|ts)(\?|$)/i)) {
      console.log(`\n🎬 [VIDEO FOUND] ${status} ${ct} ${url}\n`);
    }
  });

  console.log('\n=== 前往文章頁 ===');
  await page.goto(ARTICLE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // 截圖確認登入狀態
  await page.screenshot({ path: path.join(__dirname, 'debug-network-1.png') });
  console.log('[截圖] debug-network-1.png');

  // 顯示頁面標題和登入狀態
  const title = await page.title();
  console.log('[title]', title);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('[body preview]', bodyText.replace(/\s+/g, ' '));

  // 找到播放器並截圖
  const playerHtml = await page.evaluate(() => {
    const el = document.querySelector('[class*="player"], [class*="viewer"], video');
    return el ? el.outerHTML.slice(0, 1000) : '(找不到播放器元素)';
  });
  console.log('\n[player HTML]', playerHtml);

  // 等待並嘗試互動
  console.log('\n=== 嘗試點擊播放 ===');
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(1500);

  // 列出所有可點擊的元素在播放器區域
  const clickableEls = await page.evaluate(() => {
    const container = document.querySelector('[class*="viewer"], [class*="article-content"], main');
    if (!container) return [];
    return Array.from(container.querySelectorAll('*')).slice(0, 50).map((el) => ({
      tag: el.tagName,
      class: el.className?.toString().slice(0, 60) || '',
      id: el.id || '',
      visible: el.offsetParent !== null,
    })).filter((e) => e.visible);
  });
  console.log('[article elements]:', clickableEls.slice(0, 20));

  // 嘗試強制點擊播放器中心
  try {
    const playerBox = await page.$('[class*="viewer-player"], [class*="player-container"], [class*="vjs"], video');
    if (playerBox) {
      const box = await playerBox.boundingBox();
      if (box) {
        console.log('[player boundingBox]', box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(__dirname, 'debug-network-2.png') });
        console.log('[截圖] debug-network-2.png');
      }
    }
  } catch (e) {
    console.log('[click error]', e.message);
  }

  // 最終等待 5 秒看看有沒有影片請求
  console.log('\n=== 等待 5 秒觀察請求 ===');
  await page.waitForTimeout(5000);

  // 輸出所有 scantrader.com 的請求
  console.log('\n=== 所有 scantrader.com 請求 ===');
  requests
    .filter((r) => r.url.includes('scantrader.com'))
    .forEach((r) => {
      console.log(`  [${r.type.padEnd(8)}] ${r.method} ${r.url}`);
      if (r.response) console.log(`    -> ${r.response.status} ${r.response.ct}`);
    });

  // 儲存完整報告
  await fs.writeJson(path.join(__dirname, 'debug-network-report.json'), { requests }, { spaces: 2 });
  console.log('\n[報告] debug-network-report.json');

  readlineSync.question('\n按 Enter 關閉...');
  await browser.close();
})();
