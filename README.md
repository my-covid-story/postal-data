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
├── wikipedia/   HTML pages fetched from wikipedia.org (fsa-fetch)
│   ├── A.html   One file per valid first letter, listing FSAs
│   ├── B.html
│   │   ...
│   └── Y.html
└── fsa.json     JSON FSA data scraped from HTML pages (fsa-scrape)
```
