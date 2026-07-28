const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const sessionPath = './downloadScantrader/.session/state.json';
  const storageState = fs.existsSync(sessionPath) ? sessionPath : undefined;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  console.log('Navigating to article...');
  await page.goto('https://scantrader.com/article/019f934b241200003cdd63000000000000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  
  const content = await page.content();
  const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s"'<>]+)/gi;
  const matches = content.match(ytRegex) || [];
  const uniqueUrls = Array.from(new Set(matches));
  
  console.log('Page Title:', await page.title());
  console.log('Found YouTube URLs count:', uniqueUrls.length);
  console.log('YouTube URLs:', uniqueUrls);

  // Also check if there are any iframe src or hrefs pointing to YouTube or videos
  const links = await page.$$eval('a', anchors => anchors.map(a => a.href));
  const iframes = await page.$$eval('iframe', frames => frames.map(f => f.src));
  console.log('All iframe sources:', iframes);
  console.log('All YouTube links in A tags:', links.filter(l => l.includes('youtube') || l.includes('youtu.be')));

  await browser.close();
})();
