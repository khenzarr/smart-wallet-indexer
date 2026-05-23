import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const INPUT_FILES = [
  'tier1-smart-money-actors.csv',
  'smart-contract-actors.csv',
  'tier2-smart-money-watch.csv',
];

const REPORT_FILE = 'actor-profit-report.csv';
const PROFITABLE_EOA_FILE = 'tier1-profitable-smart-money.csv';
const CONTRACT_REVIEW_FILE = 'contract-profit-review.csv';

const DEX_DELAY_MS = Number(process.env.ACTOR_PROFIT_DEX_DELAY_MS || 300);

const HIGH_LIQUIDITY_USD = Number(process.env.ACTOR_PROFIT_HIGH_LIQUIDITY_USD || 100000);
const HIGH_VOLUME_24H = Number(process.env.ACTOR_PROFIT_HIGH_VOLUME_24H || 100000);
const MOMENTUM_24H_CHANGE = Number(process.env.ACTOR_PROFIT_MOMENTUM_24H_CHANGE || 25);
const STRONG_MOMENTUM_24H_CHANGE = Number(process.env.ACTOR_PROFIT_STRONG_MOMENTUM_24H_CHANGE || 75);

const MAX_EXAMPLES_PER_ACTOR = Number(process.env.ACTOR_PROFIT_MAX_EXAMPLES_PER_ACTOR || 16);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function loadActorRows() {
  const rows = [];

  for (const file of INPUT_FILES) {
    const fileRows = parseCsv(file).map((row) => ({
      ...row,
      sourceFile: file,
    }));

    console.log(`${file}: ${fileRows.length} rows`);
    rows.push(...fileRows);
  }

  const dedup = new Map();

  for (const row of rows) {
    const actor = norm(row.actor);

    if (!actor) continue;

    const existing = dedup.get(actor);

    if (!existing) {
      dedup.set(actor, row);
      continue;
    }

    const existingScore = number(existing.auditScore || existing.score, 0);
    const nextScore = number(row.auditScore || row.score, 0);

    if (nextScore > existingScore) {
      dedup.set(actor, row);
    }
  }

  return [...dedup.values()];
}

function extractExamples(row) {
  const examples = safeJsonParse(row.examples || '[]', []);

  const normalized = examples
    .map((item) => ({
      chain: norm(item.chain),
      tokenAddress: norm(item.token),
      symbol: item.symbol || '',
      earlyIndex: number(item.index, 999999),
      txHash: item.tx || '',
      source: item.source || '',
      actorType: item.actorType || '',
      contractName: item.contractName || '',
    }))
    .filter((item) => item.chain && item.tokenAddress)
    .slice(0, MAX_EXAMPLES_PER_ACTOR);

  const dedup = new Map();

  for (const item of normalized) {
    dedup.set(`${item.chain}:${item.tokenAddress}`, item);
  }

  return [...dedup.values()];
}

async function fetchDexPairs(chain, tokenAddress) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${tokenAddress}`;

  try {
    const { data } = await axios.get(url, {
      timeout: 30000,
    });

    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.log(`  DexScreener error ${chain}:${tokenAddress} | ${err.message}`);
    return [];
  }
}

function pickBestPair(pairs) {
  if (!pairs.length) return null;

  return [...pairs].sort((a, b) => {
    const liqA = number(a?.liquidity?.usd, 0);
    const liqB = number(b?.liquidity?.usd, 0);

    if (liqA !== liqB) return liqB - liqA;

    const volA = number(a?.volume?.h24, 0);
    const volB = number(b?.volume?.h24, 0);

    return volB - volA;
  })[0];
}

function classifyTokenPerformance(pair) {
  if (!pair) {
    return {
      quality: 'NO_PAIR',
      score: -50,
    };
  }

  const liquidityUsd = number(pair?.liquidity?.usd, 0);
  const volume24h = number(pair?.volume?.h24, 0);
  const fdv = number(pair?.fdv, 0);
  const priceChange24h = number(pair?.priceChange?.h24, 0);

  let score = 0;
  let quality = 'LOW_QUALITY';

  if (liquidityUsd >= HIGH_LIQUIDITY_USD) score += 80;
  else if (liquidityUsd >= 25000) score += 40;
  else if (liquidityUsd >= 5000) score += 20;
  else score -= 40;

  if (volume24h >= HIGH_VOLUME_24H) score += 80;
  else if (volume24h >= 25000) score += 40;
  else if (volume24h >= 5000) score += 20;
  else score -= 30;

  if (priceChange24h >= STRONG_MOMENTUM_24H_CHANGE) score += 120;
  else if (priceChange24h >= MOMENTUM_24H_CHANGE) score += 70;
  else if (priceChange24h >= 0) score += 15;
  else if (priceChange24h <= -50) score -= 60;
  else score -= 20;

  if (fdv > 0 && fdv <= 2000000) score += 40;
  else if (fdv > 0 && fdv <= 15000000) score += 20;
  else if (fdv > 50000000) score -= 40;

  if (score >= 220) {
    quality = 'STRONG_PROFIT_PROXY';
  } else if (score >= 150) {
    quality = 'GOOD_PROFIT_PROXY';
  } else if (score >= 80) {
    quality = 'ACTIVE_WATCH';
  } else if (score >= 20) {
    quality = 'WEAK_WATCH';
  } else {
    quality = 'LOW_QUALITY';
  }

  return {
    quality,
    score,
  };
}

async function enrichActor(row) {
  const actor = norm(row.actor);
  const examples = extractExamples(row);

  const enrichedExamples = [];

  for (const example of examples) {
    console.log(`  ${actor} -> ${example.chain}:${example.tokenAddress} ${example.symbol}`);

    const pairs = await fetchDexPairs(example.chain, example.tokenAddress);
    const bestPair = pickBestPair(pairs);
    const performance = classifyTokenPerformance(bestPair);

    enrichedExamples.push({
      chain: example.chain,
      tokenAddress: example.tokenAddress,
      symbol: bestPair?.baseToken?.symbol || example.symbol || '',
      earlyIndex: example.earlyIndex,
      tokenQuality: performance.quality,
      tokenScore: performance.score,
      liquidityUsd: number(bestPair?.liquidity?.usd, 0),
      volume24h: number(bestPair?.volume?.h24, 0),
      fdv: number(bestPair?.fdv, 0),
      priceChange24h: number(bestPair?.priceChange?.h24, 0),
      dexUrl: bestPair?.url || '',
      txHash: example.txHash,
    });

    await sleep(DEX_DELAY_MS);
  }

  const tokenCount = enrichedExamples.length;

  const avgLiquidityUsd =
    tokenCount > 0
      ? enrichedExamples.reduce((sum, item) => sum + item.liquidityUsd, 0) / tokenCount
      : 0;

  const avgVolume24h =
    tokenCount > 0
      ? enrichedExamples.reduce((sum, item) => sum + item.volume24h, 0) / tokenCount
      : 0;

  const avgPriceChange24h =
    tokenCount > 0
      ? enrichedExamples.reduce((sum, item) => sum + item.priceChange24h, 0) / tokenCount
      : 0;

  const avgTokenScore =
    tokenCount > 0
      ? enrichedExamples.reduce((sum, item) => sum + item.tokenScore, 0) / tokenCount
      : 0;

  const strongProfitProxyCount = enrichedExamples.filter((item) =>
    item.tokenQuality === 'STRONG_PROFIT_PROXY'
  ).length;

  const goodProfitProxyCount = enrichedExamples.filter((item) =>
    item.tokenQuality === 'GOOD_PROFIT_PROXY'
  ).length;

  const activeWatchCount = enrichedExamples.filter((item) =>
    item.tokenQuality === 'ACTIVE_WATCH'
  ).length;

  const lowQualityCount = enrichedExamples.filter((item) =>
    ['LOW_QUALITY', 'NO_PAIR'].includes(item.tokenQuality)
  ).length;

  const avgEarlyIndex = number(row.avgEarlyIndex, 999999);
  const originalAuditScore = number(row.auditScore || row.score, 0);

  const profitProxyScore =
    originalAuditScore +
    strongProfitProxyCount * 250 +
    goodProfitProxyCount * 150 +
    activeWatchCount * 75 -
    lowQualityCount * 75 +
    Math.max(0, 100 - avgEarlyIndex) +
    avgTokenScore;

  let profitTier = 'LOW_PRIORITY';

  if (
    strongProfitProxyCount >= 2 &&
    tokenCount >= 5 &&
    profitProxyScore >= 1600
  ) {
    profitTier = 'TIER_1_PROFITABLE_SMART_MONEY';
  } else if (
    strongProfitProxyCount + goodProfitProxyCount >= 2 &&
    tokenCount >= 4 &&
    profitProxyScore >= 1100
  ) {
    profitTier = 'TIER_2_PROFITABLE_WATCH';
  } else if (
    strongProfitProxyCount + goodProfitProxyCount + activeWatchCount >= 2
  ) {
    profitTier = 'TIER_3_ACTIVE_WATCH';
  }

  return {
    actor,
    profitTier,
    profitProxyScore: Number(profitProxyScore.toFixed(2)),

    sourceFile: row.sourceFile || '',
    auditTier: row.auditTier || '',
    auditReason: row.auditReason || '',
    auditScore: row.auditScore || '',

    actorTypes: row.actorTypes || '',
    actorSubtypes: row.actorSubtypes || '',
    contractNames: row.contractNames || '',

    uniqueTokenCount: row.uniqueTokenCount || '',
    enrichedTokenCount: tokenCount,
    strongProfitProxyCount,
    goodProfitProxyCount,
    activeWatchCount,
    lowQualityCount,

    chains: row.chains || '',
    tokenSymbols: row.tokenSymbols || '',
    bestEarlyIndex: row.bestEarlyIndex || '',
    avgEarlyIndex: row.avgEarlyIndex || '',

    avgLiquidityUsd: Number(avgLiquidityUsd.toFixed(2)),
    avgVolume24h: Number(avgVolume24h.toFixed(2)),
    avgPriceChange24h: Number(avgPriceChange24h.toFixed(2)),
    avgTokenScore: Number(avgTokenScore.toFixed(2)),

    examples: JSON.stringify(enrichedExamples),
  };
}

async function main() {
  console.log('Actor Profit Proxy Enricher v1.6');
  console.log('');
  console.log(`INPUT_FILES=${INPUT_FILES.join('|')}`);
  console.log(`REPORT_FILE=${REPORT_FILE}`);
  console.log(`HIGH_LIQUIDITY_USD=${HIGH_LIQUIDITY_USD}`);
  console.log(`HIGH_VOLUME_24H=${HIGH_VOLUME_24H}`);
  console.log(`MOMENTUM_24H_CHANGE=${MOMENTUM_24H_CHANGE}`);
  console.log(`STRONG_MOMENTUM_24H_CHANGE=${STRONG_MOMENTUM_24H_CHANGE}`);
  console.log(`MAX_EXAMPLES_PER_ACTOR=${MAX_EXAMPLES_PER_ACTOR}`);
  console.log('');

  const actors = loadActorRows();

  console.log(`Loaded unique actors: ${actors.length}`);

  const reports = [];

  for (const actor of actors) {
    console.log('');
    console.log(`Enriching actor ${actor.actor} | ${actor.auditTier || actor.sourceFile}`);

    const report = await enrichActor(actor);
    reports.push(report);
  }

  reports.sort((a, b) => b.profitProxyScore - a.profitProxyScore);

  const profitableEoa = reports.filter((row) =>
    ['TIER_1_PROFITABLE_SMART_MONEY', 'TIER_2_PROFITABLE_WATCH'].includes(row.profitTier) &&
    String(row.auditTier || '').includes('EOA')
  );

  const contractReview = reports.filter((row) =>
    String(row.auditTier || '').includes('CONTRACT') ||
    String(row.actorTypes || '').includes('CONTRACT')
  );

  writeCsv(REPORT_FILE, reports);
  writeCsv(PROFITABLE_EOA_FILE, profitableEoa);
  writeCsv(CONTRACT_REVIEW_FILE, contractReview);

  console.log('');
  console.log('Done.');
  console.log(`Actor profit reports: ${reports.length}`);
  console.log(`Profitable EOA smart money actors: ${profitableEoa.length}`);
  console.log(`Contract profit review actors: ${contractReview.length}`);

  if (reports.length > 0) {
    console.log('');
    console.log('Top actor profit proxy results:');

    for (const row of reports.slice(0, 20)) {
      console.log(
        `  ${row.actor} | ${row.profitTier} | profitScore=${row.profitProxyScore} | auditTier=${row.auditTier} | strong=${row.strongProfitProxyCount} | good=${row.goodProfitProxyCount} | active=${row.activeWatchCount} | low=${row.lowQualityCount} | avgChg24h=${row.avgPriceChange24h}% | symbols=${row.tokenSymbols}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});