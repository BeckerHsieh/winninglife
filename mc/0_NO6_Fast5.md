# 0_NO6_Fast5 / pExitWin 說明

## 1. `BarsSinceEntry = 0` 是什麼意思

這個條件表示：

- 這個部位剛剛才進場成功
- 目前正處在入場後的第一根 bar
- 也就是「剛成交，剛成立」的那個瞬間

對應程式：

```plaintext
If MarketPosition <> 0 and BarsSinceEntry = 0 then
    OwnPos = ConditionTime[1];
```

這代表：

- 只有在「剛進場」的那一刻，才去判斷這筆部位屬不屬於這個 signal
- 一旦過了這個瞬間，就不再重算 `OwnPos`

---

## 2. 為什麼要用 `ConditionTime[1]`

`ConditionTime` 表示現在這一根 bar 是否在 entry window 內；`[1]` 則是前一根 bar 的狀態。

這裡的邏輯是：

- 進場單是在前一根 bar 送出
- 但實際成交是在下一根 bar
- 所以要判斷「這筆部位是在哪一根 bar 送出的」，就要看 `ConditionTime[1]`

也就是：

> 如果進場前一根 bar 是在這個 signal 的 window 內，則這筆部位屬於這個 signal。

---

## 3. `pExitWin` 的用途

### `pExitWin = 0`

```plaintext
ExitOK = (pExitWin = 0) or OwnPos;
```

當 `pExitWin = 0` 時，`ExitOK` 永遠為 true，表示：

- 出場、停損、獲利目標都一直有效
- 所有 signal 都可以平倉

這是原始行為，會有問題：

- 同一張圖上如果開雙 signal
- 兩個 signal 共享同一個 `MarketPosition`
- 每個 signal 都可能送出自己的 exit / SL
- 最後造成 duplicate exit / duplicate SL fill

---

### `pExitWin = 1`

```plaintext
ExitOK = (pExitWin = 0) or OwnPos;
```

當 `pExitWin = 1` 時：

- 只有 `OwnPos = true` 才能出場
- 也就是只有「這筆部位是由本 signal 在自己的 window 內送出」的那個 signal，才會執行出場

這就是為了解決：

- 同圖多 signal 共用一張 chart
- 但各自時間窗不重疊
- 只讓真正開倉的 signal 負責平倉

---

## 4. 時間軸圖

```text
Bar T-1                Bar T                   Bar T+1
--------              ---------               -----------
送出 entry order       判斷/成交前置          真正成交
(條件成立)            仍是前一根 bar          MarketPosition <> 0
                      的 time window         BarsSinceEntry = 0

                         ↓
               讀取 ConditionTime[1]
                         ↓
      若前一根 bar 在本 signal window 內
                         ↓
                  OwnPos = true
                         ↓
                 這個 signal 可出場
```

---

## 5. 同圖雙 signal 時，誰會平倉 / 誰不會平倉

假設雙 signal 時間窗如下：

- Signal A：09:15 ~ 24:00
- Signal B：00:00 ~ 04:50

則判定如下：

| 進場情境 | Signal A 的 `ConditionTime[1]` | Signal B 的 `ConditionTime[1]` | 誰擁有 `OwnPos` | 誰會平倉 |
|---|---:|---:|---:|---|
| A 在 10:00 進場 | true | false | A = true, B = false | A 會平倉，B 不會 |
| B 在 01:30 進場 | false | true | A = false, B = true | B 會平倉，A 不會 |
| 兩 signal 都在同一時間窗內進場 | true | true | 兩者都可能 true | 兩者都可能送出 exit，會失去唯一 ownership |

---

## 6. 什麼時候適用 `pExitWin = 1`

適用條件：

- 同一張 chart 上，同時有多個 Fast5 / Fast6 signal
- 各 signal 的 entry window 非重疊
- 目的是避免 duplicate exit / SL / TP order

不適用條件：

- windows 重疊
- 你希望所有 signal 都能對同一筆倉位做出場
- 進場來源不屬於這個 signal

---

## 7. 一句話總結

`pExitWin` 的核心不是「進場條件」，而是「出場權屬」。

- `pExitWin = 0`：所有 signal 都能平倉
- `pExitWin = 1`：只有在本 signal 的 time window 內開倉的那筆部位，才允許本 signal 平倉

這就是為什麼在同圖多 signal 共用一張盤時，`pExitWin = 1` 能避免重複平倉。 
