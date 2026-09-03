# A-share chat sidebar browser extension

English | [中文](README.zh.md)

This unpacked Manifest V3 extension adds a fixed stock watchlist to the right side of the zx017 chat page. It keeps the chat usable while showing A-share quotes, intraday price and volume, live 5-, 10-, and 20-day moving averages, watchlist sorting, and configurable alerts.

## Install

1. Open `arc://extensions` in Arc, `chrome://extensions` in Chrome, or `edge://extensions` in Edge. Arc also accepts `chrome://extensions` on builds that redirect Chromium settings pages.
2. Enable Developer mode.
3. Select **Load unpacked** and choose the downloaded repository directory containing `manifest.json`.
4. Open or refresh [the zx017 chat page](https://pc.zx017.net/vueapp/uc/chatting?forum_id=157). A warm light “我的股票” panel appears in the blank area on the right.

Reload the extension from the extensions page and refresh the chat tab after changing any file in this directory. The extension runs directly from these files and has no build step.

## Use the watchlist

New installations start with an empty watchlist. Type a Chinese stock name, six-digit code, or pinyin in the search field, then select the intended Shanghai or Shenzhen A-share from the autocomplete list. The arrow keys and Enter also operate the list.

Each card has a remove button, a moving-average alert switch, and an alert-settings button. Price, percentage-change, and moving-average rules are stored with the watchlist in `chrome.storage.local`. The header can sort the current page by original order, triggered alerts, gain, loss, or code; the selected sort mode is not persisted.

## Read the card and alert

The card shows the latest price, change, change percentage, previous close, live MA5, MA10, MA20, and distance from MA5. Its chart draws price, the yellow average-price line, per-minute volume bars, and sampled intraday high/low markers. Those markers are extrema of the displayed minute prices, not exact trade-by-trade session extrema. The fixed horizontal axis covers 09:30–11:30 and 13:00–15:00, so the lines advance with trading time while future minutes remain blank. The crosshair shows time, price, average, change percentage, and volume; the arrow keys provide the same inspection.

Quotes refresh every 15 seconds while the page is visible. The header button refreshes immediately, and the arrow button collapses the panel to a narrow rail. A failed refresh keeps the last usable quote and marks the affected card instead of displaying a false zero.

Alerts can watch upper/lower price thresholds, upper/lower percentage-change thresholds, and one above/below rule for MA5, MA10, or MA20. A desktop notification is sent only when a rule changes from inactive to active, rather than every 15 seconds while it remains active. Checks run only while the chat page is open and visible. Live averages use the latest minute price in place of the current session close.

## Data, permissions, and privacy

The content script runs only on `https://pc.zx017.net/vueapp/uc/chatting*` and mounts one closed Shadow DOM host so page scripts cannot inspect the sidebar UI through `shadowRoot`. It does not read or transmit chat messages, cookies, credentials, or page storage.

The background service worker uses Eastmoney for name and code suggestions. Daily and minute requests prefer Tencent, then independently fall back to Eastmoney and Sina when an earlier provider fails; provider responses are checked against the requested stock before they reach the card. The `storage` permission persists the watchlist and alert rules, while `notifications` displays triggered alerts. Third-party public endpoints may be delayed, rate-limited, unavailable, or changed without notice; the displayed data is for personal observation and is not investment advice.

## Files and checks

```text
stock-chat-sidebar/
├── manifest.json
├── background.js
├── market-api.mjs
├── content.js
├── content.css
├── package.json
└── test/
```

These commands are only for development; regular installation does not require Node.js or npm. Run the focused checks from the repository root:

```sh
npm ci
npm test
node --check market-api.mjs
node --check background.js
node --check content.js
```

## Troubleshooting

If the panel does not appear, confirm that the URL starts with `https://pc.zx017.net/vueapp/uc/chatting`, reload the extension, and refresh the tab. If Arc still runs stale source after an extension reload, keep `manifest.json`'s version and the `market-api.mjs?v=...` import in `background.js` synchronized, reload the extension again, and then refresh the chat tab. If autocomplete or quotes fail, inspect the extension service worker from `chrome://extensions`; a public data endpoint may also be temporarily unavailable. If the page is narrow, use the panel arrow to collapse it while chatting.
