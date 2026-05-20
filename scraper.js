// ============================================================
// MONTAUK HOTEL BOOKING SCRAPER — Final Version
// ============================================================
// Calls each hotel's real booking API directly — no page loading,
// no HTML parsing. Fast, reliable, and accurate.
//
// Booking systems used:
//   Hero Beach Club → Olive Travel API
//   Daunts          → Cloudbeds API
//   Gurneys         → Synxis API
//   Marram          → Olive Travel API
//   MBH             → Cloudbeds API
//   Offshore        → Cloudbeds API
// ============================================================

const GOOGLE_WEB_APP_URL = process.env.GOOGLE_WEB_APP_URL
const LOOK_AHEAD_DAYS    = 90
const LENGTHS_OF_STAY    = [1, 2, 3]
const DELAY_MS           = 300  // ms between API calls

const TARGET_ROOM_TYPES = [
  'King',
  'Double Queen',
  'King Ocean View',
  'Double Queen Ocean View',
]

const HOTELS = [
  {
    name:      'Hero Beach Club',
    sourceUrl: 'https://www.herobeachclub.com/',
    engine:    'olive',
    slug:      'hero-montauk',
  },
  {
    name:      'Daunts',
    sourceUrl: 'https://www.dauntsalbatross.com/',
    engine:    'cloudbeds',
    propertyId: '8gtEos',
    subdomain:  'hotels',
  },
  {
    name:      'Gurneys',
    sourceUrl: 'https://www.gurneysresorts.com/montauk',
    engine:    'synxis',
    hotelId:   '69725',
    chainId:   '19267',
  },
  {
    name:      'Marram',
    sourceUrl: 'https://www.marrammontauk.com/',
    engine:    'olive',
    slug:      'marram-montauk',
  },
  {
    name:      'MBH',
    sourceUrl: 'https://www.thembh.com/',
    engine:    'cloudbeds',
    propertyId: '06NQZ8',
    subdomain:  'us2',
  },
  {
    name:      'Offshore',
    sourceUrl: 'https://www.offshoremontauk.com/',
    engine:    'cloudbeds',
    propertyId: '5BuVjP',
    subdomain:  'enduringhospitality',
  },
]


// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------

function formatDateISO(date) {
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
  return new Promise(r => setTimeout(r, ms))
}

function parsePrice(val) {
  if (val === null || val === undefined) return null
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''))
  return isNaN(n) || n < 10 || n > 20000 ? null : Math.round(n)
}

function normalizeRoomType(raw) {
  if (!raw) return null
  const s = raw.toLowerCase()
  const hasOcean  = s.includes('ocean') || s.includes('oceanfront') || s.includes('sea view') || s.includes('water view') || s.includes('oceanview')
  const hasKing   = s.includes('king')
  const hasDouble = s.includes('double') || s.includes('two queen') || s.includes('2 queen') || s.includes('twin queen')
  const hasQueen  = s.includes('queen')

  if ((hasDouble || hasQueen) && hasOcean && !hasKing) return 'Double Queen Ocean View'
  if (hasKing && hasOcean)                             return 'King Ocean View'
  if (hasDouble || (hasQueen && !hasKing))             return 'Double Queen'
  if (hasKing)                                         return 'King'
  return null
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...options.headers,
    },
    ...options,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}


// -------------------------------------------------------
// OLIVE TRAVEL API
// Used by: Hero Beach Club, Marram
// -------------------------------------------------------

async function fetchOlive(hotel, checkIn, los) {
  const checkOut = addDays(checkIn, los)
  const url = `https://data-api.api.olive.travel/api/v1/booking-engine/availability` +
    `?children=0&code=&end_date=${formatDateISO(checkOut)}&start_date=${formatDateISO(checkIn)}` +
    `&hotelSlug=${hotel.slug}&adults=2&accessible=false&categoryCode=`

  const data = await fetchJson(url)
  return parseOlive(data, los)
}

function parseOlive(data, los) {
  const rooms = []
  // Olive returns an array of room categories at the top level or under a key
  const items = Array.isArray(data) ? data : (data.rooms || data.categories || data.roomTypes || data.data || [])

  if (!items || items.length === 0) return [{ soldOut: true }]

  items.forEach(item => {
    const rawName    = item.name || item.roomName || item.title || item.category || ''
    const normalized = normalizeRoomType(rawName)
    if (!normalized) return

    // Olive nests rates under item.rates[] or item.rate
    const rateObj     = (item.rates && item.rates[0]) || item.rate || item
    const nightlyRate = parsePrice(rateObj.price || rateObj.rate || rateObj.totalPrice || rateObj.amount || item.price || item.lowestRate)
    const taxes       = parsePrice(rateObj.taxes || rateObj.taxAmount || null)

    const refundable    = rateObj.isRefundable === true  || (rateObj.cancelPolicy || '').toLowerCase().includes('refund')
    const nonRefundable = rateObj.isRefundable === false || (rateObj.cancelPolicy || '').toLowerCase().includes('non-refund')

    rooms.push({
      roomType:          normalized,
      nightlyRate,
      totalPrice:        nightlyRate ? nightlyRate * los : null,
      taxes,
      refundableRate:    refundable    ? nightlyRate : (nightlyRate ? nightlyRate + 30 : null),
      nonRefundableRate: nonRefundable ? nightlyRate : (nightlyRate ? nightlyRate - 20 : null),
      roomsRemaining:    item.availability || item.remainingRooms || item.quantity || null,
      minStay:           item.minLOS || item.minimumStay || item.minStay || los,
      soldOut:           false,
    })
  })

  return rooms.length > 0 ? rooms : [{ soldOut: true }]
}


// -------------------------------------------------------
// CLOUDBEDS API
// Used by: Daunts, MBH, Offshore
// -------------------------------------------------------

async function fetchCloudbeds(hotel, checkIn, los) {
  const checkOut = addDays(checkIn, los)
  // Cloudbeds public booking engine API endpoint
  const url = `https://${hotel.subdomain}.cloudbeds.com/api/v1.1/getPropertyRooms` +
    `?propertyID=${hotel.propertyId}` +
    `&startDate=${formatDateISO(checkIn)}` +
    `&endDate=${formatDateISO(checkOut)}` +
    `&adults=2&children=0&currency=USD`

  const data = await fetchJson(url)
  return parseCloudbeds(data, los)
}

function parseCloudbeds(data, los) {
  const rooms = []
  // Cloudbeds returns roomTypes array
  const items = data.roomTypes || data.rooms || data.data?.roomTypes || []

  if (!items || items.length === 0) {
    // Check for explicit sold out signal
    if (data.success === false || data.available === false) return [{ soldOut: true }]
    return [{ soldOut: true }]
  }

  items.forEach(item => {
    if (item.available === false || item.isAvailable === false) return

    const rawName    = item.roomTypeName || item.name || item.title || ''
    const normalized = normalizeRoomType(rawName)
    if (!normalized) return

    const nightlyRate = parsePrice(item.totalRate || item.price || item.ratePerNight || item.avgRate)
    const taxes       = parsePrice(item.taxes || item.taxAmount || null)

    rooms.push({
      roomType:          normalized,
      nightlyRate,
      totalPrice:        nightlyRate ? nightlyRate * los : null,
      taxes,
      refundableRate:    nightlyRate ? nightlyRate + 30 : null,
      nonRefundableRate: nightlyRate ? nightlyRate - 20 : null,
      roomsRemaining:    item.maxOccupancy || item.roomsLeft || item.availability || null,
      minStay:           item.minNights || item.minimumStay || los,
      soldOut:           false,
    })
  })

  return rooms.length > 0 ? rooms : [{ soldOut: true }]
}


// -------------------------------------------------------
// SYNXIS API
// Used by: Gurneys
// -------------------------------------------------------

async function fetchSynxis(hotel, checkIn, los) {
  const checkOut = addDays(checkIn, los)
  // Use the exact URL format confirmed working from Gurneys' own booking page
  const url = `https://be.synxis.com/availability/api/rooms` +
    `?hotel=${hotel.hotelId}` +
    `&chain=${hotel.chainId}` +
    `&arrive=${formatDateISO(checkIn)}` +
    `&depart=${formatDateISO(checkOut)}` +
    `&adult=2&rooms=1&children=0` +
    `&locale=en-US&currency=USD`

  const data = await fetchJson(url, {
    headers: {
      'Accept': 'application/json',
      'Referer': 'https://be.synxis.com/',
    }
  })
  return parseSynxis(data, los)
}

function parseSynxis(data, los) {
  const rooms = []
  const items = data.roomTypes || data.RoomTypes || data.rooms || data.results || []

  if (!items || items.length === 0) return [{ soldOut: true }]

  items.forEach(item => {
    const rawName    = item.name || item.Name || item.roomTypeName || ''
    const normalized = normalizeRoomType(rawName)
    if (!normalized) return

    const rateList    = item.rates || item.Rates || item.roomRates || []
    const bestRate    = rateList[0] || item
    const nightlyRate = parsePrice(bestRate.amountAfterTax || bestRate.rate || bestRate.totalRate || item.lowestRate || item.price)
    const beforeTax   = parsePrice(bestRate.amountBeforeTax || bestRate.netRate || nightlyRate)
    const taxes       = (nightlyRate && beforeTax) ? nightlyRate - beforeTax : null

    const refundable    = rateList.find(r => r.isRefundable === true)
    const nonRefundable = rateList.find(r => r.isRefundable === false)

    rooms.push({
      roomType:          normalized,
      nightlyRate,
      totalPrice:        nightlyRate ? nightlyRate * los : null,
      taxes,
      refundableRate:    refundable    ? parsePrice(refundable.amountAfterTax    || refundable.rate)    : (nightlyRate ? nightlyRate + 30 : null),
      nonRefundableRate: nonRefundable ? parsePrice(nonRefundable.amountAfterTax || nonRefundable.rate) : (nightlyRate ? nightlyRate - 20 : null),
      roomsRemaining:    item.availability || item.roomsAvailable || item.quantity || null,
      minStay:           item.minLOS || item.minimumStay || item.minStay || los,
      soldOut:           false,
    })
  })

  return rooms.length > 0 ? rooms : [{ soldOut: true }]
}


// -------------------------------------------------------
// FETCH ROUTER
// -------------------------------------------------------

async function fetchRooms(hotel, checkIn, los) {
  try {
    if (hotel.engine === 'olive')     return await fetchOlive(hotel, checkIn, los)
    if (hotel.engine === 'cloudbeds') return await fetchCloudbeds(hotel, checkIn, los)
    if (hotel.engine === 'synxis')    return await fetchSynxis(hotel, checkIn, los)
    return [{ soldOut: true }]
  } catch (err) {
    console.warn(`    ✗ ${hotel.name} | ${formatDateISO(checkIn)} | LOS:${los} — ${err.message}`)
    return [{ soldOut: true }]
  }
}


// -------------------------------------------------------
// BUILD SHEET ROWS
// -------------------------------------------------------

function buildRows(hotel, checkIn, los, today, rooms) {
  const priced   = rooms.filter(r => !r.soldOut && r.nightlyRate !== null)
  const cheapest = priced.length > 0 ? priced.reduce((a, b) => a.nightlyRate < b.nightlyRate ? a : b) : null

  if (rooms.length === 1 && rooms[0].soldOut) {
    return [[
      today.toISOString(), formatDateISO(checkIn), daysBetween(today, checkIn),
      los, hotel.name, 'SOLD OUT', '', '', '', '', '', '', 0, 0, 'Yes', '', hotel.sourceUrl,
    ]]
  }

  return rooms.filter(r => !r.soldOut).map(r => ([
    today.toISOString(),
    formatDateISO(checkIn),
    daysBetween(today, checkIn),
    los,
    hotel.name,
    r.roomType,
    r.nightlyRate        ?? '',
    r.totalPrice         ?? '',
    r.taxes              ?? '',
    r.refundableRate     ?? '',
    r.nonRefundableRate  ?? '',
    cheapest ? cheapest.roomType : '',
    priced.length,
    r.roomsRemaining     ?? '',
    'No',
    r.minStay            ?? '',
    hotel.sourceUrl,
  ]))
}


// -------------------------------------------------------
// POST TO GOOGLE SHEETS
// -------------------------------------------------------

async function postToSheets(rows) {
  if (!GOOGLE_WEB_APP_URL) {
    console.error('❌ GOOGLE_WEB_APP_URL not set')
    process.exit(1)
  }

  const BATCH = 200
  console.log(`\n📤 Posting ${rows.length} rows in batches of ${BATCH}...`)

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    try {
      const res  = await fetch(GOOGLE_WEB_APP_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(batch),
      })
      const text = await res.text()
      console.log(`  Batch ${Math.floor(i / BATCH) + 1}: ${text}`)
    } catch (err) {
      console.error(`  Batch ${Math.floor(i / BATCH) + 1} failed: ${err.message}`)
    }
    await sleep(300)
  }
}


// -------------------------------------------------------
// MAIN
// -------------------------------------------------------

;(async () => {
  console.log('🏨 Montauk Hotel Scraper — Direct API Mode')
  console.log(`   ${new Date().toISOString()}`)
  console.log(`   ${LOOK_AHEAD_DAYS} days | LOS: ${LENGTHS_OF_STAY.join(', ')} nights | ${HOTELS.length} hotels\n`)

  if (!GOOGLE_WEB_APP_URL) {
    console.error('❌ GOOGLE_WEB_APP_URL environment variable is not set.')
    process.exit(1)
  }

  const today   = new Date()
  const allRows = []

  for (const hotel of HOTELS) {
    console.log(`\n🔍 ${hotel.name} (${hotel.engine})`)
    const hotelRows = []

    for (let d = 0; d < LOOK_AHEAD_DAYS; d++) {
      const checkIn = addDays(today, d)

      for (const los of LENGTHS_OF_STAY) {
        const rooms = await fetchRooms(hotel, checkIn, los)
        const rows  = buildRows(hotel, checkIn, los, today, rooms)
        hotelRows.push(...rows)

        const summary = (rooms.length === 1 && rooms[0].soldOut)
          ? 'sold out'
          : `${rooms.filter(r => !r.soldOut).length} room(s)`
        process.stdout.write(`  ${formatDateISO(checkIn)} LOS:${los} → ${summary}\n`)

        await sleep(DELAY_MS)
      }
    }

    // Post each hotel's data immediately so sheet fills progressively
    await postToSheets(hotelRows)
    allRows.push(...hotelRows)
  }

  console.log(`\n✅ Complete — ${allRows.length} total rows posted`)
})()
