/**
 * Small, dependency-free A-share market client used by the MV3 service worker.
 *
 * The feeds are public browser endpoints and do not provide a trading API.  The
 * parsers intentionally live in this module so that a changed provider payload
 * can be tested without a browser or a network connection.
 */

export const DEFAULT_FQKLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
export const DEFAULT_MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query'
export const DEFAULT_SUGGEST_URL = 'https://searchapi.eastmoney.com/api/suggest/get'
export const DEFAULT_EASTMONEY_KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
export const DEFAULT_EASTMONEY_TRENDS_URL = 'https://push2.eastmoney.com/api/qt/stock/trends2/get'
export const DEFAULT_SINA_KLINE_URL = 'https://quotes.sina.cn/cn/api/jsonp_v2.php'

export const DEFAULT_DAILY_LIMIT = 60
export const DEFAULT_INTRADAY_LIMIT = 242
export const DEFAULT_TIMEOUT_MS = 8_000
export const DEFAULT_SEARCH_LIMIT = 20
export const DEFAULT_SUGGEST_TOKEN = '44d9d2e8c4b14f1f9f2f5b9e3f3a0f5a'
export const DEFAULT_PUSH2_TOKEN = 'fa5fd1943c7b386f172d6893dbfba10b'

/** A normalized mainland-China security identifier. */
export class StockApiError extends Error {
  /** Machine-readable failure category. */
  code
  /** HTTP status when the provider returned one. */
  status

  /**
   * @param {string} message - Safe diagnostic text.
   * @param {string} code - Stable failure category.
   * @param {{cause?: unknown,status?: number}} [options] - Optional cause/status.
   */
  constructor(message, code, options = {}) {
    super(message, options)
    this.name = 'StockApiError'
    this.code = code
    this.status = options.status
  }
}

/**
 * Convert a provider payload (JSON, text JSON, or JSONP) into a value.
 *
 * @param {unknown} payload - Provider response.
 * @param {string} [label] - Error label.
 * @returns {unknown} Parsed payload.
 */
export function parseJsonLike(payload, label = 'provider response') {
  if (payload !== null && typeof payload === 'object') return payload
  if (typeof payload !== 'string') {
    throw new StockApiError(`${label} is not JSON`, 'PAYLOAD')
  }
  const text = payload.trim()
  if (text.length === 0) throw new StockApiError(`${label} is empty`, 'EMPTY')
  try {
    return JSON.parse(text)
  } catch {
    // Eastmoney occasionally wraps the result in a JSONP callback.  Strip only
    // a callback-shaped wrapper; do not use eval for an external response.
    const wrapped = text.match(/^[\w$]+\s*\((\s*[\s\S]*\s*)\)\s*;?$/)
    if (wrapped?.[1] !== undefined) {
      try {
        return JSON.parse(wrapped[1])
      } catch (error) {
        throw new StockApiError(`${label} is invalid JSON`, 'PAYLOAD', { cause: error })
      }
    }
    throw new StockApiError(`${label} is invalid JSON`, 'PAYLOAD')
  }
}

/**
 * Infer an exchange from a six-digit mainland stock code.
 *
 * @param {unknown} value - Code or provider security id.
 * @returns {'SSE'|'SZSE'|null} Exchange or null when it cannot be inferred.
 */
export function inferMarket(value) {
  const text = String(value ?? '').trim().toUpperCase()
  const code = text.match(/(?:^|[. _-])([0-9]{6})$/)?.[1] ?? (/^[0-9]{6}$/.test(text) ? text : '')
  if (/^6/.test(code)) return 'SSE'
  if (/^(0|3)/.test(code)) return 'SZSE'
  // Codes beginning with 2/9 are B shares; 4/8 belong to the Beijing exchange.
  // This sidebar deliberately labels and searches only Shanghai/Shenzhen A shares.
  return null
}

/**
 * Normalize a stock input from the UI or a provider search result.
 *
 * @param {unknown} input - `{code, market, name}`, prefixed code, or secid.
 * @param {{name?: string}} [options] - Fallback display name.
 * @returns {{name:string,market:'SSE'|'SZSE',code:string}} Normalized symbol.
 */
export function normalizeStock(input, options = {}) {
  let code = ''
  let market = null
  let name = ''
  if (typeof input === 'string' || typeof input === 'number') {
    const text = String(input).trim().toUpperCase()
    const prefix = text.match(/^(SH|SZ)([0-9]{6})$/)
    const secid = text.match(/^[01]\.([0-9]{6})$/)
    code = prefix?.[2] ?? secid?.[1] ?? (/[0-9]{6}/.test(text) ? text.match(/[0-9]{6}/)?.[0] ?? '' : '')
    market = prefix?.[1] === 'SH' ? 'SSE' : prefix?.[1] === 'SZ' ? 'SZSE' : secid?.[0]?.startsWith('1.') ? 'SSE' : null
  } else if (input !== null && typeof input === 'object') {
    const value = /** @type {Record<string, unknown>} */ (input)
    name = text(value.name ?? value.Name ?? value.displayName)
    const rawCode = value.code ?? value.Code ?? value.securityCode ?? value.SECURITYCODE ?? value.symbol
    if (typeof rawCode === 'string' || typeof rawCode === 'number') code = String(rawCode).trim().toUpperCase()
    const rawMarket = value.market ?? value.Market ?? value.marketType ?? value.MktNum
    market = normalizeMarket(rawMarket)
    const quoteId = value.quoteId ?? value.QuoteID ?? value.secId ?? value.SecID ?? value.secid
    if (code === '' && (typeof quoteId === 'string' || typeof quoteId === 'number')) code = String(quoteId).trim().toUpperCase()
  }
  const prefixed = code.match(/^(SH|SZ)([0-9]{6})$/)
  const secid = code.match(/^([01])\.([0-9]{6})$/)
  if (prefixed) {
    market = market ?? (prefixed[1] === 'SH' ? 'SSE' : 'SZSE')
    code = prefixed[2]
  } else if (secid) {
    market = market ?? (secid[1] === '1' ? 'SSE' : 'SZSE')
    code = secid[2]
  } else {
    const six = code.match(/([0-9]{6})/)
    code = six?.[1] ?? ''
  }
  market = market ?? inferMarket(code)
  const inferredMarket = inferMarket(code)
  if (!/^[0-9]{6}$/.test(code) || inferredMarket === null || market !== inferredMarket) {
    throw new StockApiError('股票代码或市场无效', 'INVALID_SYMBOL')
  }
  return { name: name || text(options.name) || code, market, code }
}

/** Return Tencent's lowercase exchange-prefixed code. */
export function toTencentCode(stock) {
  const symbol = normalizeStock(stock)
  return `${symbol.market === 'SSE' ? 'sh' : 'sz'}${symbol.code}`
}

/** Return Eastmoney's numeric security id. */
export function toEastmoneySecid(stock) {
  const symbol = normalizeStock(stock)
  return `${symbol.market === 'SSE' ? '1' : '0'}.${symbol.code}`
}

/**
 * Parse Tencent's adjusted daily K-line (`fqkline`) response.
 *
 * @param {unknown} payload - Response object/text.
 * @param {{code?: string,limit?: number}} [options] - Symbol and row limit.
 * @returns {Array<{time:string,open:number,close:number,high:number,low:number,volume:number,turnover:number}>}
 */
export function parseTencentFqkline(payload, options = {}) {
  const root = parseJsonLike(payload, 'Tencent K-line response')
  const rows = findTencentKlineRows(root, options.code)
  if (!rows || rows.length === 0) throw new StockApiError('Tencent returned no daily K-lines', 'EMPTY')
  const parsed = rows.flatMap((row, index) => {
    try {
      return [parseKlineRow(row, index)]
    } catch {
      return []
    }
  })
  if (parsed.length === 0) throw new StockApiError('Tencent returned invalid daily K-lines', 'PAYLOAD')
  const limit = positiveInteger(options.limit, parsed.length)
  return parsed.slice(-limit)
}

/** Alias retained for consumers that call the feed simply “K-line”. */
export const parseTencentKline = parseTencentFqkline
/** Alias matching the endpoint name used in older prototypes. */
export const parseFqkline = parseTencentFqkline

/**
 * Parse Eastmoney Push2's adjusted daily K-line response after verifying that
 * the response belongs to the requested Shanghai/Shenzhen A-share.
 *
 * @param {unknown} payload - Push2 history response object/text.
 * @param {{stock:unknown,limit?:number}} options - Expected security and row limit.
 * @returns {Array<{time:string,open:number,close:number,high:number,low:number,volume:number,turnover:number}>}
 */
export function parseEastmoneyKline(payload, options) {
  const root = parseJsonLike(payload, 'Eastmoney K-line response')
  const data = eastmoneySecurityData(root, options?.stock, 'Eastmoney K-line')
  if (!Array.isArray(data.klines) || data.klines.length === 0) {
    throw new StockApiError('Eastmoney returned no daily K-lines', 'EMPTY')
  }
  const parsed = data.klines.flatMap((row, index) => {
    try {
      return [parseKlineRow(row, index)]
    } catch {
      return []
    }
  })
  if (parsed.length === 0) throw new StockApiError('Eastmoney returned invalid daily K-lines', 'PAYLOAD')
  const limit = positiveInteger(options?.limit, parsed.length)
  return parsed.slice(-limit)
}

/**
 * Parse Sina's daily JSONP response. The callback name must echo the expected
 * stock, scale, and request size because the row payload has no symbol field.
 *
 * @param {unknown} payload - Sina JSONP response text.
 * @param {{stock:unknown,requestLimit?:number,limit?:number}} options - Expected security and row limits.
 * @returns {Array<{time:string,open:number,close:number,high:number,low:number,volume:number,turnover:number}>}
 */
export function parseSinaKline(payload, options) {
  const stock = normalizeStock(options?.stock)
  const requestLimit = positiveInteger(options?.requestLimit, DEFAULT_DAILY_LIMIT)
  const rows = parseSinaJsonpRows(
    payload,
    sinaCallbackName(stock, 240, requestLimit),
    'Sina K-line',
  )
  const parsed = rows.flatMap((row, index) => {
    try {
      return [parseSinaCandleRow(row, index)]
    } catch {
      return []
    }
  })
  if (parsed.length === 0) throw new StockApiError('Sina returned invalid daily K-lines', 'PAYLOAD')
  const limit = positiveInteger(options?.limit, parsed.length)
  return parsed.slice(-limit)
}

/**
 * Parse Tencent's cumulative one-minute response.  Eastmoney Push2 rows are
 * accepted too, which keeps the extension usable when Tencent rate-limits.
 *
 * @param {unknown} payload - Response object/text.
 * @param {{code?: string,previousClose?: number,limit?: number}} [options] - Parse options.
 * @returns {Array<{time:string,price:number,averagePrice:number,volume:number,turnover:number,changePercent:number}>}
 */
export function parseTencentMinute(payload, options = {}) {
  const root = parseJsonLike(payload, 'Tencent minute response')
  const source = findMinuteSource(root, options.code)
  if (!source.rows || source.rows.length === 0) throw new StockApiError('Tencent returned no intraday points', 'EMPTY')
  const previousClose = finite(options.previousClose)
  let parsed = source.rows.flatMap((row, index) => {
    try {
      return [parseMinuteRow(row, index, source.date, previousClose)]
    } catch {
      return []
    }
  })
  if (parsed.length === 0) throw new StockApiError('Tencent returned invalid intraday points', 'PAYLOAD')
  if (source.kind === 'tencent') {
    const regularSession = parsed.filter((point) => isRegularSessionMinute(point.time))
    if (regularSession.length > 0) parsed = regularSession
    let previousVolume = 0
    let previousTurnover = 0
    parsed = parsed.map((point) => {
      const volume = point.volume >= previousVolume ? point.volume - previousVolume : point.volume
      const turnover = point.turnover >= previousTurnover ? point.turnover - previousTurnover : point.turnover
      previousVolume = point.volume
      previousTurnover = point.turnover
      return { ...point, volume, turnover }
    })
  }
  const limit = positiveInteger(options.limit, parsed.length)
  return parsed.slice(-limit)
}

/** Alias for callers that use the shorter feed name. */
export const parseMinute = parseTencentMinute

/**
 * Parse Eastmoney Push2's one-minute trend response after verifying the
 * returned security identity. Push2 minute volume is reported in lots and is
 * normalized to shares.
 *
 * @param {unknown} payload - Push2 trends response object/text.
 * @param {{stock:unknown,limit?:number}} options - Expected security and row limit.
 * @returns {Array<{time:string,price:number,averagePrice:number,volume:number,turnover:number,changePercent:number,previousClose:number|null}>}
 */
export function parseEastmoneyTrends(payload, options) {
  const root = parseJsonLike(payload, 'Eastmoney trends response')
  const data = eastmoneySecurityData(root, options?.stock, 'Eastmoney trends')
  if (!Array.isArray(data.trends) || data.trends.length === 0) {
    throw new StockApiError('Eastmoney returned no intraday points', 'EMPTY')
  }
  const previousClose = finite(data.preClose)
  let parsed = data.trends.flatMap((row, index) => {
    try {
      return [parseEastmoneyTrendRow(row, index, previousClose)]
    } catch {
      return []
    }
  })
  if (parsed.length === 0) throw new StockApiError('Eastmoney returned invalid intraday points', 'PAYLOAD')
  const regularSession = parsed.filter((point) => isRegularSessionMinute(point.time))
  if (regularSession.length > 0) parsed = regularSession
  const limit = positiveInteger(options?.limit, parsed.length)
  return parsed.slice(-limit)
}

/**
 * Parse Sina's one-minute JSONP response. Only the latest returned trading day
 * and regular A-share session minutes are retained; volume remains per-minute.
 *
 * @param {unknown} payload - Sina JSONP response text.
 * @param {{stock:unknown,requestLimit?:number,limit?:number}} options - Expected security and row limits.
 * @returns {Array<{time:string,price:number,averagePrice:number,volume:number,turnover:number,changePercent:number}>}
 */
export function parseSinaMinute(payload, options) {
  const stock = normalizeStock(options?.stock)
  const requestLimit = positiveInteger(options?.requestLimit, DEFAULT_INTRADAY_LIMIT)
  const rows = parseSinaJsonpRows(
    payload,
    sinaCallbackName(stock, 1, requestLimit),
    'Sina minute',
  )
  const parsed = rows.flatMap((row, index) => {
    try {
      return [parseSinaMinuteRow(row, index)]
    } catch {
      return []
    }
  })
  if (parsed.length === 0) throw new StockApiError('Sina returned invalid intraday points', 'PAYLOAD')
  const latestDate = parsed.reduce((latest, point) => {
    const date = point.time.slice(0, 10)
    return date > latest ? date : latest
  }, '')
  const currentSession = parsed.filter((point) => point.time.startsWith(`${latestDate} `)
    && isRegularSessionMinute(point.time))
  if (currentSession.length === 0) throw new StockApiError('Sina returned no regular-session points', 'EMPTY')
  let cumulativeVolume = 0
  let cumulativeTurnover = 0
  const normalizedSession = currentSession.map((point) => {
    cumulativeVolume += point.volume
    cumulativeTurnover += point.turnover
    return {
      ...point,
      averagePrice: cumulativeVolume > 0 && cumulativeTurnover > 0
        ? cumulativeTurnover / cumulativeVolume
        : point.averagePrice,
    }
  })
  const limit = positiveInteger(options?.limit, normalizedSession.length)
  return normalizedSession.slice(-limit)
}

/**
 * Parse Eastmoney's stock search/suggest response.
 *
 * @param {unknown} payload - Response object/text/JSONP.
 * @param {{limit?: number}} [options] - Maximum result count.
 * @returns {Array<{name:string,code:string,market:'SSE'|'SZSE'}>} Search results.
 */
export function parseEastmoneySuggest(payload, options = {}) {
  const root = parseJsonLike(payload, 'Eastmoney suggest response')
  const entries = findSuggestEntries(root)
  const seen = new Set()
  const results = []
  for (const entry of entries) {
    const result = normalizeSuggestEntry(entry)
    if (!result) continue
    const key = `${result.market}:${result.code}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
  }
  const limit = positiveInteger(options.limit, DEFAULT_SEARCH_LIMIT)
  return results.slice(0, limit)
}

/** Alias for the generic search parser name. */
export const parseSuggest = parseEastmoneySuggest

/**
 * Calculate a simple moving average from the last `period` daily closes.
 * A missing/short series returns null, allowing the UI to distinguish “not
 * enough history” from a genuine zero price.
 *
 * @param {unknown} candles - Daily candle array or numeric close array.
 * @param {number} [period=5] - Number of closes.
 * @returns {number|null} Moving average rounded to four decimal places.
 */
export function calculateMA5(candles, period = 5) {
  const size = positiveInteger(period, 5)
  if (!Array.isArray(candles) || candles.length < size) return null
  const closes = candles.slice(-size).map((entry) => {
    if (typeof entry === 'number') return entry
    if (entry !== null && typeof entry === 'object') return finite(entry.close)
    return Number.NaN
  })
  if (closes.some((value) => !Number.isFinite(value))) return null
  const average = closes.reduce((sum, value) => sum + value, 0) / size
  return Number(average.toFixed(4))
}

/** Lower-case alias used by a few UI prototypes. */
export const calculateMa5 = calculateMA5

/**
 * Calculate a live moving average using the latest intraday price.
 *
 * If the daily feed already contains today's candle, its still-changing close
 * is replaced with the minute feed's latest price.  If the daily feed has not
 * added today yet, the latest price is appended to the required completed
 * closes. Without a usable session date this falls back to completed candles.
 *
 * @param {unknown} candles - Daily candles.
 * @param {unknown} latest - Current price.
 * @param {unknown} sessionTime - Current minute timestamp.
 * @param {number} [period=5] - Number of sessions in the average.
 * @returns {number|null} Live moving average.
 */
export function calculateLiveMA(candles, latest, sessionTime, period = 5) {
  if (!Array.isArray(candles)) return null
  const size = positiveInteger(period, 5)
  const current = finite(latest)
  const sessionDate = text(sessionTime).slice(0, 10)
  const lastDate = text(candles.at(-1)?.time).slice(0, 10)
  if (current === null || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate) || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
    return calculateMA5(candles, size)
  }
  if (sessionDate === lastDate) {
    if (candles.length < size) return null
    return averageCloses([...candles.slice(-size, -1), current])
  }
  if (sessionDate > lastDate) {
    const completedCount = size - 1
    if (candles.length < completedCount) return null
    return averageCloses([...candles.slice(candles.length - completedCount), current])
  }
  return calculateMA5(candles, size)
}

/** Five-day aliases retained for existing consumers. */
export const calculateLiveMA5 = calculateLiveMA
export const calculateLiveMa5 = calculateLiveMA

/**
 * Build one normalized snapshot from parsed provider data.
 *
 * @param {unknown} stockInput - Stock identifier.
 * @param {{candles?: unknown[],intraday?: unknown[],name?: string,now?: Date|string}} [data] - Parsed data.
 * @returns {object} Snapshot consumed by the sidebar.
 */
export function buildSnapshot(stockInput, data = {}) {
  const symbol = normalizeStock(stockInput, { name: data.name })
  const candles = Array.isArray(data.candles) ? data.candles : []
  const intraday = Array.isArray(data.intraday) ? data.intraday : []
  const quote = candles.length > 0 || intraday.length > 0
    ? deriveQuote(symbol, candles, intraday, data.now)
    : emptyQuote(symbol, data.now)
  const sessionTime = intraday.at(-1)?.time
  const ma5 = calculateLiveMA(candles, quote.latest, sessionTime, 5)
  const ma10 = calculateLiveMA(candles, quote.latest, sessionTime, 10)
  const ma20 = calculateLiveMA(candles, quote.latest, sessionTime, 20)
  const belowMa5 = ma5 === null || quote.latest === null ? null : quote.latest < ma5
  return {
    symbol,
    quote,
    candles,
    intraday,
    ma5,
    ma10,
    ma20,
    belowMa5,
    updatedAt: new Date(data.now ?? Date.now()).toISOString(),
    error: data.error == null ? null : String(data.error),
  }
}

/**
 * Fetch and normalize one stock snapshot. Daily and minute requests run in
 * parallel. Each request independently tries Tencent, Eastmoney, then Sina,
 * so one unavailable feed does not discard the other.
 *
 * @param {unknown} stockInput - Stock identifier.
 * @param {object} [options] - Transport and endpoint overrides.
 * @returns {Promise<object>} Snapshot.
 */
export async function fetchSnapshot(stockInput, options = {}) {
  const symbol = normalizeStock(stockInput)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const dailyLimit = positiveInteger(options.dailyLimit, DEFAULT_DAILY_LIMIT)
  const intradayLimit = positiveInteger(options.intradayLimit, DEFAULT_INTRADAY_LIMIT)
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const signal = options.signal
  const fqUrl = new URL(options.fqklineUrl ?? DEFAULT_FQKLINE_URL)
  fqUrl.searchParams.set('param', `${toTencentCode(symbol)},day,,,${dailyLimit},qfq`)
  const minuteUrl = new URL(options.minuteUrl ?? DEFAULT_MINUTE_URL)
  minuteUrl.searchParams.set('code', toTencentCode(symbol))
  const eastmoneyKlineUrl = buildEastmoneyKlineUrl(
    options.eastmoneyKlineUrl ?? DEFAULT_EASTMONEY_KLINE_URL,
    symbol,
    dailyLimit,
    options.push2Token,
  )
  const eastmoneyTrendsUrl = buildEastmoneyTrendsUrl(
    options.eastmoneyTrendsUrl ?? DEFAULT_EASTMONEY_TRENDS_URL,
    symbol,
    options.push2Token,
  )
  const sinaKlineUrl = buildSinaUrl(
    options.sinaKlineUrl ?? DEFAULT_SINA_KLINE_URL,
    symbol,
    240,
    dailyLimit,
  )
  const sinaMinuteUrl = buildSinaUrl(
    options.sinaMinuteUrl ?? DEFAULT_SINA_KLINE_URL,
    symbol,
    1,
    intradayLimit,
  )

  const [daily, minute] = await Promise.all([
    fetchProviderFeed({
      feedName: '日K',
      primary: async () => {
        const payload = await fetchJson(fqUrl, { fetchImpl, signal, timeoutMs, label: 'Tencent K-line' })
        return {
          values: parseTencentFqkline(payload, { code: toTencentCode(symbol), limit: dailyLimit }),
          name: extractTencentName(payload, toTencentCode(symbol)),
        }
      },
      fallback: async () => {
        const payload = await fetchJson(eastmoneyKlineUrl, {
          fetchImpl, signal, timeoutMs, label: 'Eastmoney K-line',
        })
        return {
          values: parseEastmoneyKline(payload, { stock: symbol, limit: dailyLimit }),
          name: extractEastmoneyName(payload, symbol),
        }
      },
      finalFallback: async () => {
        const payload = await fetchText(sinaKlineUrl, {
          fetchImpl, signal, timeoutMs, label: 'Sina K-line',
        })
        return {
          values: parseSinaKline(payload, {
            stock: symbol,
            requestLimit: dailyLimit,
            limit: dailyLimit,
          }),
          name: '',
        }
      },
    }),
    fetchProviderFeed({
      feedName: '分时',
      primary: async () => {
        const payload = await fetchJson(minuteUrl, { fetchImpl, signal, timeoutMs, label: 'Tencent minute' })
        return {
          values: parseTencentMinute(payload, {
            code: toTencentCode(symbol),
            limit: intradayLimit,
          }),
          name: extractTencentName(payload, toTencentCode(symbol)),
        }
      },
      fallback: async () => {
        const payload = await fetchJson(eastmoneyTrendsUrl, {
          fetchImpl, signal, timeoutMs, label: 'Eastmoney trends',
        })
        return {
          values: parseEastmoneyTrends(payload, { stock: symbol, limit: intradayLimit }),
          name: extractEastmoneyName(payload, symbol),
        }
      },
      finalFallback: async () => {
        const payload = await fetchText(sinaMinuteUrl, {
          fetchImpl, signal, timeoutMs, label: 'Sina minute',
        })
        return {
          values: parseSinaMinute(payload, {
            stock: symbol,
            requestLimit: intradayLimit,
            limit: intradayLimit,
          }),
          name: '',
        }
      },
    }),
  ])
  const candles = daily.values
  let intraday = minute.values
  const previousClose = previousCloseFromSeries(candles, intraday)
  if (previousClose !== null) {
    intraday = intraday.map((point) => ({
      ...point,
      changePercent: percent(point.price, previousClose),
    }))
  }
  const displayName = daily.name || minute.name || symbol.name
  const snapshot = buildSnapshot({ ...symbol, name: displayName }, { candles, intraday })
  snapshot.sources = { daily: daily.provider, intraday: minute.provider }
  snapshot.error = [daily.error, minute.error].filter(Boolean).join('；') || null
  return snapshot
}

/**
 * Search Eastmoney's public autocomplete endpoint.
 *
 * @param {string} query - Name/code fragment.
 * @param {object} [options] - Transport and endpoint overrides.
 * @returns {Promise<Array<{name:string,code:string,market:'SSE'|'SZSE'}>>} Results.
 */
export async function searchStocks(query, options = {}) {
  const textQuery = String(query ?? '').trim()
  if (textQuery.length === 0) return []
  const endpoint = new URL(options.suggestUrl ?? DEFAULT_SUGGEST_URL)
  endpoint.searchParams.set('input', textQuery.slice(0, 64))
  // These parameters match the public web autocomplete request and are
  // harmless for mirrors that only inspect `input`.
  endpoint.searchParams.set('type', '14')
  endpoint.searchParams.set('token', options.token ?? DEFAULT_SUGGEST_TOKEN)
  endpoint.searchParams.set('count', String(positiveInteger(options.limit, DEFAULT_SEARCH_LIMIT)))
  const payload = await fetchJson(endpoint, {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    signal: options.signal,
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    label: 'Eastmoney suggest',
  })
  return parseEastmoneySuggest(payload, { limit: options.limit })
}

/** Build a best-effort quote from daily and minute series. */
export function deriveQuote(symbol, candles, intraday, now = new Date()) {
  const daily = Array.isArray(candles) ? candles : []
  const points = Array.isArray(intraday) ? intraday : []
  const lastDaily = daily.at(-1)
  const priorDaily = daily.at(-2)
  const latest = finite(points.at(-1)?.price) ?? finite(lastDaily?.close) ?? 0
  const previousClose = previousCloseFromSeries(daily, points) ?? finite(priorDaily?.close) ?? finite(lastDaily?.close) ?? latest
  const currentOpen = finite(points[0]?.price) ?? finite(lastDaily?.open) ?? latest
  const currentHigh = points.length > 0 ? Math.max(...points.map((point) => finite(point.price) ?? 0)) : finite(lastDaily?.high) ?? latest
  const currentLow = points.length > 0 ? Math.min(...points.map((point) => finite(point.price) ?? latest)) : finite(lastDaily?.low) ?? latest
  const dailyForVolume = lastDaily && points.length === 0
  const volume = dailyForVolume ? finite(lastDaily.volume) ?? 0 : points.reduce((sum, point) => sum + (finite(point.volume) ?? 0), 0)
  const turnover = dailyForVolume ? finite(lastDaily.turnover) ?? 0 : points.reduce((sum, point) => sum + (finite(point.turnover) ?? 0), 0)
  const change = latest - previousClose
  const changePercent = previousClose === 0 ? 0 : change / previousClose * 100
  const quotedAt = quotedAtFromPoint(points.at(-1)?.time, now)
  return {
    symbol,
    name: symbol.name,
    latest,
    previousClose,
    open: currentOpen,
    high: currentHigh,
    low: currentLow,
    change,
    changePercent,
    volume,
    turnover,
    quotedAt,
  }
}

function emptyQuote(symbol, now) {
  return {
    symbol,
    name: symbol.name,
    latest: null,
    previousClose: null,
    open: null,
    high: null,
    low: null,
    change: null,
    changePercent: null,
    volume: null,
    turnover: null,
    quotedAt: new Date(now ?? Date.now()).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Network helpers and provider-specific extraction.  These functions are kept
// below the public API to make the pure parsing exports easy to discover.
// ---------------------------------------------------------------------------

function buildEastmoneyKlineUrl(endpoint, symbol, limit, token) {
  const url = new URL(endpoint)
  url.searchParams.set('secid', toEastmoneySecid(symbol))
  url.searchParams.set('ut', text(token) || DEFAULT_PUSH2_TOKEN)
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61')
  url.searchParams.set('klt', '101')
  url.searchParams.set('fqt', '1')
  url.searchParams.set('beg', '0')
  url.searchParams.set('end', '20500101')
  url.searchParams.set('lmt', String(limit))
  return url
}

function buildEastmoneyTrendsUrl(endpoint, symbol, token) {
  const url = new URL(endpoint)
  url.searchParams.set('secid', toEastmoneySecid(symbol))
  url.searchParams.set('ut', text(token) || DEFAULT_PUSH2_TOKEN)
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13')
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58')
  url.searchParams.set('ndays', '1')
  url.searchParams.set('iscr', '0')
  url.searchParams.set('iscca', '0')
  return url
}

function buildSinaUrl(endpoint, symbol, scale, limit) {
  const url = new URL(endpoint)
  const callback = sinaCallbackName(symbol, scale, limit)
  url.pathname = `/cn/api/jsonp_v2.php/var ${callback}=/CN_MarketDataService.getKLineData`
  url.search = ''
  url.hash = ''
  url.searchParams.set('symbol', toTencentCode(symbol))
  url.searchParams.set('scale', String(scale))
  url.searchParams.set('ma', 'no')
  url.searchParams.set('datalen', String(limit))
  return url
}

function sinaCallbackName(symbol, scale, limit) {
  return `_${toTencentCode(symbol)}_${scale}_${limit}`
}

async function fetchProviderFeed(options) {
  let primaryError
  let fallbackError
  try {
    const result = await options.primary()
    return { ...result, provider: 'tencent', error: null }
  } catch (error) {
    primaryError = errorMessage(error)
  }
  try {
    const result = await options.fallback()
    return { ...result, provider: 'eastmoney', error: null }
  } catch (error) {
    fallbackError = errorMessage(error)
  }
  try {
    const result = await options.finalFallback()
    return { ...result, provider: 'sina', error: null }
  } catch (error) {
    return {
      values: [],
      name: '',
      provider: null,
      error: `${options.feedName}不可用（腾讯：${primaryError}；东方财富：${fallbackError}；新浪：${errorMessage(error)}）`,
    }
  }
}

async function fetchText(url, options) {
  return fetchJson(url, { ...options, rawText: true })
}

async function fetchJson(url, options) {
  if (typeof options.fetchImpl !== 'function') throw new StockApiError('当前环境没有 fetch', 'NETWORK')
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, options.timeoutMs)
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) forwardAbort()
    else options.signal.addEventListener('abort', forwardAbort, { once: true })
  }
  try {
    const response = await Reflect.apply(options.fetchImpl, globalThis, [url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        accept: 'application/json,text/plain,*/*',
      },
    }])
    const status = Number(response?.status)
    if (response?.ok === false || (Number.isFinite(status) && status >= 400)) {
      throw new StockApiError(`${options.label} HTTP ${status || 500}`, 'HTTP', { status })
    }
    let body
    if (typeof response?.text === 'function') body = await response.text()
    else if (typeof response?.json === 'function') body = await response.json()
    else body = response
    if (options.rawText) {
      if (typeof body !== 'string') throw new StockApiError(`${options.label} response is not text`, 'PAYLOAD')
      return body
    }
    return parseJsonLike(body, `${options.label} response`)
  } catch (error) {
    if (error instanceof StockApiError) throw error
    if (timedOut) throw new StockApiError(`${options.label} 请求超时`, 'TIMEOUT', { cause: error })
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new StockApiError(`${options.label} 请求已取消`, 'ABORTED', { cause: error })
    }
    throw new StockApiError(`${options.label} 请求失败：${errorMessage(error)}`, 'NETWORK', { cause: error })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

function findTencentKlineRows(root, code) {
  const data = root?.data
  if (Array.isArray(data)) return data
  const key = typeof code === 'string' ? code.toLowerCase() : ''
  const candidates = []
  if (data && typeof data === 'object') {
    if (key && data[key]) candidates.push(data[key])
    const lowerKey = key.replace(/^sh|^sz/, '')
    for (const [entryKey, value] of Object.entries(data)) {
      if (entryKey.toLowerCase() === key || entryKey.replace(/^sh|^sz/, '') === lowerKey) candidates.unshift(value)
    }
    candidates.push(...Object.values(data))
  }
  candidates.push(root)
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    for (const name of ['qfqday', 'day', 'hfqday']) {
      const value = candidate[name]
      if (Array.isArray(value)) return value
      if (value && typeof value === 'object' && Array.isArray(value.data)) return value.data
    }
    if (Array.isArray(candidate.klines)) return candidate.klines
  }
  return null
}

function parseKlineRow(row, index) {
  let fields
  if (Array.isArray(row)) fields = row
  else if (typeof row === 'string') fields = row.split(',')
  else if (row && typeof row === 'object') {
    const value = /** @type {Record<string, unknown>} */ (row)
    return {
      time: requiredText(value.time ?? value.date ?? value.day, `daily ${index} time`),
      open: requiredNumber(value.open, `daily ${index} open`),
      close: requiredNumber(value.close, `daily ${index} close`),
      high: requiredNumber(value.high, `daily ${index} high`),
      low: requiredNumber(value.low, `daily ${index} low`),
      volume: finite(value.volume) ?? 0,
      turnover: finite(value.turnover ?? value.amount) ?? 0,
    }
  } else throw new Error('not a row')
  if (fields.length < 5) throw new Error('short row')
  return {
    time: requiredText(fields[0], `daily ${index} time`),
    open: requiredNumber(fields[1], `daily ${index} open`),
    close: requiredNumber(fields[2], `daily ${index} close`),
    high: requiredNumber(fields[3], `daily ${index} high`),
    low: requiredNumber(fields[4], `daily ${index} low`),
    volume: (finite(fields[5]) ?? 0) * 100,
    turnover: finite(fields[6]) ?? 0,
  }
}

function parseSinaJsonpRows(payload, expectedCallback, label) {
  if (typeof payload !== 'string') throw new StockApiError(`${label} response is not JSONP`, 'PAYLOAD')
  const match = payload.trim().match(
    /^(?:\/\*[\s\S]*?\*\/\s*)?var\s+([A-Za-z_$][\w$]*)\s*=\s*\(([\s\S]*)\)\s*;?$/,
  )
  if (!match) throw new StockApiError(`${label} response is invalid JSONP`, 'PAYLOAD')
  if (match[1] !== expectedCallback) {
    throw new StockApiError(
      `${label} 股票身份不匹配：期待回调 ${expectedCallback}，返回 ${match[1]}`,
      'IDENTITY',
    )
  }
  let rows
  try {
    rows = JSON.parse(match[2])
  } catch (error) {
    throw new StockApiError(`${label} response is invalid JSON`, 'PAYLOAD', { cause: error })
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new StockApiError(`${label} returned no rows`, 'EMPTY')
  }
  return rows
}

function parseSinaCandleRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid Sina candle row')
  const value = /** @type {Record<string, unknown>} */ (row)
  const time = requiredText(value.day, `Sina daily ${index} time`).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(time)) throw new Error('invalid Sina daily time')
  return {
    time,
    open: requiredNumber(value.open, `Sina daily ${index} open`),
    close: requiredNumber(value.close, `Sina daily ${index} close`),
    high: requiredNumber(value.high, `Sina daily ${index} high`),
    low: requiredNumber(value.low, `Sina daily ${index} low`),
    volume: finite(value.volume) ?? 0,
    turnover: finite(value.amount) ?? 0,
  }
}

function parseSinaMinuteRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid Sina minute row')
  const value = /** @type {Record<string, unknown>} */ (row)
  const time = requiredText(value.day, `Sina minute ${index} time`).replace('T', ' ')
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(time)) throw new Error('invalid Sina minute time')
  const price = requiredNumber(value.close, `Sina minute ${index} close`)
  const volume = finite(value.volume) ?? 0
  const turnover = finite(value.amount) ?? 0
  return {
    time,
    price,
    averagePrice: volume > 0 && turnover > 0 ? turnover / volume : price,
    volume,
    turnover,
    changePercent: 0,
  }
}

function eastmoneySecurityData(root, stock, label) {
  const expected = normalizeStock(stock)
  const data = root?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new StockApiError(`${label} returned no security data`, 'EMPTY')
  }
  const actualCode = text(data.code)
  const actualMarket = normalizeMarket(data.market)
  if (actualCode !== expected.code || actualMarket !== expected.market) {
    throw new StockApiError(
      `${label} 股票身份不匹配：请求 ${toEastmoneySecid(expected)}，返回 ${text(data.market)}.${actualCode || '?'}`,
      'IDENTITY',
    )
  }
  return data
}

function findMinuteSource(root, code) {
  // Eastmoney Push2 compatibility format (`data.klines`).
  if (Array.isArray(root?.data?.klines)) return { rows: root.data.klines, date: undefined, kind: 'eastmoney' }
  const data = root?.data
  const key = typeof code === 'string' ? code.toLowerCase() : ''
  const candidates = []
  if (data && typeof data === 'object') {
    if (key && data[key]) candidates.push(data[key])
    candidates.push(...Object.values(data))
  }
  candidates.push(root)
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const nested = candidate.data
    if (Array.isArray(nested)) return { rows: nested, date: candidate.date, kind: 'tencent' }
    if (nested && typeof nested === 'object' && Array.isArray(nested.data)) {
      return { rows: nested.data, date: nested.date ?? candidate.date, kind: 'tencent' }
    }
    if (Array.isArray(candidate.rows)) return { rows: candidate.rows, date: candidate.date, kind: 'tencent' }
    if (Array.isArray(candidate.klines)) return { rows: candidate.klines, date: candidate.date, kind: 'eastmoney' }
  }
  return { rows: null, date: undefined, kind: 'tencent' }
}

function parseMinuteRow(row, index, date, previousClose) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const value = /** @type {Record<string, unknown>} */ (row)
    const price = requiredNumber(value.price ?? value.close ?? value.last, `minute ${index} price`)
    const volume = finite(value.volume) ?? 0
    const turnover = finite(value.turnover ?? value.amount) ?? 0
    return {
      time: normalizeMinuteTime(value.time ?? value.datetime ?? value.date, date, index),
      price,
      averagePrice: finite(value.averagePrice ?? value.avg) ?? (volume > 0 ? turnover / volume : price),
      volume,
      turnover,
      changePercent: finite(value.changePercent ?? value.pct) ?? percent(price, previousClose),
    }
  }
  const fields = Array.isArray(row)
    ? row
    : typeof row === 'string'
      ? row.includes(',') ? row.trim().split(',') : row.trim().split(/\s+/)
      : []
  if (fields.length < 2) throw new Error('short minute row')
  const time = normalizeMinuteTime(fields[0], date, index)
  const price = requiredNumber(fields[1], `minute ${index} price`)
  // Tencent rows are `clock price volume amount`; Eastmoney rows are
  // `datetime open close high low volume amount ... pct`.  Detect the latter
  // by its date-shaped first field and use the close/volume/amount columns.
  const eastmoney = typeof fields[0] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fields[0]) && fields.length >= 9
  const actualPrice = eastmoney ? requiredNumber(fields[2], `minute ${index} close`) : price
  const volumeRaw = eastmoney ? fields[5] : fields[2]
  const turnoverRaw = eastmoney ? fields[6] : fields[3]
  const volume = (finite(volumeRaw) ?? 0) * (eastmoney ? 100 : 100)
  const turnover = finite(turnoverRaw) ?? 0
  const explicitPct = eastmoney ? finite(fields[8]) : undefined
  return {
    time,
    price: actualPrice,
    averagePrice: volume > 0 ? turnover / volume : actualPrice,
    volume,
    turnover,
    changePercent: explicitPct ?? percent(actualPrice, previousClose),
  }
}

function parseEastmoneyTrendRow(row, index, previousClose) {
  const fields = Array.isArray(row)
    ? row
    : typeof row === 'string'
      ? row.trim().split(',')
      : []
  if (fields.length < 8) throw new Error('short Eastmoney trend row')
  const time = requiredText(fields[0], `trend ${index} time`)
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(time)) throw new Error('invalid Eastmoney trend time')
  const price = requiredNumber(fields[2], `trend ${index} price`)
  const volume = (finite(fields[5]) ?? 0) * 100
  const turnover = finite(fields[6]) ?? 0
  return {
    time: normalizeMinuteTime(time, undefined, index),
    price,
    averagePrice: finite(fields[7]) ?? (volume > 0 ? turnover / volume : price),
    volume,
    turnover,
    changePercent: percent(price, previousClose),
    previousClose,
  }
}

function findSuggestEntries(root) {
  const direct = [root?.QuotationCodeTable?.Data, root?.data?.QuotationCodeTable?.Data, root?.data, root?.Data, root?.result]
  for (const value of direct) if (Array.isArray(value)) return value
  const found = []
  const visit = (value, depth) => {
    if (depth > 4 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      if (value.some((entry) => entry && typeof entry === 'object')) found.push(...value)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (/data|result|quotation|list/i.test(key) && Array.isArray(child)) found.push(...child)
      else visit(child, depth + 1)
    }
  }
  visit(root, 0)
  return found
}

function normalizeSuggestEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const value = /** @type {Record<string, unknown>} */ (entry)
  const name = text(value.Name ?? value.name ?? value.SecurityName ?? value.SECURITYNAME ?? value.SecuName)
  const quoteId = text(value.QuoteID ?? value.quoteId ?? value.SecID ?? value.secid ?? value.SecurityCode)
  const code = text(value.Code ?? value.code ?? value.SECURITYCODE ?? value.securityCode)
  const market = inferMarket(code)
  if (!name || !/^[0-9]{6}$/.test(code) || market === null) return null
  const spec = suggestSecuritySpec(market, code)
  if (text(value.Classify) !== spec.classify
    || text(value.SecurityType) !== spec.securityType
    || text(value.MktNum) !== spec.mktNum
    || quoteId !== `${spec.mktNum}.${code}`
    || text(value.MarketType) !== spec.marketType) {
    return null
  }
  return { name, code, market }
}

function suggestSecuritySpec(market, code) {
  if (market === 'SSE' && /^68/.test(code)) {
    return { classify: '23', securityType: '25', mktNum: '1', marketType: '1' }
  }
  return market === 'SSE'
    ? { classify: 'AStock', securityType: '1', mktNum: '1', marketType: '1' }
    : { classify: 'AStock', securityType: '2', mktNum: '0', marketType: '2' }
}

function extractTencentName(payload, tencentCode) {
  if (!payload || typeof payload !== 'object') return ''
  const data = payload.data
  if (!data || typeof data !== 'object') return ''
  const symbolData = data[tencentCode]
  if (!symbolData || typeof symbolData !== 'object') return ''
  const qt = symbolData.qt
  const quote = qt && typeof qt === 'object' ? qt[tencentCode] : undefined
  if (!Array.isArray(quote) || text(quote[2]) !== tencentCode.slice(2)) return ''
  return text(quote[1])
}

function extractEastmoneyName(payload, stock) {
  if (!payload || typeof payload !== 'object') return ''
  const data = payload.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const expected = normalizeStock(stock)
  if (text(data.code) !== expected.code || normalizeMarket(data.market) !== expected.market) return ''
  return text(data.name)
}

function normalizeMinuteTime(value, date, index) {
  const raw = text(value)
  const normalizedDate = normalizeProviderDate(date) ?? todayDate()
  if (!raw) return `${normalizedDate} ${String(index).padStart(2, '0')}:00`
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw)) return raw.replace('T', ' ')
  const clock = raw.match(/^(\d{2}):?(\d{2})$/)
  if (clock) return `${normalizedDate} ${clock[1]}:${clock[2]}`
  return raw
}

function normalizeProviderDate(value) {
  const raw = text(value)
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function isRegularSessionMinute(value) {
  const clock = text(value).match(/(?:^|\s)(\d{2}):(\d{2})(?::\d{2})?$/)
  if (!clock) return true
  const minutes = Number(clock[1]) * 60 + Number(clock[2])
  return (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30)
    || (minutes >= 13 * 60 && minutes <= 15 * 60)
}

function quotedAtFromPoint(time, now) {
  const raw = text(time)
  if (raw) {
    const normalized = raw.replace('T', ' ')
    const full = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(normalized)
      ? `${normalized}${normalized.length === 16 ? ':00' : ''}+08:00`
      : null
    if (full) {
      const parsed = new Date(full)
      if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
    }
  }
  return new Date(now ?? Date.now()).toISOString()
}

function normalizeMarket(value) {
  const textValue = text(value).toUpperCase()
  if (textValue === 'SSE' || textValue === 'SH' || textValue === 'SHANGHAI' || textValue === '1') return 'SSE'
  if (textValue === 'SZSE' || textValue === 'SZ' || textValue === 'SHENZHEN' || textValue === '0') return 'SZSE'
  return null
}

function percent(price, previousClose) {
  return previousClose && Number.isFinite(previousClose) ? (price - previousClose) / previousClose * 100 : 0
}

function previousCloseFromSeries(candles, intraday) {
  const daily = Array.isArray(candles) ? candles : []
  const points = Array.isArray(intraday) ? intraday : []
  const lastDaily = daily.at(-1)
  const priorDaily = daily.at(-2)
  const lastClose = finite(lastDaily?.close)
  const priorClose = finite(priorDaily?.close)
  const providerPreviousClose = finite(points[0]?.previousClose)
  if (providerPreviousClose !== null) return providerPreviousClose
  if (points.length === 0) return priorClose ?? lastClose
  const sessionDate = text(points[0]?.time).slice(0, 10)
  const dailyDate = text(lastDaily?.time).slice(0, 10)
  return sessionDate && dailyDate && sessionDate === dailyDate
    ? priorClose ?? lastClose
    : lastClose ?? priorClose
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function averageCloses(values) {
  const closes = values.map((entry) => entry !== null && typeof entry === 'object' ? finite(entry.close) : finite(entry))
  if (closes.some((value) => value === null)) return null
  return Number((closes.reduce((sum, value) => sum + value, 0) / closes.length).toFixed(4))
}

function finite(value) {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function requiredNumber(value, label) {
  const parsed = finite(value)
  if (parsed === null) throw new Error(`${label} is not numeric`)
  return parsed
}

function requiredText(value, label) {
  const parsed = text(value)
  if (!parsed) throw new Error(`${label} is empty`)
  return parsed
}

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function errorMessage(error) {
  if (error instanceof StockApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

function todayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}
