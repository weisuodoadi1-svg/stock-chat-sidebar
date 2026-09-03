import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8')

const yaoming = {
  name: '药明康德',
  code: '603259',
  market: 'SSE',
  alerts: { belowMa5: true },
}

const pingan = {
  name: '平安银行',
  code: '000001',
  market: 'SZSE',
}

test('injects one Shadow DOM sidebar with chart axes, moving averages, and an MA5 alert', async () => {
  const harness = createHarness()
  try {
    const host = harness.document.querySelector('#dsh-stock-chat-sidebar-host')
    assert.ok(host)
    assert.equal(host.shadowRoot, null)
    const shadow = harness.shadow
    assert.ok(shadow.querySelector('.dsh-stock-sidebar'))

    await waitFor(() => {
      assert.equal(shadow.querySelector('[data-role="price"]').textContent, '9.80')
    })

    harness.window.eval(contentSource)
    assert.equal(harness.document.querySelectorAll('#dsh-stock-chat-sidebar-host').length, 1)

    const card = shadow.querySelector('.dsh-stock-card')
    assert.ok(card.classList.contains('is-alerting'))
    assert.equal(card.querySelector('[data-role="alert-banner"]').hidden, false)
    assert.equal(card.querySelector('[data-role="alert-title"]').textContent, '低于 MA5')
    assert.equal(card.querySelector('[data-role="condition-status"]').textContent, '已触发 1 项')
    assert.equal(card.querySelector('[data-role="ma5"]').textContent, '10.00')
    assert.equal(card.querySelector('[data-role="ma10"]').textContent, '10.10')
    assert.equal(card.querySelector('[data-role="ma20"]').textContent, '10.20')

    const leftAxis = [...card.querySelectorAll('.chart-axis-price')]
    const rightAxis = [...card.querySelectorAll('.chart-axis-percent')]
    assert.deepEqual(leftAxis.map((node) => node.textContent), ['10.22', '10.00', '9.78'])
    assert.ok(leftAxis.every((node) => node.getAttribute('text-anchor') === 'end'))
    assert.deepEqual(rightAxis.map((node) => node.textContent), ['+2.24%', '0.00%', '-2.24%'])
    assert.ok(leftAxis.every((node) => Number(node.getAttribute('x')) < 49))
    assert.ok(rightAxis.every((node) => Number(node.getAttribute('x')) > 257))

    const pricePoints = polylinePoints(card.querySelector('.chart-price-line'))
    const averagePoints = polylinePoints(card.querySelector('.chart-average-line'))
    assert.deepEqual(pricePoints.map(([x]) => x), [49, 153, 153, 153.87])
    assert.deepEqual(averagePoints.map(([x]) => x), [49, 153, 153, 153.87])
    assert.ok(pricePoints.at(-1)[0] < 257)
    assert.ok(averagePoints.at(-1)[1] < pricePoints.at(-1)[1])
    const volumeBars = [...card.querySelectorAll('.chart-volume-bar')]
    assert.equal(volumeBars.length, 3)
    assert.equal(Math.max(...volumeBars.map((bar) => Number(bar.getAttribute('height')))), 14)
    assert.doesNotMatch(card.querySelector('[data-role="chart"] svg').innerHTML, /NaN|Infinity/)
    assert.equal(card.querySelector('.chart-extreme.is-high text').textContent, '高 10.05')
    assert.equal(card.querySelector('.chart-extreme.is-low text').textContent, '低 9.80')
    assert.equal(card.querySelector('.chart-extreme.is-high text').getAttribute('y'), '4.5')
    assert.equal(card.querySelector('.chart-extreme.is-low text').getAttribute('y'), '4.5')
    assert.equal(card.querySelectorAll('.chart-extreme rect').length, 0)

    const timeLabels = [...card.querySelectorAll('.chart-time')].map((node) => node.textContent)
    assert.deepEqual(timeLabels, ['09:30', '10:30', '11:30/13:00', '14:00', '15:00'])

    const chart = card.querySelector('[data-role="chart"]')
    const svg = chart.querySelector('svg')
    const tooltip = chart.querySelector('[data-role="chart-tooltip"]')
    svg.getBoundingClientRect = () => ({ left: 100, top: 50, width: 620, height: 220 })
    chart.dispatchEvent(new harness.window.MouseEvent('pointermove', {
      bubbles: true,
      clientX: 406,
      clientY: 140,
    }))
    assert.equal(tooltip.hidden, false)
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-time"]').textContent, '13:00')
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-price"]').textContent, '9.95')
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-average"]').textContent, '9.98')
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-percent"]').textContent, '-0.50%')
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-volume"]').textContent, '0')
    assert.ok(card.querySelector('.chart-crosshair').classList.contains('is-visible'))
    assert.equal(card.querySelector('.chart-crosshair-line').getAttribute('x1'), '153')

    chart.dispatchEvent(new harness.window.MouseEvent('pointerleave'))
    assert.equal(tooltip.hidden, true)
    svg.focus()
    assert.equal(svg.tabIndex, 0)
    assert.equal(svg.getAttribute('role'), 'slider')
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-time"]').textContent, '13:01')
    assert.equal(svg.getAttribute('aria-valuenow'), '3')
    assert.match(svg.getAttribute('aria-valuetext'), /成交量 300/)
    svg.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-time"]').textContent, '13:00')
    svg.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    assert.equal(tooltip.querySelector('[data-role="chart-tooltip-time"]').textContent, '11:30')

    shadow.querySelector('[data-action="refresh"]').click()
    await waitFor(() => {
      const refreshedChart = shadow.querySelector('[data-role="chart"] svg')
      assert.equal(shadow.querySelector('[data-action="refresh"]').disabled, false)
      assert.equal(harness.calls.filter((message) => message.type === 'GET_SNAPSHOTS').length, 2)
      assert.equal(shadow.activeElement, refreshedChart)
      assert.match(refreshedChart.getAttribute('aria-valuetext'), /13:01/)
    })
  } finally {
    harness.close()
  }
})

test('search autocomplete selects and saves a stock through all four runtime messages', async () => {
  const harness = createHarness()
  try {
    const shadow = harness.shadow
    await waitFor(() => {
      assert.equal(shadow.querySelector('[data-role="price"]').textContent, '9.80')
    })

    const input = shadow.querySelector('#dsh-stock-search-input')
    input.value = '平安'
    input.dispatchEvent(new harness.window.Event('input', { bubbles: true }))

    await waitFor(() => {
      const option = shadow.querySelector('[data-action="select-search-result"]')
      assert.ok(option)
      assert.match(option.textContent, /平安银行/)
      assert.match(option.textContent, /000001/)
    })

    shadow.querySelector('[data-action="select-search-result"]').click()

    await waitFor(() => {
      assert.equal(shadow.querySelectorAll('.dsh-stock-card').length, 2)
      assert.equal(shadow.querySelector('[data-role="stock-count"]').textContent, '2')
      assert.equal(shadow.querySelectorAll('[data-role="price"]')[1].textContent, '12.50')
    })

    const saveCall = harness.calls.find((message) => message.type === 'SAVE_WATCHLIST')
    assert.deepEqual(JSON.parse(JSON.stringify(saveCall.watchlist[1])), {
      ...pingan,
      alerts: {
        maEnabled: true,
        maPeriod: 5,
        maDirection: 'below',
        priceAbove: null,
        priceBelow: null,
        changeAbove: null,
        changeBelow: null,
      },
    })
    assert.deepEqual(new Set(harness.calls.map((message) => message.type)), new Set([
      'GET_WATCHLIST',
      'GET_SNAPSHOTS',
      'SEARCH_STOCKS',
      'SAVE_WATCHLIST',
    ]))
    assert.equal(input.value, '')
    assert.equal(input.getAttribute('aria-expanded'), 'false')

    const sortMode = shadow.querySelector('[data-role="sort-mode"]')
    for (const [mode, expected] of [
      ['watchlist', ['603259', '000001']],
      ['alerts', ['603259', '000001']],
      ['gainers', ['000001', '603259']],
      ['losers', ['603259', '000001']],
      ['code', ['000001', '603259']],
      ['watchlist', ['603259', '000001']],
    ]) {
      sortMode.value = mode
      sortMode.dispatchEvent(new harness.window.Event('change', { bubbles: true }))
      assert.deepEqual(cardCodes(shadow), expected)
    }
  } finally {
    harness.close()
  }
})

test('validates and saves custom alert rules without repeating desktop notifications', async () => {
  const harness = createHarness()
  try {
    const shadow = harness.shadow
    await waitFor(() => assert.equal(shadow.querySelector('[data-role="price"]').textContent, '9.80'))

    shadow.querySelector('[data-action="configure-alerts"]').click()
    const dialog = shadow.querySelector('[data-role="alert-dialog"]')
    const form = shadow.querySelector('[data-role="alert-form"]')
    assert.equal(dialog.hasAttribute('open'), true)
    form.elements.priceAbove.value = '10'
    form.elements.priceBelow.value = '11'
    form.dispatchEvent(new harness.window.Event('submit', { bubbles: true, cancelable: true }))
    assert.equal(shadow.querySelector('[data-role="alert-form-error"]').textContent, '价格下限必须小于价格上限')
    assert.equal(form.elements.priceBelow.getAttribute('aria-invalid'), 'true')
    assert.equal(shadow.activeElement, form.elements.priceBelow)
    assert.equal(harness.calls.filter((message) => message.type === 'SAVE_WATCHLIST').length, 0)

    form.elements.priceAbove.value = '9.8'
    form.elements.priceBelow.value = ''
    form.elements.changeAbove.value = ''
    form.elements.changeBelow.value = '-2'
    form.elements.maEnabled.checked = true
    form.elements.maPeriod.value = '10'
    form.elements.maDirection.value = 'below'
    form.dispatchEvent(new harness.window.Event('submit', { bubbles: true, cancelable: true }))

    await waitFor(() => {
      assert.equal(dialog.hasAttribute('open'), false)
      assert.equal(harness.calls.filter((message) => message.type === 'SHOW_NOTIFICATION').length, 1)
    })
    const saveCall = harness.calls.find((message) => message.type === 'SAVE_WATCHLIST')
    assert.deepEqual(JSON.parse(JSON.stringify(saveCall.watchlist[0].alerts)), {
      maEnabled: true,
      maPeriod: 10,
      maDirection: 'below',
      priceAbove: 9.8,
      priceBelow: null,
      changeAbove: null,
      changeBelow: -2,
    })
    assert.equal(shadow.querySelector('[data-role="alert-title"]').textContent, '触发 3 项提醒')
    assert.equal(shadow.activeElement, shadow.querySelector('[data-action="configure-alerts"]'))

    shadow.querySelector('[data-action="refresh"]').click()
    await waitFor(() => assert.equal(shadow.querySelector('[data-action="refresh"]').disabled, false))
    assert.equal(harness.calls.filter((message) => message.type === 'SHOW_NOTIFICATION').length, 1)

    harness.failSaves()
    shadow.querySelector('[data-action="configure-alerts"]').click()
    form.dispatchEvent(new harness.window.Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => {
      assert.equal(dialog.hasAttribute('open'), true)
      assert.equal(shadow.querySelector('[data-role="alert-form-error"]').textContent, '提醒保存失败，请稍后重试')
    })
  } finally {
    harness.close()
  }
})

test('keeps the last usable price when a later stock refresh fails', async () => {
  const harness = createHarness()
  try {
    const shadow = harness.shadow
    await waitFor(() => {
      assert.equal(shadow.querySelector('[data-role="price"]').textContent, '9.80')
      assert.match(shadow.querySelector('[data-role="sync-status"]').textContent, /已更新/)
    })

    harness.failSnapshots()
    shadow.querySelector('[data-action="refresh"]').click()

    await waitFor(() => {
      assert.equal(shadow.querySelector('[data-role="sync-status"]').textContent, '行情暂时不可用')
      assert.equal(shadow.querySelector('[data-role="card-status"]').textContent, '模拟断网')
    })

    const card = shadow.querySelector('.dsh-stock-card')
    assert.ok(card.classList.contains('has-error'))
    assert.equal(card.querySelector('[data-role="price"]').textContent, '9.80')
    assert.equal(card.querySelector('[data-role="previous-close"]').textContent, '10.00')
    assert.equal(card.querySelector('[data-role="ma5"]').textContent, '10.00')
    assert.equal(card.querySelector('[data-role="ma10"]').textContent, '10.10')
    assert.equal(card.querySelector('[data-role="ma20"]').textContent, '10.20')
    assert.equal(harness.calls.filter((message) => message.type === 'GET_SNAPSHOTS').length, 2)
  } finally {
    harness.close()
  }
})

test('retries a newly triggered desktop alert after a transient notification failure', async () => {
  const harness = createHarness()
  try {
    const shadow = harness.shadow
    await waitFor(() => assert.equal(shadow.querySelector('[data-role="price"]').textContent, '9.80'))
    harness.failNextNotification()
    shadow.querySelector('[data-action="configure-alerts"]').click()
    const form = shadow.querySelector('[data-role="alert-form"]')
    form.elements.maEnabled.checked = false
    form.elements.priceAbove.value = '9.8'
    form.dispatchEvent(new harness.window.Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => assert.equal(shadow.querySelector('[data-role="notice-text"]').textContent, '模拟通知失败'))
    assert.equal(harness.calls.filter((message) => message.type === 'SHOW_NOTIFICATION').length, 1)

    shadow.querySelector('[data-action="refresh"]').click()
    await waitFor(() => {
      assert.equal(shadow.querySelector('[data-action="refresh"]').disabled, false)
      assert.equal(harness.calls.filter((message) => message.type === 'SHOW_NOTIFICATION').length, 2)
    })
    shadow.querySelector('[data-action="refresh"]').click()
    await waitFor(() => assert.equal(shadow.querySelector('[data-action="refresh"]').disabled, false))
    assert.equal(harness.calls.filter((message) => message.type === 'SHOW_NOTIFICATION').length, 2)
  } finally {
    harness.close()
  }
})

test('uses a fresh partial quote when only one market feed fails', async () => {
  const harness = createHarness()
  try {
    const shadow = harness.shadow
    await waitFor(() => assert.equal(shadow.querySelector('[data-role="price"]').textContent, '9.80'))
    harness.usePartialSnapshots()
    shadow.querySelector('[data-action="refresh"]').click()
    await waitFor(() => {
      assert.equal(shadow.querySelector('[data-role="price"]').textContent, '9.70')
      assert.equal(shadow.querySelector('[data-role="card-status"]').textContent, '日K暂时不可用')
    })
  } finally {
    harness.close()
  }
})

function createHarness() {
  const calls = []
  let watchlist = [{ ...yaoming, alerts: { ...yaoming.alerts } }]
  let snapshotsFail = false
  let snapshotsPartial = false
  let savesFail = false
  let notificationFailures = 0
  const dom = new JSDOM('<!doctype html><html><body><main id="chat">chat</main></body></html>', {
    url: 'https://pc.zx017.net/vueapp/uc/chatting?forum_id=157',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const { window } = dom
  let shadow
  const attachShadow = window.Element.prototype.attachShadow
  window.Element.prototype.attachShadow = function (options) {
    shadow = attachShadow.call(this, options)
    return shadow
  }
  const nativeSetTimeout = window.setTimeout.bind(window)
  window.setTimeout = (callback, delay = 0, ...args) => {
    if (delay >= 1_000) return 0
    return nativeSetTimeout(callback, delay, ...args)
  }

  window.chrome = {
    runtime: {
      getURL(path) {
        return `chrome-extension://stock-sidebar/${path}`
      },
      lastError: null,
      sendMessage(message, callback) {
        calls.push(message)
        window.queueMicrotask(() => callback(runtimeResponse(message)))
      },
    },
  }

  function runtimeResponse(message) {
    switch (message.type) {
      case 'GET_WATCHLIST':
        return { ok: true, watchlist }
      case 'SEARCH_STOCKS':
        return { ok: true, results: message.query === '平安' ? [pingan] : [] }
      case 'SAVE_WATCHLIST':
        if (savesFail) return { ok: false, error: '模拟保存失败' }
        watchlist = message.watchlist.map((item) => ({ ...item, alerts: { ...item.alerts } }))
        return { ok: true, watchlist }
      case 'GET_SNAPSHOTS':
        return {
          ok: true,
          snapshots: message.stocks.map((stock) => snapshotsFail
            ? failedSnapshot(stock)
            : snapshotsPartial ? partialSnapshot(stock) : snapshotFor(stock)),
        }
      case 'SHOW_NOTIFICATION':
        if (notificationFailures > 0) {
          notificationFailures -= 1
          return { ok: false, error: '模拟通知失败' }
        }
        return { ok: true, id: message.id }
      default:
        return { ok: false, error: `unexpected message: ${message.type}` }
    }
  }

  window.eval(contentSource)
  return {
    calls,
    document: window.document,
    get shadow() {
      return shadow
    },
    failSnapshots() {
      snapshotsFail = true
    },
    usePartialSnapshots() {
      snapshotsPartial = true
    },
    failSaves() {
      savesFail = true
    },
    failNextNotification() {
      notificationFailures += 1
    },
    get host() {
      return window.document.querySelector('#dsh-stock-chat-sidebar-host')
    },
    window,
    close() {
      dom.window.close()
    },
  }
}

function snapshotFor(stock) {
  if (stock.code === yaoming.code) {
    return {
      symbol: yaoming,
      quote: {
        latest: 9.8,
        previousClose: 10,
        change: -0.2,
        changePercent: -2,
        quotedAt: '2026-08-19 09:31',
      },
      ma5: 10,
      ma10: 10.1,
      ma20: 10.2,
      belowMa5: true,
      intraday: [
        { time: '2026-08-19 09:30', price: 10.05, averagePrice: 10.05, volume: 100 },
        { time: '2026-08-19 11:30', price: 9.9, averagePrice: 9.99, volume: 400 },
        { time: '2026-08-19 13:00', price: 9.95, averagePrice: 9.98, volume: 0 },
        { time: '2026-08-19 13:01', price: 9.8, averagePrice: 9.97, volume: 300 },
      ],
      updatedAt: '2026-08-19T01:31:00.000Z',
      error: null,
    }
  }
  return {
    symbol: { ...pingan, alerts: { belowMa5: true } },
    quote: {
      latest: 12.5,
      previousClose: 12.25,
      change: 0.25,
      changePercent: 2.04,
      quotedAt: '2026-08-19 09:31',
    },
    ma5: 12.1,
    ma10: 12,
    ma20: 11.9,
    belowMa5: false,
    intraday: [
      { time: '2026-08-19 09:30', price: 12.3, averagePrice: 12.3, volume: 0 },
      { time: '2026-08-19 09:31', price: 12.5, averagePrice: 12.4, volume: 0 },
    ],
    updatedAt: '2026-08-19T01:31:00.000Z',
    error: null,
  }
}

function failedSnapshot(stock) {
  return {
    symbol: stock,
    quote: {
      latest: null,
      previousClose: null,
      change: null,
      changePercent: null,
      quotedAt: null,
    },
    ma5: null,
    ma10: null,
    ma20: null,
    belowMa5: null,
    intraday: [],
    updatedAt: '2026-08-19T01:32:00.000Z',
    error: '模拟断网',
  }
}

function partialSnapshot(stock) {
  const snapshot = snapshotFor(stock)
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      latest: 9.7,
      change: -0.3,
      changePercent: -3,
    },
    ma5: null,
    ma10: null,
    ma20: null,
    intraday: snapshot.intraday.map((point, index, points) =>
      index === points.length - 1 ? { ...point, price: 9.7 } : point),
    error: '日K暂时不可用',
  }
}

function polylinePoints(node) {
  return node.getAttribute('points').split(' ').map((point) => point.split(',').map(Number))
}

function cardCodes(shadow) {
  return [...shadow.querySelectorAll('.dsh-stock-card [data-role="code"]')].map((node) => node.textContent)
}

async function waitFor(assertion, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return assertion()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}
