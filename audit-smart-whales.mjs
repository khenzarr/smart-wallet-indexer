import fs from 'fs';
import path from 'path';

const INPUT_FILE = 'smart-whale-score.csv';

const AUDITED_FILE = 'audited-smart-whales.csv';
const TIER1_FILE = 'tier1-smart-whales.csv';
const TIER2_FILE = 'tier2-watch-wallets.csv';
const CLUSTER_RISK_FILE = 'cluster-risk-wallets.csv';
const LOW_PRIORITY_FILE = 'tier3-low-priority-wallets.csv';

const MIN_TIER1_TOKENS = Number(process.env.AUDIT_MIN_TIER1_TOKENS || 4);
const MIN_TIER1_HIGHQ = Number(process.env.AUDIT_MIN_TIER1_HIGHQ || 3);
const MAX_TIER1_AVG_EARLY = Number(process.env.AUDIT_MAX_TIER1_AVG_EARLY || 80);
const MIN_TIER1_SCORE = Number(process.env.AUDIT_MIN_TIER1_SCORE || 1200);

const MIN_TIER2_TOKENS = Number(process.env.AUDIT_MIN_TIER2_TOKENS || 3);
const MIN_TIER2_HIGHQ = Number(process.env.AUDIT_MIN_TIER2_HIGHQ || 2);
const MAX_TIER2_AVG_EARLY = Number(process.env.AUDIT_MAX_TIER2_AVG_EARLY || 150);
const MIN_TIER2_SCORE = Number(process.env.AUDIT_MIN_TIER2_SCORE || 800);

const MAX_SINGLE_SYMBOL_DOMINANCE = Number(
  process.env.AUDIT_MAX_SINGLE_SYMBOL_DOMINANCE || 0.75
);

const AGENT_CLUSTER_SYMBOLS = new Set(
  String(process.env.AUDIT_CLUSTER_SYMBOLS || 'agent')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

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

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toLowerCase();
}

function getSymbolStats(row) {
  const examples = safeJsonParse(row.examples || '[]', []);
  const counts = new Map();

  for (const item of examples) {
    const symbol = normalizeSymbol(item.symbol);

    if (!symbol) continue;

    counts.set(symbol, (counts.get(symbol) || 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const topSymbol = sorted[0]?.[0] || '';
  const topSymbolCount = sorted[0]?.[1] || 0;
  const topSymbolDominance = total > 0 ? topSymbolCount / total : 0;

  return {
    topSymbol,
    topSymbolCount,
    topSymbolDominance,
    uniqueSymbolCount: counts.size,
    symbolBreakdown: sorted.map(([symbol, count]) => `${symbol}:${count}`).join('|'),
  };
}

function getTokenAddressStats(row) {
  const examples = safeJsonParse(row.examples || '[]', []);
  const counts = new Map();

  for (const item of examples) {
    const chain = norm(item.chain);
    const token = norm(item.token);

    if (!chain || !token) continue;

    const key = `${chain}:${token}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return {
    uniqueTokenAddressCount: counts.size,
    tokenAddressBreakdown: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([token, count]) => `${token}:${count}`)
      .join('|'),
  };
}

function hasClusterRisk(row, symbolStats) {
  const uniqueTokenCount = number(row.uniqueTokenCount, 0);
  const chainCount = number(row.chainCount, 1);
  const avgEarlyIndex = number(row.avgEarlyIndex, 999999);
  const highQualityTokenCount = number(row.highQualityTokenCount, 0);
  const lowQualityTokenCount = number(row.lowQualityTokenCount, 0);

  const topSymbol = symbolStats.topSymbol;
  const dominance = symbolStats.topSymbolDominance;

  if (
    AGENT_CLUSTER_SYMBOLS.has(topSymbol) &&
    dominance >= MAX_SINGLE_SYMBOL_DOMINANCE &&
    uniqueTokenCount >= 3
  ) {
    return {
      risk: true,
      reason: `single-symbol-cluster:${topSymbol}:${dominance.toFixed(2)}`,
    };
  }

  if (
    dominance >= 0.9 &&
    uniqueTokenCount >= 4 &&
    chainCount === 1
  ) {
    return {
      risk: true,
      reason: `high-symbol-dominance:${topSymbol}:${dominance.toFixed(2)}`,
    };
  }

  if (
    uniqueTokenCount >= 4 &&
    avgEarlyIndex <= 30 &&
    highQualityTokenCount >= 3 &&
    lowQualityTokenCount === 0 &&
    dominance >= 0.75
  ) {
    return {
      risk: true,
      reason: `possible-coordinated-sniper-cluster:${topSymbol}:${dominance.toFixed(2)}`,
    };
  }

  return {
    risk: false,
    reason: '',
  };
}

function auditRow(row) {
  const finalScore = number(row.finalScore, 0);
  const uniqueTokenCount = number(row.uniqueTokenCount, 0);
  const highQualityTokenCount = number(row.highQualityTokenCount, 0);
  const lowQualityTokenCount = number(row.lowQualityTokenCount, 0);
  const avgEarlyIndex = number(row.avgEarlyIndex, 999999);
  const bestEarlyIndex = number(row.bestEarlyIndex, 999999);
  const avgLiquidityUsd = number(row.avgLiquidityUsd, 0);
  const avgVolume24h = number(row.avgVolume24h, 0);

  const symbolStats = getSymbolStats(row);
  const tokenStats = getTokenAddressStats(row);
  const clusterCheck = hasClusterRisk(row, symbolStats);

  let auditTier = 'LOW_PRIORITY';
  let auditReason = '';

  if (clusterCheck.risk) {
    auditTier = 'CLUSTER_RISK';
    auditReason = clusterCheck.reason;
  } else if (
    uniqueTokenCount >= MIN_TIER1_TOKENS &&
    highQualityTokenCount >= MIN_TIER1_HIGHQ &&
    avgEarlyIndex <= MAX_TIER1_AVG_EARLY &&
    finalScore >= MIN_TIER1_SCORE
  ) {
    auditTier = 'TIER_1';
    auditReason = 'strong-repeat-high-quality-early-wallet';
  } else if (
    uniqueTokenCount >= MIN_TIER2_TOKENS &&
    highQualityTokenCount >= MIN_TIER2_HIGHQ &&
    avgEarlyIndex <= MAX_TIER2_AVG_EARLY &&
    finalScore >= MIN_TIER2_SCORE
  ) {
    auditTier = 'TIER_2';
    auditReason = 'repeat-high-quality-watch-wallet';
  } else if (
    uniqueTokenCount >= 2 &&
    highQualityTokenCount >= 1 &&
    lowQualityTokenCount <= 1
  ) {
    auditTier = 'TIER_3';
    auditReason = 'lower-confidence-repeat-wallet';
  } else {
    auditTier = 'LOW_PRIORITY';
    auditReason = 'insufficient-quality-or-repeat-signal';
  }

  const auditScore =
    finalScore +
    highQualityTokenCount * 100 -
    lowQualityTokenCount * 100 -
    (clusterCheck.risk ? 750 : 0) -
    (symbolStats.topSymbolDominance >= 0.75 ? 150 : 0) +
    (symbolStats.uniqueSymbolCount >= 3 ? 100 : 0) +
    (avgLiquidityUsd >= 100000 ? 100 : 0) +
    (avgVolume24h >= 100000 ? 100 : 0) +
    (bestEarlyIndex <= 20 ? 75 : 0);

  return {
    wallet: row.wallet,
    auditTier,
    auditReason,
    auditScore: Number(auditScore.toFixed(2)),
    finalClass: row.finalClass || '',
    finalScore: row.finalScore || '',
    uniqueTokenCount: row.uniqueTokenCount || '',
    highQualityTokenCount: row.highQualityTokenCount || '',
    midQualityTokenCount: row.midQualityTokenCount || '',
    lowQualityTokenCount: row.lowQualityTokenCount || '',
    highQualityRatio: row.highQualityRatio || '',
    lowQualityRatio: row.lowQualityRatio || '',
    chainCount: row.chainCount || '',
    chains: row.chains || '',
    tokenSymbols: row.tokenSymbols || '',
    topSymbol: symbolStats.topSymbol,
    topSymbolCount: symbolStats.topSymbolCount,
    topSymbolDominance: Number(symbolStats.topSymbolDominance.toFixed(3)),
    uniqueSymbolCount: symbolStats.uniqueSymbolCount,
    symbolBreakdown: symbolStats.symbolBreakdown,
    uniqueTokenAddressCount: tokenStats.uniqueTokenAddressCount,
    bestEarlyIndex: row.bestEarlyIndex || '',
    avgEarlyIndex: row.avgEarlyIndex || '',
    avgLiquidityUsd: row.avgLiquidityUsd || '',
    avgVolume24h: row.avgVolume24h || '',
    avgPriceChange24h: row.avgPriceChange24h || '',
    clusterRisk: clusterCheck.risk ? 'yes' : 'no',
    clusterReason: clusterCheck.reason,
    examples: row.examples || '',
  };
}

function main() {
  console.log('Smart Whale Auditor v1.2');
  console.log(`Input: ${INPUT_FILE}`);
  console.log('');
  console.log(`MIN_TIER1_TOKENS=${MIN_TIER1_TOKENS}`);
  console.log(`MIN_TIER1_HIGHQ=${MIN_TIER1_HIGHQ}`);
  console.log(`MAX_TIER1_AVG_EARLY=${MAX_TIER1_AVG_EARLY}`);
  console.log(`MIN_TIER1_SCORE=${MIN_TIER1_SCORE}`);
  console.log(`MAX_SINGLE_SYMBOL_DOMINANCE=${MAX_SINGLE_SYMBOL_DOMINANCE}`);
  console.log(`AUDIT_CLUSTER_SYMBOLS=${[...AGENT_CLUSTER_SYMBOLS].join('|')}`);
  console.log('');

  const rows = parseCsv(INPUT_FILE);

  console.log(`Loaded scored wallets: ${rows.length}`);

  const audited = rows
    .map(auditRow)
    .sort((a, b) => b.auditScore - a.auditScore);

  const tier1 = audited.filter((row) => row.auditTier === 'TIER_1');
  const tier2 = audited.filter((row) => row.auditTier === 'TIER_2');
  const clusterRisk = audited.filter((row) => row.auditTier === 'CLUSTER_RISK');
  const lowPriority = audited.filter((row) =>
    ['TIER_3', 'LOW_PRIORITY'].includes(row.auditTier)
  );

  writeCsv(AUDITED_FILE, audited);
  writeCsv(TIER1_FILE, tier1);
  writeCsv(TIER2_FILE, tier2);
  writeCsv(CLUSTER_RISK_FILE, clusterRisk);
  writeCsv(LOW_PRIORITY_FILE, lowPriority);

  console.log('');
  console.log('Done.');
  console.log(`Audited wallets: ${audited.length}`);
  console.log(`Tier 1 wallets: ${tier1.length}`);
  console.log(`Tier 2 wallets: ${tier2.length}`);
  console.log(`Cluster risk wallets: ${clusterRisk.length}`);
  console.log(`Tier 3 / low priority wallets: ${lowPriority.length}`);

  if (tier1.length > 0) {
    console.log('');
    console.log('Top Tier 1 wallets:');

    for (const row of tier1.slice(0, 15)) {
      console.log(
        `  ${row.wallet} | auditScore=${row.auditScore} | class=${row.finalClass} | tokens=${row.uniqueTokenCount} | highQ=${row.highQualityTokenCount} | avgEarly=${row.avgEarlyIndex} | topSymbol=${row.topSymbol}:${row.topSymbolDominance} | symbols=${row.tokenSymbols}`
      );
    }
  }

  if (clusterRisk.length > 0) {
    console.log('');
    console.log('Top cluster-risk wallets:');

    for (const row of clusterRisk.slice(0, 15)) {
      console.log(
        `  ${row.wallet} | reason=${row.clusterReason} | score=${row.finalScore} | tokens=${row.uniqueTokenCount} | topSymbol=${row.topSymbol}:${row.topSymbolDominance} | symbols=${row.tokenSymbols}`
      );
    }
  }
}

main();