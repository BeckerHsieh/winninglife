//  https://nodejs.org/en/download/prebuilt-installer
//  https://github.com/yagop/node-telegram-bot-api
// https://medium.com/jason-tech-lab/node-js%E7%B3%BB%E5%88%97-5%E5%80%8B%E6%96%B9%E6%B3%95%E7%94%A2%E7%94%9F%E9%9D%9E%E5%90%8C%E6%AD%A5http-%E8%AB%8B%E6%B1%82-52d5b5aca0f9

//   - node --version
//   - npm init -y
//   - npm i axios
//   - npm i node-cron
//   - npm i node-telegram-bot-api --save
//   - npm install request --save
//   - npm install --save node-telegram-bot-api
//   - node mc-telegram-notify.js

//https://api.telegram.org/bot7953576077:AAH1xDtge6eagswjmrn1nlxOeGGmriphxIE/sendMessage?chat_id=1066311188&text=1111

var TelegramBot = require('node-telegram-bot-api');
var token = '7953576077:AAH1xDtge6eagswjmrn1nlxOeGGmriphxIE';
var myChatId = '1066311188';
//括號裡面的內容需要改為在第5步獲得的Token
var bot = new TelegramBot(token, {polling: true});
//使用Long Polling的方式與Telegram伺服器建立連線


  // https://medium.com/jason-tech-lab/node-js%E7%B3%BB%E5%88%97-5%E5%80%8B%E6%96%B9%E6%B3%95%E7%94%A2%E7%94%9F%E9%9D%9E%E5%90%8C%E6%AD%A5http-%E8%AB%8B%E6%B1%82-52d5b5aca0f9
//   - npm init -y
//   - npm i axios
//   - npm i node-cron
//   - node mc-line-notify.js

const fs = require("fs");
const cron = require("node-cron");
const axios = require("axios");

const events = require("events");
const readline = require("readline");
const mcPath = "c:/mc/";
const fileLocation = mcPath + "mc_notice.txt";
// const dealNames = ["MXF-1hr", "MXF-18"];
// 依 MC_wsp 實際使用中的 workspace 分組；total 只加總 MXF 群組
const dealGroups = [
  { title: "MXF", showTotal: true,  names: ["MXF", "MXF-1", "MXF-18", "MXF-18-2", "MXF-1hr-2", "MXF-1hr-3", "MXF-1hr-KD"] },
  { title: "",    showTotal: false, names: ["CYF", "IRF", "OWF"] },
];
const FormData = require("form-data");
let latestTicket = "";
let latestDeal = "";

let oldTicket = "";
let oldDeal = "";
let dealCntMap = new Map();
let dealCnt = 0;

const url = "https://notify-api.line.me/api/notify";

//收到Start訊息時會觸發這段程式
// bot.onText(/start/, function (msg) {
//     var chatId = msg.chat.id; //用戶的ID
//     console.log(chatId)
//     var resp = '!!!  u are winning'; //括號裡面的為回應內容，可以隨意更改
//     bot.sendMessage(chatId, resp); //發送訊息的function
// });
 
//   bot.on('message', (msg) => {
//     const chatId = msg.chat.id;
//     console.log(chatId)
//     bot.sendMessage(chatId, 'Hello World');
//   });

  bot.sendMessage(myChatId, 'start telegram notice');
 

// https://www.npmjs.com/package/node-cron
//  # ┌────────────── second (optional)
//  # │ ┌──────────── minute
//  # │ │ ┌────────── hour
//  # │ │ │ ┌──────── day of month
//  # │ │ │ │ ┌────── month
//  # │ │ │ │ │ ┌──── day of week
//  # │ │ │ │ │ │
//  # │ │ │ │ │ │
//  # * * * * * *
// every 3 second '*/3 * * * * *'
cron.schedule("*/20 * * * * *", () => {
  console.log(new Date());

  // check ticket
  readTicket();
  noticeToLine();

  // check deal
  dealCount();
  noticeDealToLine();

  // check memory
  memoryUsage();
});

function dealCount() {
  dealCnt = 0;
  let currentDeal = "";
  dealGroups.forEach(function (group) {
    let groupCnt = 0;
    group.names.forEach(function (name) {
      const dealValue = readDeals(name);
      if (dealValue === null) {
        currentDeal += `\n ${name} : 無資料 (缺 mc_${name}.txt)`;
        return;
      }
      dealCntMap.set(name, dealValue);
      groupCnt += parseInt(dealValue.split("=")[1]) || 0;
      currentDeal += `\n ${name} : ${dealValue} `;
    });
    if (group.showTotal) {
      currentDeal += `\n ---------------${group.title} total : ${groupCnt}  ---------------`;
      dealCnt += groupCnt;
    }
  });
  console.log(`${currentDeal} `);
  latestDeal = currentDeal;
}

// 只讀檔尾，回傳最後一筆的 "MP=   x.xx"；檔案不存在或無資料回傳 null
function readDeals(fileName) {
  const filePath = mcPath + "mc_" + fileName + ".txt";
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;
    const parseDatas = lines[lines.length - 1].split(",");
    return parseDatas[2] !== undefined ? parseDatas[2] : null;
  } catch (err) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readTicket() {
  const rl = readline.createInterface({
    input: fs.createReadStream(fileLocation),
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
  // console.log(`Ticket~~~~~ : ${line} ----------------`);
    latestTicket = line;
  });
  // rl.on("close", () => {
  //   // memoryUsage();
  //   // TODO send to line
  //   // noticeToLine();
  // });
  // events.once(rl, "close");
}

function memoryUsage() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(
    `The script uses approximately ${Math.round(used * 100) / 100} MB`
  );
  console.log("~~~~~~~~~~~latestTicket=" + latestTicket);
}

function noticeDealToLine() {
  if (oldDeal != latestDeal) {
    bot.sendMessage(myChatId, latestDeal);

    oldDeal = latestDeal;
  }
}

function noticeToLine() {
  if (oldTicket != latestTicket) {
    bot.sendMessage(myChatId, latestTicket + " * " +  dealCnt);

    oldTicket = latestTicket;
  }
}
