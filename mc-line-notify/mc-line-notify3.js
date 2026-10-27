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
const dealNames = ["MXF","MXF-S","MXF-18-S-KD", "MXF-18","MXF-18-Point", "MXF-18-2","MXF-1hr-2", "MXF-1hr-3", "MXF-1hr-KD","MXF-7-LR",];

const FormData = require("form-data");
let latestTicket = "";
let latestDeal = "";

let oldTicket = "";
let oldDeal = "";
let dealCntMap = new Map();
let dealCnt = 0;

const url = "https://notify-api.line.me/api/notify";

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
  dealNames.forEach(function myFunction(value, index, array) {
    readDeals(value);
  });
  dealCount();
  noticeDealToLine();

  // check memory
  memoryUsage();
});

function dealCount() {
  dealCnt = 0;
  let currentDeal = "";
  dealCntMap.forEach(function (dealValue, dealKey) {
    let lineDealCnts = dealValue.split("=");
    dealCnt += parseInt(lineDealCnts[1]);
    currentDeal += `\n ${dealKey} : ${dealValue} `;
  });
  currentDeal += ` --------------- total : ${dealCnt}  ---------------`;
  console.log(`${currentDeal} `);
  latestDeal = currentDeal;
}

function readDeals(fileName) {
  const rl = readline.createInterface({
    input: fs.createReadStream(mcPath + "mc_" + fileName + ".txt"),
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    // console.log(`deal~~~~~ : ${line} ----------------`);
    latestDeal = line;
    let parseDatas = latestDeal.split(",");
    dealCntMap.set(parseDatas[1], parseDatas[2]);
  });

  // events.once(rl, "close");
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
  // 設定 Request Header
  const headers = {
    "Content-Type": "multipart/form-data",
    Authorization: "Bearer nUmZOvv1lzcikxoGjHPzK3gvENLiwY4kxhQgwRd8fd1",
  };

  if (oldDeal != latestDeal) {
    // 建立 FormData 物件
    const formData = new FormData();
    formData.append("message", latestDeal);
    // 發送 Request
    axios
      .post(url, formData, { headers })
      .then((response) => {
        console.log(response.data);
      })
      .catch((error) => {
        console.error(error);
      });
    oldDeal = latestDeal;
  }
}

function noticeToLine() {
  // 設定 Request Header
  const headers = {
    "Content-Type": "multipart/form-data",
    Authorization: "Bearer GpWx2f9C5NG8UtlaKV61Az60lYRC9lysODX0jQYy1bF",
  };

  if (oldTicket != latestTicket) {
    // 建立 FormData 物件
    const formData = new FormData();
    formData.append("message",  latestTicket + " * " +  dealCnt);
    // 發送 Request
    axios
      .post(url, formData, { headers })
      .then((response) => {
        console.log(response.data);
      })
      .catch((error) => {
        console.error(error);
      });
    oldTicket = latestTicket;
  }
}
