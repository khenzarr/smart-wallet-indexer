import fs from 'fs';
import path from 'path';

const INPUT_FILE = 'token-performance.csv';

const SCORE_FILE = 'smart-whale-score.csv';
const SMART_WHALES_FILE = 'smart-whales.csv';
const OBSERVE_FILE = 'observe-wallets.csv';

const HIGH_QUALITY_LABELS = new Set([
  'HIGH_LIQUIDITY_ACTIVE',
  'GOOD',
]);

const MID_QUALITY_LABELS = new Set([
  'SPECULATIVE',
]);

const LOW_QUALITY_LABELS = new Set([
  'LOW_LIQUIDITY',
  'DEAD_OR_UNKNOWN',
  'NO_PAIR',
]);

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

function number(value, fallback = 0) {
  const n = Number(value);

  if (Number.isFinite(n)) {
    return n;
  }

  return fallback;
}

function classifyWallet(profile) {
  const {
    uniqueTokenCount,
    highQualityTokenCount,
    midQualityTokenCount,
    lowQualityTokenCount,
    avgEarlyIndex,
    bestEarlyIndex,
    avgLiquidityUsd,
    avgVolume24h,
    highQualityRatio,
    lowQualityRatio,
  } = profile;

  if (
    uniqueTokenCount >= 5 &&
    highQualityTokenCount >= 3 &&
    avgEarlyIndex <= 100 &&
    avgLiquidityUsd >= 100000 &&
    avgVolume24h >= 150000
  ) {
    return 'A_PLUS_WHALE';
  }

  if (
    uniqueTokenCount >= 3 &&
    highQualityTokenCount >= 2 &&
    avgEarlyIndex <= 150 &&
    lowQualityRatio <= 0.35
  ) {
    return 'A_SMART';
  }

  if (
    uniqueTokenCount >= 2 &&
    highQualityTokenCount >= 1 &&
    avgEarlyIndex <= 150 &&
    bestEarlyIndex <= 125 &&
    lowQualityRatio <= 0.5
  ) {
    return 'B_PLUS_CANDIDATE';
  }

  if (
    uniqueTokenCount >= 2 &&
    highQualityTokenCount >= 1 &&
    lowQualityRatio <= 0.6
  ) {
    return 'B_CANDIDATE';
  }

  if (
    uniqueTokenCount >= 2 &&
    (midQualityTokenCount >= 1 || highQualityTokenCount >= 1)
  ) {
    return 'C_OBSERVE';
  }

  if (lowQualityTokenCount >= uniqueTokenCount) {
    return 'LOW_QUALITY';
  }

  return 'C_OBSERVE';
}

function buildScores(rows) {
  const wallets = new Map();

  for (const row of rows) {
    const wallet = norm(row.wallet);

    if (!wallet) continue;

    if (!wallets.has(wallet)) {
      wallets.set(wallet, {
        wallet,
        walletClassification: row.walletClassification || '',
        walletScoreFromProfiler: row.walletScore || '',
        chains: new Set(),
        tokens: new Map(),
        symbols: new Set(),
        earlyIndexes: [],
        liquidityValues: [],
        volume24hValues: [],
        priceChange24hValues: [],
        examples: [],
      });
    }

    const walletData = wallets.get(wallet);

    const chain = String(row.chain || '').trim().toLowerCase();
    const tokenAddress = norm(row.tokenAddress);
    const tokenKey = `${chain}:${tokenAddress}`;

    const tokenQuality = row.tokenQuality || 'UNKNOWN';
    const earlyIndex = number(row.earlyIndex, 999999);
    const liquidityUsd = number(row.liquidityUsd, 0);
    const volume24h = number(row.volume24h, 0);
    const priceChange24h = number(row.priceChange24h, 0);

    walletData.chains.add(chain);

    if (row.baseTokenSymbol) walletData.symbols.add(row.baseTokenSymbol);
    if (row.tokenSymbolFromProfile) walletData.symbols.add(row.tokenSymbolFromProfile);

    if (!walletData.tokens.has(tokenKey)) {
      walletData.tokens.set(tokenKey, {
        chain,
        tokenAddress,
        tokenSymbol:
          row.baseTokenSymbol ||
          row.tokenSymbolFromProfile ||
          '',
        tokenQuality,
        earlyIndex,
        liquidityUsd,
        volume24h,
        priceChange24h,
        dexUrl: row.dexUrl || '',
        txHash: row.txHash || '',
      });
    }

    if (earlyIndex > 0) walletData.earlyIndexes.push(earlyIndex);
    if (liquidityUsd > 0) walletData.liquidityValues.push(liquidityUsd);
    if (volume24h > 0) walletData.volume24hValues.push(volume24h);
    if (Number.isFinite(priceChange24h)) walletData.priceChange24hValues.push(priceChange24h);

    if (walletData.examples.length < 12) {
      walletData.examples.push({
        chain,
        token: tokenAddress,
        symbol: row.baseTokenSymbol || row.tokenSymbolFromProfile || '',
        quality: tokenQuality,
        earlyIndex,
        liquidityUsd,
        volume24h,
        priceChange24h,
        dexUrl: row.dexUrl || '',
        txHash: row.txHash || '',
      });
    }
  }

  const output = [];

  for (const [, walletData] of wallets.entries()) {
    const tokens = [...walletData.tokens.values()];
    const uniqueTokenCount = tokens.length;

    const highQualityTokenCount = tokens.filter((token) =>
      HIGH_QUALITY_LABELS.has(token.tokenQuality)
    ).length;

    const midQualityTokenCount = tokens.filter((token) =>
      MID_QUALITY_LABELS.has(token.tokenQuality)
    ).length;

    const lowQualityTokenCount = tokens.filter((token) =>
      LOW_QUALITY_LABELS.has(token.tokenQuality)
    ).length;

    const avgEarlyIndex =
      walletData.earlyIndexes.length > 0
        ? walletData.earlyIndexes.reduce((sum, value) => sum + value, 0) /
          walletData.earlyIndexes.length
        : 999999;

    const bestEarlyIndex =
      walletData.earlyIndexes.length > 0
        ? Math.min(...walletData.earlyIndexes)
        : 999999;

    const avgLiquidityUsd =
      walletData.liquidityValues.length > 0
        ? walletData.liquidityValues.reduce((sum, value) => sum + value, 0) /
          walletData.liquidityValues.length
        : 0;

    const avgVolume24h =
      walletData.volume24hValues.length > 0
        ? walletData.volume24hValues.reduce((sum, value) => sum + value, 0) /
          walletData.volume24hValues.length
        : 0;

    const avgPriceChange24h =
      walletData.priceChange24hValues.length > 0
        ? walletData.priceChange24hValues.reduce((sum, value) => sum + value, 0) /
          walletData.priceChange24hValues.length
        : 0;

    const chainCount = walletData.chains.size;
    const highQualityRatio = uniqueTokenCount > 0 ? highQualityTokenCount / uniqueTokenCount : 0;
    const lowQualityRatio = uniqueTokenCount > 0 ? lowQualityTokenCount / uniqueTokenCount : 0;

    const repeatScore = uniqueTokenCount * 150;
    const qualityScore = highQualityTokenCount * 180 + midQualityTokenCount * 60 - lowQualityTokenCount * 80;
    const earlyScore = Math.max(0, 220 - avgEarlyIndex);
    const bestIndexScore = Math.max(0, 160 - bestEarlyIndex);
    const chainScore = chainCount > 1 ? 100 : 0;

    const liquidityScore =
      avgLiquidityUsd >= 1000000 ? 160 :
      avgLiquidityUsd >= 250000 ? 110 :
      avgLiquidityUsd >= 100000 ? 70 :
      avgLiquidityUsd >= 25000 ? 35 :
      0;

    const volumeScore =
      avgVolume24h >= 1000000 ? 160 :
      avgVolume24h >= 250000 ? 110 :
      avgVolume24h >= 100000 ? 70 :
      avgVolume24h >= 25000 ? 35 :
      0;

    const priceMomentumScore =
      avgPriceChange24h >= 100 ? 120 :
      avgPriceChange24h >= 50 ? 80 :
      avgPriceChange24h >= 20 ? 40 :
      avgPriceChange24h >= 0 ? 10 :
      -40;

    const score =
      repeatScore +
      qualityScore +
      earlyScore +
      bestIndexScore +
      chainScore +
      liquidityScore +
      volumeScore +
      priceMomentumScore;

    const profile = {
      wallet: walletData.wallet,
      finalClass: '',
      finalScore: Number(score.toFixed(2)),
      previousClassification: walletData.walletClassification,
      previousWalletScore: walletData.walletScoreFromProfiler,
      uniqueTokenCount,
      highQualityTokenCount,
      midQualityTokenCount,
      lowQualityTokenCount,
      highQualityRatio: Number(highQualityRatio.toFixed(3)),
      lowQualityRatio: Number(lowQualityRatio.toFixed(3)),
      chainCount,
      chains: [...walletData.chains].join('|'),
      tokenSymbols: [...walletData.symbols].join('|'),
      bestEarlyIndex,
      avgEarlyIndex: Number(avgEarlyIndex.toFixed(2)),
      avgLiquidityUsd: Number(avgLiquidityUsd.toFixed(2)),
      avgVolume24h: Number(avgVolume24h.toFixed(2)),
      avgPriceChange24h: Number(avgPriceChange24h.toFixed(2)),
      examples: JSON.stringify(walletData.examples),
    };

    profile.finalClass = classifyWallet(profile);

    output.push(profile);
  }

  output.sort((a, b) => b.finalScore - a.finalScore);

  return output;
}

function main() {
  console.log('Smart Whale Scorer v1.0');
  console.log(`Input: ${INPUT_FILE}`);

  const rows = parseCsv(INPUT_FILE);

  console.log(`Loaded token performance rows: ${rows.length}`);

  const scores = buildScores(rows);

  const smartWhales = scores.filter((row) =>
    ['A_PLUS_WHALE', 'A_SMART', 'B_PLUS_CANDIDATE'].includes(row.finalClass)
  );

  const observeWallets = scores.filter((row) =>
    ['B_CANDIDATE', 'C_OBSERVE'].includes(row.finalClass)
  );

  writeCsv(SCORE_FILE, scores);
  writeCsv(SMART_WHALES_FILE, smartWhales);
  writeCsv(OBSERVE_FILE, observeWallets);

  console.log('');
  console.log('Done.');
  console.log(`Wallets scored: ${scores.length}`);
  console.log(`Smart whale / high-priority wallets: ${smartWhales.length}`);
  console.log(`Observe wallets: ${observeWallets.length}`);

  if (scores.length > 0) {
    console.log('');
    console.log('Top scored wallets:');

    for (const row of scores.slice(0, 20)) {
      console.log(
        `  ${row.wallet} | ${row.finalClass} | score=${row.finalScore} | tokens=${row.uniqueTokenCount} | highQ=${row.highQualityTokenCount} | lowQ=${row.lowQualityTokenCount} | avgEarly=${row.avgEarlyIndex} | avgLiq=$${row.avgLiquidityUsd} | avgVol24h=$${row.avgVolume24h} | symbols=${row.tokenSymbols}`
      );
    }
  }
}

main();