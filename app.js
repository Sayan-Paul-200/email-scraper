// scrape‑from‑csv.js

const fs        = require('fs');
const path      = require('path');
const cheerio   = require('cheerio');
const { parse } = require('csv-parse/sync');
const fetch     = global.fetch || require('node-fetch');
const puppeteer = require('puppeteer');

// 1) New spreadsheet URLs
const SHEET_EDIT_URL = 'https://docs.google.com/spreadsheets/d/1xU0f6p24RBIfxQXAGXT0SDF1HG0urREDjYJKlJTy7WY/edit?gid=0#gid=0';
const CSV_URL = SHEET_EDIT_URL
  .replace(/\/edit.*$/, `/gviz/tq?tqx=out:csv&gid=0`);

// Browser‑like UA
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                   'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                   'Chrome/114.0.0.0 Safari/537.36';

// Core Cheerio‑based scraper (unchanged)
async function basicScrape(html) {
  const $      = cheerio.load(html);
  $('script, style').remove();

  const rawSet = new Set();
  const looseRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

  // mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    rawSet.add(
      $(el).attr('href')
        .replace(/^mailto:/, '')
        .split('?')[0]
        .trim()
    );
  });

  // visible text
  const text = $('body').text();
  let m;
  while ((m = looseRe.exec(text)) !== null) {
    rawSet.add(m[0]);
  }

  // all attribute values
  $('*').each((_, el) => {
    Object.values(el.attribs || {}).forEach(val => {
      let a;
      while ((a = looseRe.exec(val)) !== null) {
        rawSet.add(a[0]);
      }
    });
  });

  // sanitize & dedupe
  const imageExts = new Set(['png','jpg','jpeg','gif','svg','webp','bmp','tiff']);
  const strictRe  = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const cleanSet  = new Set();

  for (let raw of rawSet) {
    try { raw = decodeURIComponent(raw); } catch {}
    const found = raw.match(strictRe);
    if (!found) continue;
    const email = found[0].toLowerCase();
    if (imageExts.has(email.split('.').pop())) continue;
    cleanSet.add(email);
  }

  return Array.from(cleanSet);
}

// Fetch + redirect‑aware scraping, with Puppeteer fallback (unchanged)
async function scrapeEmails(url, browser) {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA },
    redirect: 'follow'
  });
  const finalUrl = res.url;
  if (finalUrl !== url) {
    console.log(`↪ ${url} → redirected to ${finalUrl}`);
  }

  const html = await res.text();
  let emails = await basicScrape(html);

  if (emails.length === 0) {
    console.log(`→ No emails via fetch; rendering ${finalUrl} in headless browser…`);
    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent(BROWSER_UA);
      await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      const rendered = await page.content();
      emails = await basicScrape(rendered);
    } catch (err) {
      console.warn(`⚠ Puppeteer error on ${finalUrl}: ${err.message}`);
    } finally {
      if (page) await page.close();
    }
  }

  return emails;
}


;(async () => {
  // --- A) Fetch the CSV and parse records ---
  const resp    = await fetch(CSV_URL, { headers: { 'User-Agent': BROWSER_UA } });
  const rawCsv  = (await resp.text()).replace(/^\uFEFF/, '');
  const records = parse(rawCsv, { columns: true, skip_empty_lines: true, trim: true });
  if (!records.length) {
    console.error('No data found in CSV.');
    return;
  }

  // --- B) Determine output filename from the sheet's <title> ---
  let outFilename = 'output.csv';
  try {
    const htmlDoc = await (await fetch(SHEET_EDIT_URL, { headers: { 'User-Agent': BROWSER_UA } })).text();
    const titleMatch = htmlDoc.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) {
      // strip the " - Google Sheets" suffix if present
      outFilename = `${titleMatch[1].replace(/\s*-\s*Google Sheets$/, '')}.csv`;
    }
  } catch (err) {
    console.warn(`Could not fetch sheet title; using default filename: ${outFilename}`);
  }

  // --- C) Launch Puppeteer once ---
  const browser = await puppeteer.launch({ headless: true });

  // --- D) Scrape each record and attach emails ---
  for (const rec of records) {
    const url = rec.website;       // now column Z header must be 'website'
    if (!url) {
      rec.emails = '[]';
      continue;
    }
    try {
      const emails = await scrapeEmails(url, browser);
      console.log(`✔ ${url} → ${emails.length} email(s)`);
      rec.emails = JSON.stringify(emails);
    } catch (err) {
      console.error(`✖ ${url} failed: ${err.message}`);
      rec.emails = '"ERROR"';
    }
  }

  await browser.close();

  // --- E) Rebuild CSV with all original columns + new 'emails' column ---
  const originalHeaders = Object.keys(records[0]);
  const finalHeaders    = [...originalHeaders, 'emails'];
  const escapeCell = v => {
    // wrap in quotes and double-up any existing quotes
    return `"${String(v).replace(/"/g, '""')}"`;
  };

  const lines = [
    finalHeaders.join(','),                         // header row
    ...records.map(rec =>
      finalHeaders.map(h => escapeCell(rec[h] ?? '')).join(',')
    )
  ];

  fs.writeFileSync(path.resolve(process.cwd(), outFilename), lines.join('\n'), 'utf8');
  console.log(`\n✅ Done! Output written to ${outFilename}`);
})();
