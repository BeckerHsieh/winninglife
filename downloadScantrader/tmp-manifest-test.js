const axios = require('axios');
const url = 'https://cdn.jwplayer.com/manifests/gLtu4uZd.m3u8?exp=1782652800&sig=4ef903b9b3460a912275c29ffd1b8bf2';
axios.get(url, {
  timeout: 20000,
  headers: {
    referer: 'https://scantrader.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  }
}).then((r) => {
  console.log('status', r.status);
  console.log('ct', r.headers['content-type']);
  console.log(String(r.data).slice(0, 300));
}).catch((e) => {
  console.log('ERR', e.message);
  if (e.response) {
    console.log('status', e.response.status);
    console.log(String(e.response.data).slice(0, 300));
  }
});
