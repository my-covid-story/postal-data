#!/usr/bin/env node
const fs = require('fs/promises')
const https = require('https')
const bent = require('bent')
const cheerio = require('cheerio')
const shuffle = require('array-shuffle')
const delay = require('delay')
const replace = require('replace-buffer')

// TLS connections to elections.on.ca fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
// Disabling certificate verification solves that, with a risk of man-in-the-middle attacks.
https.globalAgent.options.rejectUnauthorized = false

// The script is verbose by default, can be silenced via an environment variable.
const VERBOSE = process.env.POSTAL_VERBOSE !== 'false'

function log(...args) {
  if (VERBOSE) {
    console.log(...args)
  }
}

const ELECTIONS_ONTARIO_URL = 'https://voterinformationservice.elections.on.ca'

// Data file paths.
const PATH_WIKIPEDIA = 'wikipedia.org'
const PATH_FSA = 'fsa.json'
const pathFsaHtml = (letter) => `${PATH_WIKIPEDIA}/fsa-${letter.toLowerCase()}.html`

const PATH_LDU = 'ldu.json'
const PATH_EO = 'elections.on.ca'
const PATH_ED_RAW = `${PATH_EO}/ed-raw.json`
const PATH_ED = 'ed.json'
const pathMppHtml = (id) => `${PATH_EO}/mpp-${id.toString().padStart(3, '0')}.html`
const pathFsaEd = (fsa) => `${PATH_EO}/fsa-ed-${fsa.toLowerCase()}.json`

// First letter of FSA to province mapping.
// Nunavut/Northwest Territories share a first letter, so a function is needed to disambiguate.
const LETTER_PROVINCE = {
  A: 'NL',
  B: 'NS',
  C: 'PE',
  E: 'NB',
  G: 'QC',
  H: 'QC',
  J: 'QC',
  K: 'ON',
  L: 'ON',
  M: 'ON',
  N: 'ON',
  P: 'ON',
  R: 'MB',
  S: 'SK',
  T: 'AB',
  V: 'BC',
  X: (fsa) => (['X0A', 'X0B', 'X0C'].includes(fsa) ? 'NU' : 'NT'),
  Y: 'YT',
}
const LETTERS = Object.keys(LETTER_PROVINCE)

// Look up the province for an FSA.
function fsaProvince(fsa) {
  const province = LETTER_PROVINCE[fsa.charAt(0)]
  return typeof province === 'function' ? province(fsa) : province
}

// FSA names to exclude.
const UNUSED_FSA_NAMES = ['Not assigned', 'Not in use', 'Reserved', 'Commercial Returns']

// Ontario hotspot FSAs.
// From https://covid-19.ontario.ca/ontarios-covid-19-vaccination-plan
const HOTSPOT_FSAS = [
  'L1S', // Durham Region Health Department
  'L1T',
  'L1V',
  'L1X',
  'L1Z',
  'L9E', // Halton Region Public Health
  'L8W', // City of Hamilton Public Health Services
  'L9C',
  'L2G', // Niagara Region Public Health
  'K1T', // Ottawa Public Health
  'K1V',
  'K2V',
  'L4T', // Peel Public Health
  'L4W',
  'L4X',
  'L4Z',
  'L5A',
  'L5B',
  'L5C',
  'L5K',
  'L5L',
  'L5M',
  'L5N',
  'L5R',
  'L5V',
  'L5W',
  'L6P',
  'L6R',
  'L6S',
  'L6T',
  'L6V',
  'L6W',
  'L6X',
  'L6Y',
  'L6Z',
  'L7A',
  'L7C',
  'L3Z', // Simcoe-Muskoka District Health Unit
  'N2C', // Region of Waterloo Public Health and Emergency Services
  'N1K', // Wellington-Dufferin Guelph Public Health
  'N8H', // Windsor-Essex County Health Unit
  'N8X',
  'N8Y',
  'N9A',
  'N9B',
  'N9C',
  'N9Y',
  'L0J', // York Region Public Health
  'L3S',
  'L3T',
  'L4B',
  'L4E',
  'L4H',
  'L4J',
  'L4K',
  'L4L',
  'L6A',
  'L6B',
  'L6C',
  'L6E',
  'M1B', // Toronto Public Health
  'M1C',
  'M1E',
  'M1G',
  'M1H',
  'M1J',
  'M1K',
  'M1L',
  'M1M',
  'M1P',
  'M1R',
  'M1S',
  'M1T',
  'M1V',
  'M1W',
  'M1X',
  'M2J',
  'M2M',
  'M2R',
  'M3A',
  'M3C',
  'M3H',
  'M3J',
  'M3K',
  'M3L',
  'M3M',
  'M3N',
  'M4A',
  'M4H',
  'M4X',
  'M5A',
  'M5B',
  'M5N',
  'M5V',
  'M6A',
  'M6B',
  'M6E',
  'M6H',
  'M6K',
  'M6L',
  'M6M',
  'M6N',
  'M8V',
  'M9A',
  'M9B',
  'M9C',
  'M9L',
  'M9M',
  'M9N',
  'M9P',
  'M9R',
  'M9V',
  'M9W',
  'N5H', // Southwestern Public Health
]

// How many random LDUs to search for urban FSAs.
const SEARCH_LDU_COUNT = 600

// Ontario Electoral IDs: 1..124.
const ED_IDS = Array(124)
  .fill()
  .map((_, i) => i + 1)

function stringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n'
}

async function prepare() {
  process.chdir(__dirname)
  await fs.mkdir('data', { recursive: true })
  process.chdir('data')
}

async function fsaFetch(letters = []) {
  letters = letters.length === 0 ? LETTERS : letters.map((l) => l.toUpperCase())
  const get = bent('https://en.wikipedia.org', 'buffer')
  await fs.mkdir(PATH_WIKIPEDIA, { recursive: true })

  for (const letter of letters) {
    const url = `/wiki/List_of_postal_codes_of_Canada:_${letter}`
    log(`Fetching ${url} from Wikipedia`)
    const buffer = await get(url)
    const path = pathFsaHtml(letter)
    log(`Writing HTML data to ${path}`)
    await fs.writeFile(path, buffer)
  }
  log('Done')
}

// Truncate at <hr>, then split lines on <br> (unless immediately preceded by -) and/or \n.
// Some FSAs descriptions are split by <hr> and the meaining is not apparent, e.g. A1B.
// Some hyphenated place-names are incorrectly split with <br>, e.g. G3A.
// Trim whitespace, remove footnotes, and filter out any blank lines.
function dataLines(data) {
  const html = data.html().split('<hr>')[0].replace(/-<br>/g, '-').replace(/<br>/g, '\n')
  return cheerio
    .load(html)
    .text()
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/\[[0-9]+\]/g, ''))
    .filter((line) => line)
}

function fsaScrapeFrom(buffer) {
  const $ = cheerio.load(buffer)

  // Some pages have Urban and Rural sections, with separate tables of FSAs.
  // Other pages have a single table that is all urban, all rural, or a mix of both.
  const urbanData = $('h3:contains("Urban")').next('table').first().find('td')
  const ruralData = $('h3:contains("Rural")').next('table').first().find('td')
  const data =
    urbanData.length + ruralData.length > 0
      ? [...ruralData.toArray(), ...urbanData.toArray()]
      : $('table').first().find('td').toArray()

  return data
    .map((d) => {
      const [fsa, name, ...rest] = dataLines($(d))
      const type = fsa.charAt(1) === '0' ? 'rural' : 'urban'
      const province = fsaProvince(fsa)
      const hotspot = HOTSPOT_FSAS.includes(fsa)

      if (type === 'urban') {
        // For an urban FSA, the rest, if any, is just location detail, part or all of which may be parenthesized.
        // There is no need for parenetheses around the whole detail, so remove them in that case.
        let detail = rest.join(' ')
        const captures = /^\(([^)]*)\)$/.exec(detail)
        if (captures) {
          detail = captures[1].trim()
        }
        return { fsa, type, province, hotspot, name, detail: detail || undefined }
      } else {
        // For a rural FSA, the rest lists its LDUs, one per line.
        // Each line contains the LDU and its name, separated by a colon and whitespace.
        const ldus = rest.map((line) => {
          const parts = line.split(':')
          const ldu = parts[0].trim()
          let name = parts[1].trim()
          let retired = false

          // If the name ends with an asterisk, that indicates the LDU is retired.
          if (name.endsWith('*')) {
            name = name.substring(0, name.length - 1)
            retired = true
          }
          return { ldu, retired, name }
        })
        return { fsa, type, province, hotspot, name, ldus }
      }
    })
    .filter((f) => !UNUSED_FSA_NAMES.includes(f.name))
    .sort((a, b) => (a.fsa === b.fsa ? 0 : a.fsa > b.fsa ? 1 : -1))
}

async function fsaScrape(letters = []) {
  letters = letters.length === 0 ? LETTERS : letters.map((l) => l.toUpperCase())
  const fsas = []

  for (const letter of letters) {
    const path = pathFsaHtml(letter)
    log(`Scraping FSAs for ${letter} from ${path}`)
    const buffer = await fs.readFile(path)
    const f = fsaScrapeFrom(buffer)
    log(`Obtained ${f.length} FSAs`)
    fsas.push(...f)
  }

  log(`Writing JSON data to ${PATH_FSA}`)
  await fs.writeFile(PATH_FSA, stringify(fsas))
  log('Done')
}

async function lduGenerate() {
  log('Generating LDUs')
  const letters = 'ABCEGHJKLMNPRSTVWXYZ'.split('')
  const digits = '0123456789'.split('')
  let ldus = []

  for (const d1 of digits) {
    for (const l of letters) {
      for (const d2 of digits) {
        ldus.push(d1 + l + d2)
      }
    }
  }
  ldus = shuffle(ldus)

  log(`Writing JSON data to ${PATH_LDU}`)
  await fs.writeFile(PATH_LDU, stringify(ldus))
  log('Done')
}

async function edFetch(ids = []) {
  if (ids.length === 0) ids = ED_IDS
  const get = bent(ELECTIONS_ONTARIO_URL, 'json')
  await fs.mkdir(PATH_EO, { recursive: true })

  const eds = []
  for (const id of ids) {
    const url = `/api/electoral-district/en/${id}`
    log(`Fetching ${url} from Elections Ontario`)
    eds.push(await get(url))
  }

  log(`Writing JSON data to ${PATH_ED_RAW}`)
  await fs.writeFile(PATH_ED_RAW, stringify(eds))
  log('Done')
}

async function mppFetch(ids = []) {
  if (ids.length === 0) ids = ED_IDS
  const get = bent('buffer')
  log(`Loading ED data from ${PATH_ED_RAW}`)
  const eds = JSON.parse(await fs.readFile(PATH_ED_RAW, 'utf8'))

  for (const id of ids) {
    const ed = eds.find((e) => e.id == id)
    const url = ed.mppUrl
    log(`Fetching ${url}`)
    const buffer = await get(url)
    const path = pathMppHtml(id)
    log(`Writing HTML data to ${path}`)
    await fs.writeFile(path, replace(buffer, '\r\n', '\n'))
  }
  log('Done')
}

function mppScrapeFrom(buffer) {
  const $ = cheerio.load(buffer)

  const mppParty = $('.views-field-field-party').first().text().trim()
  const emails = $('.field--name-field-email-address .field__item')
    .toArray()
    .map((e) => $(e).text().trim().toLowerCase())
  const phones = $('.field--name-field-number .field__item')
    .toArray()
    .map((e) => $(e).text().trim())

  return { mppParty, mppEmail: emails[0], mppPhone: phones[0] }
}

async function edMppEnrich(ids = []) {
  if (ids.length === 0) ids = ED_IDS
  log(`Loading ED data from ${PATH_ED_RAW}`)
  const raw = JSON.parse(await fs.readFile(PATH_ED_RAW, 'utf8'))
  const eds = []

  for (const id of ids) {
    log(`Enriching ED data for ${id}`)
    let ed = raw.find((e) => e.id == id)
    const { name, municipalities, population, areaSquareKm: area, mppUrl, mppName } = ed
    const url = `${ELECTIONS_ONTARIO_URL}/en/electoral-district/${id}`
    const names = mppName.split(' ')

    // Recognize this premier specifically by ED number.
    const mppDesignation = id === 30 ? 'Premier' : names[0] === 'Hon.' ? 'Minister' : 'MPP'
    const mppFirstName = mppDesignation === 'MPP' ? names[0] : names[1]
    const mppLastName = names[names.length - 1]
    ed = {
      name,
      municipalities,
      population,
      area,
      url,
      mppName,
      mppDesignation,
      mppFirstName,
      mppLastName,
    }

    const path = pathMppHtml(id)
    log(`Scraping MPP data from ${path}`)
    const buffer = await fs.readFile(path)
    eds.push({ id, ...ed, ...mppScrapeFrom(buffer), mppUrl })
  }

  log(`Writing JSON data to ${PATH_ED}`)
  await fs.writeFile(PATH_ED, stringify(eds))
  log('Done')
}

async function fsaEdSearchFor(fsa, ldus) {
  const get = bent(ELECTIONS_ONTARIO_URL, 'json')
  let results = []

  const path = pathFsaEd(fsa)
  log(`Checking for existing data in ${path}`)
  try {
    results = JSON.parse(await fs.readFile(path, 'utf8'))
    log(`${results.length} results found`)
  } catch (err) {
    // None found.
  }

  try {
    for (const ldu of ldus) {
      const postal = fsa + ldu
      const existing = results.find((r) => r.postal === postal)
      if (!existing) {
        const url = `/api/electoral-district-search/en/postal-code/${postal}`
        log(`Fetching ${url} from Elections Ontario`)

        // Connections to Elections Ontario's API fail sometimes, so allow retries.
        for (let retry = 0; ; retry++) {
          try {
            // Ensure we do not exceed the API limit of 4000 requests/hour.
            await delay(900)

            const result = await get(url)
            results.push({ postal, result })
            break
          } catch (err) {
            if (retry < 3) {
              log('Request failed, retrying')
            } else {
              throw err
            }
          }
        }
      }
    }
    log(`Writing JSON data to ${path}`)
  } catch (err) {
    log(`Writing partial JSON data to ${path} on error`)
    throw err
  } finally {
    await fs.writeFile(path, stringify(results))
  }
}

async function fsaEdSearch(fsas = []) {
  fsas = fsas.map((f) => f.toUpperCase())
  log(`Loading FSA data from ${PATH_FSA}`)
  const fsaData = JSON.parse(await fs.readFile(PATH_FSA, 'utf8')).filter(
    (f) => f.province === 'ON' && (fsas.length === 0 || fsas.includes(f.fsa))
  )

  log(`Loading random LDUs from ${PATH_LDU}`)
  const randomLdus = JSON.parse(await fs.readFile(PATH_LDU, 'utf8'))
  randomLdus.length = SEARCH_LDU_COUNT

  for (const { fsa, ldus } of fsaData) {
    const count = ldus ? ldus.length : SEARCH_LDU_COUNT
    log(`Searching FSA ${fsa} with ${count} ${ldus ? 'known rural' : 'random'} LDUs`)
    await fsaEdSearchFor(fsa, ldus ? ldus.map((l) => l.ldu) : randomLdus)
  }
  log('Done')
}

const [, , command, ...args] = process.argv
let func
if (command === 'fsa-fetch') func = fsaFetch
else if (command === 'fsa-scrape') func = fsaScrape
else if (command === 'ldu-generate') func = lduGenerate
else if (command === 'ed-fetch') func = edFetch
else if (command === 'mpp-fetch') func = mppFetch
else if (command === 'ed-mpp-enrich') func = edMppEnrich
else if (command === 'fsa-ed-search') func = fsaEdSearch

if (func) {
  prepare()
    .then(() => func(args))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
  return
}

console.error(`Usage: postal.js COMMAND [ARGS]

Commands:

fsa-fetch [LETTER...]   Fetch Forward Sortation Area HTML from Wikipedia
fsa-scrape [LETTER...]  Scrape FSA HTML to extract data
ldu-generate            Generate a random-order list of Local Delivery Units
ed-fetch [ID...]        Fetch Electoral District JSON from Elections Ontario
mpp-fetch [ID...]       Fetch MPP HTML from Elections Ontario
ed-mpp-enrich [ID...]   Enrich ED JSON with MPP data scraped from HTML files
fsa-ed-search [FSA...]  Search for FSA-ED mappings from Elections Ontario
`)
process.exit(1)
