/**
 * Backfill a specific trading day's K-line data.
 *
 * Usage: node ref/backfill-kline.mjs YYYY-MM-DD
 *
 * Strategy per stock:
 *  1. TWSE per-stock monthly API  (authoritative for listed stocks)
 *  2. Yahoo Finance .TWO suffix   (fallback for OTC/TPEx stocks)
 *  3. Skip with warning           (no data found)
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const KLINE_DIR = join(ROOT, 'data', 'master', 'kline')

// ── helpers ──────────────────────────────────────────────────────────────────

function parseNumber(value) {
  const text = String(value ?? '').replace(/,/g, '').trim()
  if (!text || text === '--' || text === '---') return 0
  return Number.parseFloat(text) || 0
}

function round2(n) { return Math.round(n * 100) / 100 }

function rocToAd(rocDate) {
  // "115/05/26" → "2026-05-26"
  const [y, m, d] = rocDate.split('/')
  return `${Number(y) + 1911}-${m}-${d}`
}

function adToYyyyMm01(date) {
  return date.slice(0, 7).replace('-', '').replace('-', '') + '01'
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function writeJson(path, data) { writeFileSync(path, JSON.stringify(data), 'utf8') }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchJsonOnce(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; tw-stock-sync/1.0; +https://github.com/sln-crayfish/tw-stock-sync)'
      }
    })
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location')
      if (!loc) throw new Error(`HTTP ${r.status}`)
      return fetchJsonOnce(new URL(loc, url).toString())
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function tryFetch(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try { return await fetchJsonOnce(url) }
    catch (e) {
      if (i === attempts) throw e
      await sleep(i * 1500)
    }
  }
}

// ── data sources ──────────────────────────────────────────────────────────────

async function fetchTwseCandle(stockNo, targetDate) {
  const yyyyMm01 = adToYyyyMm01(targetDate)
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${yyyyMm01}&stockNo=${stockNo}&response=json`
  const json = await tryFetch(url)

  if (json.stat !== 'OK' || !Array.isArray(json.data)) return null

  // columns: [date(ROC), volume, value, open, high, low, close, delta, count]
  for (const row of json.data) {
    const date = rocToAd(row[0])
    if (date !== targetDate) continue
    const close = parseNumber(row[6])
    return {
      date,
      open: round2(parseNumber(row[3]) || close),
      high: round2(parseNumber(row[4]) || close),
      low: round2(parseNumber(row[5]) || close),
      close: round2(close),
      volume: Math.round(parseNumber(row[1]) / 1000)
    }
  }
  return null
}

async function fetchYahooCandle(stockNo, targetDate, suffix) {
  const period1 = Math.floor(new Date(`${targetDate}T00:00:00Z`).getTime() / 1000)
  const period2 = period1 + 86400
  const symbol = `${stockNo}.${suffix}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`

  let json
  try { json = await tryFetch(url) }
  catch { return null }

  const result = json.chart?.result?.[0]
  if (!result?.timestamp?.length) return null

  const q = result.indicators.quote[0]
  const close = round2(q.close[0] ?? 0)
  if (!close) return null

  return {
    date: targetDate,
    open: round2(q.open[0] || close),
    high: round2(q.high[0] || close),
    low: round2(q.low[0] || close),
    close,
    volume: Math.round((q.volume[0] ?? 0) / 1000)
  }
}

// ── kline file update ─────────────────────────────────────────────────────────

function sameCandle(a, b) {
  return a?.date === b.date &&
    Number(a.open) === b.open &&
    Number(a.high) === b.high &&
    Number(a.low) === b.low &&
    Number(a.close) === b.close &&
    Number(a.volume) === b.volume
}

function updateKlineFile(path, candle) {
  const existing = readJson(path)
  if (!existing || existing.terminated) return 'skipped'
  if (!Array.isArray(existing.candles)) return 'invalid'

  const candleMap = new Map(existing.candles.map(c => [c.date, c]))
  const current = candleMap.get(candle.date)
  if (current && sameCandle(current, candle)) return 'unchanged'

  candleMap.set(candle.date, candle)
  const candles = [...candleMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  writeJson(path, {
    ...existing,
    lastDate: candles.at(-1)?.date ?? existing.lastDate,
    candles
  })
  return current ? 'replaced' : 'inserted'
}

// ── main ──────────────────────────────────────────────────────────────────────

async function processStock(file, targetDate) {
  const stockNo = file.slice(0, -5)
  const filePath = join(KLINE_DIR, file)

  // Try TWSE per-stock monthly API
  let candle = null
  let source = null
  try {
    candle = await fetchTwseCandle(stockNo, targetDate)
    if (candle) source = 'twse'
  } catch { /* fall through to Yahoo */ }

  // Fallback: Yahoo Finance TWSE (.TW) then OTC (.TWO)
  if (!candle) {
    candle = await fetchYahooCandle(stockNo, targetDate, 'TW')
    if (!candle) candle = await fetchYahooCandle(stockNo, targetDate, 'TWO')
    if (candle) source = 'yahoo'
  }

  if (!candle) return { result: 'noData', source: null }

  let result
  try {
    result = updateKlineFile(filePath, candle)
  } catch (e) {
    return { result: 'invalid', source, error: e.message }
  }
  return { result, source }
}

async function main() {
  const targetDate = process.argv[2]
  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    console.error('Usage: node ref/backfill-kline.mjs YYYY-MM-DD')
    process.exit(1)
  }

  if (!existsSync(KLINE_DIR)) throw new Error(`K-line directory does not exist: ${KLINE_DIR}`)

  const files = readdirSync(KLINE_DIR).filter(f => f.endsWith('.json'))
  if (!files.length) throw new Error('No kline files found')

  console.log(`Backfilling ${files.length} stocks for ${targetDate}...`)

  const counts = { inserted: 0, replaced: 0, unchanged: 0, skipped: 0, invalid: 0, noData: 0 }
  const bySource = { twse: 0, yahoo: 0 }
  const noDataList = []
  const invalidList = []

  // Process in batches of 2 with delay between batches to avoid rate limiting
  const BATCH_SIZE = 2
  const BATCH_DELAY_MS = 400
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(f => processStock(f, targetDate)))

    for (let j = 0; j < batch.length; j++) {
      const stockNo = batch[j].slice(0, -5)
      const { result, source, error } = results[j]
      counts[result] = (counts[result] ?? 0) + 1
      if (source) bySource[source] = (bySource[source] ?? 0) + 1
      if (result === 'noData') noDataList.push(stockNo)
      if (result === 'invalid') invalidList.push(`${stockNo}: ${error}`)
    }

    const done = Math.min(i + BATCH_SIZE, files.length)
    if (done % 500 < BATCH_SIZE || done === files.length) {
      console.log(`  [${done}/${files.length}] inserted=${counts.inserted} yahoo=${bySource.yahoo} noData=${counts.noData}`)
    }

    if (i + BATCH_SIZE < files.length) await sleep(BATCH_DELAY_MS)
  }

  console.log(`\nResults for ${targetDate}:`)
  console.log(`  Inserted:  ${counts.inserted}  (twse=${bySource.twse}, yahoo=${bySource.yahoo})`)
  console.log(`  Replaced:  ${counts.replaced}`)
  console.log(`  Unchanged: ${counts.unchanged}`)
  console.log(`  Skipped:   ${counts.skipped}`)
  console.log(`  Invalid:   ${counts.invalid}`)
  console.log(`  No data:   ${counts.noData}`)

  if (noDataList.length) {
    console.log(`\nStocks with no data found (${noDataList.length}):`)
    for (const s of noDataList.slice(0, 20)) console.log(`  ${s}`)
    if (noDataList.length > 20) console.log(`  ...and ${noDataList.length - 20} more`)
  }
  if (invalidList.length) {
    console.log('\nInvalid files:')
    for (const s of invalidList.slice(0, 10)) console.log(`  ${s}`)
    throw new Error(`${invalidList.length} invalid files`)
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
