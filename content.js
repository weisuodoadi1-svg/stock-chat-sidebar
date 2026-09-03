(() => {
  const HOST_ID = "dsh-stock-chat-sidebar-host";
  const REFRESH_INTERVAL_MS = 15_000;
  const SEARCH_DEBOUNCE_MS = 240;
  const DEFAULT_ALERTS = Object.freeze({
    maEnabled: true,
    maPeriod: 5,
    maDirection: "below",
    priceAbove: null,
    priceBelow: null,
    changeAbove: null,
    changeBelow: null,
  });

  if (document.getElementById(HOST_ID)) return;

  const state = {
    watchlist: [],
    snapshots: new Map(),
    searchResults: [],
    activeSearchIndex: -1,
    refreshing: false,
    saving: false,
    lastUpdatedAt: null,
    refreshTimer: null,
    searchTimer: null,
    searchSequence: 0,
    sortMode: "watchlist",
    editingStockKey: null,
    activeAlertIds: new Set(),
    alertsPrimed: false,
  };

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-collapsed", "false");
  document.documentElement.append(host);

  const shadow = host.attachShadow({ mode: "closed" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content.css");
  shadow.append(stylesheet);

  const shell = document.createElement("div");
  shell.className = "dsh-stock-shell";
  shell.innerHTML = `
    <aside class="dsh-stock-sidebar" aria-label="A 股自选观察栏">
      <header class="dsh-stock-header">
        <div class="dsh-stock-brand">
          <span class="dsh-stock-brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <div>
            <div class="dsh-stock-eyebrow">MARKET WATCH</div>
            <div class="dsh-stock-title-row">
              <h2>我的股票</h2>
              <span class="dsh-stock-count" data-role="stock-count">0</span>
            </div>
          </div>
        </div>
        <div class="dsh-stock-header-actions">
          <button class="dsh-icon-button" type="button" data-action="refresh" aria-label="立即刷新行情" title="立即刷新">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9A7 7 0 0 1 18 6l2 2M17.9 15A7 7 0 0 1 6 18l-2-2"/></svg>
          </button>
          <button class="dsh-icon-button" type="button" data-action="collapse" aria-label="收起股票侧栏" title="收起侧栏">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>
          </button>
        </div>
      </header>

      <div class="dsh-stock-sync-row">
        <span class="dsh-stock-sync-dot" data-role="sync-dot" aria-hidden="true"></span>
        <span data-role="sync-status">正在读取自选股…</span>
        <label class="dsh-stock-sort">
          <span>排序</span>
          <select data-role="sort-mode" aria-label="股票排序方式">
            <option value="watchlist">原顺序</option>
            <option value="alerts">触发优先</option>
            <option value="gainers">涨幅优先</option>
            <option value="losers">跌幅优先</option>
            <option value="code">代码</option>
          </select>
        </label>
        <span class="dsh-stock-sync-source">15 秒刷新</span>
      </div>

      <section class="dsh-stock-search" aria-label="添加股票">
        <label for="dsh-stock-search-input">添加股票</label>
        <div class="dsh-stock-search-box">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
          <input id="dsh-stock-search-input" type="search" autocomplete="off" spellcheck="false" placeholder="输入名称、代码或拼音" aria-autocomplete="list" aria-controls="dsh-stock-search-results" aria-expanded="false">
          <span class="dsh-stock-search-hint">↵</span>
        </div>
        <div id="dsh-stock-search-results" class="dsh-stock-search-results" role="listbox" hidden></div>
      </section>

      <div class="dsh-stock-notice" data-role="notice" role="status" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17h.01M10.3 3.8 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg>
        <span data-role="notice-text"></span>
      </div>

      <main class="dsh-stock-list" data-role="stock-list"></main>

      <footer class="dsh-stock-footer">
        <span>公开行情 · 仅供参考</span>
        <span data-role="footer-time">等待首次更新</span>
      </footer>
    </aside>

    <dialog class="dsh-stock-alert-dialog" data-role="alert-dialog" aria-labelledby="dsh-stock-alert-dialog-title">
      <form class="dsh-stock-alert-form" data-role="alert-form" method="dialog">
        <header>
          <div>
            <span>ALERT RULES</span>
            <h3 id="dsh-stock-alert-dialog-title" data-role="alert-dialog-title">提醒设置</h3>
          </div>
          <button type="button" data-action="close-alert-dialog" aria-label="关闭提醒设置">×</button>
        </header>
        <p class="dsh-stock-alert-hint">留空即关闭该项；页面打开时每 15 秒检查一次。</p>
        <fieldset>
          <legend>价格</legend>
          <label><span>高于或等于</span><input name="priceAbove" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="未设置" aria-describedby="dsh-stock-alert-form-error"><em>元</em></label>
          <label><span>低于或等于</span><input name="priceBelow" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="未设置" aria-describedby="dsh-stock-alert-form-error"><em>元</em></label>
        </fieldset>
        <fieldset>
          <legend>涨跌幅</legend>
          <label><span>高于或等于</span><input name="changeAbove" type="number" min="-100" max="100" step="0.01" inputmode="decimal" placeholder="未设置" aria-describedby="dsh-stock-alert-form-error"><em>%</em></label>
          <label><span>低于或等于</span><input name="changeBelow" type="number" min="-100" max="100" step="0.01" inputmode="decimal" placeholder="未设置" aria-describedby="dsh-stock-alert-form-error"><em>%</em></label>
        </fieldset>
        <fieldset class="dsh-stock-alert-ma">
          <legend>均线</legend>
          <label class="dsh-stock-alert-check"><input name="maEnabled" type="checkbox"><span>启用</span></label>
          <label><span>周期</span><select name="maPeriod"><option value="5">MA5</option><option value="10">MA10</option><option value="20">MA20</option></select></label>
          <label><span>条件</span><select name="maDirection"><option value="below">低于均线</option><option value="above">高于均线</option></select></label>
        </fieldset>
        <p id="dsh-stock-alert-form-error" class="dsh-stock-alert-error" data-role="alert-form-error" role="alert" hidden></p>
        <footer>
          <button type="button" data-action="close-alert-dialog">取消</button>
          <button type="submit" data-role="save-alerts">保存提醒</button>
        </footer>
      </form>
    </dialog>

    <button class="dsh-stock-rail" type="button" data-action="expand" aria-label="展开股票侧栏">
      <span class="dsh-stock-rail-dot" aria-hidden="true"></span>
      <span>股票</span>
      <strong data-role="rail-count">0</strong>
    </button>

    <div class="dsh-stock-toast" data-role="toast" role="status" aria-live="polite"></div>
  `;
  shadow.append(shell);

  const elements = {
    sidebar: shadow.querySelector(".dsh-stock-sidebar"),
    count: shadow.querySelector('[data-role="stock-count"]'),
    railCount: shadow.querySelector('[data-role="rail-count"]'),
    refreshButton: shadow.querySelector('[data-action="refresh"]'),
    syncDot: shadow.querySelector('[data-role="sync-dot"]'),
    syncStatus: shadow.querySelector('[data-role="sync-status"]'),
    sortMode: shadow.querySelector('[data-role="sort-mode"]'),
    searchInput: shadow.querySelector("#dsh-stock-search-input"),
    searchResults: shadow.querySelector("#dsh-stock-search-results"),
    notice: shadow.querySelector('[data-role="notice"]'),
    noticeText: shadow.querySelector('[data-role="notice-text"]'),
    list: shadow.querySelector('[data-role="stock-list"]'),
    footerTime: shadow.querySelector('[data-role="footer-time"]'),
    toast: shadow.querySelector('[data-role="toast"]'),
    alertDialog: shadow.querySelector('[data-role="alert-dialog"]'),
    alertForm: shadow.querySelector('[data-role="alert-form"]'),
    alertDialogTitle: shadow.querySelector('[data-role="alert-dialog-title"]'),
    alertFormError: shadow.querySelector('[data-role="alert-form-error"]'),
    saveAlertsButton: shadow.querySelector('[data-role="save-alerts"]'),
  };

  shell.addEventListener("click", handleShellClick);
  elements.list.addEventListener("change", handleListChange);
  elements.sortMode.addEventListener("change", () => {
    state.sortMode = elements.sortMode.value;
    renderCards();
  });
  elements.alertForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveAlertSettings();
  });
  elements.alertDialog.addEventListener("close", finishAlertDialogClose);
  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.searchInput.addEventListener("keydown", handleSearchKeydown);
  elements.searchInput.addEventListener("blur", () => {
    window.setTimeout(() => closeSearchResults(), 160);
  });
  document.addEventListener("visibilitychange", handleVisibilityChange);

  void initialize();

  async function initialize() {
    setSyncState("loading", "正在读取自选股…");
    renderCards();

    try {
      const response = await sendMessage("GET_WATCHLIST");
      state.watchlist = normalizeWatchlist(response.watchlist);
      renderCards();

      if (state.watchlist.length > 0) {
        await refreshSnapshots();
      } else {
        setSyncState("idle", "等待添加股票");
      }
    } catch (error) {
      showNotice(getErrorMessage(error, "无法读取自选股，请重新加载插件。"));
      setSyncState("error", "插件连接失败");
      renderCards();
    } finally {
      scheduleRefresh();
    }
  }

  function handleShellClick(event) {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target) return;

    switch (target.getAttribute("data-action")) {
      case "refresh":
        void refreshSnapshots({ announce: true });
        break;
      case "collapse":
        host.setAttribute("data-collapsed", "true");
        closeSearchResults();
        break;
      case "expand":
        host.setAttribute("data-collapsed", "false");
        break;
      case "remove":
        void removeStock(target.getAttribute("data-stock-key"));
        break;
      case "configure-alerts":
        openAlertDialog(target.getAttribute("data-stock-key"));
        break;
      case "close-alert-dialog":
        closeAlertDialog();
        break;
      case "select-search-result": {
        const index = Number(target.getAttribute("data-result-index"));
        const candidate = state.searchResults[index];
        if (candidate) void addStock(candidate);
        break;
      }
      case "focus-search":
        elements.searchInput.focus();
        break;
      default:
        break;
    }
  }

  function handleListChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.getAttribute("data-action") !== "toggle-ma") return;

    const key = target.getAttribute("data-stock-key");
    if (!key) return;
    void setMaAlertEnabled(key, target.checked);
  }

  function handleSearchInput() {
    const query = elements.searchInput.value.trim();
    state.searchSequence += 1;
    window.clearTimeout(state.searchTimer);

    if (!query) {
      state.searchResults = [];
      closeSearchResults();
      return;
    }

    renderSearchMessage("正在查找…", "loading");
    const sequence = state.searchSequence;
    state.searchTimer = window.setTimeout(() => {
      void searchStocks(query, sequence);
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleSearchKeydown(event) {
    if (elements.searchResults.hidden) {
      if (event.key === "ArrowDown" && elements.searchInput.value.trim()) {
        handleSearchInput();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveSearchResult(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveSearchResult(-1);
    } else if (event.key === "Enter") {
      const candidate = state.searchResults[state.activeSearchIndex];
      if (candidate) {
        event.preventDefault();
        void addStock(candidate);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchResults();
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "visible") return;

    const elapsed = state.lastUpdatedAt ? Date.now() - state.lastUpdatedAt.getTime() : Infinity;
    if (state.watchlist.length > 0 && elapsed >= REFRESH_INTERVAL_MS) {
      void refreshSnapshots();
    }
  }

  async function searchStocks(query, sequence) {
    try {
      const response = await sendMessage("SEARCH_STOCKS", { query });
      if (sequence !== state.searchSequence || query !== elements.searchInput.value.trim()) return;

      state.searchResults = normalizeSearchResults(response.results).slice(0, 8);
      state.activeSearchIndex = state.searchResults.findIndex((candidate) => !hasStock(candidate));
      renderSearchResults();
    } catch (error) {
      if (sequence !== state.searchSequence) return;
      state.searchResults = [];
      renderSearchMessage(getErrorMessage(error, "联想暂时不可用"), "error");
    }
  }

  async function addStock(candidate) {
    if (state.saving || hasStock(candidate)) return;

    const item = {
      name: candidate.name,
      code: candidate.code,
      market: candidate.market,
      alerts: { ...DEFAULT_ALERTS },
    };
    const saved = await saveWatchlist([...state.watchlist, item], `已添加 ${item.name}`);
    if (!saved) return;

    elements.searchInput.value = "";
    state.searchResults = [];
    state.searchSequence += 1;
    closeSearchResults();
    await refreshSnapshots();
  }

  async function removeStock(key) {
    if (!key || state.saving) return;
    const item = state.watchlist.find((stock) => stockKey(stock) === key);
    if (!item) return;

    const saved = await saveWatchlist(
      state.watchlist.filter((stock) => stockKey(stock) !== key),
      `已移除 ${item.name}`,
    );
    if (saved) state.snapshots.delete(key);
    renderCards();
  }

  async function setMaAlertEnabled(key, enabled) {
    if (state.saving) return;
    const item = state.watchlist.find((stock) => stockKey(stock) === key);
    if (!item) return;

    const next = state.watchlist.map((stock) =>
      stockKey(stock) === key
        ? { ...stock, alerts: { ...stock.alerts, maEnabled: enabled } }
        : stock,
    );
    const saved = await saveWatchlist(next, enabled ? `${item.name}：已开启均线提醒` : `${item.name}：已关闭均线提醒`);
    if (saved) resetAndEvaluateStockAlerts(key);
  }

  function openAlertDialog(key) {
    const item = state.watchlist.find((stock) => stockKey(stock) === key);
    if (!item) return;
    state.editingStockKey = key;
    const alerts = normalizeAlerts(item.alerts);
    elements.alertDialogTitle.textContent = `${item.name} · ${item.code}`;
    elements.alertForm.elements.priceAbove.value = inputValue(alerts.priceAbove);
    elements.alertForm.elements.priceBelow.value = inputValue(alerts.priceBelow);
    elements.alertForm.elements.changeAbove.value = inputValue(alerts.changeAbove);
    elements.alertForm.elements.changeBelow.value = inputValue(alerts.changeBelow);
    elements.alertForm.elements.maEnabled.checked = alerts.maEnabled;
    elements.alertForm.elements.maPeriod.value = String(alerts.maPeriod);
    elements.alertForm.elements.maDirection.value = alerts.maDirection;
    elements.alertForm.querySelectorAll('[aria-invalid="true"]').forEach((input) => input.removeAttribute("aria-invalid"));
    elements.alertFormError.hidden = true;
    if (typeof elements.alertDialog.showModal === "function") elements.alertDialog.showModal();
    else elements.alertDialog.setAttribute("open", "");
  }

  function closeAlertDialog() {
    if (typeof elements.alertDialog.close === "function") elements.alertDialog.close();
    else {
      elements.alertDialog.removeAttribute("open");
      finishAlertDialogClose();
    }
  }

  function finishAlertDialogClose() {
    const key = state.editingStockKey;
    state.editingStockKey = null;
    if (!key) return;
    elements.list
      .querySelector(`[data-stock-key="${key}"] [data-action="configure-alerts"]`)
      ?.focus({ preventScroll: true });
  }

  async function saveAlertSettings() {
    const key = state.editingStockKey;
    const item = state.watchlist.find((stock) => stockKey(stock) === key);
    if (!item || state.saving) return;

    try {
      elements.alertFormError.hidden = true;
      elements.alertForm.querySelectorAll('[aria-invalid="true"]').forEach((input) => input.removeAttribute("aria-invalid"));
      const alerts = {
        maEnabled: elements.alertForm.elements.maEnabled.checked,
        maPeriod: Number(elements.alertForm.elements.maPeriod.value),
        maDirection: elements.alertForm.elements.maDirection.value,
        priceAbove: alertNumber(elements.alertForm.elements.priceAbove, { positive: true }),
        priceBelow: alertNumber(elements.alertForm.elements.priceBelow, { positive: true }),
        changeAbove: alertNumber(elements.alertForm.elements.changeAbove, { minimum: -100, maximum: 100 }),
        changeBelow: alertNumber(elements.alertForm.elements.changeBelow, { minimum: -100, maximum: 100 }),
      };
      if (alerts.priceAbove !== null && alerts.priceBelow !== null && alerts.priceBelow >= alerts.priceAbove) {
        throw invalidAlert("价格下限必须小于价格上限", elements.alertForm.elements.priceBelow);
      }
      if (alerts.changeAbove !== null && alerts.changeBelow !== null && alerts.changeBelow >= alerts.changeAbove) {
        throw invalidAlert("涨跌幅下限必须小于上限", elements.alertForm.elements.changeBelow);
      }

      elements.saveAlertsButton.disabled = true;
      const next = state.watchlist.map((stock) =>
        stockKey(stock) === key ? { ...stock, alerts } : stock,
      );
      const saved = await saveWatchlist(next, `${item.name}：提醒已保存`);
      if (saved) {
        closeAlertDialog();
        resetAndEvaluateStockAlerts(key);
      } else {
        elements.alertFormError.textContent = "提醒保存失败，请稍后重试";
        elements.alertFormError.hidden = false;
      }
    } catch (error) {
      elements.alertFormError.textContent = getErrorMessage(error, "提醒设置无效");
      elements.alertFormError.hidden = false;
      if (error?.field instanceof HTMLElement) {
        error.field.setAttribute("aria-invalid", "true");
        error.field.focus();
      }
    } finally {
      elements.saveAlertsButton.disabled = false;
    }
  }

  async function saveWatchlist(nextWatchlist, successMessage) {
    if (state.saving) return false;

    const previous = state.watchlist;
    state.watchlist = normalizeWatchlist(nextWatchlist);
    state.saving = true;
    renderCards();

    try {
      const response = await sendMessage("SAVE_WATCHLIST", { watchlist: state.watchlist });
      state.watchlist = normalizeWatchlist(response.watchlist ?? state.watchlist);
      hideNotice();
      showToast(successMessage);
      return true;
    } catch (error) {
      state.watchlist = previous;
      showNotice(getErrorMessage(error, "保存失败，请稍后重试。"));
      showToast("没有保存这次修改", "error");
      return false;
    } finally {
      state.saving = false;
      renderCards();
    }
  }

  async function refreshSnapshots(options = {}) {
    if (state.refreshing) return;
    if (state.watchlist.length === 0) {
      setSyncState("idle", "等待添加股票");
      return;
    }

    state.refreshing = true;
    elements.refreshButton.classList.add("is-spinning");
    elements.refreshButton.disabled = true;
    setSyncState("loading", "行情更新中…");
    renderCards();

    try {
      const response = await sendMessage("GET_SNAPSHOTS", { stocks: state.watchlist });
      state.snapshots = mergeSnapshots(
        state.snapshots,
        indexSnapshots(response.snapshots, state.watchlist),
        state.watchlist,
      );
      evaluateAlertNotifications();
      state.lastUpdatedAt = new Date();
      hideNotice();

      const failedCount = state.watchlist.filter((item) => {
        const snapshot = state.snapshots.get(stockKey(item));
        return !snapshot || Boolean(snapshot.error);
      }).length;
      if (failedCount === state.watchlist.length) {
        setSyncState("error", "行情暂时不可用");
      } else if (failedCount > 0) {
        setSyncState("warning", `${failedCount} 只股票更新失败`);
      } else {
        setSyncState("success", `${formatClock(state.lastUpdatedAt)} 已更新`);
      }

      elements.footerTime.textContent = `最近更新 ${formatClock(state.lastUpdatedAt)}`;
      if (options.announce) showToast("行情已刷新");
    } catch (error) {
      setSyncState("error", "行情更新失败");
      showNotice(getErrorMessage(error, "行情接口暂时不可用，已保留上次数据。"));
    } finally {
      state.refreshing = false;
      elements.refreshButton.classList.remove("is-spinning");
      elements.refreshButton.disabled = false;
      renderCards();
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void refreshSnapshots();
      else scheduleRefresh();
    }, REFRESH_INTERVAL_MS);
  }

  function renderCards() {
    const focusedElement = shadow.activeElement;
    const focusedCard = focusedElement?.closest?.(".dsh-stock-card");
    const focusedStockKey = focusedCard?.dataset.stockKey ?? null;
    const focusSelector = focusedElement?.matches?.('[data-role="chart"] svg')
      ? '[data-role="chart"] svg'
      : focusedElement?.dataset.action
        ? `[data-action="${focusedElement.dataset.action}"]`
        : null;
    elements.count.textContent = String(state.watchlist.length);
    elements.railCount.textContent = String(state.watchlist.length);
    // ponytail: refresh restores control focus; a focused chart returns to the latest point.
    elements.list.replaceChildren();

    if (state.watchlist.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dsh-stock-empty";
      empty.innerHTML = `
        <div class="dsh-stock-empty-chart" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span>
          <svg viewBox="0 0 180 72"><path d="M4 57 28 44 49 49 74 27 96 35 122 15 145 24 176 6"/></svg>
        </div>
        <strong>把关注标的放在这里</strong>
        <p>输入股票名称或代码，从联想结果中选择即可开始观察。</p>
        <button type="button" data-action="focus-search">添加第一只股票</button>
      `;
      elements.list.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    sortedWatchlist().forEach((item, index) => {
      fragment.append(createStockCard(item, state.snapshots.get(stockKey(item)), index));
    });
    elements.list.append(fragment);
    if (focusedStockKey && focusSelector) {
      elements.list
        .querySelector(`[data-stock-key="${focusedStockKey}"] ${focusSelector}`)
        ?.focus({ preventScroll: true });
    }
  }

  function createStockCard(item, snapshot, index) {
    const quote = snapshot?.error && !hasUsableQuote(snapshot?.quote) ? null : snapshot?.quote ?? null;
    const latest = finiteNumber(quote?.latest);
    const previousClose = finiteNumber(quote?.previousClose);
    const change = finiteNumber(quote?.change) ?? calculateChange(latest, previousClose);
    const changePercent = finiteNumber(quote?.changePercent) ?? calculateChangePercent(latest, previousClose);
    const ma5 = finiteNumber(snapshot?.ma5);
    const ma10 = finiteNumber(snapshot?.ma10);
    const ma20 = finiteNumber(snapshot?.ma20);
    const ma5Distance = ma5 && latest !== null ? ((latest / ma5) - 1) * 100 : null;
    const alerts = normalizeAlerts(item.alerts);
    const rules = alertRules(item, snapshot);
    const activeRules = rules.filter((rule) => rule.active);
    const isAlerting = activeRules.length > 0;
    const key = stockKey(item);

    const card = document.createElement("article");
    card.className = "dsh-stock-card";
    card.dataset.stockKey = key;
    card.style.setProperty("--card-index", String(index));
    if (isAlerting) card.classList.add("is-alerting");
    if (snapshot?.error) card.classList.add("has-error");
    if (!snapshot && state.refreshing) card.classList.add("is-loading");
    card.innerHTML = `
      <div class="dsh-stock-alert-banner" data-role="alert-banner" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17h.01M10.3 3.8 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg>
        <span data-role="alert-title"></span>
        <strong data-role="alert-value"></strong>
      </div>
      <header class="dsh-stock-card-header">
        <div>
          <div class="dsh-stock-name-row">
            <h3 data-role="name"></h3>
            <span class="dsh-stock-market" data-role="market"></span>
          </div>
          <span class="dsh-stock-code" data-role="code"></span>
        </div>
        <button class="dsh-stock-remove" type="button" data-action="remove" aria-label="移除股票" title="移除股票">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="dsh-stock-quote-row">
        <strong class="dsh-stock-price" data-role="price">—</strong>
        <div class="dsh-stock-change" data-role="change">
          <span data-role="change-value">—</span>
          <b data-role="change-percent">—</b>
        </div>
      </div>
      <div class="dsh-stock-chart" data-role="chart">
        <svg viewBox="0 0 310 110" preserveAspectRatio="none" role="img"></svg>
        <div class="dsh-stock-chart-tooltip" data-role="chart-tooltip" role="tooltip" hidden>
          <strong data-role="chart-tooltip-time"></strong>
          <span>价 <b data-role="chart-tooltip-price"></b></span>
          <span>均 <b data-role="chart-tooltip-average"></b></span>
          <span>幅 <b data-role="chart-tooltip-percent"></b></span>
          <span>量 <b data-role="chart-tooltip-volume"></b></span>
        </div>
        <div class="dsh-sr-only" data-role="chart-live" aria-live="polite"></div>
        <div class="dsh-stock-chart-empty" data-role="chart-empty">等待分时数据</div>
      </div>
      <dl class="dsh-stock-metrics">
        <div><dt>昨收</dt><dd data-role="previous-close">—</dd></div>
        <div><dt>MA5</dt><dd data-role="ma5">—</dd></div>
        <div><dt>MA10</dt><dd data-role="ma10">—</dd></div>
        <div><dt>MA20</dt><dd data-role="ma20">—</dd></div>
        <div><dt>距 MA5</dt><dd data-role="ma5-distance">—</dd></div>
      </dl>
      <div class="dsh-stock-condition" data-role="condition">
        <div class="dsh-stock-condition-copy">
          <span class="dsh-stock-condition-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4"/></svg>
          </span>
          <div><strong data-role="condition-title">提醒监控</strong><span data-role="condition-status">监控中</span></div>
        </div>
        <div class="dsh-stock-condition-actions">
          <label class="dsh-stock-switch">
            <input type="checkbox" data-action="toggle-ma">
            <span aria-hidden="true"></span>
            <em>均线提醒</em>
          </label>
          <button class="dsh-stock-alert-settings-button" type="button" data-action="configure-alerts">设置</button>
        </div>
      </div>
      <div class="dsh-stock-card-status">
        <span data-role="card-status">等待行情</span>
        <span data-role="quote-time"></span>
      </div>
    `;

    card.querySelector('[data-role="name"]').textContent = item.name;
    card.querySelector('[data-role="market"]').textContent = marketLabel(item.market);
    card.querySelector('[data-role="code"]').textContent = item.code;
    card.querySelector('[data-action="remove"]').setAttribute("data-stock-key", key);
    card.querySelector('[data-action="remove"]').setAttribute("aria-label", `移除 ${item.name}`);

    const toggle = card.querySelector('[data-action="toggle-ma"]');
    toggle.checked = alerts.maEnabled;
    toggle.disabled = state.saving;
    toggle.setAttribute("data-stock-key", key);
    toggle.setAttribute("aria-label", `${alerts.maEnabled ? "关闭" : "开启"}${item.name}的均线提醒`);
    const settingsButton = card.querySelector('[data-action="configure-alerts"]');
    settingsButton.setAttribute("data-stock-key", key);
    settingsButton.setAttribute("aria-label", `设置 ${item.name} 的提醒条件`);

    const alertBanner = card.querySelector('[data-role="alert-banner"]');
    if (isAlerting) {
      alertBanner.hidden = false;
      card.querySelector('[data-role="alert-title"]').textContent = activeRules.length === 1
        ? activeRules[0].label
        : `触发 ${activeRules.length} 项提醒`;
      card.querySelector('[data-role="alert-value"]').textContent = activeRules.length === 1
        ? activeRules[0].value
        : activeRules.map((rule) => rule.shortLabel).join(" · ");
    }

    if (latest !== null) {
      card.querySelector('[data-role="price"]').textContent = formatPrice(latest);
    }
    card.querySelector('[data-role="previous-close"]').textContent = formatPriceOrDash(previousClose);
    card.querySelector('[data-role="ma5"]').textContent = formatPriceOrDash(ma5);
    card.querySelector('[data-role="ma10"]').textContent = formatPriceOrDash(ma10);
    card.querySelector('[data-role="ma20"]').textContent = formatPriceOrDash(ma20);

    const distanceElement = card.querySelector('[data-role="ma5-distance"]');
    distanceElement.textContent = formatSignedPercent(ma5Distance);
    applyDirectionClass(distanceElement, ma5Distance);

    const changeElement = card.querySelector('[data-role="change"]');
    card.querySelector('[data-role="change-value"]').textContent = formatSignedPrice(change);
    card.querySelector('[data-role="change-percent"]').textContent = formatSignedPercent(changePercent);
    applyDirectionClass(changeElement, changePercent);
    applyDirectionClass(card.querySelector('[data-role="price"]'), changePercent);

    const maLabel = `${alerts.maDirection === "above" ? "高于" : "低于"} MA${alerts.maPeriod}`;
    card.querySelector('[data-role="condition-title"]').textContent = alerts.maEnabled ? maLabel : "自定义提醒";
    const conditionStatus = card.querySelector('[data-role="condition-status"]');
    if (activeRules.length > 0) {
      conditionStatus.textContent = `已触发 ${activeRules.length} 项`;
    } else if (rules.length > 0) {
      conditionStatus.textContent = `${rules.length} 项监控中`;
    } else {
      conditionStatus.textContent = "未设置提醒";
    }

    const statusElement = card.querySelector('[data-role="card-status"]');
    if (snapshot?.error) {
      statusElement.textContent = snapshot.error;
      statusElement.title = snapshot.error;
    } else if (!snapshot && state.refreshing) {
      statusElement.textContent = "行情载入中…";
    } else if (snapshot) {
      statusElement.textContent = "实时行情";
    }

    const quoteTime = quote?.quotedAt ?? snapshot?.updatedAt;
    card.querySelector('[data-role="quote-time"]').textContent = formatQuoteTime(quoteTime);
    renderIntradayChart(card, snapshot, changePercent);
    return card;
  }

  function renderIntradayChart(card, snapshot, changePercent) {
    const chart = card.querySelector('[data-role="chart"]');
    const svg = card.querySelector('[data-role="chart"] svg');
    const empty = card.querySelector('[data-role="chart-empty"]');
    const tooltip = card.querySelector('[data-role="chart-tooltip"]');
    const chartLive = card.querySelector('[data-role="chart-live"]');
    const intraday = Array.isArray(snapshot?.intraday)
      ? snapshot.intraday
          .map((point) => ({
            time: String(point?.time ?? ""),
            price: finiteNumber(point?.price),
            averagePrice: finiteNumber(point?.averagePrice),
            volume: Math.max(0, finiteNumber(point?.volume) ?? 0),
          }))
          .filter((point) => point.price !== null)
      : [];

    if (intraday.length < 2) {
      empty.hidden = false;
      svg.replaceChildren();
      return;
    }

    empty.hidden = true;
    const previousClose = finiteNumber(snapshot?.quote?.previousClose) ?? intraday[0].price;
    if (!previousClose || previousClose <= 0) return;

    const plot = { left: 49, right: 257, top: 9, bottom: 64 };
    const volumePlot = { top: 70, bottom: 84 };
    const chartPrices = intraday.flatMap((point) =>
      point.averagePrice === null ? [point.price] : [point.price, point.averagePrice],
    );
    const maxDeviation = chartPrices.reduce(
      (maximum, price) => Math.max(maximum, Math.abs((price - previousClose) / previousClose)),
      0,
    );
    const rangeRatio = Math.max(maxDeviation * 1.12, 0.005);
    const upperPrice = previousClose * (1 + rangeRatio);
    const lowerPrice = previousClose * (1 - rangeRatio);
    const xAt = (point, index) => {
      const minute = tradingMinuteOffset(point.time) ?? Math.min(index, 240);
      return plot.left + (minute / 240) * (plot.right - plot.left);
    };
    const yAt = (price) => {
      const bounded = Math.min(upperPrice, Math.max(lowerPrice, price));
      return plot.top + ((upperPrice - bounded) / (upperPrice - lowerPrice)) * (plot.bottom - plot.top);
    };
    const highIndex = intraday.reduce((best, point, index) =>
      point.price > intraday[best].price ? index : best, 0);
    const lowIndex = intraday.reduce((best, point, index) =>
      point.price < intraday[best].price ? index : best, 0);
    const highPoint = intraday[highIndex];
    const lowPoint = intraday[lowIndex];

    svg.replaceChildren();
    const stockName = snapshot.symbol?.name ?? "股票";
    const chartLabel = `${stockName}分时价格、均价与成交量图，分时最高 ${formatPrice(highPoint.price)} ${formatMinuteTime(highPoint.time)}，分时最低 ${formatPrice(lowPoint.price)} ${formatMinuteTime(lowPoint.time)}`;
    svg.setAttribute("role", "slider");
    svg.setAttribute("aria-label", `${stockName}分时分钟数据`);
    svg.setAttribute("aria-description", chartLabel);
    svg.setAttribute("aria-orientation", "horizontal");
    svg.setAttribute("aria-valuemin", "0");
    svg.setAttribute("aria-valuemax", String(intraday.length - 1));
    svg.setAttribute("tabindex", "0");

    const levels = [
      { y: plot.top, price: upperPrice, percent: rangeRatio * 100 },
      { y: (plot.top + plot.bottom) / 2, price: previousClose, percent: 0 },
      { y: plot.bottom, price: lowerPrice, percent: -rangeRatio * 100 },
    ];

    levels.forEach((level, index) => {
      const line = svgNode("line", {
        x1: plot.left,
        x2: plot.right,
        y1: level.y,
        y2: level.y,
        class: index === 1 ? "chart-grid chart-grid-baseline" : "chart-grid",
      });
      svg.append(line);

      const priceLabel = svgNode("text", {
        x: plot.left - 5,
        y: level.y,
        class: "chart-axis chart-axis-price",
        "text-anchor": "end",
        "dominant-baseline": "middle",
      });
      priceLabel.textContent = formatPrice(level.price);
      svg.append(priceLabel);

      const percentLabel = svgNode("text", {
        x: plot.right + 5,
        y: level.y,
        class: `chart-axis chart-axis-percent ${level.percent > 0 ? "is-up" : level.percent < 0 ? "is-down" : ""}`,
        "dominant-baseline": "middle",
      });
      percentLabel.textContent = `${level.percent > 0 ? "+" : ""}${level.percent.toFixed(2)}%`;
      svg.append(percentLabel);
    });
    svg.append(svgNode("line", {
      x1: plot.left,
      x2: plot.right,
      y1: 67,
      y2: 67,
      class: "chart-volume-divider",
    }));
    const volumeLabel = svgNode("text", {
      x: plot.left - 5,
      y: (volumePlot.top + volumePlot.bottom) / 2,
      class: "chart-volume-label",
      "text-anchor": "end",
      "dominant-baseline": "middle",
    });
    volumeLabel.textContent = "量";
    svg.append(volumeLabel);

    const plotted = intraday.map((point, index) => ({
      ...point,
      x: xAt(point, index),
      priceY: yAt(point.price),
      averageY: point.averagePrice === null ? null : yAt(point.averagePrice),
    }));
    const maxVolume = plotted.reduce((maximum, point) => Math.max(maximum, point.volume), 0);
    if (maxVolume > 0) {
      const barWidth = Math.max(0.55, (plot.right - plot.left) / 240 * 0.72);
      plotted.forEach((point, index) => {
        if (point.volume <= 0) return;
        const height = Math.max(0.45, point.volume / maxVolume * (volumePlot.bottom - volumePlot.top));
        const previousPrice = index > 0 ? plotted[index - 1].price : previousClose;
        svg.append(svgNode("rect", {
          x: point.x - barWidth / 2,
          y: volumePlot.bottom - height,
          width: barWidth,
          height,
          class: `chart-volume-bar ${point.price >= previousPrice ? "is-up" : "is-down"}`,
        }));
      });
    }
    const averagePoints = plotted
      .flatMap((point) => point.averageY === null
        ? []
        : [`${point.x.toFixed(2)},${point.averageY.toFixed(2)}`])
      .join(" ");
    if (averagePoints) {
      svg.append(svgNode("polyline", { points: averagePoints, class: "chart-average-line" }));
    }

    const pricePoints = plotted
      .map((point) => `${point.x.toFixed(2)},${point.priceY.toFixed(2)}`)
      .join(" ");
    const lineClass = changePercent !== null && changePercent < 0 ? "is-down" : "is-up";
    svg.append(svgNode("polyline", { points: pricePoints, class: `chart-price-line ${lineClass}` }));

    const lastPoint = plotted[plotted.length - 1];
    svg.append(svgNode("circle", {
      cx: lastPoint.x,
      cy: lastPoint.priceY,
      r: 2.6,
      class: `chart-last-point ${lineClass}`,
    }));
    const appendExtreme = (point, kind, labelX, anchor) => {
      const marker = svgNode("g", { class: `chart-extreme is-${kind}` });
      marker.append(svgNode("circle", { cx: point.x, cy: point.priceY, r: 1.5 }));
      const label = svgNode("text", {
        x: labelX,
        y: 4.5,
        "text-anchor": anchor,
        "dominant-baseline": "middle",
      });
      label.textContent = `${kind === "high" ? "高" : "低"} ${formatPrice(point.price)}`;
      marker.append(label);
      svg.append(marker);
    };
    appendExtreme(plotted[highIndex], "high", plot.left, "start");
    if (lowIndex !== highIndex) appendExtreme(plotted[lowIndex], "low", plot.right, "end");

    [
      { x: plot.left, anchor: "start", text: "09:30" },
      { x: plot.left + (plot.right - plot.left) / 4, anchor: "middle", text: "10:30" },
      { x: (plot.left + plot.right) / 2, anchor: "middle", text: "11:30/13:00" },
      { x: plot.left + (plot.right - plot.left) * 3 / 4, anchor: "middle", text: "14:00" },
      { x: plot.right, anchor: "end", text: "15:00" },
    ].forEach((label) => {
      const node = svgNode("text", {
        x: label.x,
        y: 102,
        class: "chart-time",
        "text-anchor": label.anchor,
      });
      node.textContent = label.text;
      svg.append(node);
    });

    const crosshair = svgNode("g", { class: "chart-crosshair", "aria-hidden": "true" });
    const vertical = svgNode("line", {
      y1: plot.top,
      y2: volumePlot.bottom,
      class: "chart-crosshair-line",
    });
    const horizontal = svgNode("line", {
      x1: plot.left,
      x2: plot.right,
      class: "chart-crosshair-line is-horizontal",
    });
    const priceMarker = svgNode("circle", {
      r: 3,
      class: `chart-crosshair-dot is-price ${lineClass}`,
    });
    const averageMarker = svgNode("circle", {
      r: 2.5,
      class: "chart-crosshair-dot is-average",
    });
    crosshair.append(vertical, horizontal, priceMarker, averageMarker);
    svg.append(crosshair);

    const tooltipTime = tooltip.querySelector('[data-role="chart-tooltip-time"]');
    const tooltipPrice = tooltip.querySelector('[data-role="chart-tooltip-price"]');
    const tooltipAverage = tooltip.querySelector('[data-role="chart-tooltip-average"]');
    const tooltipPercent = tooltip.querySelector('[data-role="chart-tooltip-percent"]');
    const tooltipVolume = tooltip.querySelector('[data-role="chart-tooltip-volume"]');
    let inspectedIndex = plotted.length - 1;
    const pointDescription = (point) => {
      const percent = ((point.price / previousClose) - 1) * 100;
      return `${formatMinuteTime(point.time)}，价格 ${formatPrice(point.price)}，均价 ${formatPriceOrDash(point.averagePrice)}，涨跌幅 ${formatSignedPercent(percent)}，成交量 ${formatVolume(point.volume)}`;
    };
    svg.setAttribute("aria-valuenow", String(inspectedIndex));
    svg.setAttribute("aria-valuetext", pointDescription(lastPoint));

    const showPoint = (index) => {
      const point = plotted[index];
      const percent = ((point.price / previousClose) - 1) * 100;
      inspectedIndex = index;
      vertical.setAttribute("x1", point.x);
      vertical.setAttribute("x2", point.x);
      horizontal.setAttribute("y1", point.priceY);
      horizontal.setAttribute("y2", point.priceY);
      priceMarker.setAttribute("cx", point.x);
      priceMarker.setAttribute("cy", point.priceY);
      averageMarker.toggleAttribute("hidden", point.averageY === null);
      if (point.averageY !== null) {
        averageMarker.setAttribute("cx", point.x);
        averageMarker.setAttribute("cy", point.averageY);
      }
      tooltipTime.textContent = formatMinuteTime(point.time);
      tooltipPrice.textContent = formatPrice(point.price);
      tooltipAverage.textContent = formatPriceOrDash(point.averagePrice);
      tooltipPercent.textContent = formatSignedPercent(percent);
      tooltipVolume.textContent = formatVolume(point.volume);
      tooltipPercent.className = percent > 0 ? "is-up" : percent < 0 ? "is-down" : "";
      tooltip.dataset.side = point.x > (plot.left + plot.right) / 2 ? "left" : "right";
      tooltip.style.left = `${(point.x / 310 * 100).toFixed(2)}%`;
      tooltip.hidden = false;
      crosshair.classList.add("is-visible");
      const description = pointDescription(point);
      svg.setAttribute("aria-valuenow", String(index));
      svg.setAttribute("aria-valuetext", description);
      if (shadow.activeElement === svg) chartLive.textContent = description;
    };
    const hidePoint = () => {
      tooltip.hidden = true;
      crosshair.classList.remove("is-visible");
    };

    chart.addEventListener("pointermove", (event) => {
      const bounds = svg.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const x = (event.clientX - bounds.left) / bounds.width * 310;
      const y = (event.clientY - bounds.top) / bounds.height * 110;
      if (x < plot.left || x > plot.right || y < plot.top || y > volumePlot.bottom) {
        hidePoint();
        return;
      }
      const nearestIndex = plotted.reduce((best, point, index) =>
        Math.abs(point.x - x) <= Math.abs(plotted[best].x - x) ? index : best, 0);
      showPoint(nearestIndex);
    });
    chart.addEventListener("pointerleave", hidePoint);
    svg.addEventListener("focus", () => {
      if (tooltip.hidden) showPoint(plotted.length - 1);
    });
    svg.addEventListener("blur", hidePoint);
    svg.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePoint();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.key === "ArrowLeft" ? -1 : 1;
      showPoint(Math.min(plotted.length - 1, Math.max(0, inspectedIndex + step)));
    });
  }

  function renderSearchResults() {
    elements.searchResults.replaceChildren();
    elements.searchResults.hidden = false;
    elements.searchInput.setAttribute("aria-expanded", "true");

    if (state.searchResults.length === 0) {
      renderSearchMessage("没有找到匹配的 A 股", "empty");
      return;
    }

    state.searchResults.forEach((candidate, index) => {
      const existing = hasStock(candidate);
      const option = document.createElement("button");
      option.type = "button";
      option.className = "dsh-stock-search-option";
      option.setAttribute("role", "option");
      option.setAttribute("data-action", "select-search-result");
      option.setAttribute("data-result-index", String(index));
      option.setAttribute("aria-selected", String(index === state.activeSearchIndex));
      option.disabled = existing || state.saving;

      const identity = document.createElement("span");
      identity.className = "dsh-stock-search-identity";
      const name = document.createElement("strong");
      name.textContent = candidate.name;
      const meta = document.createElement("span");
      meta.textContent = `${candidate.code} · ${marketLabel(candidate.market)}`;
      identity.append(name, meta);

      const action = document.createElement("span");
      action.className = "dsh-stock-search-action";
      action.textContent = existing ? "已添加" : "+ 添加";
      option.append(identity, action);
      elements.searchResults.append(option);
    });
  }

  function renderSearchMessage(message, kind) {
    elements.searchResults.replaceChildren();
    elements.searchResults.hidden = false;
    elements.searchInput.setAttribute("aria-expanded", "true");
    const status = document.createElement("div");
    status.className = `dsh-stock-search-message is-${kind}`;
    status.textContent = message;
    elements.searchResults.append(status);
  }

  function closeSearchResults() {
    elements.searchResults.hidden = true;
    elements.searchInput.setAttribute("aria-expanded", "false");
    state.activeSearchIndex = -1;
  }

  function moveActiveSearchResult(step) {
    if (state.searchResults.length === 0) return;
    let nextIndex = state.activeSearchIndex;
    for (let attempts = 0; attempts < state.searchResults.length; attempts += 1) {
      nextIndex = (nextIndex + step + state.searchResults.length) % state.searchResults.length;
      if (!hasStock(state.searchResults[nextIndex])) break;
    }
    state.activeSearchIndex = hasStock(state.searchResults[nextIndex]) ? -1 : nextIndex;
    const options = elements.searchResults.querySelectorAll('[role="option"]');
    options.forEach((option, index) => {
      const selected = index === state.activeSearchIndex;
      option.setAttribute("aria-selected", String(selected));
      if (selected) option.scrollIntoView({ block: "nearest" });
    });
  }

  function setSyncState(kind, message) {
    elements.syncDot.className = `dsh-stock-sync-dot is-${kind}`;
    elements.syncStatus.textContent = message;
  }

  function showNotice(message) {
    elements.noticeText.textContent = message;
    elements.notice.hidden = false;
  }

  function hideNotice() {
    elements.notice.hidden = true;
  }

  let toastTimer = null;
  function showToast(message, kind = "success") {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `dsh-stock-toast is-visible is-${kind}`;
    toastTimer = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 2200);
  }

  function sendMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response) {
          reject(new Error("插件后台没有响应"));
          return;
        }
        if (response.ok === false) {
          reject(new Error(response.error || "请求失败"));
          return;
        }
        resolve(response);
      });
    });
  }

  function normalizeWatchlist(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.flatMap((item) => {
      const normalized = normalizeStock(item);
      if (!normalized) return [];
      const key = stockKey(normalized);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        ...normalized,
        alerts: normalizeAlerts(item?.alerts),
      }];
    });
  }

  function normalizeAlerts(value) {
    const source = value && typeof value === "object" ? value : {};
    const maPeriod = [5, 10, 20].includes(Number(source.maPeriod)) ? Number(source.maPeriod) : 5;
    const maDirection = source.maDirection === "above" ? "above" : "below";
    return {
      maEnabled: typeof source.maEnabled === "boolean" ? source.maEnabled : source.belowMa5 !== false,
      maPeriod,
      maDirection,
      priceAbove: normalizedAlertNumber(source.priceAbove, { positive: true }),
      priceBelow: normalizedAlertNumber(source.priceBelow, { positive: true }),
      changeAbove: normalizedAlertNumber(source.changeAbove, { minimum: -100, maximum: 100 }),
      changeBelow: normalizedAlertNumber(source.changeBelow, { minimum: -100, maximum: 100 }),
    };
  }

  function normalizedAlertNumber(value, options) {
    const number = finiteNumber(value);
    if (number === null) return null;
    if (options.positive && number <= 0) return null;
    if (options.minimum !== undefined && number < options.minimum) return null;
    if (options.maximum !== undefined && number > options.maximum) return null;
    return number;
  }

  function alertNumber(input, options) {
    const text = input.value.trim();
    input.removeAttribute("aria-invalid");
    if (!text) return null;
    const number = Number(text);
    if (!Number.isFinite(number)
      || (options.positive && number <= 0)
      || (options.minimum !== undefined && number < options.minimum)
      || (options.maximum !== undefined && number > options.maximum)) {
      throw invalidAlert("请输入有效的提醒数值", input);
    }
    return number;
  }

  function invalidAlert(message, field) {
    const error = new Error(message);
    error.field = field;
    return error;
  }

  function inputValue(value) {
    return value === null ? "" : String(value);
  }

  function alertRules(item, snapshot) {
    const alerts = normalizeAlerts(item?.alerts);
    const latest = finiteNumber(snapshot?.quote?.latest);
    const changePercent = finiteNumber(snapshot?.quote?.changePercent);
    const rules = [];
    const addThresholdRule = (key, threshold, current, comparison, label, shortLabel, formatter) => {
      if (threshold === null) return;
      rules.push({
        key,
        label: `${label} ${formatter(threshold)}`,
        shortLabel,
        active: current !== null && comparison(current, threshold),
        value: formatter(current),
      });
    };
    addThresholdRule("price-above", alerts.priceAbove, latest, (current, threshold) => current >= threshold, "价格 ≥", "价↑", formatPrice);
    addThresholdRule("price-below", alerts.priceBelow, latest, (current, threshold) => current <= threshold, "价格 ≤", "价↓", formatPrice);
    addThresholdRule("change-above", alerts.changeAbove, changePercent, (current, threshold) => current >= threshold, "涨跌幅 ≥", "幅↑", formatSignedPercent);
    addThresholdRule("change-below", alerts.changeBelow, changePercent, (current, threshold) => current <= threshold, "涨跌幅 ≤", "幅↓", formatSignedPercent);
    if (alerts.maEnabled) {
      const average = finiteNumber(snapshot?.[`ma${alerts.maPeriod}`]);
      const distance = average && latest !== null ? (latest / average - 1) * 100 : null;
      const above = alerts.maDirection === "above";
      rules.push({
        key: `ma-${alerts.maPeriod}-${alerts.maDirection}`,
        label: `${above ? "高于" : "低于"} MA${alerts.maPeriod}`,
        shortLabel: `MA${alerts.maPeriod}${above ? "↑" : "↓"}`,
        active: latest !== null && average !== null && (above ? latest > average : latest < average),
        value: formatSignedPercent(distance),
      });
    }
    return rules;
  }

  function sortedWatchlist() {
    const entries = state.watchlist.map((item, index) => ({ item, index }));
    if (state.sortMode === "watchlist") return entries.map(({ item }) => item);
    const nullableNumber = (left, right, direction) => {
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return (left - right) * direction;
    };
    entries.sort((left, right) => {
      let result = 0;
      if (state.sortMode === "alerts") {
        result = alertRules(right.item, state.snapshots.get(stockKey(right.item))).filter((rule) => rule.active).length
          - alertRules(left.item, state.snapshots.get(stockKey(left.item))).filter((rule) => rule.active).length;
      } else if (state.sortMode === "gainers" || state.sortMode === "losers") {
        const leftChange = finiteNumber(state.snapshots.get(stockKey(left.item))?.quote?.changePercent);
        const rightChange = finiteNumber(state.snapshots.get(stockKey(right.item))?.quote?.changePercent);
        result = nullableNumber(leftChange, rightChange, state.sortMode === "gainers" ? -1 : 1);
      } else if (state.sortMode === "code") {
        result = left.item.code.localeCompare(right.item.code);
      }
      return result || left.index - right.index;
    });
    return entries.map(({ item }) => item);
  }

  function resetAndEvaluateStockAlerts(key) {
    const prefix = `${key}:`;
    state.activeAlertIds.forEach((id) => {
      if (id.startsWith(prefix)) state.activeAlertIds.delete(id);
    });
    evaluateAlertNotifications();
  }

  function evaluateAlertNotifications() {
    const nextActive = new Set();
    state.watchlist.forEach((item) => {
      const key = stockKey(item);
      const prefix = `${key}:`;
      const snapshot = state.snapshots.get(key);
      if (!snapshot || snapshot.stale || !hasUsableQuote(snapshot.quote)) {
        state.activeAlertIds.forEach((id) => {
          if (id.startsWith(prefix)) nextActive.add(id);
        });
        return;
      }
      const newlyActive = [];
      alertRules(item, snapshot).forEach((rule) => {
        if (!rule.active) return;
        const id = `${prefix}${rule.key}`;
        nextActive.add(id);
        if (!state.activeAlertIds.has(id)) newlyActive.push(rule);
      });
      if (state.alertsPrimed && newlyActive.length > 0) {
        const latest = finiteNumber(snapshot.quote.latest);
        const changePercent = finiteNumber(snapshot.quote.changePercent);
        const retryIds = newlyActive.map((rule) => `${prefix}${rule.key}`);
        showToast(`${item.name}：${newlyActive.map((rule) => rule.shortLabel).join("、")}`, "error");
        void sendMessage("SHOW_NOTIFICATION", {
          id: `stock-alert-${key}`,
          title: `${item.name} 触发提醒`,
          message: `${newlyActive.map((rule) => rule.label).join("、")}；现价 ${formatPrice(latest)}，涨跌幅 ${formatSignedPercent(changePercent)}`,
        }).catch((error) => {
          retryIds.forEach((id) => state.activeAlertIds.delete(id));
          showNotice(getErrorMessage(error, "桌面提醒发送失败"));
        });
      }
    });
    state.activeAlertIds = nextActive;
    state.alertsPrimed = true;
  }

  function normalizeSearchResults(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.flatMap((item) => {
      const normalized = normalizeStock(item);
      if (!normalized) return [];
      const key = stockKey(normalized);
      if (seen.has(key)) return [];
      seen.add(key);
      return [normalized];
    });
  }

  function normalizeStock(item) {
    if (!item || typeof item !== "object") return null;
    const name = String(item.name ?? "").trim();
    const code = String(item.code ?? "").trim();
    const market = String(item.market ?? "").trim().toUpperCase();
    if (!name || !/^\d{6}$/.test(code) || !["SSE", "SZSE"].includes(market)) return null;
    return { name, code, market };
  }

  function indexSnapshots(value, requestedStocks) {
    const map = new Map();
    if (!Array.isArray(value)) return map;
    value.forEach((snapshot, index) => {
      const symbol = normalizeStock(snapshot?.symbol);
      const fallback = requestedStocks[index];
      const key = symbol ? stockKey(symbol) : fallback ? stockKey(fallback) : null;
      if (key) map.set(key, snapshot);
    });
    return map;
  }

  function mergeSnapshots(previous, incoming, watchlist) {
    const merged = new Map();
    watchlist.forEach((item) => {
      const key = stockKey(item);
      const nextSnapshot = incoming.get(key);
      const lastSnapshot = previous.get(key);
      if (nextSnapshot?.error
        && !hasUsableQuote(nextSnapshot?.quote)
        && hasUsableQuote(lastSnapshot?.quote)) {
        merged.set(key, {
          ...lastSnapshot,
          updatedAt: nextSnapshot.updatedAt ?? lastSnapshot.updatedAt,
          error: nextSnapshot.error,
          stale: true,
        });
      } else if (nextSnapshot) {
        merged.set(key, { ...nextSnapshot, stale: false });
      } else if (lastSnapshot) {
        merged.set(key, {
          ...lastSnapshot,
          error: "本轮行情没有返回这只股票",
          stale: true,
        });
      }
    });
    return merged;
  }

  function stockKey(stock) {
    return `${stock.market}:${stock.code}`;
  }

  function hasUsableQuote(quote) {
    const latest = finiteNumber(quote?.latest);
    return latest !== null && latest > 0;
  }

  function hasStock(stock) {
    const key = stockKey(stock);
    return state.watchlist.some((item) => stockKey(item) === key);
  }

  function marketLabel(market) {
    return market === "SSE" ? "沪 A" : market === "SZSE" ? "深 A" : market;
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function calculateChange(latest, previousClose) {
    return latest !== null && previousClose !== null ? latest - previousClose : null;
  }

  function calculateChangePercent(latest, previousClose) {
    return latest !== null && previousClose ? ((latest / previousClose) - 1) * 100 : null;
  }

  function formatPrice(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return number.toFixed(2);
  }

  function formatPriceOrDash(value) {
    return value === null || value === undefined ? "—" : formatPrice(value);
  }

  function formatVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "—";
    if (number >= 100_000_000) return `${(number / 100_000_000).toFixed(2)}亿`;
    if (number >= 10_000) return `${(number / 10_000).toFixed(2)}万`;
    return String(Math.round(number));
  }

  function formatSignedPrice(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${formatPrice(number)}`;
  }

  function formatSignedPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
  }

  function applyDirectionClass(element, value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
    if (Number(value) > 0) element.classList.add("is-up");
    if (Number(value) < 0) element.classList.add("is-down");
  }

  function formatClock(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatQuoteTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return formatClock(date);
    const match = String(value).match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
    return match ? `${match[1]}:${match[2]}${match[3] ? `:${match[3]}` : ""}` : "";
  }

  function formatMinuteTime(value) {
    const text = String(value ?? "");
    const colonClock = text.match(/(?:^|\s|T)(\d{2}):(\d{2})(?::\d{2})?$/);
    if (colonClock) return `${colonClock[1]}:${colonClock[2]}`;
    const compactClock = text.match(/(?:^|\s)(\d{2})(\d{2})$/);
    return compactClock ? `${compactClock[1]}:${compactClock[2]}` : "";
  }

  function tradingMinuteOffset(value) {
    const clock = formatMinuteTime(value).match(/^(\d{2}):(\d{2})$/);
    if (!clock) return null;
    const minute = Number(clock[1]) * 60 + Number(clock[2]);
    if (minute >= 570 && minute <= 690) return minute - 570;
    if (minute >= 780 && minute <= 900) return minute - 660;
    return null;
  }

  function getErrorMessage(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  function svgNode(tag, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    return node;
  }
})();
