import fs from 'fs';
import path from 'path';

const INPUT_FILE = 'smart-actor-score.csv';

const AUDITED_FILE = 'audited-smart-actors.csv';
const TIER1_FILE = 'tier1-smart-money-actors.csv';
const TIER2_FILE = 'tier2-smart-money-watch.csv';
const CONTRACT_ACTORS_FILE = 'smart-contract-actors.csv';
const INFRA_FILE = 'infra-actors-filtered.csv';
const CLUSTER_FILE = 'cluster-risk-actors.csv';
const LOW_PRIORITY_FILE = 'low-priority-actors.csv';

const MIN_TIER1_TOKENS = Number(process.env.ACTOR_AUDIT_MIN_TIER1_TOKENS || 5);
const MAX_TIER1_AVG_EARLY = Number(process.env.ACTOR_AUDIT_MAX_TIER1_AVG_EARLY || 80);
const MIN_TIER1_SCORE = Number(process.env.ACTOR_AUDIT_MIN_TIER1_SCORE || 1000);

const MIN_TIER2_TOKENS = Number(process.env.ACTOR_AUDIT_MIN_TIER2_TOKENS || 3);
const MAX_TIER2_AVG_EARLY = Number(process.env.ACTOR_AUDIT_MAX_TIER2_AVG_EARLY || 150);
const MIN_TIER2_SCORE = Number(process.env.ACTOR_AUDIT_MIN_TIER2_SCORE || 650);

const MIN_CONTRACT_TOKENS = Number(process.env.ACTOR_AUDIT_MIN_CONTRACT_TOKENS || 3);
const MAX_CONTRACT_AVG_EARLY = Number(process.env.ACTOR_AUDIT_MAX_CONTRACT_AVG_EARLY || 120);
const MIN_CONTRACT_SCORE = Number(process.env.ACTOR_AUDIT_MIN_CONTRACT_SCORE || 700);

const MAX_SINGLE_SYMBOL_DOMINANCE = Number(
  process.env.ACTOR_AUDIT_MAX_SINGLE_SYMBOL_DOMINANCE || 0.75
);

const CLUSTER_SYMBOLS = new Set(
  String(process.env.ACTOR_AUDIT_CLUSTER_SYMBOLS || 'agent')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

const INFRA_NAME_PATTERNS = [
  'router',
  'settler',
  'settlement',
  'diamond',
  'lifi',
  'li.fi',
  'hookadapter',
  'hook adapter',
  'base settler',
  'basesettler',
  'intent',
  'metatxn',
  'meta txn',
  'pair',
  'pool',
  'factory',
  'vault',
  'staking',
  'farm',
  'proxyadmin',
  'proxy admin',
  'multicall',
  'positionmanager',
  'position manager',
  'swaprouter',
  'swap router',
  'uniswap',
  'sushiswap',
  'curve',
  'balancer',
  'aerodrome',
  'pancake',
  'quoter',
  'univ4hookadapter',
  'univ4',
  'permit2',
];

const INFRA_ADDRESS_DENYLIST = new Set([
  // Known infra/execution contracts surfaced by v1.4 output.
  '0x7747f8d2a76bd6345cc29622a946a929647f2359', // BaseSettler
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', // LiFiDiamond
  '0xfd78ba0f717223bebe555a777b70b86667837ff6', // UniV4HookAdapter
  '0x68a14203953130ae840e37dbe3d64c1e6858da7b', // BaseSettlerMetaTxn
  '0x6b6e87d2cc438c287a5550a8732c302454e4382b', // BaseSettlerIntent
]);

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

function containsAnyPattern(value, patterns) {
  const text = String(value || '').toLowerCase();
  return patterns.some((pattern) => text.includes(pattern));
}

function getSymbolStats(row) {
  const examples = safeJsonParse(row.examples || '[]', []);
  const counts = new Map();

  for (const item of examples) {
    const symbol = norm(item.symbol);

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

function getExampleStats(row) {
  const examples = safeJsonParse(row.examples || '[]', []);

  const contractNameCounts = new Map();
  const actorTypeCounts = new Map();
  const tokenCounts = new Map();

  for (const item of examples) {
    const contractName = String(item.contractName || '').trim();
    const actorType = String(item.actorType || '').trim();
    const tokenKey = `${norm(item.chain)}:${norm(item.token)}`;

    if (contractName) {
      contractNameCounts.set(contractName, (contractNameCounts.get(contractName) || 0) + 1);
    }

    if (actorType) {
      actorTypeCounts.set(actorType, (actorTypeCounts.get(actorType) || 0) + 1);
    }

    if (tokenKey !== ':') {
      tokenCounts.set(tokenKey, (tokenCounts.get(tokenKey) || 0) + 1);
    }
  }

  return {
    examplesCount: examples.length,
    exampleContractNames: [...contractNameCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}:${count}`)
      .join('|'),
    exampleActorTypes: [...actorTypeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}:${count}`)
      .join('|'),
    uniqueExampleTokenCount: tokenCounts.size,
  };
}

function isInfraActor(row, symbolStats, exampleStats) {
  const actor = norm(row.actor);
  const actorTypes = String(row.actorTypes || '');
  const actorSubtypes = String(row.actorSubtypes || '');
  const contractNames = String(row.contractNames || '');
  const combined = `${actorTypes} ${actorSubtypes} ${contractNames} ${exampleStats.exampleContractNames}`;

  if (INFRA_ADDRESS_DENYLIST.has(actor)) {
    return {
      isInfra: true,
      reason: 'address-denylist',
    };
  }

  if (actorTypes.includes('INFRA_CONTRACT')) {
    return {
      isInfra: true,
      reason: 'actorType=INFRA_CONTRACT',
    };
  }

  if (containsAnyPattern(combined, INFRA_NAME_PATTERNS)) {
    return {
      isInfra: true,
      reason: 'infra-name-pattern',
    };
  }

  return {
    isInfra: false,
    reason: '',
  };
}

function isClusterRisk(row, symbolStats) {
  const uniqueTokenCount = number(row.uniqueTokenCount, 0);
  const topSymbol = symbolStats.topSymbol;
  const dominance = symbolStats.topSymbolDominance;

  if (
    CLUSTER_SYMBOLS.has(topSymbol) &&
    dominance >= MAX_SINGLE_SYMBOL_DOMINANCE &&
    uniqueTokenCount >= 3
  ) {
    return {
      isCluster: true,
      reason: `single-symbol-cluster:${topSymbol}:${dominance.toFixed(2)}`,
    };
  }

  if (
    dominance >= 0.9 &&
    uniqueTokenCount >= 4
  ) {
    return {
      isCluster: true,
      reason: `high-symbol-dominance:${topSymbol}:${dominance.toFixed(2)}`,
    };
  }

  return {
    isCluster: false,
    reason: '',
  };
}

function classifyActor(row, symbolStats, infraCheck, clusterCheck) {
  const actorTypes = String(row.actorTypes || '');
  const score = number(row.score, 0);
  const uniqueTokenCount = number(row.uniqueTokenCount, 0);
  const avgEarlyIndex = number(row.avgEarlyIndex, 999999);
  const bestEarlyIndex = number(row.bestEarlyIndex, 999999);
  const chainCount = number(row.chainCount, 1);

  const isContractLike =
    actorTypes.includes('CONTRACT') ||
    actorTypes.includes('UNKNOWN');

  const isPureEoa =
    actorTypes === 'EOA' ||
    actorTypes === 'EOA_OR_UNVERIFIED';

  if (infraCheck.isInfra) {
    return {
      auditTier: 'INFRA',
      auditReason: infraCheck.reason,
    };
  }

  if (clusterCheck.isCluster) {
    return {
      auditTier: 'CLUSTER_RISK',
      auditReason: clusterCheck.reason,
    };
  }

  if (
    isPureEoa &&
    uniqueTokenCount >= MIN_TIER1_TOKENS &&
    avgEarlyIndex <= MAX_TIER1_AVG_EARLY &&
    score >= MIN_TIER1_SCORE
  ) {
    return {
      auditTier: 'TIER_1_EOA_SMART_MONEY',
      auditReason: 'strong-repeat-early-eoa-actor',
    };
  }

  if (
    isPureEoa &&
    uniqueTokenCount >= MIN_TIER2_TOKENS &&
    avgEarlyIndex <= MAX_TIER2_AVG_EARLY &&
    score >= MIN_TIER2_SCORE
  ) {
    return {
      auditTier: 'TIER_2_EOA_WATCH',
      auditReason: 'repeat-early-eoa-watch',
    };
  }

  if (
    isContractLike &&
    uniqueTokenCount >= MIN_CONTRACT_TOKENS &&
    avgEarlyIndex <= MAX_CONTRACT_AVG_EARLY &&
    score >= MIN_CONTRACT_SCORE
  ) {
    return {
      auditTier: 'SMART_CONTRACT_ACTOR',
      auditReason: 'contract-like-repeat-early-actor-needs-manual-review',
    };
  }

  if (
    uniqueTokenCount >= 2 &&
    bestEarlyIndex <= 100 &&
    avgEarlyIndex <= 200
  ) {
    return {
      auditTier: 'TIER_3_OBSERVE',
      auditReason: 'low-confidence-repeat-actor',
    };
  }

  return {
    auditTier: 'LOW_PRIORITY',
    auditReason: 'insufficient-repeat-or-early-quality',
  };
}

function auditActor(row) {
  const symbolStats = getSymbolStats(row);
  const exampleStats = getExampleStats(row);
  const infraCheck = isInfraActor(row, symbolStats, exampleStats);
  const clusterCheck = isClusterRisk(row, symbolStats);
  const classification = classifyActor(row, symbolStats, infraCheck, clusterCheck);

  const baseScore = number(row.score, 0);
  const uniqueTokenCount = number(row.uniqueTokenCount, 0);
  const avgEarlyIndex = number(row.avgEarlyIndex, 999999);
  const bestEarlyIndex = number(row.bestEarlyIndex, 999999);
  const chainCount = number(row.chainCount, 1);

  const symbolDiversityBonus = symbolStats.uniqueSymbolCount >= 4 ? 250 : symbolStats.uniqueSymbolCount >= 2 ? 100 : 0;
  const tokenRepeatBonus = uniqueTokenCount >= 10 ? 350 : uniqueTokenCount >= 5 ? 200 : uniqueTokenCount >= 3 ? 100 : 0;
  const earlyBonus = bestEarlyIndex <= 3 ? 150 : bestEarlyIndex <= 10 ? 100 : bestEarlyIndex <= 25 ? 50 : 0;
  const chainBonus = chainCount > 1 ? 150 : 0;

  const infraPenalty = infraCheck.isInfra ? 1500 : 0;
  const clusterPenalty = clusterCheck.isCluster ? 750 : 0;
  const dominancePenalty = symbolStats.topSymbolDominance >= 0.75 ? 250 : 0;
  const avgEarlyPenalty = avgEarlyIndex > 150 ? 150 : 0;

  const auditScore =
    baseScore +
    symbolDiversityBonus +
    tokenRepeatBonus +
    earlyBonus +
    chainBonus -
    infraPenalty -
    clusterPenalty -
    dominancePenalty -
    avgEarlyPenalty;

  return {
    actor: row.actor,
    auditTier: classification.auditTier,
    auditReason: classification.auditReason,
    auditScore: Number(auditScore.toFixed(2)),

    actorTypes: row.actorTypes || '',
    actorSubtypes: row.actorSubtypes || '',
    contractNames: row.contractNames || '',

    originalScore: row.score || '',
    uniqueTokenCount: row.uniqueTokenCount || '',
    earlyHits: row.earlyHits || '',
    chains: row.chains || '',
    chainCount: row.chainCount || '',
    tokenSymbols: row.tokenSymbols || '',
    bestEarlyIndex: row.bestEarlyIndex || '',
    avgEarlyIndex: row.avgEarlyIndex || '',
    firstSeenBlock: row.firstSeenBlock || '',
    latestSeenTimestamp: row.latestSeenTimestamp || '',

    topSymbol: symbolStats.topSymbol,
    topSymbolCount: symbolStats.topSymbolCount,
    topSymbolDominance: Number(symbolStats.topSymbolDominance.toFixed(3)),
    uniqueSymbolCount: symbolStats.uniqueSymbolCount,
    symbolBreakdown: symbolStats.symbolBreakdown,

    infraRisk: infraCheck.isInfra ? 'yes' : 'no',
    infraReason: infraCheck.reason,
    clusterRisk: clusterCheck.isCluster ? 'yes' : 'no',
    clusterReason: clusterCheck.reason,

    examplesCount: exampleStats.examplesCount,
    exampleActorTypes: exampleStats.exampleActorTypes,
    exampleContractNames: exampleStats.exampleContractNames,
    uniqueExampleTokenCount: exampleStats.uniqueExampleTokenCount,

    examples: row.examples || '',
  };
}

function main() {
  console.log('Smart Actor Auditor v1.5');
  console.log(`Input: ${INPUT_FILE}`);
  console.log('');
  console.log(`MIN_TIER1_TOKENS=${MIN_TIER1_TOKENS}`);
  console.log(`MAX_TIER1_AVG_EARLY=${MAX_TIER1_AVG_EARLY}`);
  console.log(`MIN_TIER1_SCORE=${MIN_TIER1_SCORE}`);
  console.log(`MIN_CONTRACT_TOKENS=${MIN_CONTRACT_TOKENS}`);
  console.log(`MAX_CONTRACT_AVG_EARLY=${MAX_CONTRACT_AVG_EARLY}`);
  console.log(`MIN_CONTRACT_SCORE=${MIN_CONTRACT_SCORE}`);
  console.log(`MAX_SINGLE_SYMBOL_DOMINANCE=${MAX_SINGLE_SYMBOL_DOMINANCE}`);
  console.log(`CLUSTER_SYMBOLS=${[...CLUSTER_SYMBOLS].join('|')}`);
  console.log('');

  const rows = parseCsv(INPUT_FILE);

  console.log(`Loaded scored actors: ${rows.length}`);

  const audited = rows
    .map(auditActor)
    .sort((a, b) => b.auditScore - a.auditScore);

  const tier1 = audited.filter((row) => row.auditTier === 'TIER_1_EOA_SMART_MONEY');
  const tier2 = audited.filter((row) => row.auditTier === 'TIER_2_EOA_WATCH');
  const contractActors = audited.filter((row) => row.auditTier === 'SMART_CONTRACT_ACTOR');
  const infraActors = audited.filter((row) => row.auditTier === 'INFRA');
  const clusterActors = audited.filter((row) => row.auditTier === 'CLUSTER_RISK');
  const lowPriority = audited.filter((row) =>
    ['TIER_3_OBSERVE', 'LOW_PRIORITY'].includes(row.auditTier)
  );

  writeCsv(AUDITED_FILE, audited);
  writeCsv(TIER1_FILE, tier1);
  writeCsv(TIER2_FILE, tier2);
  writeCsv(CONTRACT_ACTORS_FILE, contractActors);
  writeCsv(INFRA_FILE, infraActors);
  writeCsv(CLUSTER_FILE, clusterActors);
  writeCsv(LOW_PRIORITY_FILE, lowPriority);

  console.log('');
  console.log('Done.');
  console.log(`Audited actors: ${audited.length}`);
  console.log(`Tier 1 EOA smart money actors: ${tier1.length}`);
  console.log(`Tier 2 EOA watch actors: ${tier2.length}`);
  console.log(`Smart contract actors: ${contractActors.length}`);
  console.log(`Infra actors filtered: ${infraActors.length}`);
  console.log(`Cluster risk actors: ${clusterActors.length}`);
  console.log(`Low priority / observe actors: ${lowPriority.length}`);

  if (tier1.length > 0) {
    console.log('');
    console.log('Top Tier 1 EOA smart money actors:');

    for (const row of tier1.slice(0, 20)) {
      console.log(
        `  ${row.actor} | auditScore=${row.auditScore} | tokens=${row.uniqueTokenCount} | best=${row.bestEarlyIndex} | avg=${row.avgEarlyIndex} | symbols=${row.tokenSymbols}`
      );
    }
  }

  if (contractActors.length > 0) {
    console.log('');
    console.log('Top smart contract actors for manual review:');

    for (const row of contractActors.slice(0, 20)) {
      console.log(
        `  ${row.actor} | auditScore=${row.auditScore} | types=${row.actorTypes} | names=${row.contractNames || '-'} | tokens=${row.uniqueTokenCount} | best=${row.bestEarlyIndex} | avg=${row.avgEarlyIndex} | symbols=${row.tokenSymbols}`
      );
    }
  }

  if (infraActors.length > 0) {
    console.log('');
    console.log('Top infra actors filtered:');

    for (const row of infraActors.slice(0, 15)) {
      console.log(
        `  ${row.actor} | reason=${row.infraReason} | names=${row.contractNames || row.exampleContractNames || '-'} | tokens=${row.uniqueTokenCount} | score=${row.originalScore}`
      );
    }
  }

  if (clusterActors.length > 0) {
    console.log('');
    console.log('Top cluster-risk actors:');

    for (const row of clusterActors.slice(0, 15)) {
      console.log(
        `  ${row.actor} | reason=${row.clusterReason} | tokens=${row.uniqueTokenCount} | topSymbol=${row.topSymbol}:${row.topSymbolDominance} | symbols=${row.tokenSymbols}`
      );
    }
  }
}

main();