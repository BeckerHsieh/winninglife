"""
透過 pywinauto 模擬使用者操作 MultiCharts，開啟指定的工作區 (.wsp)。

流程：
1. attach 到已啟動的 MultiCharts；若未啟動則透過捷徑（或 --exe）啟動並等待主視窗
2. 送出 Ctrl+O 開啟工作區（未出現對話框則 fallback 為「檔案 → 開啟工作區」選單）
3. 在開啟檔案對話框輸入 .wsp 完整路徑並確認
4. 等待視窗標題出現工作區名稱
5. （選用）以「新增 → 訊號」將指定訊號套入目前圖表；已套用則略過
6. （選用）截圖存證

用法：
  python open_workspace.py
  python open_workspace.py --wsp "C:\\path\\to\\IRF.wsp" --screenshot out.png
  python open_workspace.py --signal 0_NO6_MACD_STOCK
  python open_workspace.py --exe "C:\\...\\MultiCharts64.exe" --timeout 120
"""

import argparse
import os
import re
import sys
import time

try:
    import win32con
    import win32gui
    from pywinauto import Application, Desktop
    from pywinauto.application import process_get_modules
    from pywinauto.findwindows import ElementNotFoundError
    from pywinauto.keyboard import send_keys
except ImportError:
    sys.exit("找不到 pywinauto，請先執行：pip install -r requirements.txt")

DEFAULT_WSP = r"C:\Users\MC12\Desktop\康和MultiCharts12\MC_wsp\IRF.wsp"
DEFAULT_SHORTCUTS = [
    r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Concord MultiCharts64.lnk",
    r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Concord MultiCharts64\Concord MultiCharts64.lnk",
]
MAIN_TITLE_RE = r".*MultiCharts.*"
# 券商版執行檔名稱會加前綴（例如康和版為 "Concord MultiCharts64.exe"），故以結尾比對
PROCESS_NAME_SUFFIX = "multicharts64.exe"


class PollTimeout(Exception):
    pass


def log(msg):
    print(f"[open_workspace] {msg}", flush=True)


def wait_until(timeout, interval, func):
    """反覆呼叫 func，直到回傳 truthy 值並回傳之；逾時拋出 PollTimeout。"""
    deadline = time.time() + timeout
    while True:
        result = func()
        if result:
            return result
        if time.time() >= deadline:
            raise PollTimeout()
        time.sleep(interval)


def mc_pids():
    """回傳所有 *MultiCharts64.exe 的 PID。"""
    return [pid for pid, path, _ in process_get_modules()
            if os.path.basename(path or "").lower().endswith(PROCESS_NAME_SUFFIX)]


def title_has_workspace(title, wsp_path):
    """視窗標題是否含工作區名稱（以單字邊界比對，避免 IRF 誤中 IRF1）。"""
    name = os.path.splitext(os.path.basename(wsp_path))[0]
    return re.search(rf"\b{re.escape(name)}\b", title, re.IGNORECASE) is not None


def find_main_window():
    """回傳 MultiCharts 主視窗 (UIA wrapper)，找不到則回傳 None。"""
    for pid in mc_pids():
        # 最小化的視窗在 UIA 視為不可見，需另外納入
        wins = [w for w in Desktop(backend="uia").windows(process=pid, title_re=MAIN_TITLE_RE, visible_only=False)
                if w.is_visible() or w.is_minimized()]
        if wins:
            # 同一程序可能有多個頂層視窗，取面積最大者為主視窗
            return max(wins, key=lambda w: w.rectangle().width() * w.rectangle().height())
    return None


def find_dialogs():
    """回傳 MultiCharts 程序底下目前可見的標準對話框 (#32770)。"""
    dlgs = []
    for pid in mc_pids():
        dlgs += Desktop(backend="win32").windows(process=pid, class_name="#32770", visible_only=True)
    return dlgs


def launch_multicharts(exe_path):
    if exe_path:
        if not os.path.isfile(exe_path):
            raise FileNotFoundError(f"指定的 MultiCharts 執行檔不存在：{exe_path}")
        log(f"啟動 MultiCharts：{exe_path}")
        Application(backend="uia").start(f'"{exe_path}"')
        return
    for lnk in DEFAULT_SHORTCUTS:
        if os.path.isfile(lnk):
            log(f"透過捷徑啟動 MultiCharts：{lnk}")
            os.startfile(lnk)
            return
    raise FileNotFoundError("找不到 MultiCharts 捷徑，請以 --exe 指定 MultiCharts64.exe 路徑")


def get_or_start_main_window(exe_path, timeout):
    win = find_main_window()
    if win:
        log(f"已 attach 到執行中的 MultiCharts：{win.window_text()}")
        if win.is_minimized():
            log("主視窗為最小化，先還原")
            # 以 SW_RESTORE 還原才會回到最小化前的狀態（例如最大化）；UIA 的 restore() 會變成一般視窗大小
            win32gui.ShowWindow(win.handle, win32con.SW_RESTORE)
            time.sleep(1)
        return win
    launch_multicharts(exe_path)
    log(f"等待 MultiCharts 主視窗出現（最多 {timeout} 秒，含登入/資料連線時間）...")
    try:
        return wait_until(timeout, 1, find_main_window)
    except PollTimeout:
        raise RuntimeError("等待 MultiCharts 主視窗逾時；若有登入視窗請先手動完成登入後重跑")


def open_file_dialog(main_win):
    """觸發「開啟工作區」對話框，回傳對話框 wrapper。"""
    def _find_dialog():
        dlgs = find_dialogs()
        return dlgs[0] if dlgs else None

    # 先送 Ctrl+O（開啟工作底稿）。鍵盤焦點可能停在下單匣等停駐視窗，
    # 按鍵不可打進下單區，故先把焦點移到圖表子視窗，再直接送鍵（不經 main_win.type_keys 以免焦點被移回）
    main_win.set_focus()
    charts = [c for c in main_win.descendants(control_type="Window") if c.class_name() == "ATL_MCMDIChildFrame"]
    if charts:
        charts[0].set_focus()
        send_keys("^o")
        log("已將焦點移至圖表並送出 Ctrl+O")
        try:
            return _log_dialog(wait_until(10, 0.5, _find_dialog))
        except PollTimeout:
            log("Ctrl+O 未開出對話框，改用選單「檔案 → 開啟工作底稿」")
    else:
        log("找不到圖表子視窗，不送快捷鍵，改用選單「檔案 → 開啟工作底稿」")

    click_menu(main_win, "檔案(F)", "開啟工作底稿")
    try:
        return _log_dialog(wait_until(10, 0.5, _find_dialog))
    except PollTimeout:
        raise RuntimeError("Ctrl+O 與選單皆未開出檔案對話框")


def _log_dialog(dlg):
    log(f"找到對話框：{dlg.window_text()!r}")
    return dlg


def fill_path_and_confirm(dlg, wsp_path):
    dlg.set_focus()
    edit = None
    # 標準 Common File Dialog 的檔名欄位為 control id 1148 的 Edit（位於 ComboBoxEx32 內）
    try:
        spec = Application(backend="win32").connect(handle=dlg.handle).window(handle=dlg.handle)
        for crit in ({"class_name": "Edit", "control_id": 1148}, {"class_name": "Edit"}):
            ctrl = spec.child_window(found_index=0, **crit)
            if ctrl.exists(timeout=2):
                edit = ctrl.wrapper_object()
                break
    except Exception as e:
        log(f"尋找檔名欄位時發生例外：{e}")

    if edit is not None:
        edit.set_edit_text(wsp_path)
        if edit.window_text() != wsp_path:
            raise RuntimeError(f"檔名欄位填入失敗，目前內容：{edit.window_text()!r}")
        log("已填入檔名欄位")
        dlg.type_keys("{ENTER}")
    else:
        # fallback：直接以 Alt+N 聚焦檔名欄位後鍵入
        log("找不到檔名欄位，改用 Alt+N 鍵盤輸入")
        dlg.type_keys("%n")
        dlg.type_keys(wsp_path, with_spaces=True)
        dlg.type_keys("{ENTER}")


def wait_workspace_loaded(wsp_path, timeout):
    name = os.path.splitext(os.path.basename(wsp_path))[0]

    def _loaded():
        # 對話框需已關閉，且主視窗標題包含工作區名稱
        if find_dialogs():
            return None
        win = find_main_window()
        return win if win and title_has_workspace(win.window_text(), wsp_path) else None

    try:
        win = wait_until(timeout, 1, _loaded)
        log(f"工作區已載入：{win.window_text()}")
        return win
    except PollTimeout:
        dlgs = find_dialogs()
        if dlgs:
            raise RuntimeError(f"仍有對話框未關閉（可能為錯誤訊息）：{dlgs[0].window_text()!r}")
        log(f"警告：{timeout} 秒內視窗標題未出現「{name}」，工作區可能已載入但標題格式不同，請目視確認")
        return find_main_window()


def dialog_spec(dlg):
    """將對話框 wrapper 轉為 win32 WindowSpecification，以便用 control_id 找子控制項。"""
    return Application(backend="win32").connect(handle=dlg.handle).window(handle=dlg.handle)


def wait_dialog(title, timeout=10):
    def _find():
        return next((d for d in find_dialogs() if d.window_text() == title), None)
    try:
        return wait_until(timeout, 0.5, _find)
    except PollTimeout:
        raise RuntimeError(f"{timeout} 秒內未出現「{title}」對話框")


def click_menu(main_win, top, item_prefix):
    """點選單列的 top（例如「新增(I)」），再點以 item_prefix 開頭的子項目。"""
    main_win.set_focus()
    tops = [c for c in main_win.descendants(control_type="MenuItem") if c.window_text() == top]
    if not tops:
        raise RuntimeError(f"找不到選單「{top}」")
    tops[0].click_input()

    def _popup_item():
        for pid in mc_pids():
            for m in Desktop(backend="uia").windows(process=pid, class_name="#32768"):
                for c in m.descendants(control_type="MenuItem"):
                    if c.window_text().startswith(item_prefix):
                        return c
        return None

    try:
        item = wait_until(5, 0.3, _popup_item)
    except PollTimeout:
        send_keys("{ESC}{ESC}")  # 關閉展開的選單
        raise RuntimeError(f"選單「{top}」中找不到「{item_prefix}」（可能有強制回應對話框擋住主視窗）")
    item.click_input()


# 「設定物件」對話框的控制項 ID
FORMAT_DLG_TITLE = "設定物件"
FORMAT_LIST_ID = 2080
# 「新增指標」對話框的控制項 ID
INSERT_DLG_TITLE = "新增指標"
INSERT_LIST_ID = 2138
ID_OK, ID_CLOSE = 1, 2


def applied_signals(main_win):
    """開啟「設定 → 訊號」讀取目前圖表已套用的訊號名稱，讀完即關閉對話框。"""
    click_menu(main_win, "設定(O)", "訊號")
    spec = dialog_spec(wait_dialog(FORMAT_DLG_TITLE))
    try:
        lv = spec.child_window(control_id=FORMAT_LIST_ID).wrapper_object()
        return [lv.get_item(i).text() for i in range(lv.item_count())]
    finally:
        spec.child_window(control_id=ID_CLOSE).click()
        time.sleep(1)


def insert_signal(main_win, signal):
    """以「新增 → 訊號」將 signal 套入目前圖表；已套用則略過。"""
    existing = applied_signals(main_win)
    if signal in existing:
        log(f"訊號 {signal} 已套用在圖表上，略過")
        return

    click_menu(main_win, "新增(I)", "訊號")
    spec = dialog_spec(wait_dialog(INSERT_DLG_TITLE))
    lv = spec.child_window(control_id=INSERT_LIST_ID).wrapper_object()
    try:
        item = lv.get_item(signal)
    except (ValueError, IndexError):
        spec.child_window(control_id=ID_CLOSE).click()
        raise RuntimeError(f"訊號清單中找不到 {signal}，請確認已在 PowerLanguage Editor 匯入並編譯")
    item.ensure_visible()
    item.select()
    time.sleep(0.5)
    spec.child_window(control_id=ID_OK).click()
    log(f"已選擇訊號並按確定：{signal}")

    # 對話框中「設定」有勾選時，確定後會開出「設定物件」對話框，按 Close 保留套用結果
    try:
        fmt = wait_dialog(FORMAT_DLG_TITLE, timeout=5)
        dialog_spec(fmt).child_window(control_id=ID_CLOSE).click()
        time.sleep(1)
    except RuntimeError:
        pass

    if signal not in applied_signals(main_win):
        raise RuntimeError(f"套入後於「設定物件」中找不到 {signal}")
    log(f"訊號已套入圖表：{signal}")


def main():
    parser = argparse.ArgumentParser(description="以 GUI 自動化在 MultiCharts 開啟工作區 (.wsp)")
    parser.add_argument("--wsp", default=DEFAULT_WSP, help="工作區檔案完整路徑")
    parser.add_argument("--exe", default=os.environ.get("MC_EXE"),
                        help="MultiCharts64.exe 路徑（未指定時使用開始選單捷徑；也可設環境變數 MC_EXE）")
    parser.add_argument("--timeout", type=int, default=90, help="等待 MultiCharts 啟動的秒數")
    parser.add_argument("--load-timeout", type=int, default=60, help="等待工作區載入的秒數")
    parser.add_argument("--screenshot", help="完成後將主視窗截圖存到此路徑 (.png)")
    parser.add_argument("--force", action="store_true", help="即使工作區已開啟仍重新執行開檔")
    parser.add_argument("--signal", help="開啟工作區後套入目前圖表的訊號名稱（例如 0_NO6_MACD_STOCK）")
    args = parser.parse_args()

    wsp_path = os.path.abspath(args.wsp)
    if not os.path.isfile(wsp_path):
        sys.exit(f"工作區檔案不存在：{wsp_path}")

    try:
        main_win = get_or_start_main_window(args.exe, args.timeout)
        if title_has_workspace(main_win.window_text(), wsp_path) and not args.force:
            # MultiCharts 啟動時會自動還原上次的工作區，已開啟就不重複開
            log("工作區已是開啟狀態，略過開檔（如需強制重開請加 --force）")
            win = main_win
        else:
            dlg = open_file_dialog(main_win)
            fill_path_and_confirm(dlg, wsp_path)
            win = wait_workspace_loaded(wsp_path, args.load_timeout)
        if args.signal:
            insert_signal(win, args.signal)
        if args.screenshot and win:
            win.set_focus()
            time.sleep(1)
            win.capture_as_image().save(args.screenshot)
            log(f"截圖已存至：{args.screenshot}")
    except (RuntimeError, FileNotFoundError, ElementNotFoundError) as e:
        sys.exit(f"[open_workspace] 失敗：{e}")

    log("完成")


if __name__ == "__main__":
    main()
