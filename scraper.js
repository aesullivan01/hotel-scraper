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
const LOOK_AHEAD_DAYS    = 3
const LENGTHS_OF_STAY    = [1, 2, 3]
const REQUEST_DELAY_MS   = 2000   // Wait between requests to avoid rate limiting

const HOTELS = [
  {
    name:       'Hero Beach Club',
    sourceUrl:  'https://www.herobeachclub.com/',
    // Navigate to their stay page which embeds the booking widget
    bookingUrl: 'https://www.herobeachclub.com/stay/',
    engine:     'widget',
  },
  {
    name:       'Daunts',
    sourceUrl:  'https://www.dauntsalbatross.com/',
    bookingUrl: 'https://www.dauntsalbatross.com/rooms/',
    engine:     'widget',
  },
  {
    name:       'Gurneys',
    sourceUrl:  'https://www.gurneysresorts.com/montauk',
    bookingUrl: 'https://www.gurneysresorts.com/montauk/rooms-suites',
    engine:     'widget',
  },
  {
    name:       'Marram',
    sourceUrl:  'https://www.marrammontauk.com/',
    bookingUrl: 'https://www.marrammontauk.com/rooms/',
    engine:     'widget',
  },
  {
    name:       'MBH',
    sourceUrl:  'https://www.thembh.com/',
    bookingUrl: 'https://www.thembh.com/rooms/',
    engine:     'widget',
  },
  {
    name:       'Offshore',
    sourceUrl:  'https://www.offshoremontauk.com/',
    bookingUrl: 'https://www.offshoremontauk.com/rooms/',
    engine:     'widget',
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

// -------------------------------------------------------
// WIDGET SCRAPER
// Navigates to each hotel's own rooms page, fills in dates
// via the booking widget, then extracts rendered room data.
// -------------------------------------------------------

let debugDumped = false

async function scrapeWidget(page, hotel, checkIn, los) {
  const checkOut    = addDays(checkIn, los)
  const arriveStr   = formatDate(checkIn)    // MM/DD/YYYY for form inputs
  const departStr   = formatDate(checkOut)
  const arriveFull  = checkIn.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  console.log(`    → ${hotel.bookingUrl}`)

  try {
    await page.goto(hotel.bookingUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(3000)

    // -- Step 1: Try to intercept XHR/fetch calls for availability data --
    // Many booking widgets call an API when dates are entered.
    // We listen for JSON responses that look like availability data.
    let capturedRooms = []

    page.on('response', async response => {
      try {
        const url = response.url()
        const ct  = response.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        if (!url.includes('avail') && !url.includes('room') && !url.includes('rate') && !url.includes('price')) return

        const json = await response.json()
        const parsed = extractRoomsFromJson(json)
        if (parsed.length > 0) {
          capturedRooms.push(...parsed)
        }
      } catch (_) {}
    })

    // -- Step 2: Fill in the date fields in the booking widget --
    const dateInputSelectors = [
      'input[name*="arrive"], input[name*="checkin"], input[name*="check_in"], input[placeholder*="Check"], input[placeholder*="Arrival"], input[aria-label*="Check"]',
    ]

    for (const sel of dateInputSelectors) {
      try {
        const input = await page.$(sel)
        if (input) {
          await input.click({ clickCount: 3 })
          await input.fill(arriveStr)
          await page.keyboard.press('Tab')
          await page.waitForTimeout(500)
          break
        }
      } catch (_) {}
    }

    // Try clicking a "Check Availability" or "Search" button
    const btnSelectors = [
      'button[type="submit"]',
      'button:has-text("Check Availability")',
      'button:has-text("Search")',
      'button:has-text("Book")',
      'input[type="submit"]',
      '[class*="search-btn"]',
      '[class*="check-avail"]',
    ]

    for (const sel of btnSelectors) {
      try {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          break
        }
      } catch (_) {}
    }

    // Wait for results to load
    await page.waitForTimeout(5000)

    // -- Step 3: Use intercepted API data if available --
    if (capturedRooms.length > 0) {
      console.log(`    ✓ Captured ${capturedRooms.length} rooms from API intercept`)
      capturedRooms.forEach(r => r.availableCount = capturedRooms.length)
      return capturedRooms
    }

    // -- Step 4: DEBUG — dump HTML so we can inspect the real structure --
    if (!debugDumped) {
      debugDumped = true
      const html = await page.evaluate(() => document.body.innerHTML)
      console.log('\n===== DEBUG HTML START (first 8000 chars) =====')
      console.log(html.substring(0, 8000))
      console.log('===== DEBUG HTML END =====\n')
    }

    // -- Step 5: Scrape rendered HTML for room cards --
    const extracted = await page.evaluate(() => {
      const results = []

      // Cast a wide net across booking widget patterns
      const cardSelectors = [
        '[class*="room-type"]', '[class*="roomType"]', '[class*="RoomType"]',
        '[class*="room-card"]', '[class*="roomCard"]', '[class*="room-item"]',
        '[class*="room_item"]', '[class*="room_type"]', '[class*="be-room"]',
        '[class*="suite-item"]', '[data-room-type]', '[data-room]',
        '[class*="accommodation"]', '[class*="unit-item"]',
      ]

      let cards = []
      for (const sel of cardSelectors) {
        const found = document.querySelectorAll(sel)
        if (found.length > 0) { cards = Array.from(found); break }
      }

      cards.forEach(card => {
        const nameEl = card.querySelector(
          'h1, h2, h3, h4, [class*="name"], [class*="title"], [class*="heading"]'
        )
        const priceEls = card.querySelectorAll(
          '[class*="rate"], [class*="price"], [class*="amount"], [class*="cost"]'
        )
        let rawPrice = null
        priceEls.forEach(el => {
          if (el.innerText && el.innerText.includes('$') && !rawPrice) {
            rawPrice = el.innerText.trim()
          }
        })

        if (nameEl) {
          results.push({
            rawName:  nameEl.innerText.trim(),
            rawPrice: rawPrice,
          })
        }
      })

      // Last resort — grab all text
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

    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase())
    const soldOutSignals = ['sold out', 'not available', 'no availability', 'no rooms', 'unavailable', 'no rates']
    if (soldOutSignals.some(s => pageText.includes(s))) {
      console.log(`    ✗ Sold out`)
      return [{ soldOut: true }]
    }

    console.log(`    ✗ No rooms parsed`)
    return [{ soldOut: true }]

  } catch (err) {
    console.warn(`    ✗ Error: ${err.message}`)
    return [{ soldOut: true }]
  }
}

// Extract rooms from an intercepted JSON API response
function extractRoomsFromJson(json) {
  const rooms = []
  let items = []

  // Handle various response shapes
  if (Array.isArray(json)) items = json
  else if (json.roomTypes)       items = json.roomTypes
  else if (json.rooms)           items = json.rooms
  else if (json.data?.rooms)     items = json.data.rooms
  else if (json.data?.roomTypes) items = json.data.roomTypes
  else if (json.results)         items = json.results

  items.forEach(item => {
    const rawName    = item.name || item.roomName || item.roomType || item.title || ''
    const normalized = normalizeRoomType(rawName)
    if (!normalized) return

    const rate        = item.rate || item.price || item.lowestRate || item.totalRate || item.baseRate || null
    const nightlyRate = rate ? Math.round(parseFloat(rate)) : null

    rooms.push({
      roomType:          normalized,
      nightlyRate,
      taxes:             item.taxes || item.taxAmount || null,
      refundableRate:    item.refundableRate || null,
      nonRefundableRate: item.nonRefundableRate || null,
      roomsRemaining:    item.availability || item.roomsLeft || item.quantity || null,
      minStay:           item.minLOS || item.minimumStay || item.minStay || 1,
      soldOut:           false,
      availableCount:    0,
    })
  })

  return rooms
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
        rooms = await scrapeWidget(page, hotel, checkIn, los)

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
