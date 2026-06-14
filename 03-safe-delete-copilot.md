# AI 誤刪怎麼辦？Copilot CLI 安全三件套：垃圾桶 + 危險指令黑名單 + 權限模式自己選

> ⭐ 初學者友善｜10 分鐘｜Windows（macOS/Linux 見底部說明）

## 你可能遇過這三個問題

用 Copilot CLI 寫程式、整理檔案、架網站很爽，但心裡總有三個不安：

1. **「AI 會不會把我的檔案刪掉？」** — AI 在 Windows 執行 `Remove-Item` 或 `del` 是永久刪除，不進資源回收桶。一個打錯字、一個路徑多打空格，就沒了。
2. **「AI 會不會跑出很危險的指令？」** — 像 `git reset --hard` 把你沒 commit 的改動全清空、`git push --force` 覆寫遠端、`rmdir /s /q` 整個資料夾刪掉。你根本看不懂它在做什麼。
3. **「每次都跳確認框好煩，可是我又不敢全關掉…」** — 關掉怕失控、不關又很煩躁。到底該怎麼設？

這份文件一次幫你解決這三個問題。裝完以後，你可以放心讓 AI 做事，因為底層有三層安全網接著。

## 裝完之後你會得到三層安全網

- **第一層：刪除改成移到資源回收桶** — AI 誤刪的檔案全部可還原，從資源回收桶撈回來就好
- **第二層：最嚴重的危險指令直接被擋** — 像遞迴刪除、`sudo`、`dd`、`git reset --hard`、`git push --force`、`shutdown` 這類「一執行就回不來」的指令，Copilot CLI 連問都不會問，直接拒絕執行
- **第三層：權限模式你自己選** — 由 AI 引導你在 3 種模式裡挑一個，說清楚每個模式的差別與適合誰。選完直接告訴你怎麼切換

**結果：你不用再每次提心吊膽，也不用為了怕煩就把所有護欄都關掉。** 把底層的底線守住，上層的自由度才能放大。

## 怎麼裝？

把這份文件丟給 Copilot CLI，跟它說：

> 照這份文件幫我設定 Copilot CLI 的安全三件套

AI 會按順序幫你做三件事：裝垃圾桶 → 加指令黑名單 → 問你要哪種權限模式。全部只要 10 分鐘。

---

<!-- 以下是給 Copilot CLI 讀的安裝指令 -->

## 安裝指令（AI 執行區）

> **🤖 AI 互動規範（給 Copilot CLI 的指引）**
>
> 執行此設定檔時，請遵守以下原則：
>
> 1. **需要個人化資訊時，用 `ask_user` 工具跳出互動框**：不要猜測用戶的路徑、偏好、或選擇。例如：專案目錄、權限模式偏好。
> 2. **偵測到既有配置時，先確認再行動**：如果發現用戶已有相關設定（例如 alias、PowerShell Profile、copilot-instructions.md），用 `ask_user` 說明現狀，讓用戶決定要覆蓋、跳過、還是合併。
> 3. **安裝完成後，用白話文條列總結**：列出你做了什麼、改了哪些檔案、怎麼驗證成功。讓非工程師用戶也能看懂、放心。

> **給 Copilot CLI 的總覽**：這份文件要你幫用戶裝三層安全網。請**按順序**執行 Section A → B → C → D，完成每一節後再進下一節。全程用繁體中文跟用戶互動，語氣親切、不要用太多技術術語。

---

## Section A：垃圾桶保護（刪除 → 資源回收桶）

這一節把刪除指令改成移到資源回收桶，讓誤刪可還原。

### A-1. 安裝 Recycle 模組

開啟 PowerShell（以一般使用者身份執行），執行：

```powershell
Install-Module -Name Recycle -Scope CurrentUser -Force
```

如果出現「執行原則」錯誤，先執行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### A-2. 確認 PowerShell Profile 路徑

```powershell
$PROFILE
# 通常是 C:\Users\<使用者名稱>\Documents\PowerShell\Microsoft.PowerShell_profile.ps1
```

如果 Profile 檔案不存在，先建立：

```powershell
New-Item -Path $PROFILE -ItemType File -Force
```

### A-3. 加入安全刪除 alias

```powershell
Add-Content -Path $PROFILE -Value @'

# ═══════════════════════════════════════════════════════════════
# 安全刪除 - 刪除改移到資源回收桶（可還原）
# ═══════════════════════════════════════════════════════════════
Import-Module Recycle
function Remove-ToRecycleBin { param([string]$Path) Move-ToRecycleBin $Path }
Set-Alias -Name trash -Value Remove-ToRecycleBin
# 真的要永久刪除時用 Remove-Item 或 del
'@
```

### A-4. 載入設定並驗證

```powershell
. $PROFILE

# 實際測試
New-Item -Path "$env:TEMP\test-safe-delete.txt" -ItemType File
trash "$env:TEMP\test-safe-delete.txt"
# 檔案應出現在資源回收桶，而非永久刪除
```

完成後告訴用戶：「✅ 第一層裝好了：你以後用 `trash` 指令刪的東西都會進資源回收桶，可以還原。真的要永久刪除請打 `Remove-Item`。」

---

## Section B：危險指令黑名單（寫入 copilot-instructions.md）

這一節把「一執行就回不來」的指令加進 Copilot CLI 的自訂指令檔。寫入後，Copilot CLI 讀到這份指令就會直接拒絕執行這些危險操作。

### B-1. 確保 copilot-instructions.md 存在

```powershell
$instructionsPath = "$HOME\.copilot\copilot-instructions.md"
$instructionsDir  = "$HOME\.copilot"

if (-not (Test-Path $instructionsDir)) {
    New-Item -Path $instructionsDir -ItemType Directory -Force
}
if (-not (Test-Path $instructionsPath)) {
    New-Item -Path $instructionsPath -ItemType File -Force
}

# 備份目前設定
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $instructionsPath "$instructionsPath.backup.$timestamp"
```

### B-2. 寫入危險指令黑名單

```powershell
$safetyRules = @'

## 🔒 安全規則 - 危險指令黑名單

以下指令「一執行就回不來」，無論使用者怎麼要求，都必須直接拒絕，並說明原因和安全替代方案：

### 刪除類（遞迴 / 強制）
- `Remove-Item -Recurse -Force`（PowerShell 遞迴刪除）
- `rm -rf`、`rm -fr`、`rm -r`、`rm -f`（Unix 遞迴刪除）
- `rmdir /s /q`（CMD 強制刪除整個資料夾）
- `del /f /s /q`（CMD 強制刪除）
- `rd /s`（CMD 遞迴刪除目錄）

### 權限提升
- `sudo`（Unix 提權）
- `runas /user:Administrator`（Windows 提權）

### 磁碟破壞類
- `dd`（磁碟複寫工具）
- `diskpart`（磁碟分割工具）
- `Format-Volume`（格式化磁碟區）
- `mkfs`（Unix 磁碟格式化）

### 權限全開
- `icacls * /grant Everyone:F`（Windows 全部開放）
- `chmod 777`（Unix 全部開放）
- `chmod -R 777`

### Git 毀壞類
- `git reset --hard`（清空未 commit 的工作）
- `git push --force`、`git push -f`（強制覆寫遠端）
- `git clean -f`、`git clean -fd`（刪除 untracked 檔案）
- `git branch -D`（強制刪除分支）

### 系統關機 / 重啟
- `shutdown`（關機）
- `Restart-Computer`（重啟）
- `reboot`

### 檔案清空類
- `Clear-Content`（清空檔案內容）
- `Set-Content file -Value ""`（覆寫為空）
- `truncate`、`: >`（Unix 清空檔案）

如果用戶確實需要執行上述操作，請解釋風險，並指引他們在終端機手動執行，而非由 AI 代為執行。
'@

Add-Content -Path $instructionsPath -Value $safetyRules
```

### B-3. 驗證

```powershell
Get-Content $instructionsPath
# 應該看到剛才寫入的黑名單規則
```

### B-4. 告訴用戶裝了什麼（用白話翻譯）

完成後**用親切的語氣**告訴用戶：

> ✅ 第二層裝好了！我幫你把以下這些「危險操作」加到 Copilot CLI 的指令規則，之後 AI 會連問都不問直接拒絕：
>
> 1. **刪除類** — 各種遞迴強制刪除（Windows 和 Unix 指令全部擋）
> 2. **權限提升** — `sudo`、`runas Administrator`（AI 不應該用提權指令）
> 3. **砸硬碟類** — `dd`、`diskpart`、磁碟格式化（格式化磁碟機、清空磁區）
> 4. **權限全開** — `chmod 777`、`icacls Everyone:F`（是安全漏洞）
> 5. **Git 毀壞類** — `git reset --hard`、`git push --force`、`git clean -f`（會清空沒存的工作）
> 6. **系統關機** — `shutdown`、`Restart-Computer`（AI 沒理由關你電腦）
> 7. **檔案清空** — `truncate`、`Clear-Content`（瞬間清空檔案內容）
>
> 這些都是「一執行就回不來」的指令，看不懂沒關係，反正你也不太會需要讓 AI 執行它們。

---

## Section C：權限模式互動式選擇（核心步驟）

**重要指示給 Copilot CLI**：接下來你必須使用 `ask_user` 工具跳出**互動式選項框**讓用戶選擇，**不要**用純文字列出選項問用戶「你要選哪個」，新手不知道要回什麼。

### C-1. 用 ask_user 跳出選單

使用 `ask_user` 工具，問題與選項如下：

- **question**：`Copilot CLI 的「權限模式」決定 AI 每次做事前會不會先問過你。你希望它有多主動？（放心，前面裝的垃圾桶和黑名單會一直在底下保護你，不管你選哪個模式，最嚴重的指令都不會被執行）`
- **choices**：
  - `Interactive（推薦）` — 一般互動模式，改程式碼會直接做，跑終端機指令會問你一次。速度快、關鍵時刻有煞車。適合 90% 的新手。
  - `Plan（先規劃）` — AI 先擬出完整計劃讓你看，你確認後才動手。適合要做大改造、想先看全貌。你也可以隨時用 `/plan` 指令臨時切到這個模式。
  - `Autopilot（全自動）` — AI 什麼都不問直接執行。速度最快，但信任門檻高。這個選項有額外的確認步驟。

### C-2. 根據用戶選擇執行對應動作

**如果用戶選 Interactive**（最常見）：

告訴用戶：
> ✅ 選好了！模式是 Interactive。
>
> Copilot CLI 預設就是這個模式。你不需要改任何設定。
>
> **怎麼運作**：AI 寫程式、改檔案會直接做，但要執行 Shell 指令（裝套件、刪東西、呼叫 API）時會先問你一次，確認後才執行。
>
> **如果想臨時換模式**：在對話中按 `Shift+Tab` 可以在 Interactive / Plan / Autopilot 之間切換，不影響預設設定。

---

**如果用戶選 Plan**：

告訴用戶：
> ✅ 選好了！預計以 Plan 模式為主要工作方式。
>
> **怎麼切換**：輸入 `/plan` 指令，或在對話中按 `Shift+Tab` 切到 Plan 模式。
>
> **怎麼運作**：AI 先產出計劃，你看完按確認才開始執行。適合大型任務、架構調整、重構。小任務的話可以按 `Shift+Tab` 切回 Interactive 比較不煩。
>
> **提醒**：Plan 模式是「按需切入」，你不需要把它設為預設。遇到大任務就用 `/plan` 呼叫，平時維持 Interactive 就好。

---

**如果用戶選 Autopilot** → **必須再問一次**（用不同說法，不是嚇人，是讓他理解）：

請**再次**使用 `ask_user` 工具：

- **question**：`再跟你確認一次：選 Autopilot 的話，AI 除了黑名單裡那些指令之外，其他都會自己判斷直接執行，不會再跳任何確認框。前面裝的垃圾桶 + 黑名單會幫你擋住最嚴重的事情，但 AI 在它們範圍外做的每一個動作（改檔案、裝套件、送 API 請求…）你都不會事先看到。你還是要選這個嗎？`
- **choices**：
  - `確定，我要 Autopilot` — 我理解風險，我想要最大化效率。
  - `還是改成 Interactive 好了` — 我再想想，先用安全一點的模式。

**如果用戶二次確認還是選 Autopilot**：

告訴用戶：
> ✅ 好的，你選了 Autopilot。
>
> **怎麼切換**：輸入 `/autopilot` 指令開啟，或在對話中按 `Shift+Tab` 切到 Autopilot 模式。
>
> **記得**：前面的黑名單會一直守著，但其他操作 AI 會自己決定。如果之後覺得太野，隨時按 `Shift+Tab` 切回 Interactive。

**如果用戶二次確認選了 Interactive**：

用前面 Interactive 的說明和話術回應用戶。

---

## Section D：完成後的總結說明

三層都裝好後，請給用戶一個清楚的總結：

> 🎉 **安全三件套全部裝好了！**
>
> **目前你的狀態：**
> - ✅ 第一層：`trash` 指令 → 資源回收桶（誤刪可還原）
> - ✅ 第二層：危險指令黑名單（寫入 `~/.copilot/copilot-instructions.md`，最嚴重的 AI 碰不到）
> - ✅ 第三層：權限模式 = **[用戶選的模式]**
>
> **最後兩件事你要知道：**
>
> 1. **請重新開一個 Copilot CLI 對話**，`copilot-instructions.md` 的黑名單才會生效。現在這個對話已有讀入，但重開才確保乾淨狀態。
>
> 2. **模式怎麼切換？** 隨時在對話中按 `Shift+Tab` 可以在 Interactive / Plan / Autopilot 之間輪切。也可以用 `/autopilot` 指令直接切換 Autopilot，或用 `/plan` 切到計劃模式。你不需要記任何設定檔路徑，切換非常直覺。
>
> 有問題隨時可以打開 `%USERPROFILE%\.copilot\copilot-instructions.md` 自己改，或是叫 Copilot CLI 幫你改。如果改壞了，備份檔在同一個目錄的 `.backup.*` 檔案。

---

## 踩坑紀錄（給協作者看）

- **為什麼預設推薦 Interactive 不是 Plan？** 因為 Plan 模式每個動作都要先看計畫才能跑，小任務會覺得很卡。Interactive 是甜蜜點：程式操作不煩人，但真正危險的 Shell 指令還是會煞車。
- **為什麼黑名單用 copilot-instructions.md 而不是 JSON 設定檔？** Copilot CLI 目前沒有 `permissions.deny` 這樣的 JSON 欄位（不同於 Claude Code 的 `settings.json`）。自訂指令是最直接有效的替代方案，且可讀性高、容易維護。
- **為什麼黑名單裡要放 `sudo` 和 `runas`？** 大多數情況下讓 AI 用提權指令操作系統是不必要的風險。真的遇到需要的時候，手動在終端機執行比較安全，不要讓 AI 幫你跑。
- **Autopilot 和 Interactive 的差別是什麼？** Interactive 模式 AI 在執行 Shell 指令前會確認；Autopilot 模式 AI 會直接執行（黑名單以外的指令），不需要用戶確認。

### 常見問題

**Q：會影響 Copilot CLI 的正常操作嗎？**
不會。黑名單只擋「一執行就回不來」的指令，正常開發（讀寫程式碼、執行測試、安裝依賴）完全不會被影響。

**Q：macOS / Linux 怎麼辦？**
Section A 改用 `brew install trash`（macOS）或 `apt install trash-cli`（Ubuntu），alias 加進 `~/.zshrc` 或 `~/.bashrc`。Section B 的 `copilot-instructions.md` 路徑改為 `~/.copilot/copilot-instructions.md`，PowerShell 指令換成對應的 shell 指令。Section C/D 完全一樣。

**Q：裝了以後我要改黑名單怎麼辦？**
直接編輯 `%USERPROFILE%\.copilot\copilot-instructions.md`，或叫 Copilot CLI 幫你改。備份檔在同目錄的 `.backup.*` 檔案。

**Q：`trash` 指令和 `Remove-Item` 有什麼差？**
`trash` 是我們設定的 alias，會呼叫 Recycle 模組把檔案移到資源回收桶，可以還原。`Remove-Item` 是 PowerShell 原生的永久刪除指令，刪了就沒了（不進回收桶）。

**Q：copilot-instructions.md 裡已經有其他規則，會衝突嗎？**
不會。Section B 的指令是 `Add-Content`（附加）而非覆蓋，你原有的規則會保留。黑名單只是額外新增的段落。

---

> 📖 更多 Copilot CLI 使用說明 → [GitHub Copilot 官方文件](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli)
