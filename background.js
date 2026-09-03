// Arc can retain an unpacked extension's imported module across reloads.  Keep
// this query synchronized with manifest.version; a focused test enforces it.
import { StockApiError, buildSnapshot, fetchSnapshot, normalizeStock, searchStocks } from './market-api.mjs?v=0.1.8'

/** Local-storage key owned by this extension. */
export const WATCHLIST_STORAGE_KEY = 'stockChatSidebar.watchlist'

const DEFAULT_ALERTS = Object.freeze({
  maEnabled: true,
  maPeriod: 5,
  maDirection: 'below',
  priceAbove: null,
  priceBelow: null,
  changeAbove: null,
  changeBelow: null,
})
const NOTIFICATION_ICON = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"%3E%3Crect width="128" height="128" rx="24" fill="%2395641f"/%3E%3Cpath d="M22 88 45 62l20 13 39-43" fill="none" stroke="white" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/%3E%3C/svg%3E'

/** New installs start without revealing any example-stock preference. */
export const DEFAULT_WATCHLIST = Object.freeze([])

const MAX_WATCHLIST_SIZE = 50
const installedRuntimes = new WeakSet()
let memoryWatchlist

/**
 * Normalize, deduplicate, and cap a list before persisting it.
 *
 * @param {unknown} input - Message-provided list.
 * @returns {Array<object>} Safe list with canonical alert settings.
 */
export function normalizeWatchlist(input) {
  if (!Array.isArray(input)) throw new StockApiError('自选股列表必须是数组', 'INVALID_WATCHLIST')
  if (input.length > MAX_WATCHLIST_SIZE) {
    throw new StockApiError(`最多只能添加 ${MAX_WATCHLIST_SIZE} 只股票`, 'WATCHLIST_LIMIT')
  }
  const seen = new Set()
  const list = []
  for (const entry of input) {
    const symbol = normalizeStock(entry)
    const key = `${symbol.market}:${symbol.code}`
    if (seen.has(key)) continue
    seen.add(key)
    const rawAlerts = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? entry.alerts
      : undefined
    list.push({ ...symbol, alerts: normalizeAlerts(rawAlerts) })
  }
  return list
}

/**
 * Read the persisted list, falling back to an empty watchlist.
 *
 * @param {object} [storageArea] - `chrome.storage.local`-compatible object.
 * @returns {Promise<Array<object>>} Watchlist clone.
 */
export async function getWatchlist(storageArea = globalThis.chrome?.storage?.local) {
  if (!storageArea) return cloneWatchlist(memoryWatchlist ?? DEFAULT_WATCHLIST)
  const values = await chromeStorageCall(storageArea, 'get', WATCHLIST_STORAGE_KEY)
  const stored = values?.[WATCHLIST_STORAGE_KEY]
  if (stored === undefined) return cloneWatchlist(DEFAULT_WATCHLIST)
  try {
    return normalizeWatchlist(stored)
  } catch {
    // Corrupt extension-owned storage cannot be safely rendered.  Keep the
    // invalid value untouched so a user can still inspect/clear it in Chrome.
    return cloneWatchlist(DEFAULT_WATCHLIST)
  }
}

/**
 * Persist a validated list.
 *
 * @param {unknown} input - Watchlist message field.
 * @param {object} [storageArea] - `chrome.storage.local`-compatible object.
 * @returns {Promise<Array<object>>} Saved list clone.
 */
export async function saveWatchlist(input, storageArea = globalThis.chrome?.storage?.local) {
  const watchlist = normalizeWatchlist(input)
  if (storageArea) {
    await chromeStorageCall(storageArea, 'set', { [WATCHLIST_STORAGE_KEY]: watchlist })
  } else {
    memoryWatchlist = cloneWatchlist(watchlist)
  }
  return cloneWatchlist(watchlist)
}

/**
 * Handle one MV3 runtime request.  Dependencies are injectable for Node tests.
 *
 * @param {unknown} message - Runtime message.
 * @param {{storageArea?: object,search?: Function,snapshot?: Function,notify?: Function}} [dependencies] - Test/runtime dependencies.
 * @returns {Promise<object>} JSON-serializable response.
 */
export async function handleMessage(message, dependencies = {}) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return failure(new StockApiError('消息格式无效', 'INVALID_MESSAGE'))
  }
  const request = /** @type {Record<string, unknown>} */ (message)
  const storageArea = dependencies.storageArea ?? globalThis.chrome?.storage?.local
  const search = dependencies.search ?? searchStocks
  const snapshot = dependencies.snapshot ?? fetchSnapshot
  const notify = dependencies.notify ?? createNotification
  try {
    switch (request.type) {
      case 'SEARCH_STOCKS': {
        if (typeof request.query !== 'string') throw new StockApiError('搜索词必须是文本', 'INVALID_QUERY')
        const results = await search(request.query)
        return { ok: true, results }
      }
      case 'GET_WATCHLIST': {
        const watchlist = await getWatchlist(storageArea)
        return { ok: true, watchlist }
      }
      case 'SAVE_WATCHLIST': {
        const watchlist = await saveWatchlist(request.watchlist, storageArea)
        return { ok: true, watchlist }
      }
      case 'GET_SNAPSHOTS': {
        const stocks = request.stocks === undefined
          ? await getWatchlist(storageArea)
          : normalizeWatchlist(request.stocks)
        const snapshots = await Promise.all(stocks.map(async (stock) => {
          try {
            return await snapshot(stock)
          } catch (error) {
            return failedSnapshot(stock, error)
          }
        }))
        return { ok: true, snapshots }
      }
      case 'SHOW_NOTIFICATION': {
        const notification = normalizeNotification(request)
        await notify(notification.id, {
          type: 'basic',
          iconUrl: NOTIFICATION_ICON,
          title: notification.title,
          message: notification.message,
        })
        return { ok: true, id: notification.id }
      }
      default:
        throw new StockApiError(`不支持的消息类型：${String(request.type ?? '')}`, 'UNKNOWN_MESSAGE')
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Register the service-worker listener once for a Chrome runtime.
 *
 * @param {typeof chrome} [chromeApi] - Browser API object.
 * @returns {boolean} Whether a listener was installed.
 */
export function installBackground(chromeApi = globalThis.chrome) {
  const runtime = chromeApi?.runtime
  if (!runtime?.onMessage?.addListener || installedRuntimes.has(runtime)) return false
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void handleMessage(message, {
      storageArea: chromeApi.storage?.local,
      notify: (id, options) => createNotification(id, options, chromeApi.notifications),
    })
      .then(sendResponse)
      .catch((error) => sendResponse(failure(error)))
    return true
  })
  installedRuntimes.add(runtime)
  return true
}

function failedSnapshot(stock, error) {
  return buildSnapshot(stock, { error: errorText(error) })
}

function failure(error) {
  return {
    ok: false,
    error: errorText(error),
    code: error instanceof StockApiError ? error.code : 'UNEXPECTED',
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function cloneWatchlist(list) {
  return Array.from(list, (entry) => ({
    name: entry.name,
    code: entry.code,
    market: entry.market,
    alerts: normalizeAlerts(entry.alerts),
  }))
}

function normalizeAlerts(input) {
  const alerts = input === undefined || input === null ? {} : input
  if (typeof alerts !== 'object' || Array.isArray(alerts)) {
    throw new StockApiError('提醒设置必须是对象', 'INVALID_ALERT')
  }
  if (alerts.maEnabled !== undefined && typeof alerts.maEnabled !== 'boolean') {
    throw new StockApiError('均线提醒开关必须是布尔值', 'INVALID_ALERT')
  }
  if (alerts.belowMa5 !== undefined && typeof alerts.belowMa5 !== 'boolean') {
    throw new StockApiError('belowMa5 必须是布尔值', 'INVALID_ALERT')
  }
  const maPeriod = alerts.maPeriod ?? 5
  if (![5, 10, 20].includes(maPeriod)) {
    throw new StockApiError('均线周期只能是 5、10 或 20', 'INVALID_ALERT')
  }
  const maDirection = alerts.maDirection ?? 'below'
  if (maDirection !== 'above' && maDirection !== 'below') {
    throw new StockApiError('均线提醒方向只能是 above 或 below', 'INVALID_ALERT')
  }
  const normalized = {
    maEnabled: alerts.maEnabled ?? alerts.belowMa5 ?? DEFAULT_ALERTS.maEnabled,
    maPeriod,
    maDirection,
    priceAbove: normalizeThreshold(alerts.priceAbove, '上破价格', (value) => value > 0),
    priceBelow: normalizeThreshold(alerts.priceBelow, '跌破价格', (value) => value > 0),
    changeAbove: normalizeThreshold(alerts.changeAbove, '涨幅上限', (value) => value >= -100 && value <= 100),
    changeBelow: normalizeThreshold(alerts.changeBelow, '涨幅下限', (value) => value >= -100 && value <= 100),
  }
  if (normalized.priceBelow !== null && normalized.priceAbove !== null
      && normalized.priceBelow >= normalized.priceAbove) {
    throw new StockApiError('跌破价格必须低于上破价格', 'INVALID_ALERT')
  }
  if (normalized.changeBelow !== null && normalized.changeAbove !== null
      && normalized.changeBelow >= normalized.changeAbove) {
    throw new StockApiError('涨幅下限必须低于涨幅上限', 'INVALID_ALERT')
  }
  return normalized
}

function normalizeThreshold(value, label, accepts) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || !accepts(value)) {
    throw new StockApiError(`${label}无效`, 'INVALID_ALERT')
  }
  return value
}

function normalizeNotification(request) {
  return {
    id: sanitizeNotificationId(request.id),
    title: sanitizeNotificationText(request.title, '通知标题', 80),
    message: sanitizeNotificationText(request.message, '通知内容', 240),
  }
}

function sanitizeNotificationId(value) {
  if (value !== undefined && typeof value !== 'string') {
    throw new StockApiError('通知 ID 必须是文本', 'INVALID_NOTIFICATION')
  }
  return (value ?? 'stock-alert')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'stock-alert'
}

function sanitizeNotificationText(value, label, limit) {
  if (typeof value !== 'string') {
    throw new StockApiError(`${label}必须是文本`, 'INVALID_NOTIFICATION')
  }
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) throw new StockApiError(`${label}不能为空`, 'INVALID_NOTIFICATION')
  return Array.from(text).slice(0, limit).join('')
}

function createNotification(id, options, notifications = globalThis.chrome?.notifications) {
  if (!notifications?.create) {
    return Promise.reject(new StockApiError('浏览器通知不可用', 'NOTIFICATION'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const callback = (createdId) => {
      const runtimeError = globalThis.chrome?.runtime?.lastError
      if (runtimeError) fail(new StockApiError(runtimeError.message, 'NOTIFICATION'))
      else done(createdId)
    }
    try {
      const result = notifications.create(id, options, callback)
      if (result && typeof result.then === 'function') result.then(done, fail)
    } catch (error) {
      fail(new StockApiError('无法显示浏览器通知', 'NOTIFICATION', { cause: error }))
    }
  })
}

function chromeStorageCall(storageArea, method, argument) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback) => (value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    const done = settle(resolve)
    const fail = settle(reject)
    const callback = (value) => {
      const runtimeError = globalThis.chrome?.runtime?.lastError
      if (runtimeError) fail(new StockApiError(runtimeError.message, 'STORAGE'))
      else done(value)
    }
    try {
      const result = storageArea[method](argument, callback)
      if (result && typeof result.then === 'function') result.then(done, fail)
      // Callback-style Chrome calls resolve through `callback`.  Passing a
      // callback is still supported by Promise-capable MV3 implementations.
    } catch (error) {
      fail(new StockApiError('无法访问浏览器本地存储', 'STORAGE', { cause: error }))
    }
  })
}

installBackground()
