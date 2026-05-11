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
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const KLINE_DIR = join(ROOT, 'data', 'master', 'kline')

function adToRocDate(date) {
  const [year, month, day] = date.split('-').map(Number)
  return `${year - 1911}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`
}

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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'tw-stock-sync/1.0'
    }
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`)
  }

  return response.json()
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
  const url = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json'
  const json = await fetchJson(url)
  const date = rocToDate(json.date) ?? rocToDate(json.title)
  const quotes = new Map()

  if (!date) {
    throw new Error('TWSE did not return a valid quote date.')
  }

  for (const row of json.data ?? []) {
    const code = String(row[0] ?? '').trim()
    const close = parseNumber(row[7])

    addQuote(quotes, code, row[1], {
      date,
      open: parseNumber(row[4]) || close,
      high: parseNumber(row[5]) || close,
      low: parseNumber(row[6]) || close,
      close,
      volume: Math.round(parseNumber(row[2]) / 1000)
    })
  }

  if (quotes.size === 0) {
    throw new Error(`TWSE returned no valid quotes for ${date}.`)
  }

  return { date, quotes }
}

async function fetchTpexQuotes(date) {
  const rocDate = adToRocDate(date)
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${encodeURIComponent(rocDate)}&type=0&response=json`
  const json = await fetchJson(url)
  const responseDate = rocToDate(json.date) ?? rocToDate(json.title)
  const quotes = new Map()

  if (responseDate && responseDate !== date) {
    throw new Error(`TPEx returned quote date ${responseDate}, expected ${date}.`)
  }

  for (const row of json.tables?.[0]?.data ?? []) {
    const code = String(row[0] ?? '').trim()
    const close = parseNumber(row[2])

    addQuote(quotes, code, row[1], {
      date: responseDate ?? date,
      open: parseNumber(row[4]) || close,
      high: parseNumber(row[5]) || close,
      low: parseNumber(row[6]) || close,
      close,
      volume: Math.round(parseNumber(row[8]) / 1000)
    })
  }

  if (quotes.size === 0) {
    throw new Error(`TPEx returned no valid quotes for ${date}.`)
  }

  return { date, quotes }
}

async function fetchDailyQuotes() {
  const twse = await fetchTwseQuotes()
  const tpex = await fetchTpexQuotes(twse.date)

  return {
    date: twse.date,
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

  console.log(`Quote date: ${quoteDate}`)
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

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
