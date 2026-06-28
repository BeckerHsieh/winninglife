#!/usr/bin/env node
/**
 * index.js — 主程式
 *
 * 用法：
 *   node index.js                        # 下載「我是金錢爆速效錠」頻道所有影片
 *   node index.js --article <url>        # 只下載單篇文章的影片
 *   node index.js --no-headless          # 顯示瀏覽器視窗（方便除錯）
 *
 * 環境變數（選用）：
 *   SCANTRADER_EMAIL    登入 email（若未設定則互動輸入）
 *   SCANTRADER_PASSWORD 登入密碼（若未設定則互動輸入）
 */

const readlineSync = require('readline-sync');
const { login, hasSavedSession } = require('./login');
const { getArticleUrls, getVideoUrlsFromArticle, CHANNEL_URL, CHANNEL_NAME } = require('./scraper');
const { downloadVideo, OUTPUT_DIR } = require('./downloader');

// ─── 解析命令列引數 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const headless = !args.includes('--no-headless');
const singleArticleIdx = args.indexOf('--article');
const singleArticleUrl = singleArticleIdx !== -1 ? args[singleArticleIdx + 1] : null;

// ─── 主流程 ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('='.repeat(60));
  console.log(`  Scantrader 影片下載器`);
  console.log(`  頻道：${CHANNEL_NAME}`);
  console.log(`  下載目錄：${OUTPUT_DIR}`);
  console.log('='.repeat(60));

  const sessionExists = await hasSavedSession();
  const promptForCredentials = () => ({
    email: process.env.SCANTRADER_EMAIL || readlineSync.question('LINE 登入 Email: '),
    password:
      process.env.SCANTRADER_PASSWORD ||
      readlineSync.question('LINE 登入密碼: ', { hideEchoBack: true }),
  });

  // 有有效 session 時先嘗試不打擾地登入；失敗再要求輸入憑證
  const initialCredentials = sessionExists
    ? { email: process.env.SCANTRADER_EMAIL || '', password: process.env.SCANTRADER_PASSWORD || '' }
    : promptForCredentials();

  let browser, context, page;

  try {
    ({ browser, context, page } = await login(initialCredentials.email, initialCredentials.password, headless));
  } catch (err) {
    if (sessionExists) {
      const credentials = promptForCredentials();
      try {
        ({ browser, context, page } = await login(credentials.email, credentials.password, headless));
      } catch (retryErr) {
        console.error('[主程式] 登入失敗：', retryErr.message);
        process.exit(1);
      }
    } else {
      console.error('[主程式] 登入失敗：', err.message);
      process.exit(1);
    }
  }

  // 決定要處理的文章列表
  let articleUrls;
  if (singleArticleUrl) {
    console.log(`\n[主程式] 單篇文章模式：${singleArticleUrl}`);
    articleUrls = [singleArticleUrl];
  } else {
    console.log(`\n[主程式] 頻道模式：掃描 ${CHANNEL_URL}`);
    articleUrls = await getArticleUrls(page);
  }

  if (articleUrls.length === 0) {
    console.log('[主程式] 未找到任何文章，程式結束。');
    await browser.close();
    return;
  }

  // 統計
  let totalVideos = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // 逐篇文章處理
  for (let i = 0; i < articleUrls.length; i++) {
    const url = articleUrls[i];
    console.log(`\n[${i + 1}/${articleUrls.length}] ${url}`);

    let videoUrls;
    try {
      videoUrls = await getVideoUrlsFromArticle(page, url);
    } catch (err) {
      console.error(`  [錯誤] 無法解析文章：${err.message}`);
      failed++;
      continue;
    }

    if (videoUrls.length === 0) continue;

    // 取得文章標題（截斷到 70 字元，保留後綴 -1/-2 的空間）
    let title = `article_${i + 1}`;
    try {
      title = (await page.title()).slice(0, 70);
    } catch {
      // 忽略
    }

    totalVideos += videoUrls.length;

    // 取得 cookies（一次即可，所有影片共用）
    const cookies = await context.cookies();

    // ── 並行下載同篇文章的所有影片（避免簽名 URL 過期）──────────────────────
    const downloadTasks = videoUrls.map((videoSource, j) => {
      const suffix = videoUrls.length > 1 ? `-${j + 1}` : '';
      const fileTitle = `${title}${suffix}`;
      return downloadVideo(videoSource, fileTitle, i + 1, cookies);
    });

    const results = await Promise.all(downloadTasks);
    for (const result of results) {
      if (result.error) failed++;
      else if (result.skipped) skipped++;
      else downloaded++;
    }
  }

  await browser.close();

  // 最終報告
  console.log('\n' + '='.repeat(60));
  console.log(`  完成！`);
  console.log(`  文章總數：${articleUrls.length}`);
  console.log(`  找到影片：${totalVideos}`);
  console.log(`  成功下載：${downloaded}`);
  console.log(`  已略過  ：${skipped}`);
  console.log(`  失敗    ：${failed}`);
  console.log(`  下載目錄：${OUTPUT_DIR}`);
  console.log('='.repeat(60));
})();
