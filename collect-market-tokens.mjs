import axios from 'axios';
import fs from 'fs';
import path from 'path';

const OUTPUT_FILE = 'market-tokens.csv';

const MIN_LIQUIDITY_USD = Number(process.env.MARKET_MIN_LIQUIDITY_USD || 5000);
const MIN_VOLUME_24H = Number(process.env.MARKET_MIN_VOLUME_24H || 10000);
const MAX_TOKENS_PER_QUERY = Number(process.env.MARKET_MAX_TOKENS_PER_QUERY || 25);
const SEARCH_DELAY_MS = Number(process.env.MARKET_SEARCH_DELAY_MS || 400);

const CHAINS = new Set(['ethereum', 'base']);

const SEARCH_QUERIES = [
  'pepe',
  'doge',
  'inu',
  'ai',
  'agent',
  'meme',
  'sato',
  'base',
  'degen',
  'virtual',
  'fart',
  'punk',
  'frog',
  'cat',
  'chad',
  'cto',
  'trench',
  'trenches',
  'cult',
  'moon',
  'pump',
  'yzy',
  'kek',
  'wojak',
  'mog',
  'goat',
  'terminal',
  'zora',
  'eth',
  'btc',
  'sol',
  'mascot',
  'hedge',
  'research',
  'zero',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function isLikelyAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
}

function csvEscape(value) {
  const str = String(value ?? '');

  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }

  return str;
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);

  return result;
}

function parseCsv(filePath) {
  const abs = path.resolve(filePath);

  if (!fs.existsSync(abs)) {
    return [];
  }

  const raw = fs.readFileSync(abs, 'utf8').trim();

  if (!raw) {
    return [];
  }

  const lines = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length <= 1) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = cols[index] || '';
    });

    return row;
  });
}

function writeMarketTokensCsv(rows) {
  const headers = [
    'chain',
    'tokenAddress',
    'symbol',
    'name',
    'note',
    'source',
    'query',
    'dexId',
    'pairAddress',
    'quoteTokenSymbol',
    'priceUsd',
    'liquidityUsd',
    'volume24h',
    'priceChange24h',
    'fdv',
    'marketCap',
    'pairCreatedAt',
    'dexUrl',
  ];

  const body = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');

  fs.writeFileSync(path.resolve(OUTPUT_FILE), body + '\n');
}

async function fetchLatestProfiles() {
  const url = 'https://api.dexscreener.com/token-profiles/latest/v1';
  const { data } = await axios.get(url, { timeout: 30000 });

  return Array.isArray(data) ? data : [];
}

async function fetchLatestBoosts() {
  const url = 'https://api.dexscreener.com/token-boosts/latest/v1';
  const { data } = await axios.get(url, { timeout: 30000 });

  return Array.isArray(data) ? data : [];
}

async function fetchTopBoosts() {
  const url = 'https://api.dexscreener.com/token-boosts/top/v1';
  const { data } = await axios.get(url, { timeout: 30000 });

  return Array.isArray(data) ? data : [];
}

async function searchPairs(query) {
  const url = 'https://api.dexscreener.com/latest/dex/search';

  const { data } = await axios.get(url, {
    params: { q: query },
    timeout: 30000,
  });

  return Array.isArray(data?.pairs) ? data.pairs : [];
}

async function fetchTokenPairs(chain, tokenAddress) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${tokenAddress}`;

  try {
    const { data } = await axios.get(url, { timeout: 30000 });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function pairToTokenRow(pair, source, query = '') {
  const chain = norm(pair?.chainId);
  const baseToken = pair?.baseToken || {};
  const quoteToken = pair?.quoteToken || {};

  const tokenAddress = norm(baseToken.address);

  if (!CHAINS.has(chain)) return null;
  if (!isLikelyAddress(tokenAddress)) return null;

  const liquidityUsd = Number(pair?.liquidity?.usd || 0);
  const volume24h = Number(pair?.volume?.h24 || 0);

  if (liquidityUsd < MIN_LIQUIDITY_USD) return null;
  if (volume24h < MIN_VOLUME_24H) return null;

  return {
    chain,
    tokenAddress,
    symbol: baseToken.symbol || '',
    name: baseToken.name || '',
    note: `${source}${query ? ` query=${query}` : ''}`.trim(),
    source,
    query,
    dexId: pair?.dexId || '',
    pairAddress: pair?.pairAddress || '',
    quoteTokenSymbol: quoteToken.symbol || '',
    priceUsd: pair?.priceUsd || '',
    liquidityUsd,
    volume24h,
    priceChange24h: pair?.priceChange?.h24 || '',
    fdv: pair?.fdv || '',
    marketCap: pair?.marketCap || '',
    pairCreatedAt: pair?.pairCreatedAt || '',
    dexUrl: pair?.url || '',
  };
}

function profileItemToSeed(item, source) {
  const chain = norm(item.chainId);
  const tokenAddress = norm(item.tokenAddress);

  if (!CHAINS.has(chain)) return null;
  if (!isLikelyAddress(tokenAddress)) return null;

  return {
    chain,
    tokenAddress,
    source,
    query: '',
  };
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!row) continue;

    const chain = norm(row.chain);
    const tokenAddress = norm(row.tokenAddress);

    if (!CHAINS.has(chain)) continue;
    if (!isLikelyAddress(tokenAddress)) continue;

    const key = `${chain}:${tokenAddress}`;

    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        ...row,
        chain,
        tokenAddress,
      });
      continue;
    }

    const existingLiquidity = Number(existing.liquidityUsd || 0);
    const nextLiquidity = Number(row.liquidityUsd || 0);

    if (nextLiquidity > existingLiquidity) {
      map.set(key, {
        ...row,
        chain,
        tokenAddress,
      });
    }
  }

  return [...map.values()].sort((a, b) => {
    const volDiff = Number(b.volume24h || 0) - Number(a.volume24h || 0);
    if (volDiff !== 0) return volDiff;

    return Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0);
  });
}

async function enrichSeedsWithPairs(seeds) {
  const rows = [];

  for (const seed of seeds) {
    console.log(`  Enriching seed ${seed.chain}:${seed.tokenAddress}`);

    const pairs = await fetchTokenPairs(seed.chain, seed.tokenAddress);

    const bestPair = pairs
      .filter((pair) => norm(pair.chainId) === seed.chain)
      .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];

    const row = bestPair
      ? pairToTokenRow(bestPair, seed.source, seed.query)
      : null;

    if (row) {
      rows.push(row);
    }

    await sleep(SEARCH_DELAY_MS);
  }

  return rows;
}

async function main() {
  console.log('Market Token Collector v1.2');
  console.log(`OUTPUT_FILE=${OUTPUT_FILE}`);
  console.log(`MIN_LIQUIDITY_USD=${MIN_LIQUIDITY_USD}`);
  console.log(`MIN_VOLUME_24H=${MIN_VOLUME_24H}`);
  console.log(`MAX_TOKENS_PER_QUERY=${MAX_TOKENS_PER_QUERY}`);
  console.log(`SEARCH_DELAY_MS=${SEARCH_DELAY_MS}`);
  console.log('');

  const existingRows = parseCsv(OUTPUT_FILE);

  console.log(`Existing market tokens: ${existingRows.length}`);

  console.log('Fetching DEX Screener profile/boost sources...');

  const [profiles, latestBoosts, topBoosts] = await Promise.all([
    fetchLatestProfiles(),
    fetchLatestBoosts(),
    fetchTopBoosts(),
  ]);

  const seedItems = [
    ...profiles.map((item) => profileItemToSeed(item, 'dex_profiles_latest')),
    ...latestBoosts.map((item) => profileItemToSeed(item, 'dex_boosts_latest')),
    ...topBoosts.map((item) => profileItemToSeed(item, 'dex_boosts_top')),
  ].filter(Boolean);

  console.log(`Profile/boost seeds: ${seedItems.length}`);

  const seedRows = await enrichSeedsWithPairs(seedItems);

  console.log(`Profile/boost rows after filters: ${seedRows.length}`);
  console.log('');

  const searchRows = [];

  for (const query of SEARCH_QUERIES) {
    console.log(`Searching query: ${query}`);

    try {
      const pairs = await searchPairs(query);

      const rowsForQuery = pairs
        .map((pair) => pairToTokenRow(pair, 'dex_search', query))
        .filter(Boolean)
        .slice(0, MAX_TOKENS_PER_QUERY);

      console.log(`  accepted rows: ${rowsForQuery.length}`);

      searchRows.push(...rowsForQuery);
    } catch (err) {
      console.log(`  search error: ${err.message}`);
    }

    await sleep(SEARCH_DELAY_MS);
  }

  const merged = dedupeRows([
    ...existingRows,
    ...seedRows,
    ...searchRows,
  ]);

  writeMarketTokensCsv(merged);

  console.log('');
  console.log('Done.');
  console.log(`Search rows after filters: ${searchRows.length}`);
  console.log(`Updated market token universe: ${merged.length}`);
  console.log(`Output: ${OUTPUT_FILE}`);

  console.log('');
  console.log('Next: make index-smart-wallets.mjs read market-tokens.csv, then run:');
  console.log('  npm start');
  console.log('  npm run profile');
  console.log('  npm run enrich');
  console.log('  npm run score');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});