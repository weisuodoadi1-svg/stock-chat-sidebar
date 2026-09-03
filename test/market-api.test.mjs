import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildSnapshot,
  calculateLiveMA5,
  calculateMA5,
  fetchSnapshot,
  normalizeStock,
  parseEastmoneyKline,
  parseEastmoneySuggest,
  parseEastmoneyTrends,
  parseSinaKline,
  parseSinaMinute,
  parseTencentFqkline,
  parseTencentMinute,
  searchStocks,
  toEastmoneySecid,
  toTencentCode,
} from '../market-api.mjs'
import {
  DEFAULT_WATCHLIST,
  WATCHLIST_STORAGE_KEY,
  getWatchlist,
  handleMessage,
  normalizeWatchlist,
  saveWatchlist,
} from '../background.js'

const DEFAULT_ALERTS = {
  maEnabled: true,
  maPeriod: 5,
  maDirection: 'below',
  priceAbove: null,
  priceBelow: null,
  changeAbove: null,
  changeBelow: null,
}

test('runtime assets match the manifest version', async () => {
  const extensionRoot = new URL('../', import.meta.url)
  const [manifestSource, backgroundSource, notificationIcon] = await Promise.all([
    readFile(new URL('manifest.json', extensionRoot), 'utf8'),
    readFile(new URL('background.js', extensionRoot), 'utf8'),
    readFile(new URL('icon-128.png', extensionRoot)),
  ])
  const manifest = JSON.parse(manifestSource)
  const fingerprint = backgroundSource.match(/from '\.\/market-api\.mjs\?v=([^']+)'/)
  assert.ok(fingerprint, 'background market module import must carry a version query')
  assert.equal(fingerprint[1], manifest.version)
  assert.deepEqual([...notificationIcon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(notificationIcon.readUInt32BE(16), 128)
  assert.equal(notificationIcon.readUInt32BE(20), 128)
})

test('normalizes supported A-share identifiers for both providers', () => {
  assert.deepEqual(normalizeStock('sh603259'), { name: '603259', code: '603259', market: 'SSE' })
  assert.deepEqual(normalizeStock({ name: '平安银行', code: '000001', market: 'SZ' }), {
    name: '平安银行', code: '000001', market: 'SZSE',
  })
  assert.equal(toTencentCode({ code: '603259', market: 'SSE' }), 'sh603259')
  assert.equal(toEastmoneySecid({ code: '000001', market: 'SZSE' }), '0.000001')
  assert.throws(() => normalizeStock('830001'), { code: 'INVALID_SYMBOL' })
  assert.throws(() => normalizeStock('900901'), { code: 'INVALID_SYMBOL' })
  assert.throws(() => normalizeStock('200001'), { code: 'INVALID_SYMBOL' })
  assert.throws(() => normalizeStock({ code: '000001', market: 'SSE' }), { code: 'INVALID_SYMBOL' })
})

test('parses Tencent qfq daily rows and keeps only the requested tail', () => {
  const payload = {
    data: {
      sh603259: {
        qt: { sh603259: ['1', '药明康德', '603259'] },
        qfqday: [
          ['2026-08-14', '164.00', '165.00', '166.00', '163.00', '100'],
          ['2026-08-17', '165.00', '166.00', '167.00', '164.00', '120'],
          ['2026-08-18', '166.00', '164.00', '168.00', '163.00', '140'],
        ],
      },
    },
  }
  assert.deepEqual(parseTencentFqkline(payload, { code: 'sh603259', limit: 2 }), [
    { time: '2026-08-17', open: 165, close: 166, high: 167, low: 164, volume: 12_000, turnover: 0 },
    { time: '2026-08-18', open: 166, close: 164, high: 168, low: 163, volume: 14_000, turnover: 0 },
  ])
})

test('parses Tencent cumulative minute rows into per-minute volume and normalizes date', () => {
  const payload = {
    data: {
      sh603259: {
        data: {
          date: '20260818',
          data: [
            '0930 165.00 10 165000',
            '0931 166.00 25 414000',
            '0932 164.00 30 496000',
            '1506 164.00 31 512400',
          ],
        },
      },
    },
  }
  const result = parseTencentMinute(payload, { code: 'sh603259', previousClose: 165, limit: 3 })
  assert.deepEqual(result.map(({ time, price, volume, turnover }) => ({ time, price, volume, turnover })), [
    { time: '2026-08-18 09:30', price: 165, volume: 1_000, turnover: 165_000 },
    { time: '2026-08-18 09:31', price: 166, volume: 1_500, turnover: 249_000 },
    { time: '2026-08-18 09:32', price: 164, volume: 500, turnover: 82_000 },
  ])
  assert.equal(result[1].averagePrice, 414_000 / 2_500)
  assert.equal(result[2].changePercent, (164 - 165) / 165 * 100)
})

test('accepts Eastmoney minute rows without treating them as cumulative', () => {
  const payload = { data: { klines: [
    '2026-08-18 09:31,167.10,167.18,167.20,167.00,120,2007960,0.12,0.17,0.08',
    '2026-08-18 09:32,167.18,167.15,167.22,167.10,80,1337200,0.10,-0.02,-0.03',
  ] } }
  assert.deepEqual(parseTencentMinute(payload, { limit: 2 }), [
    { time: '2026-08-18 09:31', price: 167.18, averagePrice: 167.33, volume: 12_000, turnover: 2_007_960, changePercent: 0.17 },
    { time: '2026-08-18 09:32', price: 167.15, averagePrice: 167.15, volume: 8_000, turnover: 1_337_200, changePercent: -0.02 },
  ])
})

test('parses real Push2 history fields and rejects a different security identity', () => {
  const payload = eastmoneyDailyFixture()
  assert.deepEqual(parseEastmoneyKline(payload, {
    stock: { code: '603259', market: 'SSE' },
    limit: 2,
  }), [
    {
      time: '2026-08-17', open: 165, close: 167.18, high: 168.7, low: 164.3,
      volume: 48_276_100, turnover: 8_061_624_300,
    },
    {
      time: '2026-08-18', open: 165.1, close: 164, high: 166.26, low: 163.5,
      volume: 50_378_100, turnover: 8_342_459_000,
    },
  ])
  assert.throws(() => parseEastmoneyKline({
    ...payload,
    data: { ...payload.data, code: '000001', market: 0 },
  }, { stock: { code: '603259', market: 'SSE' } }), { code: 'IDENTITY' })
})

test('parses real Push2 trends fields with quote baseline and per-minute volume', () => {
  const result = parseEastmoneyTrends(eastmoneyTrendsFixture(), {
    stock: { code: '603259', market: 'SSE' },
  })
  assert.deepEqual(result, [
    {
      time: '2026-08-18 09:30', price: 165.1, averagePrice: 165.1,
      volume: 445_000, turnover: 73_469_500, changePercent: (165.1 - 167.18) / 167.18 * 100,
      previousClose: 167.18,
    },
    {
      time: '2026-08-18 09:31', price: 165.2, averagePrice: 165.145,
      volume: 320_000, turnover: 52_856_000, changePercent: (165.2 - 167.18) / 167.18 * 100,
      previousClose: 167.18,
    },
  ])
})

test('parses Sina daily JSONP only when the callback echoes the requested stock', () => {
  const result = parseSinaKline(sinaDailyFixture(), {
    stock: { code: '603259', market: 'SSE' },
    requestLimit: 60,
    limit: 2,
  })
  assert.deepEqual(result, [
    {
      time: '2026-08-17', open: 159, close: 166.89, high: 168.38, low: 157.4,
      volume: 68_943_301, turnover: 0,
    },
    {
      time: '2026-08-18', open: 165.1, close: 167.18, high: 168.7, low: 163.5,
      volume: 50_378_126, turnover: 0,
    },
  ])
  assert.throws(() => parseSinaKline(
    sinaDailyFixture().replace('_sh603259_240_60', '_sz000001_240_60'),
    { stock: { code: '603259', market: 'SSE' }, requestLimit: 60 },
  ), { code: 'IDENTITY' })
})

test('parses Sina minute JSONP with a cumulative average and keeps only the latest regular session', () => {
  const result = parseSinaMinute(sinaMinuteFixture(), {
    stock: { code: '603259', market: 'SSE' },
    requestLimit: 242,
  })
  assert.deepEqual(result, [
    {
      time: '2026-08-19 11:29:00', price: 163.06,
      averagePrice: 23_965_241.937 / 146_999,
      volume: 146_999, turnover: 23_965_241.937, changePercent: 0,
    },
    {
      time: '2026-08-19 11:30:00', price: 163.4,
      averagePrice: (23_965_241.937 + 17_464_739.1104) / (146_999 + 107_001),
      volume: 107_001, turnover: 17_464_739.1104, changePercent: 0,
    },
  ])
})

test('accepts real Shanghai, Shenzhen, ChiNext, and STAR suggest entries', () => {
  const payload = `callback(${JSON.stringify({ QuotationCodeTable: { Data: [
    eastmoneyAStock({ Code: '600519', Name: '贵州茅台' }),
    eastmoneyAStock({ Code: '600519', Name: '贵州茅台' }),
    eastmoneyAStock({ Code: '000001', Name: '平安银行' }),
    eastmoneyAStock({ Code: '300750', Name: '宁德时代' }),
    eastmoneyAStock({ Code: '688981', Name: '中芯国际' }),
  ] } })});`
  assert.deepEqual(parseEastmoneySuggest(payload), [
    { name: '贵州茅台', code: '600519', market: 'SSE' },
    { name: '平安银行', code: '000001', market: 'SZSE' },
    { name: '宁德时代', code: '300750', market: 'SZSE' },
    { name: '中芯国际', code: '688981', market: 'SSE' },
  ])
})

test('rejects OTC funds, indices, exchange funds, and inconsistent A-stock metadata', () => {
  const payload = { QuotationCodeTable: { Data: [
    {
      Code: '000001', Name: '华夏成长混合', Classify: 'OTCFUND', MarketType: '6',
      SecurityTypeName: '基金', SecurityType: '17', MktNum: '150', QuoteID: '150.000001',
    },
    {
      Code: '000001', Name: '上证指数', Classify: 'Index', MarketType: '1',
      SecurityTypeName: '指数', SecurityType: '5', MktNum: '1', QuoteID: '1.000001',
    },
    {
      Code: '510210', Name: '上证指数ETF富国', Classify: 'Fund', MarketType: '1',
      SecurityTypeName: '基金', SecurityType: '8', MktNum: '1', QuoteID: '1.510210',
    },
    {
      ...eastmoneyAStock({ Code: '000001', Name: '伪造的沪市股票' }),
      MktNum: '1', QuoteID: '1.000001',
    },
  ] } }
  assert.deepEqual(parseEastmoneySuggest(payload), [])
})

test('calculates live MA5, MA10, and MA20 in one snapshot', () => {
  const candles = Array.from({ length: 20 }, (_, index) => index + 1).map((close, index) => ({
    time: `2026-08-${String(index + 1).padStart(2, '0')}`,
    open: close,
    close,
    high: close,
    low: close,
    volume: 0,
    turnover: 0,
  }))
  assert.equal(calculateMA5(candles), 18)
  assert.equal(calculateMA5(candles.slice(-4), 5), null)
  const snapshot = buildSnapshot({ name: '示例', code: '000001', market: 'SZSE' }, {
    candles,
    intraday: [{ time: '2026-08-20 09:31', price: 21, averagePrice: 21, volume: 100, turnover: 2_100, changePercent: 0 }],
    now: '2026-08-20T02:00:00.000Z',
  })
  assert.equal(snapshot.quote.latest, 21)
  assert.equal(snapshot.quote.previousClose, 19)
  assert.equal(snapshot.ma5, 18.2)
  assert.equal(snapshot.ma10, 15.6)
  assert.equal(snapshot.ma20, 10.55)
  assert.equal(snapshot.belowMa5, false)
  assert.equal(snapshot.error, null)
})

test('live MA5 appends latest when the daily feed has not added today', () => {
  const completed = [10, 11, 12, 13].map((close, index) => ({
    time: `2026-08-${String(index + 14).padStart(2, '0')}`,
    close,
  }))
  assert.equal(calculateLiveMA5(completed, 14, '2026-08-18 10:00'), 12)
  assert.equal(calculateLiveMA5(completed.slice(1), 14, '2026-08-18 10:00'), null)
})

test('fetchSnapshot requests both Tencent endpoints and uses fqkline quote name', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(new URL(url))
    if (url.pathname.includes('fqkline')) return response({ data: { sh603259: {
      qt: { sh603259: ['1', '药明康德', '603259'] },
      qfqday: [
        ['2026-08-14', '10', '10', '10', '10', '1'],
        ['2026-08-15', '11', '11', '11', '11', '1'],
        ['2026-08-16', '12', '12', '12', '12', '1'],
        ['2026-08-17', '13', '13', '13', '13', '1'],
        ['2026-08-18', '14', '14', '14', '14', '1'],
      ],
    } } })
    return response({ data: { sh603259: { data: { date: '20260818', data: ['0930 13.5 1 1350'] } } } })
  }
  const snapshot = await fetchSnapshot({ code: '603259', market: 'SSE', name: '华夏成长混合' }, { fetchImpl })
  assert.equal(snapshot.symbol.name, '药明康德')
  assert.equal(snapshot.quote.latest, 13.5)
  assert.equal(snapshot.quote.previousClose, 13)
  assert.equal(snapshot.ma5, 11.9)
  assert.equal(snapshot.belowMa5, false)
  assert.equal(snapshot.error, null)
  assert.equal(calls[0].searchParams.get('param'), 'sh603259,day,,,60,qfq')
  assert.equal(calls[1].searchParams.get('code'), 'sh603259')
})

test('fetchSnapshot falls back independently to Push2 without marking a recovered card failed', async () => {
  const calls = []
  const fetchImpl = async (input) => {
    const url = new URL(input)
    calls.push(url)
    if (url.hostname === 'web.ifzq.gtimg.cn') throw new TypeError('Failed to fetch')
    if (url.hostname === 'push2his.eastmoney.com') return response(eastmoneyDailyFixture())
    if (url.hostname === 'push2.eastmoney.com') return response(eastmoneyTrendsFixture())
    throw new Error(`unexpected URL ${url}`)
  }
  const snapshot = await fetchSnapshot({ code: '603259', market: 'SSE', name: '药明康德' }, { fetchImpl })
  assert.equal(snapshot.quote.latest, 165.2)
  assert.equal(snapshot.quote.previousClose, 167.18)
  assert.equal(snapshot.ma5, 165.642)
  assert.deepEqual(snapshot.sources, { daily: 'eastmoney', intraday: 'eastmoney' })
  assert.equal(snapshot.error, null)
  assert.deepEqual(new Set(calls.map((url) => url.hostname)), new Set([
    'web.ifzq.gtimg.cn',
    'push2his.eastmoney.com',
    'push2.eastmoney.com',
  ]))
  const historyUrl = calls.find((url) => url.hostname === 'push2his.eastmoney.com')
  const trendsUrl = calls.find((url) => url.hostname === 'push2.eastmoney.com')
  assert.equal(historyUrl.searchParams.get('secid'), '1.603259')
  assert.equal(historyUrl.searchParams.get('klt'), '101')
  assert.equal(trendsUrl.searchParams.get('secid'), '1.603259')
  assert.equal(trendsUrl.searchParams.get('ndays'), '1')
})

test('fetchSnapshot uses Sina after both earlier providers fail and overwrites endpoint identity parameters', async () => {
  const calls = []
  const fetchImpl = async (input) => {
    const url = new URL(input)
    calls.push(url)
    if (url.hostname === 'web.ifzq.gtimg.cn') throw new TypeError('Tencent EOF')
    if (url.hostname.endsWith('eastmoney.com')) throw new TypeError('Eastmoney EOF')
    if (url.searchParams.get('scale') === '240') return textResponse(sinaDailyFixture())
    return textResponse(sinaMinuteFixture())
  }
  const snapshot = await fetchSnapshot({ code: '603259', market: 'SSE', name: '药明康德' }, {
    fetchImpl,
    sinaKlineUrl: 'https://quotes.sina.cn/wrong/path?symbol=sz000001&scale=5&datalen=1',
    sinaMinuteUrl: 'https://quotes.sina.cn/another/path?symbol=sz000001&scale=5&datalen=1',
  })
  assert.equal(snapshot.quote.latest, 163.4)
  assert.equal(snapshot.quote.previousClose, 167.18)
  assert.equal(snapshot.ma5, 163.808)
  assert.deepEqual(snapshot.sources, { daily: 'sina', intraday: 'sina' })
  assert.equal(snapshot.error, null)
  const sinaCalls = calls.filter((url) => url.hostname === 'quotes.sina.cn')
  assert.equal(sinaCalls.length, 2)
  assert.deepEqual(sinaCalls.map((url) => url.searchParams.get('symbol')), ['sh603259', 'sh603259'])
  assert.deepEqual(sinaCalls.map((url) => url.searchParams.get('scale')).sort(), ['1', '240'])
  assert.deepEqual(sinaCalls.map((url) => url.searchParams.get('datalen')).sort(), ['242', '60'])
  assert.ok(sinaCalls.every((url) => /\/var%20_sh603259_(?:1_242|240_60)=\//.test(url.pathname)))
})

test('fetchSnapshot keeps a usable quote and lists all three failed daily providers', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input)
    if (url.hostname === 'web.ifzq.gtimg.cn') throw new TypeError('Failed to fetch')
    if (url.hostname === 'push2his.eastmoney.com') return response({}, 502)
    if (url.hostname === 'quotes.sina.cn') return response({}, 502)
    return response(eastmoneyTrendsFixture())
  }
  const snapshot = await fetchSnapshot({ code: '603259', market: 'SSE', name: '药明康德' }, { fetchImpl })
  assert.equal(snapshot.quote.latest, 165.2)
  assert.equal(snapshot.quote.previousClose, 167.18)
  assert.deepEqual(snapshot.sources, { daily: null, intraday: 'eastmoney' })
  assert.match(snapshot.error, /^日K不可用（腾讯：Tencent K-line 请求失败：Failed to fetch；东方财富：Eastmoney K-line HTTP 502；新浪：Sina K-line HTTP 502）$/)
})

test('searchStocks builds Eastmoney autocomplete parameters', async () => {
  let requested
  const results = await searchStocks('药明', {
    fetchImpl: async (url) => {
      requested = new URL(url)
      return response({ QuotationCodeTable: { Data: [
        eastmoneyAStock({ Code: '603259', Name: '药明康德' }),
      ] } })
    },
  })
  assert.deepEqual(results, [{ name: '药明康德', code: '603259', market: 'SSE' }])
  assert.equal(requested.searchParams.get('input'), '药明')
  assert.equal(requested.searchParams.get('type'), '14')
  assert.ok(requested.searchParams.get('token'))
})

test('fetch transport preserves the service-worker global receiver', async () => {
  const results = await searchStocks('药明', {
    async fetchImpl() {
      assert.equal(this, globalThis)
      return response({ QuotationCodeTable: { Data: [
        eastmoneyAStock({ Code: '603259', Name: '药明康德' }),
      ] } })
    },
  })
  assert.deepEqual(results, [{ name: '药明康德', code: '603259', market: 'SSE' }])
})

test('watchlist storage migrates legacy MA5 settings to canonical alerts', async () => {
  const state = {}
  const storageArea = storage(state)
  assert.deepEqual(DEFAULT_WATCHLIST, [])
  assert.deepEqual(await getWatchlist(storageArea), [])
  const saved = await saveWatchlist([
    { name: '药明康德', code: '603259', market: 'SSE', alerts: { belowMa5: false } },
    { name: '重复项', code: '603259', market: 'SSE', alerts: { belowMa5: true } },
  ], storageArea)
  assert.deepEqual(saved, [{
    name: '药明康德', code: '603259', market: 'SSE', alerts: { ...DEFAULT_ALERTS, maEnabled: false },
  }])
  assert.deepEqual(state[WATCHLIST_STORAGE_KEY], saved)
  assert.deepEqual(normalizeWatchlist([]), [])
})

test('alert thresholds are finite, bounded, and non-overlapping', () => {
  const stock = { name: '工业富联', code: '601138', market: 'SSE' }
  assert.deepEqual(normalizeWatchlist([{ ...stock, alerts: {
    maEnabled: false,
    maPeriod: 20,
    maDirection: 'above',
    priceBelow: 60,
    priceAbove: 70,
    changeBelow: -5,
    changeAbove: 8,
  } }]), [{ ...stock, alerts: {
    maEnabled: false,
    maPeriod: 20,
    maDirection: 'above',
    priceAbove: 70,
    priceBelow: 60,
    changeAbove: 8,
    changeBelow: -5,
  } }])
  for (const alerts of [
    { priceAbove: Number.POSITIVE_INFINITY },
    { priceBelow: 0 },
    { changeAbove: 101 },
    { priceBelow: 70, priceAbove: 60 },
    { changeBelow: 8, changeAbove: -5 },
  ]) {
    assert.throws(() => normalizeWatchlist([{ ...stock, alerts }]), { code: 'INVALID_ALERT' })
  }
})

test('background implements request/response messages and isolates stock errors', async () => {
  const state = {}
  const storageArea = storage(state)
  const stock = { name: '药明康德', code: '603259', market: 'SSE', alerts: DEFAULT_ALERTS }
  assert.deepEqual(await handleMessage({ type: 'SEARCH_STOCKS', query: '药明' }, {
    storageArea,
    search: async () => [stock],
  }), { ok: true, results: [stock] })
  assert.deepEqual(await handleMessage({ type: 'SAVE_WATCHLIST', watchlist: [stock] }, { storageArea }), {
    ok: true, watchlist: [stock],
  })
  assert.deepEqual(await handleMessage({ type: 'GET_WATCHLIST' }, { storageArea }), {
    ok: true, watchlist: [stock],
  })
  const snapshots = await handleMessage({ type: 'GET_SNAPSHOTS', stocks: [stock] }, {
    storageArea,
    snapshot: async () => { throw new Error('offline') },
  })
  assert.equal(snapshots.ok, true)
  assert.equal(snapshots.snapshots[0].symbol.code, '603259')
  assert.equal(snapshots.snapshots[0].quote.latest, null)
  assert.equal(snapshots.snapshots[0].error, 'offline')
  assert.deepEqual(await handleMessage({ type: 'NOPE' }, { storageArea }), {
    ok: false, error: '不支持的消息类型：NOPE', code: 'UNKNOWN_MESSAGE',
  })
})

test('notification messages are sanitized and bounded before dispatch', async () => {
  const calls = []
  const result = await handleMessage({
    type: 'SHOW_NOTIFICATION',
    id: ' sh603259/below MA5!? ',
    title: ` 药明\n康德\u0000提醒${'题'.repeat(100)} `,
    message: ` 最新价\t63.20\n${'价'.repeat(250)} `,
  }, {
    notify: async (id, options) => calls.push({ id, options }),
  })
  assert.deepEqual(result, { ok: true, id: 'sh603259-below-MA5' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, result.id)
  assert.equal(calls[0].options.type, 'basic')
  assert.equal(calls[0].options.iconUrl, 'icon-128.png')
  assert.equal(Array.from(calls[0].options.title).length, 80)
  assert.equal(Array.from(calls[0].options.message).length, 240)
  assert.match(calls[0].options.title, /^药明 康德 提醒/)
  assert.match(calls[0].options.message, /^最新价 63\.20 /)
  assert.doesNotMatch(`${calls[0].options.title}${calls[0].options.message}`, /[\u0000-\u001f]/)
  assert.deepEqual(await handleMessage({ type: 'SHOW_NOTIFICATION', title: ' ', message: '内容' }, {
    notify: async () => { throw new Error('must not run') },
  }), { ok: false, error: '通知标题不能为空', code: 'INVALID_NOTIFICATION' })
})

function eastmoneyDailyFixture() {
  return {
    rc: 0,
    rt: 17,
    data: {
      code: '603259',
      market: 1,
      name: '药明康德',
      decimal: 2,
      dktotal: 2338,
      preKPrice: 164.83,
      klines: [
        '2026-08-12,164.73,164.83,168.65,163.40,610207,10176861120.00,3.19,0.82,1.35,2.41',
        '2026-08-13,164.83,165.00,166.20,163.88,401260,6624550000.00,1.41,0.10,0.17,1.58',
        '2026-08-14,164.00,166.00,167.00,163.00,420000,6950000000.00,2.42,0.61,1.00,1.66',
        '2026-08-17,165.00,167.18,168.70,164.30,482761,8061624300.00,2.65,0.71,1.18,1.91',
        '2026-08-18,165.10,164.00,166.26,163.50,503781,8342459000.00,1.65,-1.90,-3.18,1.99',
      ],
    },
  }
}

function eastmoneyTrendsFixture() {
  return {
    rc: 0,
    rt: 10,
    data: {
      code: '603259',
      market: 1,
      type: 1,
      status: 0,
      name: '药明康德',
      decimal: 2,
      preSettlement: 0,
      preClose: 167.18,
      trends: [
        '2026-08-18 09:30,165.10,165.10,165.10,165.10,4450,73469500.00,165.100',
        '2026-08-18 09:31,165.10,165.20,165.22,165.08,3200,52856000.00,165.145',
      ],
    },
  }
}

function sinaDailyFixture() {
  return `/*<script>location.href='//sina.com';</script>*/
var _sh603259_240_60=(${JSON.stringify([
    { day: '2026-08-12', open: '159.210', high: '161.960', low: '158.080', close: '159.040', volume: '67027216' },
    { day: '2026-08-13', open: '158.900', high: '164.800', low: '157.150', close: '162.330', volume: '74225264' },
    { day: '2026-08-14', open: '160.500', high: '163.000', low: '157.500', close: '159.240', volume: '54590148' },
    { day: '2026-08-17', open: '159.000', high: '168.380', low: '157.400', close: '166.890', volume: '68943301' },
    { day: '2026-08-18', open: '165.100', high: '168.700', low: '163.500', close: '167.180', volume: '50378126' },
  ])});`
}

function sinaMinuteFixture() {
  return `/*<script>location.href='//sina.com';</script>*/
var _sh603259_1_242=(${JSON.stringify([
    { day: '2026-08-18 15:00:00', open: '167.100', high: '167.200', low: '167.050', close: '167.180', volume: '162000', amount: '27080000.0000' },
    { day: '2026-08-19 09:29:00', open: '165.000', high: '165.000', low: '165.000', close: '165.000', volume: '100', amount: '16500.0000' },
    { day: '2026-08-19 11:29:00', open: '163.030', high: '163.140', low: '162.980', close: '163.060', volume: '146999', amount: '23965241.9370' },
    { day: '2026-08-19 11:30:00', open: '163.040', high: '163.480', low: '163.000', close: '163.400', volume: '107001', amount: '17464739.1104' },
  ])});`
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status })
}

function textResponse(value, status = 200) {
  return new Response(value, { status })
}

function eastmoneyAStock({ Code, Name }) {
  if (Code.startsWith('68')) {
    return {
      Code, Name, Classify: '23', MarketType: '1', SecurityTypeName: '科创板',
      SecurityType: '25', MktNum: '1', QuoteID: `1.${Code}`,
    }
  }
  const shanghai = Code.startsWith('6')
  return {
    Code,
    Name,
    Classify: 'AStock',
    MarketType: shanghai ? '1' : '2',
    SecurityTypeName: shanghai ? '沪A' : '深A',
    SecurityType: shanghai ? '1' : '2',
    MktNum: shanghai ? '1' : '0',
    QuoteID: `${shanghai ? '1' : '0'}.${Code}`,
  }
}

function storage(state) {
  return {
    async get(key) {
      return { [key]: state[key] }
    },
    async set(value) {
      Object.assign(state, value)
    },
  }
}
