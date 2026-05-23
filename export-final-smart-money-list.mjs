import fs from 'fs';
import path from 'path';

const OUTPUT_FILE = 'final-smart-money-list.csv';

const SOURCE_FILES = [
  {
    file: 'tier1-profitable-smart-money.csv',
    defaultCategory: 'EOA_SMART_MONEY',
    priority: 1,
  },
  {
    file: 'contract-profit-review.csv',
    defaultCategory: 'CONTRACT_OR_EXECUTOR_REVIEW',
    priority: 2,
  },
  {
    file: 'actor-profit-report.csv',
    defaultCategory: 'PROFIT_PROXY_REPORT',
    priority: 3,
  },
  {
    file: 'tier1-smart-money-actors.csv',
    defaultCategory: 'TIER1_EARLY_ACTOR',
    priority: 4,
  },
  {
    file: 'tier2-smart-money-watch.csv',
    defaultCategory: 'TIER2_WATCH_ACTOR',
    priority: 5,
  },
  {
    file: 'smart-contract-actors.csv',
    defaultCategory: 'SMART_CONTRACT_ACTOR_REVIEW',
    priority: 6,
  },
];

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

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getAddress(row) {
  return norm(row.actor || row.wallet || row.address);
}

function inferActorType(row) {
  const actorTypes = String(row.actorTypes || '').trim();

  if (actorTypes) return actorTypes;

  const auditTier = String(row.auditTier || '');
  const sourceFile = String(row.sourceFile || '');

  if (auditTier.includes('EOA') || sourceFile.includes('tier1-smart-money')) {
    return 'EOA';
  }

  if (auditTier.includes('CONTRACT') || sourceFile.includes('contract')) {
    return 'CONTRACT_OR_SMART_ACCOUNT';
  }

  return 'UNKNOWN';
}

function inferRankTier(row, defaultCategory) {
  const profitTier = String(row.profitTier || '');
  const auditTier = String(row.auditTier || '');

  if (profitTier === 'TIER_1_PROFITABLE_SMART_MONEY') {
    return 'TIER_1';
  }

  if (profitTier === 'TIER_2_PROFITABLE_WATCH') {
    return 'TIER_2';
  }

  if (profitTier === 'TIER_3_ACTIVE_WATCH') {
    return 'TIER_3';
  }

  if (auditTier.includes('TIER_1')) {
    return 'TIER_1';
  }

  if (auditTier.includes('TIER_2')) {
    return 'TIER_2';
  }

  if (defaultCategory.includes('CONTRACT')) {
    return 'CONTRACT_REVIEW';
  }

  return 'OBSERVE';
}

function inferCategory(row, defaultCategory) {
  const auditTier = String(row.auditTier || '');
  const actorTypes = String(row.actorTypes || '');
  const profitTier = String(row.profitTier || '');

  if (
    auditTier.includes('EOA') &&
    ['TIER_1_PROFITABLE_SMART_MONEY', 'TIER_2_PROFITABLE_WATCH'].includes(profitTier)
  ) {
    return 'PROFITABLE_EOA_SMART_MONEY';
  }

  if (
    auditTier.includes('CONTRACT') ||
    actorTypes.includes('CONTRACT') ||
    defaultCategory.includes('CONTRACT')
  ) {
    return 'CONTRACT_OR_EXECUTOR_REVIEW';
  }

  if (auditTier.includes('EOA')) {
    return 'EOA_SMART_MONEY';
  }

  return defaultCategory;
}

function inferRiskLabel(row) {
  const auditTier = String(row.auditTier || '');
  const actorTypes = String(row.actorTypes || '');
  const lowQualityCount = number(row.lowQualityCount, 0);
  const strongCount = number(row.strongProfitProxyCount, 0);
  const goodCount = number(row.goodProfitProxyCount, 0);
  const uniqueTokenCount = number(row.uniqueTokenCount, 0);
  const avgEarlyIndex = number(row.avgEarlyIndex, 999999);

  if (auditTier.includes('CONTRACT') || actorTypes.includes('CONTRACT')) {
    return 'MANUAL_REVIEW_REQUIRED_CONTRACT';
  }

  if (lowQualityCount >= 2) {
    return 'MEDIUM_RISK_LOW_QUALITY_TOKENS';
  }

  if (uniqueTokenCount >= 5 && avgEarlyIndex <= 30 && strongCount >= 2) {
    return 'LOW_RISK_HIGH_CONFIDENCE';
  }

  if (strongCount + goodCount >= 2) {
    return 'MEDIUM_RISK_PROFIT_PROXY';
  }

  return 'HIGH_RISK_OBSERVE_ONLY';
}

function inferReviewStatus(row) {
  const risk = inferRiskLabel(row);

  if (risk === 'MANUAL_REVIEW_REQUIRED_CONTRACT') {
    return 'NEEDS_CONTRACT_MANUAL_REVIEW';
  }

  if (risk === 'LOW_RISK_HIGH_CONFIDENCE') {
    return 'READY_FOR_WATCHLIST';
  }

  if (risk === 'MEDIUM_RISK_PROFIT_PROXY') {
    return 'WATCHLIST_CANDIDATE';
  }

  return 'OBSERVE_ONLY';
}

function inferRecommendedAction(row) {
  const reviewStatus = inferReviewStatus(row);
  const profitTier = String(row.profitTier || '');

  if (reviewStatus === 'READY_FOR_WATCHLIST') {
    return 'Add to primary smart-money watchlist; monitor new token activity.';
  }

  if (reviewStatus === 'WATCHLIST_CANDIDATE') {
    return 'Add to secondary watchlist; require extra validation before acting.';
  }

  if (reviewStatus === 'NEEDS_CONTRACT_MANUAL_REVIEW') {
    return 'Manually inspect contract/executor behavior before treating as smart money.';
  }

  if (profitTier === 'LOW_PRIORITY') {
    return 'Do not monitor actively; keep for historical reference only.';
  }

  return 'Observe only; do not use as direct signal.';
}

function getTopExampleSymbols(row) {
  const examples = safeJsonParse(row.examples || '[]', []);

  if (!Array.isArray(examples)) {
    return '';
  }

  return examples
    .map((item) => item.symbol || item.tokenSymbol || '')
    .filter(Boolean)
    .slice(0, 10)
    .join('|');
}

function normalizeRow(row, sourceFile, defaultCategory, priority) {
  const address = getAddress(row);
  const actorType = inferActorType(row);
  const actorCategory = inferCategory(row, defaultCategory);
  const rankTier = inferRankTier(row, defaultCategory);
  const riskLabel = inferRiskLabel(row);
  const reviewStatus = inferReviewStatus(row);
  const recommendedAction = inferRecommendedAction(row);

  return {
    address,
    actorCategory,
    actorType,
    rankTier,

    profitTier: row.profitTier || '',
    profitProxyScore: row.profitProxyScore || '',
    auditTier: row.auditTier || '',
    auditScore: row.auditScore || row.score || '',
    originalScore: row.originalScore || row.score || '',

    uniqueTokenCount: row.uniqueTokenCount || '',
    enrichedTokenCount: row.enrichedTokenCount || '',
    strongProfitProxyCount: row.strongProfitProxyCount || '',
    goodProfitProxyCount: row.goodProfitProxyCount || '',
    activeWatchCount: row.activeWatchCount || '',
    lowQualityCount: row.lowQualityCount || '',

    avgEarlyIndex: row.avgEarlyIndex || '',
    bestEarlyIndex: row.bestEarlyIndex || '',
    avgPriceChange24h: row.avgPriceChange24h || '',
    avgLiquidityUsd: row.avgLiquidityUsd || '',
    avgVolume24h: row.avgVolume24h || '',

    chains: row.chains || '',
    tokenSymbols: row.tokenSymbols || getTopExampleSymbols(row),
    contractNames: row.contractNames || '',
    actorSubtypes: row.actorSubtypes || '',

    riskLabel,
    reviewStatus,
    recommendedAction,

    sourceFile,
    sourcePriority: priority,
    examples: row.examples || '',
  };
}

function getSortScore(row) {
  const profitScore = number(row.profitProxyScore, 0);
  const auditScore = number(row.auditScore, 0);
  const originalScore = number(row.originalScore, 0);
  const strong = number(row.strongProfitProxyCount, 0);
  const good = number(row.goodProfitProxyCount, 0);

  return profitScore + auditScore * 0.25 + originalScore * 0.1 + strong * 250 + good * 100;
}

function main() {
  console.log('Final Smart Money List Exporter v1.7');
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log('');

  const candidates = [];

  for (const source of SOURCE_FILES) {
    const rows = parseCsv(source.file);

    console.log(`${source.file}: ${rows.length} rows`);

    for (const row of rows) {
      const address = getAddress(row);

      if (!address) continue;

      candidates.push(
        normalizeRow(row, source.file, source.defaultCategory, source.priority)
      );
    }
  }

  const dedup = new Map();

  for (const row of candidates) {
    const existing = dedup.get(row.address);

    if (!existing) {
      dedup.set(row.address, row);
      continue;
    }

    const existingScore = getSortScore(existing);
    const nextScore = getSortScore(row);

    if (nextScore > existingScore) {
      dedup.set(row.address, row);
    }
  }

  const finalRows = [...dedup.values()].sort((a, b) => {
    const rankOrder = {
      TIER_1: 1,
      TIER_2: 2,
      CONTRACT_REVIEW: 3,
      TIER_3: 4,
      OBSERVE: 5,
    };

    const rankA = rankOrder[a.rankTier] || 99;
    const rankB = rankOrder[b.rankTier] || 99;

    if (rankA !== rankB) return rankA - rankB;

    return getSortScore(b) - getSortScore(a);
  });

  const headers = [
    'address',
    'actorCategory',
    'actorType',
    'rankTier',
    'profitTier',
    'profitProxyScore',
    'auditTier',
    'auditScore',
    'originalScore',
    'uniqueTokenCount',
    'enrichedTokenCount',
    'strongProfitProxyCount',
    'goodProfitProxyCount',
    'activeWatchCount',
    'lowQualityCount',
    'avgEarlyIndex',
    'bestEarlyIndex',
    'avgPriceChange24h',
    'avgLiquidityUsd',
    'avgVolume24h',
    'chains',
    'tokenSymbols',
    'contractNames',
    'actorSubtypes',
    'riskLabel',
    'reviewStatus',
    'recommendedAction',
    'sourceFile',
    'sourcePriority',
    'examples',
  ];

  const body = [
    headers.join(','),
    ...finalRows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');

  fs.writeFileSync(path.resolve(OUTPUT_FILE), body + '\n');

  const primaryReady = finalRows.filter((row) => row.reviewStatus === 'READY_FOR_WATCHLIST');
  const secondaryReady = finalRows.filter((row) => row.reviewStatus === 'WATCHLIST_CANDIDATE');
  const contractReview = finalRows.filter((row) => row.reviewStatus === 'NEEDS_CONTRACT_MANUAL_REVIEW');

  console.log('');
  console.log('Done.');
  console.log(`Raw candidates loaded: ${candidates.length}`);
  console.log(`Final unique addresses: ${finalRows.length}`);
  console.log(`Ready for primary watchlist: ${primaryReady.length}`);
  console.log(`Secondary watchlist candidates: ${secondaryReady.length}`);
  console.log(`Contract/manual review required: ${contractReview.length}`);
  console.log(`Output: ${OUTPUT_FILE}`);

  if (finalRows.length > 0) {
    console.log('');
    console.log('Top final smart-money addresses:');

    for (const row of finalRows.slice(0, 20)) {
      console.log(
        `  ${row.address} | ${row.rankTier} | ${row.actorCategory} | ${row.reviewStatus} | profitScore=${row.profitProxyScore || '-'} | tokens=${row.uniqueTokenCount || '-'} | strong=${row.strongProfitProxyCount || '-'} | avgEarly=${row.avgEarlyIndex || '-'} | symbols=${row.tokenSymbols}`
      );
    }
  }
}

main();