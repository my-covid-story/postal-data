#!/usr/bin/env node
const fs = require('fs/promises')
const https = require('https')
const bent = require('bent')
const cheerio = require('cheerio')
const shuffle = require('array-shuffle')

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
const NOT_FSA = ['Not assigned', 'Not in use', 'Reserved', 'Commercial Returns']

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

async function fsaFetch(letters = LETTERS) {
  if (letters.length === 0) letters = LETTERS
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

      if (type === 'urban') {
        // For an urban FSA, the rest, if any, is just location detail, part or all of which may be parenthesized.
        // There is no need for parenetheses around the whole detail, so remove them in that case.
        let detail = rest.join(' ')
        const captures = /^\(([^)]*)\)$/.exec(detail)
        if (captures) {
          detail = captures[1].trim()
        }
        return { fsa, type, province, name, detail: detail || undefined }
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
          return { ldu, name, retired }
        })
        return { fsa, type, province, name, ldus }
      }
    })
    .filter((f) => !NOT_FSA.includes(f.name))
    .sort((a, b) => (a.fsa === b.fsa ? 0 : a.fsa > b.fsa ? 1 : -1))
}

async function fsaScrape(letters = LETTERS) {
  if (letters.length === 0) letters = LETTERS
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

async function edFetch(ids = ED_IDS) {
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

async function mppFetch(ids = ED_IDS) {
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
    await fs.writeFile(path, buffer)
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

async function edMppEnrich(ids = ED_IDS) {
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
    const mppFirstName = names[0] !== 'Hon.' ? names[0] : names[1]
    const mppLastName = names[names.length - 1]
    ed = { name, municipalities, population, area, url, mppUrl, mppName, mppFirstName, mppLastName }

    const path = pathMppHtml(id)
    log(`Scraping MPP data from ${path}`)
    const buffer = await fs.readFile(path)
    eds.push({ id, ...ed, ...mppScrapeFrom(buffer) })
  }

  log(`Writing JSON data to ${PATH_ED}`)
  await fs.writeFile(PATH_ED, stringify(eds))
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
ed-mpp-enrich [ID...]   Enrich ED JSON with MPP data scraped from HTML files.
`)
process.exit(1)
