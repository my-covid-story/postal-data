#!/usr/bin/env node
const fs = require('fs/promises')
const bent = require('bent')
const cheerio = require('cheerio')

const VERBOSE = true

function log(...args) {
  if (VERBOSE) {
    console.log(...args)
  }
}

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

function fsaProvince(fsa) {
  const province = LETTER_PROVINCE[fsa.charAt(0)]
  return typeof province === 'function' ? province(fsa) : province
}

const NOT_FSA = ['Not assigned', 'Not in use', 'Reserved', 'Commercial Returns']

async function prepare() {
  process.chdir(__dirname)
  await fs.mkdir('data', { recursive: true })
  process.chdir('data')
}

async function fsaFetch(letters = LETTERS) {
  if (letters.length === 0) letters = LETTERS
  const get = bent('https://en.wikipedia.org/wiki', 'buffer')
  await fs.mkdir('wikipedia', { recursive: true })

  for (const letter of letters) {
    const url = `/List_of_postal_codes_of_Canada:_${letter}`
    log(`Fetching ${url} from Wikipedia`)
    const buffer = await get(url)
    const path = `wikipedia/${letter}.html`
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
  const $ = cheerio.load(buffer, { ignoreWhitespace: false })

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
    const path = `wikipedia/${letter}.html`
    log(`Scraping FSAs for ${letter} from ${path}`)
    const buffer = await fs.readFile(path)
    const f = fsaScrapeFrom(buffer)
    log(`Obtained ${f.length} FSAs`)
    fsas.push(...f)
  }

  const path = 'fsa.json'
  log(`Writing JSON data to ${path}`)
  await fs.writeFile(path, JSON.stringify(fsas, null, 2))
  log('Done')
}

const [, , command, ...args] = process.argv
const func = command === 'fsa-fetch' ? fsaFetch : command === 'fsa-scrape' ? fsaScrape : undefined
if (func) {
  prepare()
    .then(() => func(args))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
  return
}

const usage = `Usage: postal.js COMMAND [ARGS]

Commands:

fsa-fetch [LETTER...]   Fetch Forward Sortation Area HTML from Wikipedia
fsa-scrape [LETTER...]  Scrape FSA HTML to extract data
`
console.error(usage)
process.exit(1)
