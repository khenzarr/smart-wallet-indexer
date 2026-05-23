import fs from 'fs';
import path from 'path';
import axios from 'axios';

const INPUT_FILE = 'smart-wallets.csv';
const OUTPUT_FILE = 'token-performance.csv';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
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
    throw new Error(`Missing input file: ${filePath}`);
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

function writeCsv(filename, rows) {
  if (!rows.length) {
    fs.writeFileSync(path.resolve(filename), '');
    console.log(`No rows for ${filename}`);
    return;
  }

  const headers = Object.keys(rows[0]);

  const body = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');

  fs.writeFileSync(path.resolve(filename), body + '\n');
  console.log(`Wrote ${rows.length} rows to ${filename}`);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractWalletTokenExamples(walletRows) {
  const output = [];

  for (const row of walletRows) {
    const examples = safeJsonParse(row.examples || '[]', []);

    for (const example of examples) {
      const chain = String(example.chain || '').trim().toLowerCase();
      const tokenAddress = norm(example.token);

      if (!chain || !tokenAddress) continue;

      output.push({
        wallet: norm(row.wallet),
        walletClassification: row.classification || '',
        walletScore: row.score || '',
        walletTokenCount: row.uniqueTokenCount || '',
        chain,
        tokenAddress,
        tokenSymbolFromProfile: example.symbol || '',
        earlyIndex: example.index || '',
        txHash: example.tx || '',
      });
    }
  }

  const dedup = new Map();

  for (const item of output) {
    dedup.set(`${item.wallet}:${item.chain}:${item.tokenAddress}`, item);
  }

  return [...dedup.values()];
}

async function fetchDexScreenerTokenPairs(chain, tokenAddress) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${tokenAddress}`;

  try {
    const { data } = await axios.get(url, {
      timeout: 30000,
    });

    if (!Array.isArray(data)) {
      return [];
    }

    return data;
  } catch (err) {
    console.log(`  DexScreener error ${chain}:${tokenAddress} | ${err.message}`);
    return [];
  }
}

function pickBestPair(pairs) {
  if (!pairs.length) return null;

  return [...pairs].sort((a, b) => {
    const liqA = Number(a?.liquidity?.usd || 0);
    const liqB = Number(b?.liquidity?.usd || 0);

    if (liqA !== liqB) return liqB - liqA;

    const volA = Number(a?.volume?.h24 || 0);
    const volB = Number(b?.volume?.h24 || 0);

    return volB - volA;
  })[0];
}

function classifyTokenQuality(pair) {
  if (!pair) return 'NO_PAIR';

  const liquidityUsd = Number(pair?.liquidity?.usd || 0);
  const volume24h = Number(pair?.volume?.h24 || 0);
  const fdv = Number(pair?.fdv || 0);

  if (liquidityUsd >= 100000 && volume24h >= 250000) {
    return 'HIGH_LIQUIDITY_ACTIVE';
  }

  if (liquidityUsd >= 25000 && volume24h >= 50000) {
    return 'GOOD';
  }

  if (liquidityUsd >= 5000 && volume24h >= 10000) {
    return 'SPECULATIVE';
  }

  if (liquidityUsd > 0 || volume24h > 0 || fdv > 0) {
    return 'LOW_LIQUIDITY';
  }

  return 'DEAD_OR_UNKNOWN';
}

async function main() {
  console.log('Token Performance Enricher v0.9');
  console.log(`Input: ${INPUT_FILE}`);
  console.log(`Output: ${OUTPUT_FILE}`);

  const walletRows = parseCsv(INPUT_FILE);

  console.log(`Loaded smart wallet rows: ${walletRows.length}`);

  const tokenExamples = extractWalletTokenExamples(walletRows);

  console.log(`Token examples to enrich: ${tokenExamples.length}`);

  const rows = [];

  for (const item of tokenExamples) {
    console.log('');
    console.log(`Fetching ${item.chain} ${item.tokenAddress}`);

    const pairs = await fetchDexScreenerTokenPairs(item.chain, item.tokenAddress);
    const bestPair = pickBestPair(pairs);

    const quality = classifyTokenQuality(bestPair);

    rows.push({
      wallet: item.wallet,
      walletClassification: item.walletClassification,
      walletScore: item.walletScore,
      walletTokenCount: item.walletTokenCount,
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      tokenSymbolFromProfile: item.tokenSymbolFromProfile,
      earlyIndex: item.earlyIndex,
      txHash: item.txHash,
      dexPairFound: bestPair ? 'yes' : 'no',
      tokenQuality: quality,
      pairAddress: bestPair?.pairAddress || '',
      dexId: bestPair?.dexId || '',
      baseTokenSymbol: bestPair?.baseToken?.symbol || '',
      quoteTokenSymbol: bestPair?.quoteToken?.symbol || '',
      priceUsd: bestPair?.priceUsd || '',
      liquidityUsd: bestPair?.liquidity?.usd || '',
      volume5m: bestPair?.volume?.m5 || '',
      volume1h: bestPair?.volume?.h1 || '',
      volume6h: bestPair?.volume?.h6 || '',
      volume24h: bestPair?.volume?.h24 || '',
      priceChange5m: bestPair?.priceChange?.m5 || '',
      priceChange1h: bestPair?.priceChange?.h1 || '',
      priceChange6h: bestPair?.priceChange?.h6 || '',
      priceChange24h: bestPair?.priceChange?.h24 || '',
      fdv: bestPair?.fdv || '',
      marketCap: bestPair?.marketCap || '',
      pairCreatedAt: bestPair?.pairCreatedAt || '',
      dexUrl: bestPair?.url || '',
      pairsFound: pairs.length,
    });

    await sleep(350);
  }

  writeCsv(OUTPUT_FILE, rows);

  console.log('');
  console.log('Done.');

  const qualityCounts = rows.reduce((acc, row) => {
    acc[row.tokenQuality] = (acc[row.tokenQuality] || 0) + 1;
    return acc;
  }, {});

  console.log('Token quality counts:');

  for (const [key, value] of Object.entries(qualityCounts)) {
    console.log(`  ${key}: ${value}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});