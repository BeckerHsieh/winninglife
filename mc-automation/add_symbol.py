"""
透過 pywinauto 模擬使用者操作，在 QuoteManager 新增期貨商品，並在 MultiCharts 建立該商品的工作底稿 (.wsp)。

流程（以 OWF 為例）：
1. 由參數或互動輸入取得商品代號（OWF），連續月1 為 OWF1
2. QuoteManager：先檢查「期貨 → TAIFEX」是否已有 OWF1；沒有才執行
   商品(I) → 新增商品(A) → 從數據源取得 → Concord Futures64 → 期貨 tab → 商品源輸入 OWF → 搜尋
   → 選 OWF1 → 新增，完成後再回「期貨 → TAIFEX」確認 OWF1 已存在
3. MultiCharts：檔案 → 新增 → 工作底稿，再 檔案 → 新增 → 圖表視窗
   → 設定商品：數據源 Concord Futures64、期貨 tab 選 OWF1、樣式 tab 圖表類型選「蠟燭線」→ 確定
4. 檔案 → 另存工作底稿 → OWF.wsp（工作底稿已存在則略過，除非 --force）

用法：
  python add_symbol.py OWF
  python add_symbol.py            （互動輸入商品代號）
  python add_symbol.py OWF --wsp-dir "C:\\...\\MC_wsp" --screenshot owf.png
"""

import argparse
import os
import re
import sys
import time

import open_workspace as ow
from open_workspace import PollTimeout, wait_until, dialog_spec

try:
    import win32con
    import win32gui
    from pywinauto import Application, Desktop
    from pywinauto.application import process_get_modules
    from pywinauto.controls.uiawrapper import UIAWrapper
    from pywinauto.findwindows import ElementNotFoundError
    from pywinauto.keyboard import send_keys
    from pywinauto.uia_element_info import UIAElementInfo
except ImportError:
    sys.exit("找不到 pywinauto，請先執行：pip install -r requirements.txt")

DEFAULT_WSP_DIR = r"C:\Users\MC12\Desktop\康和MultiCharts12\MC_wsp"
QM_SHORTCUT = r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Concord MultiCharts64\QuoteManager.lnk"
QM_PROCESS_NAME = "quotemanager.exe"
QM_TITLE_RE = r".*QuoteManager$"
DATA_SOURCE = "Concord Futures64"
EXCHANGE = "TAIFEX"

# QuoteManager「新增商品至投資組合」對話框
QM_ADD_DLG_RE = r"新增商品至投資組合.*"
QM_MENU_PATH = ["商品", "新增商品", "從數據源取得", DATA_SOURCE]
QM_SYMBOL_EDIT_ID = 1009
QM_SEARCH_ID = 1011
QM_RESULT_LIST_ID = 1008
QM_TAB_ID = 12320
# MultiCharts「設定商品」對話框
MC_SYMBOL_DLG = "設定商品"
MC_MAIN_TAB_ID = 12320
MC_SOURCE_COMBO_ID = 2241
MC_SYMBOL_COMBO_ID = 2246
MC_CATEGORY_TAB_ID = 2082
MC_SYMBOL_LIST_ID = 2244
MC_CHART_TYPE_LIST_ID = 2137
CHART_TYPE = "蠟燭線"
ID_OK, ID_CLOSE = 1, 2


def log(msg):
    print(f"[add_symbol] {msg}", flush=True)


def norm_menu_text(text):
    """去掉選單文字的 &、快速鍵與 (X) 助憶字，方便以前綴比對。"""
    text = text.replace("&", "").split("\t")[0]
    return re.sub(r"\([A-Z]\)", "", text).strip()


def visible_child(dlg, control_id, class_name=None):
    """對話框內 tab 頁會有同 ID 的隱藏控制項，只取目前可見的那一個。"""
    for c in dlg.descendants():
        if c.control_id() == control_id and c.is_visible() and (class_name is None or c.class_name() == class_name):
            return c
    raise RuntimeError(f"對話框「{dlg.window_text()}」中找不到可見控制項 id={control_id}")


def read_list_names(lv, timeout, desc):
    """讀取 ListView 第一欄；清單可能正在重新載入，重試直到連續兩次讀到相同且非空的結果。"""
    last = None

    def _stable():
        nonlocal last
        try:
            names = [lv.get_item(i, 0).text() for i in range(lv.item_count())]
        except OSError:  # 讀取當下清單被重建，ReadProcessMemory 只完成部分
            last = None
            return None
        if names and names == last:
            return names
        last = names
        return None

    try:
        return wait_until(timeout, 1, _stable)
    except PollTimeout:
        raise RuntimeError(f"{timeout} 秒內{desc}清單為空或持續變動")


def wait_process_dialog(pid, title_re, timeout=15):
    def _find():
        dlgs = Desktop(backend="win32").windows(process=pid, class_name="#32770", visible_only=True)
        return next((d for d in dlgs if re.fullmatch(title_re, d.window_text())), None)
    try:
        return wait_until(timeout, 0.5, _find)
    except PollTimeout:
        raise RuntimeError(f"{timeout} 秒內未出現對話框：{title_re}")


def dismiss_message_boxes(pid, keep_titles):
    """關閉非預期的訊息框（記錄內容後按確定/是），回傳訊息文字清單。"""
    msgs = []
    for d in Desktop(backend="win32").windows(process=pid, class_name="#32770", visible_only=True):
        if any(re.fullmatch(t, d.window_text()) for t in keep_titles):
            continue
        text = " ".join(c.window_text() for c in d.children() if c.class_name() == "Static" and c.window_text())
        msgs.append(f"{d.window_text()}：{text}")
        log(f"訊息框 {d.window_text()!r}：{text}")
        buttons = [c for c in d.children() if c.class_name() == "Button"]
        # 優先按 是(IDYES=6)/確定(IDOK=1)，自訂訊息框則按第一個按鈕
        btn = next((c for btn_id in (6, ID_OK) for c in buttons if c.control_id() == btn_id), None) \
            or (buttons[0] if buttons else None)
        if btn:
            btn.click()
        time.sleep(1)
    return msgs


# ---------------------------------------------------------------- QuoteManager

def qm_pid():
    return next((pid for pid, path, _ in process_get_modules()
                 if os.path.basename(path or "").lower() == QM_PROCESS_NAME), None)


def find_qm_window():
    pid = qm_pid()
    if not pid:
        return None
    wins = Desktop(backend="win32").windows(process=pid, title_re=QM_TITLE_RE, visible_only=False)
    wins = [w for w in wins if w.is_visible() or w.is_minimized()]
    return wins[0] if wins else None


def get_or_start_qm(timeout):
    win = find_qm_window()
    if not win:
        if not os.path.isfile(QM_SHORTCUT):
            raise FileNotFoundError(f"找不到 QuoteManager 捷徑：{QM_SHORTCUT}")
        log(f"啟動 QuoteManager：{QM_SHORTCUT}")
        os.startfile(QM_SHORTCUT)
        try:
            win = wait_until(timeout, 1, find_qm_window)
        except PollTimeout:
            raise RuntimeError("等待 QuoteManager 主視窗逾時")
        time.sleep(3)  # 等商品清單載入
    else:
        log(f"已 attach 到執行中的 QuoteManager：{win.window_text()}")
    if win.is_minimized():
        win32gui.ShowWindow(win.handle, win32con.SW_RESTORE)
        time.sleep(1)
    win.set_focus()
    return win


def qm_menu_command_id(qm_win, path):
    """依 path（各層文字前綴）走訪 Win32 選單，回傳最終項目的 command id。"""
    menu = qm_win.menu()
    item = None
    for name in path:
        if menu is None:
            raise RuntimeError(f"QuoteManager 選單「{' → '.join(path)}」層級不足")
        item = next((it for it in menu.items() if norm_menu_text(it.text()).startswith(name)), None)
        if item is None:
            raise RuntimeError(f"QuoteManager 選單中找不到「{name}」（路徑 {' → '.join(path)}）")
        menu = item.sub_menu()
    if not item.is_enabled():
        raise RuntimeError(f"QuoteManager 選單「{' → '.join(path)}」目前為停用狀態")
    return item.item_id()


def qm_taifex_symbols(qm_win):
    """在左側樹狀選「所有商品 → 期貨 → TAIFEX」，回傳右側清單的商品代碼。"""
    tree = Application(backend="win32").connect(handle=qm_win.handle) \
        .window(handle=qm_win.handle).child_window(class_name="SysTreeView32").wrapper_object()
    tree.get_item(["所有商品", "期貨", EXCHANGE]).click_input()
    uia_win = UIAWrapper(UIAElementInfo(qm_win.handle))

    def _symbols():
        banner = [p for p in uia_win.descendants(control_type="Pane") if p.window_text() == f"期貨 ({EXCHANGE})"]
        if not banner:
            return None
        lst = uia_win.descendants(control_type="List")
        items = [i.window_text() for i in lst[0].children(control_type="ListItem")] if lst else []
        return items or None

    try:
        return wait_until(10, 0.5, _symbols)
    except PollTimeout:
        raise RuntimeError(f"QuoteManager 無法切換到「期貨 → {EXCHANGE}」清單")


def qm_add_symbol(qm_win, base, symbol, timeout):
    pid = qm_win.process_id()
    cmd_id = qm_menu_command_id(qm_win, QM_MENU_PATH)
    log(f"QuoteManager：商品 → 新增商品 → 從數據源取得 → {DATA_SOURCE}")
    win32gui.PostMessage(qm_win.handle, win32con.WM_COMMAND, cmd_id, 0)
    dlg = wait_process_dialog(pid, QM_ADD_DLG_RE)

    tab = next(c for c in dlg.children() if c.control_id() == QM_TAB_ID and c.class_name() == "SysTabControl32")
    tab.select("期貨")
    log("已切換到「期貨」頁")
    try:
        wait_until(5, 0.3, lambda: any(c.window_text().startswith("商品源") and c.is_visible()
                                        for c in dlg.descendants() if c.class_name() == "Static"))
    except PollTimeout:
        raise RuntimeError("切換「期貨」頁後找不到「商品源」欄位")

    edit = visible_child(dlg, QM_SYMBOL_EDIT_ID, "Edit")
    edit.set_edit_text(base)
    if edit.window_text() != base:
        raise RuntimeError(f"商品源欄位填入失敗，目前內容：{edit.window_text()!r}")
    btn = visible_child(dlg, QM_SEARCH_ID, "Button")
    if not btn.is_enabled():
        raise RuntimeError("「搜尋」按鈕未啟用")
    btn.click()
    log(f"已輸入商品源 {base} 並按搜尋，等待結果...")

    lv = visible_child(dlg, QM_RESULT_LIST_ID, "SysListView32")
    try:
        names = read_list_names(lv, timeout, "搜尋結果")
    except RuntimeError:
        msgs = dismiss_message_boxes(pid, [QM_ADD_DLG_RE])
        close_dialog(dlg)
        raise RuntimeError(f"{timeout} 秒內搜尋不到 {base} 的任何商品 {msgs or ''}".strip())

    if symbol not in names:
        close_dialog(dlg)
        raise RuntimeError(f"搜尋結果沒有 {symbol}（共 {len(names)} 筆，例如 {names[:5]}）")
    idx = names.index(symbol)
    item = lv.get_item(idx)
    item.ensure_visible()
    item.click_input()
    desc = lv.get_item(idx, 1).text()
    exch = lv.get_item(idx, 3).text()
    log(f"已選擇 {symbol}（{desc}，{exch}）")

    add_btn = next(c for c in dlg.children() if c.control_id() == ID_OK and c.class_name() == "Button")
    try:
        wait_until(5, 0.3, add_btn.is_enabled)
    except PollTimeout:
        close_dialog(dlg)
        raise RuntimeError("選擇商品後「新增」按鈕未啟用")
    add_btn.click()
    log("已按「新增」")
    time.sleep(2)
    dismiss_message_boxes(pid, [QM_ADD_DLG_RE])
    close_dialog(dlg)


def close_dialog(dlg):
    try:
        if dlg.exists() and dlg.is_visible():
            btn = [c for c in dlg.children() if c.control_id() == ID_CLOSE and c.class_name() == "Button"]
            if btn:
                btn[0].click()
                time.sleep(1)
    except Exception:
        pass


def ensure_symbol_in_qm(base, symbol, timeout):
    qm = get_or_start_qm(timeout)
    if symbol in qm_taifex_symbols(qm):
        log(f"QuoteManager「期貨 → {EXCHANGE}」已有 {symbol}，略過新增")
        return
    qm_add_symbol(qm, base, symbol, timeout)
    qm = find_qm_window()
    try:
        wait_until(15, 1, lambda: symbol in qm_taifex_symbols(qm))
    except PollTimeout:
        raise RuntimeError(f"新增後於 QuoteManager「期貨 → {EXCHANGE}」仍找不到 {symbol}")
    log(f"確認 QuoteManager「期貨 → {EXCHANGE}」已有 {symbol}")


# ---------------------------------------------------------------- MultiCharts

def mc_popups():
    return [m for pid in ow.mc_pids()
            for m in Desktop(backend="win32").windows(process=pid, class_name="#32768", visible_only=True)]


def click_mc_menu(main_win, top, *path):
    """點 MultiCharts 選單列 top，再依序點 path 中各層子選單（以文字前綴比對）。"""
    main_win.set_focus()
    tops = [c for c in main_win.descendants(control_type="MenuItem") if c.window_text() == top]
    if not tops:
        raise RuntimeError(f"找不到選單「{top}」")
    tops[0].click_input()
    seen = set()
    for name in path:
        def _item():
            for m in mc_popups():
                for c in UIAWrapper(UIAElementInfo(m.handle)).descendants(control_type="MenuItem"):
                    if norm_menu_text(c.window_text()).startswith(name) and (m.handle, name) not in seen:
                        return m.handle, c
            return None
        try:
            handle, item = wait_until(5, 0.3, _item)
        except PollTimeout:
            send_keys("{ESC}{ESC}{ESC}")
            raise RuntimeError(f"選單「{top} → {' → '.join(path)}」中找不到「{name}」")
        if not item.is_enabled():
            send_keys("{ESC}{ESC}{ESC}")
            raise RuntimeError(f"選單項目「{name}」目前為停用狀態")
        seen.add((handle, name))
        item.click_input()
        time.sleep(0.5)


def mc_new_workspace(main_win):
    before = main_win.window_text()
    click_mc_menu(main_win, "檔案(F)", "新增", "工作底稿")
    try:
        win = wait_until(10, 0.5, lambda: (w := ow.find_main_window()) and w.window_text() != before and w)
    except PollTimeout:
        raise RuntimeError("新增工作底稿後視窗標題未改變")
    log(f"已新增工作底稿：{win.window_text()}")
    return win


def mc_insert_chart(main_win, symbol):
    click_mc_menu(main_win, "檔案(F)", "新增", "圖表視窗")
    try:
        dlg = wait_until(10, 0.5, lambda: (d := ow.find_dialogs()) and d[0])
    except PollTimeout:
        raise RuntimeError(f"10 秒內未出現「{MC_SYMBOL_DLG}」對話框")
    if dlg.window_text() != MC_SYMBOL_DLG:
        # 例如「不可開啟10個以上的圖表視窗」：記錄訊息後按確定關閉
        text = " ".join(c.window_text() for c in dlg.children() if c.class_name() == "Static" and c.window_text())
        buttons = [c for c in dlg.children() if c.class_name() == "Button"]
        if buttons:
            buttons[0].click()  # 訊息框只有「確定」，其 control id 不一定是 IDOK
        raise RuntimeError(f"未開出「{MC_SYMBOL_DLG}」，MultiCharts 訊息：{text or dlg.window_text()}"
                           "（若為圖表數量上限，請先關閉部分工作底稿後重跑）")
    spec = dialog_spec(dlg)
    try:
        spec.child_window(control_id=MC_MAIN_TAB_ID, class_name="SysTabControl32").wrapper_object().select("商品")
        time.sleep(0.5)

        source = spec.child_window(control_id=MC_SOURCE_COMBO_ID, class_name="ComboBox").wrapper_object()
        if source.selected_text() != DATA_SOURCE:
            source.select(DATA_SOURCE)
            time.sleep(1)
        log(f"數據源：{source.selected_text()}")

        spec.child_window(control_id=MC_CATEGORY_TAB_ID, class_name="SysTabControl32").wrapper_object().select("期貨")
        lv = visible_child(dlg, MC_SYMBOL_LIST_ID, "SysListView32")
        names = read_list_names(lv, 15, "「期貨」商品")
        if symbol not in names:
            raise RuntimeError(f"「設定商品 → 期貨」清單中沒有 {symbol}，請確認 QuoteManager 已新增")
        item = lv.get_item(names.index(symbol))
        item.ensure_visible()
        item.click_input()
        combo_edit = spec.child_window(control_id=MC_SYMBOL_COMBO_ID).child_window(class_name="Edit").wrapper_object()
        try:
            wait_until(5, 0.3, lambda: combo_edit.window_text() == symbol)
        except PollTimeout:
            raise RuntimeError(f"選擇商品後欄位為 {combo_edit.window_text()!r}，不是 {symbol}")
        log(f"已選擇商品：{symbol}")

        spec.child_window(control_id=MC_MAIN_TAB_ID, class_name="SysTabControl32").wrapper_object().select("樣式")
        lb = visible_child(dlg, MC_CHART_TYPE_LIST_ID, "ListBox")
        lb.select(CHART_TYPE)
        time.sleep(0.5)
        if [lb.item_texts()[i] for i in lb.selected_indices()] != [CHART_TYPE]:
            raise RuntimeError(f"圖表類型未成功選取 {CHART_TYPE}")
        log(f"圖表類型：{CHART_TYPE}")
    except Exception:
        spec.child_window(control_id=ID_CLOSE).click()
        raise

    spec.child_window(control_id=ID_OK).click()

    def _chart():
        # 圖表未最大化時主視窗標題不含商品，改看圖表子視窗（標題如「OWF1 - 1 分鐘 - Concord Futures64」）
        if any(d.window_text() == MC_SYMBOL_DLG for d in ow.find_dialogs()):
            return None
        charts = [c for c in main_win.descendants(control_type="Window")
                  if c.class_name() == "ATL_MCMDIChildFrame" and c.window_text().startswith(f"{symbol} ")]
        return charts[0] if charts else None

    try:
        chart = wait_until(30, 1, _chart)
    except PollTimeout:
        raise RuntimeError(f"按確定後 30 秒內未出現 {symbol} 圖表視窗")
    log(f"圖表已建立：{chart.window_text()}")
    return main_win


def mc_save_workspace_as(main_win, wsp_path, overwrite):
    click_mc_menu(main_win, "檔案(F)", "另存工作底稿")
    dlg = wait_until_dialog_any()
    log(f"找到存檔對話框：{dlg.window_text()!r}")
    spec = dialog_spec(dlg)
    edit = None
    # 存檔對話框檔名欄位：新版為 ComboBox(1001) 內的 Edit；舊版為 Edit(1152) 或 ComboBoxEx32(1148)
    for crit in ({"class_name": "Edit", "control_id": 1001}, {"class_name": "Edit", "control_id": 1148},
                 {"class_name": "Edit", "control_id": 1152}):
        ctrl = spec.child_window(found_index=0, **crit)
        if ctrl.exists(timeout=1):
            edit = ctrl.wrapper_object()
            break
    if edit is None:
        spec.child_window(control_id=ID_CLOSE).click()
        raise RuntimeError("存檔對話框中找不到檔名欄位")
    edit.set_edit_text(wsp_path)
    if edit.window_text() != wsp_path:
        raise RuntimeError(f"檔名欄位填入失敗：{edit.window_text()!r}")
    spec.child_window(control_id=ID_OK).click()
    time.sleep(1.5)

    # 檔案已存在時會跳出覆寫確認
    for d in ow.find_dialogs():
        if d.handle == dlg.handle:
            continue
        btn_id = 6 if overwrite else 7  # IDYES / IDNO
        text = " ".join(c.window_text() for c in d.descendants() if c.window_text())
        log(f"確認對話框：{text[:120]}")
        btns = [c for c in d.descendants() if c.control_id() == btn_id and c.class_name() == "Button"]
        if btns:
            btns[0].click()
        if not overwrite:
            time.sleep(1)
            for left in ow.find_dialogs():
                dialog_spec(left).child_window(control_id=ID_CLOSE).click()
            raise RuntimeError(f"{wsp_path} 已存在，未覆寫（如需覆寫請加 --force）")

    name = os.path.splitext(os.path.basename(wsp_path))[0]
    try:
        win = wait_until(15, 0.5, lambda: not ow.find_dialogs() and (w := ow.find_main_window())
                         and ow.title_has_workspace(w.window_text(), wsp_path) and w)
    except PollTimeout:
        raise RuntimeError(f"存檔後主視窗標題未出現 {name}")
    if not os.path.isfile(wsp_path):
        raise RuntimeError(f"存檔後找不到檔案：{wsp_path}")
    log(f"工作底稿已儲存：{wsp_path}")
    return win


def wait_until_dialog_any(timeout=10):
    try:
        return wait_until(timeout, 0.5, lambda: (d := ow.find_dialogs()) and d[0])
    except PollTimeout:
        raise RuntimeError("未開出存檔對話框")


def main():
    parser = argparse.ArgumentParser(description="在 QuoteManager 新增期貨商品，並於 MultiCharts 建立該商品的工作底稿")
    parser.add_argument("symbol", nargs="?", help="商品代號，例如 OWF（未指定則互動輸入）")
    parser.add_argument("--wsp-dir", default=DEFAULT_WSP_DIR, help="工作底稿存放資料夾")
    parser.add_argument("--exe", default=os.environ.get("MC_EXE"),
                        help="MultiCharts64.exe 路徑（未指定時使用開始選單捷徑；也可設環境變數 MC_EXE）")
    parser.add_argument("--timeout", type=int, default=90, help="等待程式啟動/搜尋結果的秒數")
    parser.add_argument("--force", action="store_true", help="工作底稿已存在時仍重建並覆寫")
    parser.add_argument("--skip-qm", action="store_true", help="略過 QuoteManager 新增商品步驟")
    parser.add_argument("--screenshot", help="完成後將 MultiCharts 主視窗截圖存到此路徑 (.png)")
    args = parser.parse_args()

    base = (args.symbol or input("請輸入商品代號（例如 OWF）：")).strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{2,6}", base):
        sys.exit(f"商品代號格式不正確：{base!r}")
    symbol = f"{base}1"
    wsp_path = os.path.join(os.path.abspath(args.wsp_dir), f"{base}.wsp")
    log(f"商品代號 {base}，連續月1 {symbol}，工作底稿 {wsp_path}")

    try:
        if args.skip_qm:
            log("略過 QuoteManager 步驟（--skip-qm）")
        else:
            ensure_symbol_in_qm(base, symbol, args.timeout)

        if os.path.isfile(wsp_path) and not args.force:
            log(f"工作底稿已存在，略過建立（如需重建請加 --force）：{wsp_path}")
            return
        if not os.path.isdir(os.path.dirname(wsp_path)):
            raise FileNotFoundError(f"工作底稿資料夾不存在：{os.path.dirname(wsp_path)}")

        main_win = ow.get_or_start_main_window(args.exe, args.timeout)
        main_win = mc_new_workspace(main_win)
        try:
            main_win = mc_insert_chart(main_win, symbol)
        except Exception:
            # 剛新增的工作底稿還是空的，關閉時不會詢問存檔，直接收掉避免殘留「未命名」分頁
            time.sleep(1)
            if not ow.find_dialogs():
                log("建立圖表失敗，關閉剛新增的空白工作底稿")
                click_mc_menu(ow.find_main_window(), "檔案(F)", "關閉工作底稿")
            raise
        main_win = mc_save_workspace_as(main_win, wsp_path, args.force)
        if args.screenshot:
            main_win.set_focus()
            time.sleep(1)
            main_win.capture_as_image().save(args.screenshot)
            log(f"截圖已存至：{args.screenshot}")
    except (RuntimeError, OSError, ElementNotFoundError) as e:
        sys.exit(f"[add_symbol] 失敗：{e}")

    log("完成")


if __name__ == "__main__":
    main()
