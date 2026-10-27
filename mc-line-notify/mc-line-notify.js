// https://medium.com/jason-tech-lab/node-js%E7%B3%BB%E5%88%97-5%E5%80%8B%E6%96%B9%E6%B3%95%E7%94%A2%E7%94%9F%E9%9D%9E%E5%90%8C%E6%AD%A5http-%E8%AB%8B%E6%B1%82-52d5b5aca0f9
//   - npm init -y
//   - npm i axios
//   - npm i node-cron
//   - node mc-line-notify.js

const fs = require("fs");
const cron = require("node-cron");
const axios = require("axios");

const fileLocation = "c:/mc_notice.txt";
const FormData = require("form-data");
let lastestData = "";

const url = "https://notify-api.line.me/api/notify";

// 設定 Request Header
const headers = {
  "Content-Type": "multipart/form-data",
  Authorization: "Bearer GpWx2f9C5NG8UtlaKV61Az60lYRC9lysODX0jQYy1bF",
};

// every 3 second '*/3 * * * * *'
cron.schedule("*/2 * * * * *", () => {
  // Use fs.readFile() method to read the file
  fs.readFile(fileLocation, "utf8", function (err, data) {
    // Display the file content
    if (lastestData != data) {
      console.log(new Date() + ":" + data);
      // 建立 FormData 物件
      const formData = new FormData();
      formData.append("message", data);

      // 發送 Request
      axios
        .post(url, formData, { headers })
        .then((response) => {
          console.log(response.data);
        })
        .catch((error) => {
          console.error(error);
        });
    }
    lastestData = data;
  });
});
