/**
 * login.js — 使用 LINE 帳號登入 scantrader.com (微股力)
 *
 * 流程：
 *  1. 前往 scantrader.com，偵測是否已登入
 *  2. 若未登入，點擊「立即登入」→ 再點擊「LINE 登入」
 *  3. 在 LINE OAuth 頁填入 email / 密碼
 *  4. 完成登入後儲存 session，返回 browser context
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs-extra');

const SESSION_FILE = path.join(__dirname, '.session', 'auth.json');

async function login(email, password, headless = false) {
  console.log('[登入] 啟動瀏覽器...');

  const browser = await chromium.launch({ headless, slowMo: 150 });

  // 嘗試還原已儲存的 session
  let context;
  if (await fs.pathExists(SESSION_FILE)) {
    console.log('[登入] 發現已儲存的 session，嘗試還原...');
    context = await browser.newContext({ storageState: SESSION_FILE });
  } else {
    context = await browser.newContext();
  }

  const page = await context.newPage();

  // ── 前往首頁，確認登入狀態 ────────────────────────────────────────────────
  await page.goto('https://scantrader.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  if (await isLoggedIn(page)) {
    console.log('[登入] 已使用儲存的 session 登入成功！');
    return { browser, context, page };
  }

  // ── 前往登入頁 ────────────────────────────────────────────────────────────
  console.log('[登入] 前往登入頁面...');
  await page.goto('https://scantrader.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(__dirname, 'debug-login-page.png') });

  // ── 找 LINE 登入按鈕（多種 selector 備用）────────────────────────────────
  const lineBtnSelectors = [
    'a[href*="line.me"]',
    'a[href*="/auth/line"]',
    'button:has-text("LINE")',
    'a:has-text("LINE")',
    '[class*="line"]:has-text("登入")',
    'img[alt*="LINE"]',
    'a[class*="line"]',
  ];

  let lineBtn = null;
  for (const sel of lineBtnSelectors) {
    lineBtn = await page.$(sel);
    if (lineBtn) {
      console.log(`[登入] 找到 LINE 按鈕：${sel}`);
      break;
    }
  }

  if (!lineBtn) {
    // 列出頁面所有連結協助除錯
    const allLinks = await page.$$eval('a, button', (els) =>
      els.map((e) => `${e.tagName} | ${(e.innerText || '').trim().slice(0, 40)} | ${e.href || e.className}`).slice(0, 30)
    );
    console.log('[登入] 頁面上的連結/按鈕：\n', allLinks.join('\n'));
    await page.screenshot({ path: path.join(__dirname, 'debug-no-line-btn.png') });
    throw new Error('[登入] 找不到 LINE 登入按鈕，已截圖至 debug-no-line-btn.png');
  }

  // ── 點擊 LINE，等待跳轉至 LINE OAuth ─────────────────────────────────────
  console.log('[登入] 點擊 LINE 登入...');

  // 先取出 href，再直接導航（避免 target="_blank" 開新分頁被遺漏）
  const lineHref = await lineBtn.getAttribute('href');
  console.log('[登入] LINE href:', lineHref);

  let linePage;
  if (lineHref && (lineHref.startsWith('http') || lineHref.startsWith('//'))) {
    // 直接在同一個 page 導航到 LINE OAuth URL
    await page.goto(lineHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
    linePage = page;
  } else {
    // href 是相對路徑，用點擊 + 等待新 page 的方式
    const newPagePromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await lineBtn.click({ force: true });
    const newPage = await newPagePromise;
    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded');
      linePage = newPage;
    } else {
      // 等待原 page 導航
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      linePage = page;
    }
  }

  // LINE OAuth 頁面需要時間渲染輸入欄位
  await linePage.waitForTimeout(3000);
  console.log('[登入] LINE 頁面 URL:', linePage.url());
  await linePage.screenshot({ path: path.join(__dirname, 'debug-line-page.png') });

  // 確認是否真的到了 LINE 的頁面
  if (!linePage.url().includes('line.me') && !linePage.url().includes('access.line')) {
    await linePage.screenshot({ path: path.join(__dirname, 'debug-not-line.png') });
    throw new Error(`[登入] 未能導航到 LINE 登入頁，目前 URL：${linePage.url()}`);
  }

  // ── 填入 LINE 帳號密碼 ────────────────────────────────────────────────────
  // LINE 登入頁的 email 欄位可能是 tid / email / 電話
  const emailSelectors = [
    'input[name="tid"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[placeholder*="Email"]',
    'input[placeholder*="email"]',
    'input[placeholder*="電話"]',
    'input:not([type="password"]):not([type="hidden"])',
  ];

  let emailInput = null;
  for (const sel of emailSelectors) {
    emailInput = await linePage.$(sel);
    if (emailInput) {
      console.log(`[登入] 找到 email 欄位：${sel}`);
      break;
    }
  }

  if (!emailInput) {
    await linePage.screenshot({ path: path.join(__dirname, 'debug-no-email.png') });
    throw new Error('[登入] 找不到 email 輸入欄，已截圖至 debug-no-email.png');
  }

  // LINE 頁面有時輸入欄被覆蓋，用 force + dispatchEvent 確保輸入
  await emailInput.scrollIntoViewIfNeeded();
  await emailInput.click({ force: true, timeout: 10000 });
  await linePage.waitForTimeout(500);
  await emailInput.fill(email);

  // 密碼
  const pwInput = await linePage.$('input[type="password"]');
  if (!pwInput) {
    await linePage.screenshot({ path: path.join(__dirname, 'debug-no-pw.png') });
    throw new Error('[登入] 找不到密碼輸入欄');
  }
  await pwInput.scrollIntoViewIfNeeded();
  await pwInput.click({ force: true, timeout: 10000 });
  await linePage.waitForTimeout(500);
  await pwInput.fill(password);

  await linePage.screenshot({ path: path.join(__dirname, 'debug-before-submit.png') });

  // ── 送出表單 ──────────────────────────────────────────────────────────────
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("登入")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    '[class*="login-btn"]',
    '[class*="submit"]',
  ];

  let submitBtn = null;
  for (const sel of submitSelectors) {
    submitBtn = await linePage.$(sel);
    if (submitBtn) {
      console.log(`[登入] 找到送出按鈕：${sel}`);
      break;
    }
  }

  if (!submitBtn) {
    await linePage.screenshot({ path: path.join(__dirname, 'debug-no-submit.png') });
    throw new Error('[登入] 找不到送出按鈕');
  }

  console.log('[登入] 送出 LINE 登入...');
  await submitBtn.click();
  await linePage.waitForTimeout(4000);
  console.log('[登入] 送出後 URL:', linePage.url());
  await linePage.screenshot({ path: path.join(__dirname, 'debug-after-submit.png') });

  // ── 處理 LINE 授權/同意頁（若出現）──────────────────────────────────────
  const agreeSelectors = [
    'button:has-text("同意")',
    'button:has-text("Agree")',
    'button:has-text("允許")',
    'button[name="action"][value="allow"]',
    '[class*="agree"]',
    '[class*="allow"]',
  ];
  for (const sel of agreeSelectors) {
    const btn = await linePage.$(sel);
    if (btn) {
      console.log(`[登入] 點擊授權按鈕：${sel}`);
      await btn.click();
      await linePage.waitForTimeout(3000);
      break;
    }
  }

  // 如果是新分頁登入，等待原頁面更新
  if (linePage !== page) {
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  // ── 確認登入成功 ──────────────────────────────────────────────────────────
  const checkPage = linePage !== page ? page : linePage;
  await checkPage.screenshot({ path: path.join(__dirname, 'debug-final.png') });

  if (!(await isLoggedIn(checkPage))) {
    throw new Error('[登入] 登入失敗，請查看 debug-final.png。可能原因：密碼錯誤 / 需要手動驗證');
  }

  // 儲存 session
  await fs.ensureDir(path.dirname(SESSION_FILE));
  await context.storageState({ path: SESSION_FILE });
  console.log('[登入] 登入成功！Session 已儲存至', SESSION_FILE);

  return { browser, context, page: checkPage };
}

/**
 * 判斷目前頁面是否已登入
 * scantrader 未登入時，header 右側顯示「登入」文字連結
 */
async function isLoggedIn(page) {
  try {
    const text = await page.textContent('body', { timeout: 3000 });
    // 未登入時會有這些文字
    const notLoggedInMarkers = ['你尚未登入', '立即登入', '請記得登入'];
    const hasNotLoggedIn = notLoggedInMarkers.some((m) => text.includes(m));

    // 已登入時 header 右側沒有「登入」獨立連結（而是顯示頭像）
    const loginLink = await page.$('a[href="/login"]:not([class*="btn"])');
    const headerLoginText = await page.$('header .login, nav a:has-text("登入"), [class*="header"] a:has-text("登入")');

    if (hasNotLoggedIn) return false;
    if (loginLink || headerLoginText) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { login, isLoggedIn };
