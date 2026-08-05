/**
 * yt-stream-capture.js
 * 使用 Playwright 注入 cookies，從 ytInitialPlayerResponse 解析串流 URL 後下載
 * Usage: node yt-stream-capture.js <youtube_url>
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs-extra");
const { execFile, execSync, spawn } = require("child_process");

const COOKIES_FILE = path.join(__dirname, ".session", "yt-cookies.txt");
const OUTPUT_DIR = path.join(__dirname, "downloads");

const urlArg = process.argv[2];
if (!urlArg) { console.error("Usage: node yt-stream-capture.js <youtube_url>"); process.exit(1); }

function parseNetscapeCookies(filepath) {
  const lines = fs.readFileSync(filepath, "utf8").split(/\r?\n/);
  const cookies = [];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domainRaw, includeSubdomains, cookiePath, secure, expires, name, ...rest] = parts;
    const value = rest.join("\t").trim();
    const domain = domainRaw.trim().startsWith(".") ? domainRaw.trim() : "." + domainRaw.trim();
    if (!name || !name.trim()) continue;
    const exp = parseInt(expires);
    cookies.push({
      name: name.trim(),
      value: value,
      domain: domain,
      path: cookiePath || "/",
      secure: secure === "TRUE",
      httpOnly: false,
      sameSite: "None",
      ...(exp > 0 ? { expires: exp } : {}),
    });
  }
  return cookies;
}

function findFfmpeg() {
  try { const p = require("ffmpeg-static"); if (p && fs.existsSync(p)) return p; } catch {}
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return "ffmpeg"; } catch {}
  return null;
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    console.log("[ffmpeg] " + ffmpegPath + " " + args.join(" ").slice(0, 120));
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (s.includes("time=") || s.includes("speed=")) process.stdout.write("\r" + s.trim().slice(0, 100));
    });
    proc.on("close", (code) => {
      process.stdout.write("\n");
      if (code === 0) resolve(); else reject(new Error("ffmpeg exit " + code));
    });
  });
}

function pickBestFormat(formats, mimeType) {
  const filtered = formats.filter(f =>
    f.mimeType && f.mimeType.startsWith(mimeType) && f.url
  );
  filtered.sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  return filtered[0] || null;
}

(async () => {
  await fs.ensureDir(OUTPUT_DIR);

  if (!fs.existsSync(COOKIES_FILE)) {
    console.error("[Error] Cookies file not found: " + COOKIES_FILE);
    process.exit(1);
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { console.error("[Error] ffmpeg not found"); process.exit(1); }

  const cookies = parseNetscapeCookies(COOKIES_FILE);
  console.log("[Cookies] Loaded " + cookies.length + " cookies");

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    locale: "zh-TW",
    extraHTTPHeaders: { "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7" },
  });

  try {
    await context.addCookies(cookies);
    console.log("[Playwright] Cookies injected");
  } catch (e) {
    console.warn("[Warning] Some cookies failed: " + e.message);
  }

  const page = await context.newPage();

  // 移除 Playwright 偵測痕跡
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  console.log("[Playwright] Loading: " + urlArg);
  await page.goto(urlArg, { waitUntil: "domcontentloaded", timeout: 30000 });

  // 等待頁面 JS 執行
  await page.waitForTimeout(3000);

  // 從頁面原始碼取得 ytInitialPlayerResponse
  const playerData = await page.evaluate(() => {
    try {
      if (typeof ytInitialPlayerResponse !== "undefined") return ytInitialPlayerResponse;
    } catch {}
    // fallback: parse from page source
    const match = document.documentElement.innerHTML.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|window|<\/script>)/s);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
    return null;
  });

  await browser.close();

  if (!playerData) {
    console.error("[Error] Could not find ytInitialPlayerResponse. Cookie may be invalid or video requires login.");
    process.exit(1);
  }

  const status = playerData.playabilityStatus;
  console.log("[YouTube] Playability: " + (status && status.status));
  if (status && status.status !== "OK") {
    console.error("[Error] Video not playable: " + (status.reason || status.status));
    process.exit(1);
  }

  const streamingData = playerData.streamingData;
  if (!streamingData) {
    console.error("[Error] No streamingData in player response");
    process.exit(1);
  }

  const allFormats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptiveFormats || []),
  ];

  console.log("[YouTube] Available formats: " + allFormats.length);

  // 先找影片標題
  const title = (playerData.videoDetails && playerData.videoDetails.title) || "video";
  const videoId = (playerData.videoDetails && playerData.videoDetails.videoId) || "unknown";
  const safeTitle = title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 80);

  // 嘗試找到合併格式（video+audio）
  const combined = allFormats.filter(f => f.mimeType && f.mimeType.startsWith("video/") && f.url && f.audioQuality);
  combined.sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

  let videoUrl, audioUrl, outputPath;

  if (combined.length > 0) {
    videoUrl = combined[0].url;
    outputPath = path.join(OUTPUT_DIR, safeTitle + ".mp4");
    console.log("[Format] Using combined format: " + combined[0].mimeType + " " + combined[0].quality);
    await runFfmpeg(ffmpeg, ["-y", "-i", videoUrl, "-c", "copy", outputPath]);
  } else {
    // 分離格式：分別下載 video 和 audio 再合併
    const bestVideo = pickBestFormat(allFormats, "video/");
    const bestAudio = pickBestFormat(allFormats, "audio/");

    if (!bestVideo && !bestAudio) {
      console.error("[Error] No downloadable formats found");
      process.exit(1);
    }

    outputPath = path.join(OUTPUT_DIR, safeTitle + ".mp4");
    console.log("[Format] Video: " + (bestVideo && bestVideo.mimeType) + " | Audio: " + (bestAudio && bestAudio.mimeType));

    const args = ["-y"];
    if (bestVideo) args.push("-i", bestVideo.url);
    if (bestAudio) args.push("-i", bestAudio.url);
    if (bestVideo && bestAudio) { args.push("-c:v", "copy", "-c:a", "aac"); }
    else { args.push("-c", "copy"); }
    args.push(outputPath);

    await runFfmpeg(ffmpeg, args);
  }

  console.log("[Done] Saved: " + outputPath);
})();