/**
 * scraper.js — 爬取指定 scantrader 頻道的所有文章 URL，
 *              並從文章頁面取得真實影片 URL（依 Response content-type 判定）
 */

const CHANNEL_URL = 'https://scantrader.com/u/77340';
const CHANNEL_NAME = '我是金錢爆「速效錠」';

// 合法的影片 content-type
const VIDEO_CONTENT_TYPES = [
  'video/',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/octet-stream', // 部分 CDN 用這個回傳影片
];

// 排除名單：這些網域不是影片
const EXCLUDE_DOMAINS = [
  'google',
  'doubleclick',
  'facebook',
  'analytics',
  'gtm',
  'gstatic',
  'fonts',
  'twitter',
  'cdn.jsdelivr',
];

function isLikelyVideo(url, contentType) {
  if (EXCLUDE_DOMAINS.some((d) => url.includes(d))) return false;

  // 以 content-type 為主
  if (contentType && VIDEO_CONTENT_TYPES.some((t) => contentType.toLowerCase().includes(t))) {
    // 排除 octet-stream 的 JS/CSS
    if (contentType.includes('octet-stream') && (url.endsWith('.js') || url.endsWith('.css'))) return false;
    return true;
  }

  // 沒有 content-type 時，以 URL 副檔名為輔（嚴格比對）
  const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
  return cleanUrl.endsWith('.m3u8') || cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.mov') || cleanUrl.endsWith('.webm');
}

/**
 * 取得頻道所有文章 URL
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
async function getArticleUrls(page) {
  console.log(`[爬蟲] 前往頻道頁面：${CHANNEL_URL}`);
  await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const urls = new Set();
  let prevCount = 0;
  let noNewCount = 0;

  while (noNewCount < 3) {
    const links = await page.$$eval(
      'a[href*="/article/"]',
      (els) => els.map((el) => el.href)
    );
    links.forEach((u) => urls.add(u));

    if (urls.size > prevCount) {
      console.log(`[爬蟲] 已找到 ${urls.size} 篇文章...`);
      prevCount = urls.size;
      noNewCount = 0;
    } else {
      noNewCount++;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    const loadMoreBtn = await page.$('button:has-text("載入更多"), button:has-text("更多"), [class*="load-more"]');
    if (loadMoreBtn) {
      await loadMoreBtn.click();
      await page.waitForTimeout(2000);
    }
  }

  const result = Array.from(urls);
  console.log(`[爬蟲] 共找到 ${result.length} 篇文章`);
  return result;
}

/**
 * getVideoUrlsFromArticle — 從文章頁取得 JWPlayer m3u8 URL
 *
 * 流程：
 *  1. 攔截 cdn.jwplayer.com manifest 回應（content-type: application/vnd.apple.mpegurl）
 *  2. 等 viewer-player 容器內 JWPlayer 初始化完成（出現 [class*="jwplayer"] 子元素）
 *  3. 點擊播放器觸發 manifest 請求
 *  4. 等待捕獲到 m3u8 URL 或逾時
 *
 * @param {import('playwright').Page} page
 * @param {string} articleUrl
 * @returns {Promise<string[]>}
 */
async function getVideoUrlsFromArticle(page, articleUrl) {
  const videoUrls = new Set();

  // ── 只攔截 JWPlayer m3u8 manifest（嚴格排除 ping/tracking/片段）────────────
  const isManifestUrl = (url) => {
    if (url.includes('prd.jwpltx.com')) return false;           // JW ping tracker
    if (url.includes('ping.gif')) return false;
    if (/\.(ts|m4s|aac|gif|png|jpg)(\?|$)/i.test(url)) return false;  // HLS 片段
    return url.includes('.m3u8') || url.includes('cdn.jwplayer.com/manifests/');
  };

  const responseHandler = (res) => {
    const url = res.url();
    if (isManifestUrl(url)) {
      console.log(`  [m3u8 ✓] ${url.slice(0, 120)}`);
      videoUrls.add(url);
    }
  };
  page.on('response', responseHandler);

  console.log(`[爬蟲] 前往文章：${articleUrl}`);
  await page.goto(articleUrl, { waitUntil: 'domcontentloaded' });

  // 等 JWPlayer 初始化
  console.log('  等待 JWPlayer 初始化...');
  try {
    await page.waitForSelector(
      '[class*="viewer-player"] [class*="jwplayer"], [class*="viewer-player"] video, [id^="jwplayer"]',
      { timeout: 12000 }
    );
    console.log('  JWPlayer 已初始化');
  } catch {
    console.log('  JWPlayer 初始化逾時，嘗試繼續...');
  }
  await page.waitForTimeout(1000);

  // ── 找出所有播放器容器，逐一滾動＋點擊觸發 manifest ──────────────────────
  const containerSelectors = [
    '[class*="viewer-player"]',
    '[id^="jwplayer"]',
    '[class*="jwplayer"]',
  ];

  let playerEls = [];
  for (const sel of containerSelectors) {
    const found = await page.$$(sel);
    if (found.length > 0) {
      playerEls = found;
      console.log(`  找到 ${found.length} 個播放器 (${sel})`);
      break;
    }
  }

  if (playerEls.length === 0) {
    // fallback: 找 <video>
    playerEls = await page.$$('video');
    if (playerEls.length > 0) console.log(`  找到 ${playerEls.length} 個 <video>`);
  }

  // 逐一點擊每個播放器，等待 manifest 出現
  for (let pi = 0; pi < playerEls.length; pi++) {
    const el = playerEls[pi];
    try {
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      const box = await el.boundingBox();
      if (!box || box.width < 10 || box.height < 10) continue;
      console.log(`  點擊播放器 [${pi + 1}/${playerEls.length}]`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      // 等待這個播放器的 manifest（最多 8 秒）
      await page.waitForResponse(
        (res) => isManifestUrl(res.url()),
        { timeout: 8000 }
      ).catch(() => null);
      await page.waitForTimeout(500);
    } catch (e) {
      console.log(`  播放器 [${pi + 1}] 點擊失敗：${e.message}`);
    }
  }

  // 再等 2 秒，補捉延遲載入的 URL
  await page.waitForTimeout(2000);

  // 補充：從 DOM <video src> 取得
  const domSrcs = await page.$$eval('video[src], video > source[src]', (els) =>
    els.map((el) => el.src || el.getAttribute('src')).filter(Boolean)
  );
  domSrcs.forEach((u) => { if (isLikelyVideo(u, '')) videoUrls.add(u); });

  page.off('response', responseHandler);

  const result = Array.from(videoUrls).filter(Boolean);
  if (result.length > 0) {
    console.log(`[爬蟲]   ✓ 找到 ${result.length} 個影片 URL`);
  } else {
    console.log(`[爬蟲]   ✗ 未找到影片`);
  }
  return result;
}

module.exports = { getArticleUrls, getVideoUrlsFromArticle, CHANNEL_URL, CHANNEL_NAME };
