/**
 * Update Taiwan listed/OTC daily K-line files from TWSE and TPEx.
 *
 * This project already contains historical K-line JSON files under:
 *   data/master/kline/{stock_id}.json
 *
 * The daily job appends or replaces the latest trading-day candle. If a newly
 * listed stock appears in the daily quote feed, a new file is created starting
 * from that quote date. It does not fetch historical data or create institutional data.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const KLINE_DIR = join(ROOT, 'data', 'master', 'kline')

function parseNumber(value) {
  const text = String(value ?? '').replace(/,/g, '').trim()
  if (!text || text === '--' || text === '---') return 0
  return Number.parseFloat(text) || 0
}

function rocToDate(value) {
  const text = String(value ?? '').replace(/\D/g, '')

  if (text.length === 8) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  }

  if (text.length === 7) {
    const year = Number.parseInt(text.slice(0, 3), 10) + 1911
    return `${year}-${text.slice(3, 5)}-${text.slice(5, 7)}`
  }

  return null
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data), 'utf8')
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchOnce(url, parse, redirectsLeft = 3) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  let response
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json, text/csv;q=0.9, */*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; tw-stock-sync/1.0; +https://github.com/sln-crayfish/tw-stock-sync)'
      }
    })
  } finally {
    clearTimeout(timeout)
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (!location || redirectsLeft <= 0) {
      throw new Error(`HTTP ${response.status} from ${url}`)
    }

    const nextUrl = new URL(location, url).toString()
    return fetchOnce(nextUrl, parse, redirectsLeft - 1)
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`)
  }

  return parse(response)
}

async function fetchWithRetry(url, label, parse) {
  const attempts = 4

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchOnce(url, parse)
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`${label} fetch failed after ${attempts} attempts: ${error.message}`)
      }

      const wait = attempt * 3000
      console.log(`${label} fetch attempt ${attempt} failed: ${error.message}; retrying in ${wait / 1000}s...`)
      await sleep(wait)
    }
  }
}

function fetchJson(url, label) {
  return fetchWithRetry(url, label, response => response.json())
}

function fetchCsv(url, label) {
  return fetchWithRetry(url, label, response => response.text())
}

// Minimal RFC-4180-style parser for a single CSV line. TWSE quotes every field,
// so this also handles the rare case of a comma inside a quoted value.
function parseCsvLine(line) {
  const fields = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else {
      field += char
    }
  }

  fields.push(field)
  return fields
}

function addQuote(quotes, code, name, candle) {
  if (!/^\d{4}$/.test(code)) return
  if (!candle.date || !candle.close) return
  quotes.set(code, {
    symbol: code,
    name: String(name ?? '').trim(),
    candle
  })
}

async function fetchTwseQuotes() {
  // The legacy rwd JSON variant was retired; this endpoint now only serves CSV.
  // Columns: 日期, 證券代號, 證券名稱, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數
  const url = 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=csv'
  const csv = await fetchCsv(url, 'TWSE')
  const rows = csv.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '')
  const quotes = new Map()
  let date = null

  // Row 0 is the header.
  for (let i = 1; i < rows.length; i++) {
    const cols = parseCsvLine(rows[i])
    if (cols.length < 9) continue

    const rowDate = rocToDate(cols[0])
    if (!rowDate) continue
    if (!date) date = rowDate

    const code = cols[1].trim()
    const close = parseNumber(cols[8])

    addQuote(quotes, code, cols[2], {
      date: rowDate,
      open: parseNumber(cols[5]) || close,
      high: parseNumber(cols[6]) || close,
      low: parseNumber(cols[7]) || close,
      close,
      volume: Math.round(parseNumber(cols[3]) / 1000)
    })
  }

  if (!date) {
    throw new Error('TWSE did not return a valid quote date.')
  }

  if (quotes.size === 0) {
    throw new Error(`TWSE returned no valid quotes for ${date}.`)
  }

  return { date, quotes }
}

async function fetchTpexQuotes() {
  // The legacy stk_quote_result.php endpoint was retired; use the OpenAPI feed,
  // which returns the latest trading day for the OTC main board.
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'
  const json = await fetchJson(url, 'TPEx')

  if (!Array.isArray(json)) {
    throw new Error('TPEx returned an unexpected payload shape.')
  }

  const quotes = new Map()
  let date = null

  for (const row of json) {
    const rowDate = rocToDate(row.Date)
    if (!rowDate) continue
    if (!date) date = rowDate

    const code = String(row.SecuritiesCompanyCode ?? '').trim()
    const close = parseNumber(row.Close)

    addQuote(quotes, code, row.CompanyName, {
      date: rowDate,
      open: parseNumber(row.Open) || close,
      high: parseNumber(row.High) || close,
      low: parseNumber(row.Low) || close,
      close,
      volume: Math.round(parseNumber(row.TradingShares) / 1000)
    })
  }

  if (!date) {
    throw new Error('TPEx did not return a valid quote date.')
  }

  if (quotes.size === 0) {
    throw new Error(`TPEx returned no valid quotes for ${date}.`)
  }

  return { date, quotes }
}

async function fetchDailyQuotes() {
  const twse = await fetchTwseQuotes()
  const tpex = await fetchTpexQuotes()

  // TWSE and TPEx publish independently and may be a trading day apart near the
  // update window. Each candle is stored under its own source date, so a mismatch
  // is not an error; surface it for visibility only.
  if (twse.date !== tpex.date) {
    console.log(`Note: TWSE quote date ${twse.date} differs from TPEx ${tpex.date}; each candle is stored under its own source date.`)
  }

  return {
    date: twse.date,
    tpexDate: tpex.date,
    quotes: new Map([...twse.quotes, ...tpex.quotes]),
    sourceCounts: {
      twse: twse.quotes.size,
      tpex: tpex.quotes.size
    }
  }
}

function sameCandle(a, b) {
  return a?.date === b.date &&
    Number(a.open) === b.open &&
    Number(a.high) === b.high &&
    Number(a.low) === b.low &&
    Number(a.close) === b.close &&
    Number(a.volume) === b.volume
}

function createKlineFile(path, quote) {
  writeJson(path, {
    symbol: quote.symbol,
    name: quote.name,
    lastDate: quote.candle.date,
    candles: [quote.candle]
  })
}

function updateKlineFile(path, quote) {
  const existing = readJson(path)
  const candle = quote.candle

  if (!existing || existing.terminated) return 'skipped'
  if (!Array.isArray(existing.candles)) return 'invalid'
  if (existing.lastDate && existing.lastDate > candle.date) return 'skipped'

  const candleMap = new Map(existing.candles.map(candle => [candle.date, candle]))
  const current = candleMap.get(candle.date)

  if (existing.lastDate === candle.date && sameCandle(current, candle)) {
    return 'unchanged'
  }

  candleMap.set(candle.date, candle)

  const candles = [...candleMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  writeJson(path, {
    ...existing,
    lastDate: candles.at(-1)?.date ?? existing.lastDate,
    candles
  })

  return existing.lastDate === candle.date ? 'replaced' : 'updated'
}

async function main() {
  if (!existsSync(KLINE_DIR)) {
    throw new Error(`K-line directory does not exist: ${KLINE_DIR}`)
  }

  console.log('Fetching daily K-line quotes from TWSE and TPEx...')
  const daily = await fetchDailyQuotes()
  const { date: quoteDate, quotes, sourceCounts } = daily

  if (quotes.size === 0) {
    throw new Error('No daily quotes were returned from TWSE or TPEx.')
  }

  const files = readdirSync(KLINE_DIR).filter(file => file.endsWith('.json'))
  if (files.length === 0) {
    throw new Error(`No K-line JSON files found in ${KLINE_DIR}`)
  }

  const counts = {
    updated: 0,
    replaced: 0,
    unchanged: 0,
    skipped: 0,
    invalid: 0,
    noQuote: 0,
    created: 0
  }
  const invalidFiles = []
  const existingSymbols = new Set(files.map(file => file.slice(0, -'.json'.length)))

  for (const file of files) {
    const symbol = file.slice(0, -'.json'.length)
    const quote = quotes.get(symbol)

    if (!quote) {
      counts.noQuote += 1
      continue
    }

    let result
    try {
      result = updateKlineFile(join(KLINE_DIR, file), quote)
    } catch (error) {
      result = 'invalid'
      invalidFiles.push(`${file}: ${error.message}`)
    }

    if (result === 'invalid' && invalidFiles.at(-1)?.startsWith(`${file}:`) !== true) {
      invalidFiles.push(file)
    }
    counts[result] += 1
  }

  for (const [symbol, quote] of quotes) {
    if (existingSymbols.has(symbol)) continue

    try {
      createKlineFile(join(KLINE_DIR, `${symbol}.json`), quote)
      counts.created += 1
    } catch (error) {
      counts.invalid += 1
      invalidFiles.push(`${symbol}.json: ${error.message}`)
    }
  }

  console.log(`Quote date: ${quoteDate}${daily.tpexDate && daily.tpexDate !== quoteDate ? ` (TPEx ${daily.tpexDate})` : ''}`)
  console.log(`TWSE quotes: ${sourceCounts.twse}`)
  console.log(`TPEx quotes: ${sourceCounts.tpex}`)
  console.log(`Total symbols with quotes: ${quotes.size}`)
  console.log(`Updated: ${counts.updated}`)
  console.log(`Corrected same date: ${counts.replaced}`)
  console.log(`Unchanged: ${counts.unchanged}`)
  console.log(`Created new files: ${counts.created}`)
  console.log(`Skipped: ${counts.skipped}`)
  console.log(`Invalid files: ${counts.invalid}`)
  console.log(`No quote: ${counts.noQuote}`)

  if (invalidFiles.length > 0) {
    console.log('Invalid file examples:')
    for (const file of invalidFiles.slice(0, 10)) {
      console.log(`- ${file}`)
    }
    throw new Error(`${invalidFiles.length} K-line files are invalid.`)
  }
}

export { fetchTwseQuotes, fetchTpexQuotes, fetchDailyQuotes, updateKlineFile, parseCsvLine }

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
