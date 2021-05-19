# Postal Code Data for MyCovidStory.ca

Static data for MyCovidStory.ca, including postal codes and electoral districts.
The data is versioned along with the script that fetched, processed, and mapped it.

## Quick start

1. Clone the repository.
1. Install dependencies.
1. Run the script to see all supported commands.

```
git clone https://github.com/my-covid-story/postal-data
cd postal-data
npm install
./postal.js
```

## Data overview

```
data/
├── elections.on.ca/   ED and MPP data fetched from Elections Ontario
│   ├── ed-raw.json    ED JSON data (ed-fetch)
│   ├── mpp-001.html   One HTML file per ED, describing the MPP (mpp-fetch)
│   ├── mpp-002.html
│   │   ...
│   └── mpp-124.html
├── wikipedia.org/     FSA HTML pages fetched from Wikipedia
│   ├── fsa-a.html     One file per valid first letter (fsa-fetch)
│   ├── fsa-b.html
│   │   ...
│   └── fsa-y.html
├── ed.json            ED JSON data enriched with MPP details (ed-mpp-enrich)
└── fsa.json           FSA JSON data scraped from HTML pages (fsa-scrape)
```
