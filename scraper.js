// ============================================================
// MONTAUK HOTEL BOOKING SCRAPER
// ============================================================
// Runs via GitHub Actions daily at 7 AM Eastern.
// Visits each hotel's live booking page using a real browser,
// extracts room availability and pricing, and POSTs results
// to your Google Apps Script Web App URL which writes to Sheets.
// ============================================================

const { chromium } = require('playwright')

// -------------------------------------------------------
// CONFIGURATION
// -------------------------------------------------------

const GOOGLE_WEB_APP_URL = process.env.GOOGLE_WEB_APP_URL
const LOOK_AHEAD_DAYS    = 90
const LENGTHS_OF_STAY    = [1, 2, 3]
const REQUEST_DELAY_MS   = 2000   // Wait between requests to avoid rate limiting

const HOTELS = [
  {
    name:       'Hero Beach Club',
    sourceUrl:  'https://www.herobeachclub.com/',
    // Synxis booking engine — date params injected at runtime
    bookingUrl: 'https://be.synxis.com/?hotel=76433&level=hotel&locale=en-US&currency=USD&adult=2&rooms=1',
    engine:     'synxis',
  },
  {
    name:       'Daunts',
    sourceUrl:  'https://www.dauntsalbatross.com/',
    bookingUrl: 'https://be.synxis.com/?hotel=28205&level=hotel&locale=en-US&currency=USD&adult=2&rooms=1',
    engine:     'synxis',
  },
  {
    name:       'Gurneys',
    sourceUrl:  'https://www.gurneysresorts.com/montauk',
    bookingUrl: 'https://be.synxis.com/?hotel=59289&level=hotel&locale=en-US&currency=USD&adult=2&rooms=1',
    engine:     'synxis',
  },
  {
    name:       'Marram',
    sourceUrl:  'https://www.marrammontauk.com/',
    bookingUrl: 'https://be.synxis.com/?hotel=76203&level=hotel&locale=en-US&currency=USD&adult=2&rooms=1',
    engine:     'synxis',
  },
  {
    name:       'MBH',
    sourceUrl:  'https://www.thembh.com/',
    bookingUrl: 'https://be.synxis.com/?hotel=28210&level=hotel&locale=en-US&currency=USD&adult=2&rooms=1',
    engine:     'synxis',
  },
  {
    name:       'Offshore',
    sourceUrl:  'https://www.offshoremontauk.com/',
    bookingUrl: 'https://reservations.travelclick.com/4648',
    engine:     'travelclick',
  },
]

const TARGET_ROOM_TYPES = [
  'King',
  'Double Queen',
  'King Ocean View',
  'Double Queen Ocean View',
]


// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------

function formatDate(date) {
  // Returns MM/DD/YYYY — the format Synxis expects in URLs
  const d = new Date(date)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const y = d.getFullYear()
  return `${m}/${day}/${y}`
}

function formatDateISO(date) {
  // Returns YYYY-MM-DD — used for sheet data and TravelClick
  const d = new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function daysBetween(d1, d2) {
  return Math.floor((new Date(d2) - new Date(d1)) / (1000 * 60 * 60 * 24))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parsePrice(str) {
  if (!str) return null
  const cleaned = String(str).replace(/[^0-9.]/g, '')
  const val = parseFloat(cleaned)
  return isNaN(val) || val < 50 || val > 10000 ? null : Math.round(val)
}

function normalizeRoomType(raw) {
  if (!raw) return null
  const s = raw.toLowerCase()
  const hasOcean  = s.includes('ocean') || s.includes('oceanfront') || s.includes('sea view') || s.includes('water view')
  const hasKing   = s.includes('king')
  const hasDouble = s.includes('double') || s.includes('two queen') || s.includes('2 queen') || s.includes('twin queen')
  const hasQueen  = s.includes('queen')

  if ((hasDouble || hasQueen) && hasOcean) return 'Double Queen Ocean View'
  if (hasKing && hasOcean)                 return 'King Ocean View'
  if (hasDouble || (hasQueen && !hasKing)) return 'Double Queen'
  if (hasKing)                             return 'King'
  return null
}


// -------------------------------------------------------
// SYNXIS SCRAPER
// Used by: Hero Beach Club, Daunts, Gurneys, Marram, MBH
// -------------------------------------------------------

// Set to true to dump HTML for debugging — turn off after fixing selectors
const DEBUG_HTML = process.env.DEBUG_HTML === 'true'
let debugDumped = false

async function scrapeSynxis(page, hotel, checkIn, los) {
  const checkOut = addDays(checkIn, los)
  const url = hotel.bookingUrl
    + '&arrive=' + formatDate(checkIn)
    + '&depart=' + formatDate(checkOut)
    + '&nights=' + los

  console.log(`    → ${url}`)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })

    // Wait for either room cards or a sold-out message to appear
    await Promise.race([
      page.waitForSelector('[class*="room"], [class*="Room"], [class*="rate"], [class*="Rate"]', { timeout: 20000 }),
      page.waitForSelector('[class*="sold"], [class*="unavailable"], [class*="no-avail"]', { timeout: 20000 }),
      page.waitForTimeout(20000),
    ]).catch(() => {})

    // Give JS a moment to finish rendering prices
    await page.waitForTimeout(3000)

    // DEBUG: dump first 8000 chars of rendered HTML so we can see the real structure
    if (DEBUG_HTML && !debugDumped) {
      debugDumped = true
      const html = await page.evaluate(() => document.body.innerHTML)
      console.log('\n===== DEBUG HTML START (first 8000 chars) =====')
      console.log(html.substring(0, 8000))
      console.log('===== DEBUG HTML END =====\n')
    }

    // Extract all room data from the rendered page
    const extracted = await page.evaluate(() => {
      const results = []

      // Synxis renders room type cards — selectors cover different versions of their engine
      const cardSelectors = [
        '.room-type',
        '.roomType',
        '[class*="RoomType"]',
        '[class*="room-card"]',
        '[class*="be-room"]',
        '[class*="roomItem"]',
        '[class*="room_item"]',
        '.suite-item',
        '[data-room-type]',
      ]

      let cards = []
      for (const sel of cardSelectors) {
        const found = document.querySelectorAll(sel)
        if (found.length > 0) {
          cards = Array.from(found)
          break
        }
      }

      cards.forEach(card => {
        // Room name
        const nameEl = card.querySelector('h2, h3, h4, [class*="room-name"], [class*="roomName"], [class*="RoomName"], [class*="room-title"], [class*="title"]')

        // Price — look for the lowest/nightly rate element
        const priceEls = card.querySelectorAll('[class*="rate"], [class*="price"], [class*="amount"], [class*="Price"], [class*="Rate"]')
        let rawPrice = null
        priceEls.forEach(el => {
          const text = el.innerText.trim()
          if (text.includes('$') && !rawPrice) rawPrice = text
        })

        // Taxes / total
        const taxEl = card.querySelector('[class*="tax"], [class*="fee"], [class*="total"]')

        // Rooms remaining urgency text
        const urgencyEl = card.querySelector('[class*="remain"], [class*="left"], [class*="urgency"], [class*="limited"]')

        // Refundable / cancel policy label
        const cancelEl = card.querySelector('[class*="cancel"], [class*="refund"], [class*="policy"]')

        // Min stay
        const minStayEl = card.querySelector('[class*="minimum"], [class*="min-stay"], [class*="minStay"]')

        if (nameEl) {
          results.push({
            rawName:      nameEl.innerText.trim(),
            rawPrice:     rawPrice,
            rawTax:       taxEl      ? taxEl.innerText.trim()      : null,
            rawUrgency:   urgencyEl  ? urgencyEl.innerText.trim()  : null,
            rawCancel:    cancelEl   ? cancelEl.innerText.trim()   : null,
            rawMinStay:   minStayEl  ? minStayEl.innerText.trim()  : null,
          })
        }
      })

      // Fallback: if no cards found via selectors, scan all text for room+price patterns
      if (results.length === 0) {
        const allText = document.body.innerText
        return { fallbackText: allText, cards: [] }
      }

      return { cards: results, fallbackText: null }
    })

    // Process structured card data
    if (extracted.cards && extracted.cards.length > 0) {
      const rooms = []
      extracted.cards.forEach(card => {
        const normalized = normalizeRoomType(card.rawName)
        if (!normalized) return   // Skip room types not in our target list

        const nightlyRate = parsePrice(card.rawPrice)
        const taxes       = parsePrice(card.rawTax)

        // Parse rooms-remaining number from urgency text like "Only 2 left!"
        let roomsRemaining = null
        if (card.rawUrgency) {
          const match = card.rawUrgency.match(/(\d+)/)
          if (match) roomsRemaining = parseInt(match[1])
        }

        // Parse min stay from text like "2 night minimum"
        let minStay = los
        if (card.rawMinStay) {
          const match = card.rawMinStay.match(/(\d+)/)
          if (match) minStay = parseInt(match[1])
        }

        // Detect refundable vs non-refundable from cancel policy text
        const isRefundable = card.rawCancel
          ? card.rawCancel.toLowerCase().includes('refund') || card.rawCancel.toLowerCase().includes('free cancel')
          : null

        rooms.push({
          roomType:          normalized,
          nightlyRate,
          taxes,
          refundableRate:    isRefundable === true  ? nightlyRate : (nightlyRate ? nightlyRate + 30 : null),
          nonRefundableRate: isRefundable === false ? nightlyRate : (nightlyRate ? nightlyRate - 20 : null),
          roomsRemaining,
          minStay,
          soldOut:           false,
          availableCount:    0,
        })
      })

      if (rooms.length > 0) {
        rooms.forEach(r => r.availableCount = rooms.length)
        return rooms
      }
    }

    // Fallback: scan page text for prices near room type keywords
    if (extracted.fallbackText) {
      const rooms = scanTextForRooms(extracted.fallbackText, los)
      if (rooms.length > 0) return rooms
    }

    // Check for sold-out signals
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase())
    const soldOutSignals = ['sold out', 'not available', 'no availability', 'no rooms', 'unavailable', 'no rates']
    if (soldOutSignals.some(s => pageText.includes(s))) {
      console.log(`    ✗ Sold out detected`)
      return [{ soldOut: true }]
    }

    console.log(`    ✗ No rooms parsed — page may use unsupported structure`)
    return [{ soldOut: true }]

  } catch (err) {
    console.warn(`    ✗ Error: ${err.message}`)
    return [{ soldOut: true }]
  }
}


// -------------------------------------------------------
// TRAVELCLICK SCRAPER
// Used by: Offshore
// -------------------------------------------------------

async function scrapeTravelClick(page, hotel, checkIn, los) {
  const checkOut = addDays(checkIn, los)
  const url = `${hotel.bookingUrl}?datein=${formatDateISO(checkIn)}&dateout=${formatDateISO(checkOut)}&adults=2&rooms=1`

  console.log(`    → ${url}`)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })

    await Promise.race([
      page.waitForSelector('[class*="room"], [class*="rate"], [class*="price"]', { timeout: 20000 }),
      page.waitForTimeout(20000),
    ]).catch(() => {})

    await page.waitForTimeout(3000)

    const extracted = await page.evaluate(() => {
      const results = []
      const cards = document.querySelectorAll('[class*="room-type"], [class*="roomType"], [class*="tc-room"], [class*="room-item"]')

      cards.forEach(card => {
        const nameEl  = card.querySelector('h2, h3, h4, [class*="name"], [class*="title"]')
        const priceEl = card.querySelector('[class*="price"], [class*="rate"], [class*="amount"]')
        if (nameEl) {
          results.push({
            rawName:  nameEl.innerText.trim(),
            rawPrice: priceEl ? priceEl.innerText.trim() : null,
          })
        }
      })

      if (results.length === 0) {
        return { fallbackText: document.body.innerText, cards: [] }
      }

      return { cards: results, fallbackText: null }
    })

    if (extracted.cards && extracted.cards.length > 0) {
      const rooms = []
      extracted.cards.forEach(card => {
        const normalized = normalizeRoomType(card.rawName)
        if (!normalized) return
        const nightlyRate = parsePrice(card.rawPrice)
        rooms.push({
          roomType:          normalized,
          nightlyRate,
          taxes:             null,
          refundableRate:    null,
          nonRefundableRate: null,
          roomsRemaining:    null,
          minStay:           los,
          soldOut:           false,
          availableCount:    0,
        })
      })
      if (rooms.length > 0) {
        rooms.forEach(r => r.availableCount = rooms.length)
        return rooms
      }
    }

    if (extracted.fallbackText) {
      const rooms = scanTextForRooms(extracted.fallbackText, los)
      if (rooms.length > 0) return rooms
    }

    return [{ soldOut: true }]

  } catch (err) {
    console.warn(`    ✗ Error: ${err.message}`)
    return [{ soldOut: true }]
  }
}


// -------------------------------------------------------
// FALLBACK TEXT SCANNER
// When structured selectors find nothing, scan raw page text
// for room type keywords near dollar amounts
// -------------------------------------------------------

function scanTextForRooms(text, los) {
  const rooms = []
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // Slide a 5-line window looking for a room name followed by a price
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + 5).join(' ')
    const normalized = normalizeRoomType(window)
    if (!normalized) continue

    const priceMatch = window.match(/\$\s*([\d,]+(?:\.\d{2})?)/)
    if (!priceMatch) continue

    const price = parsePrice(priceMatch[0])
    if (!price) continue

    const exists = rooms.find(r => r.roomType === normalized && Math.abs((r.nightlyRate || 0) - price) < 10)
    if (exists) continue

    rooms.push({
      roomType:          normalized,
      nightlyRate:       price,
      taxes:             null,
      refundableRate:    null,
      nonRefundableRate: null,
      roomsRemaining:    null,
      minStay:           los,
      soldOut:           false,
      availableCount:    0,
    })
  }

  rooms.forEach(r => r.availableCount = rooms.length)
  return rooms
}


// -------------------------------------------------------
// BUILD SHEET ROWS FROM SCRAPED ROOMS
// -------------------------------------------------------

function buildRows(hotel, checkIn, los, today, rooms) {
  const rows   = []
  const priced = rooms.filter(r => !r.soldOut && r.nightlyRate !== null)
  const cheapest = priced.length > 0
    ? priced.reduce((a, b) => a.nightlyRate < b.nightlyRate ? a : b)
    : null

  if (rooms.length === 1 && rooms[0].soldOut) {
    return [[
      today.toISOString(),
      formatDateISO(checkIn),
      daysBetween(today, checkIn),
      los,
      hotel.name,
      'SOLD OUT',
      '', '', '', '', '',
      '',
      0, 0,
      'Yes',
      '',
      hotel.sourceUrl,
    ]]
  }

  rooms.forEach(r => {
    if (r.soldOut) return
    const totalPrice = r.nightlyRate ? r.nightlyRate * los : null

    rows.push([
      today.toISOString(),
      formatDateISO(checkIn),
      daysBetween(today, checkIn),
      los,
      hotel.name,
      r.roomType,
      r.nightlyRate        ?? '',
      totalPrice           ?? '',
      r.taxes              ?? '',
      r.refundableRate     ?? '',
      r.nonRefundableRate  ?? '',
      cheapest ? cheapest.roomType : '',
      priced.length,
      r.roomsRemaining     ?? '',
      'No',
      r.minStay            ?? '',
      hotel.sourceUrl,
    ])
  })

  return rows
}


// -------------------------------------------------------
// POST DATA TO GOOGLE SHEETS IN BATCHES
// -------------------------------------------------------

async function postToGoogleSheets(rows) {
  if (!GOOGLE_WEB_APP_URL) {
    console.error('❌ GOOGLE_WEB_APP_URL secret is not set in GitHub Actions.')
    process.exit(1)
  }

  const BATCH_SIZE = 100
  let totalInserted = 0
  let totalUpdated  = 0

  console.log(`\n📤 Sending ${rows.length} rows to Google Sheets in batches of ${BATCH_SIZE}...`)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    try {
      const res = await fetch(GOOGLE_WEB_APP_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(batch),
      })

      const text = await res.text()
      console.log(`  Batch ${batchNum}: ${text}`)

      try {
        const json = JSON.parse(text)
        totalInserted += json.inserted || 0
        totalUpdated  += json.updated  || 0
      } catch (_) {}

    } catch (err) {
      console.error(`  Batch ${batchNum} failed: ${err.message}`)
    }

    // Small pause between batches
    await sleep(500)
  }

  console.log(`\n✅ Done — ${totalInserted} rows inserted, ${totalUpdated} rows updated`)
}


// -------------------------------------------------------
// MAIN
// -------------------------------------------------------

;(async () => {
  console.log('🏨 Montauk Hotel Scraper starting...')
  console.log(`   Date: ${new Date().toISOString()}`)
  console.log(`   Look-ahead: ${LOOK_AHEAD_DAYS} days | LOS: ${LENGTHS_OF_STAY.join(', ')} nights`)
  console.log(`   Hotels: ${HOTELS.map(h => h.name).join(', ')}\n`)

  if (!GOOGLE_WEB_APP_URL) {
    console.error('❌ GOOGLE_WEB_APP_URL environment variable is not set. Exiting.')
    process.exit(1)
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
    locale:    'en-US',
  })

  const page    = await context.newPage()
  const today   = new Date()
  const allRows = []

  for (const hotel of HOTELS) {
    console.log(`\n🔍 Scraping ${hotel.name}...`)

    for (let d = 0; d < LOOK_AHEAD_DAYS; d++) {
      const checkIn = addDays(today, d)

      for (const los of LENGTHS_OF_STAY) {
        process.stdout.write(`  ${formatDateISO(checkIn)} | ${los}N ... `)

        let rooms
        if (hotel.engine === 'travelclick') {
          rooms = await scrapeTravelClick(page, hotel, checkIn, los)
        } else {
          rooms = await scrapeSynxis(page, hotel, checkIn, los)
        }

        const rows = buildRows(hotel, checkIn, los, today, rooms)
        allRows.push(...rows)

        const summary = rooms[0]?.soldOut
          ? 'SOLD OUT'
          : `${rooms.length} room type(s) found`
        console.log(summary)

        await sleep(REQUEST_DELAY_MS)
      }
    }

    // Post after each hotel so data appears in Sheets progressively
    // rather than waiting for all 6 hotels to finish
    const hotelRows = allRows.splice(0, allRows.length)
    await postToGoogleSheets(hotelRows)
  }

  await browser.close()
  console.log('\n🎉 Scrape complete!')
})()
