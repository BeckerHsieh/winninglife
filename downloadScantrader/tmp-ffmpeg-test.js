const { execFile } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const out = 'tmp-single-test.mp4';
const url = 'https://cdn.jwplayer.com/manifests/gLtu4uZd.m3u8?exp=1782652800&sig=4ef903b9b3460a912275c29ffd1b8bf2';
const headers =
  'referer: https://scantrader.com/\r\n' +
  'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36\r\n' +
  'sec-ch-ua: "Chromium";v="149", "Not)A;Brand";v="24"\r\n' +
  'sec-ch-ua-mobile: ?0\r\n' +
  'sec-ch-ua-platform: "Windows"\r\n';
const args = ['-y', '-headers', headers, '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-i', url, '-c', 'copy', out];
execFile(ffmpeg, args, { timeout: 120000 }, (err, so, se) => {
  console.log('err', err ? err.message : 'none');
  console.log((se || '').slice(-1500));
});
