\# Pipeline



This document explains the Smart Wallet Indexer pipeline.



The goal is to discover and rank smart-money actors that repeatedly appear early in degen markets and whose early tokens later show strong liquidity, volume, or momentum.



\---



\## High-level pipeline



```txt

Token universe collection

&#x20;       ↓

Early actor extraction

&#x20;       ↓

Actor type classification

&#x20;       ↓

Actor scoring

&#x20;       ↓

Infra / cluster audit

&#x20;       ↓

Profit proxy enrichment

&#x20;       ↓

Final smart-money list export

```



\---



\## Step 1 — Market token collection



Command:



```powershell

npm run market

```



Script:



```txt

collect-market-tokens.mjs

```



Purpose:



```txt

Collect a broad market token universe from DEX Screener.

Focus on Ethereum and Base.

```



Typical output:



```txt

market-tokens.csv

```



This file is generated locally and ignored by Git.



\---



\## Step 2 — Actor-aware early indexing



Command:



```powershell

npm run actors

```



Script:



```txt

index-smart-actors.mjs

```



Purpose:



```txt

Scan early token transfers.

Capture early receiving actors.

Classify actors as EOA, contract, infra contract, or unknown.

Do not blindly discard contracts.

```



Typical outputs:



```txt

all-early-actors.csv

eoa-early-actors.csv

contract-early-actors.csv

infra-early-actors.csv

unknown-early-actors.csv

smart-actor-score.csv

smart-actor-candidates.csv

```



Important idea:



```txt

Contract actor does not always mean noise.

Some contract actors may be smart accounts, executors, sniper contracts, or trading infrastructure.

```



\---



\## Step 3 — Actor audit



Command:



```powershell

npm run audit:actors

```



Script:



```txt

audit-smart-actors.mjs

```



Purpose:



```txt

Separate likely smart money from infrastructure, cluster risk, and low-priority actors.

```



Typical outputs:



```txt

audited-smart-actors.csv

tier1-smart-money-actors.csv

tier2-smart-money-watch.csv

smart-contract-actors.csv

infra-actors-filtered.csv

cluster-risk-actors.csv

low-priority-actors.csv

```



Important categories:



```txt

TIER\_1\_EOA\_SMART\_MONEY

TIER\_2\_EOA\_WATCH

SMART\_CONTRACT\_ACTOR

INFRA

CLUSTER\_RISK

LOW\_PRIORITY

```



\---



\## Step 4 — Profit proxy enrichment



Command:



```powershell

npm run profit:actors

```



Script:



```txt

enrich-actor-profit.mjs

```



Purpose:



```txt

Check whether the tokens caught early by each actor later showed strong liquidity, volume, FDV profile, or momentum.

```



Typical outputs:



```txt

actor-profit-report.csv

tier1-profitable-smart-money.csv

contract-profit-review.csv

```



Important note:



```txt

This is not realized PnL.

This is a profit proxy based on token quality and momentum.

```



\---



\## Step 5 — Final export



Command:



```powershell

npm run export:final

```



Script:



```txt

export-final-smart-money-list.mjs

```



Purpose:



```txt

Merge the strongest actor outputs into one clean final CSV.

```



Main output:



```txt

final-smart-money-list.csv

```



Important columns:



```txt

address

actorCategory

actorType

rankTier

profitTier

profitProxyScore

auditTier

auditScore

uniqueTokenCount

strongProfitProxyCount

avgEarlyIndex

tokenSymbols

riskLabel

reviewStatus

recommendedAction

```



\---



\## Review status guide



\### READY\_FOR\_WATCHLIST



Cleanest smart-money candidates.



Usually EOA actors with strong repeat early behavior and strong profit proxy.



Action:



```txt

Primary monitoring candidate.

```



\---



\### WATCHLIST\_CANDIDATE



Promising but lower confidence.



Action:



```txt

Secondary monitoring candidate.

Validate before acting.

```



\---



\### NEEDS\_CONTRACT\_MANUAL\_REVIEW



Potentially valuable contract/executor actor.



Action:



```txt

Manually inspect before treating as smart money.

```



Check:



```txt

Is it a router?

Is it a settler?

Is it a pool?

Is it an aggregation contract?

Is it a sniper/executor contract?

Is it controlled by a smart-money actor?

```



\---



\### OBSERVE\_ONLY



Lower confidence.



Action:



```txt

Keep for historical reference.

Do not use as a direct signal.

```



\---



\## Recommended full run



```powershell

npm run market

npm run actors

npm run audit:actors

npm run profit:actors

npm run export:final

```



\---



\## Generated files



These are local outputs and should not be committed:



```txt

\*.csv

\*.xlsx

seen\*.json

signals.csv

smart-whale-signals.csv

```



Protected by `.gitignore`.



\---



\## Legacy / auxiliary scripts



The repo also includes earlier wallet-oriented scripts:



```txt

index-smart-wallets.mjs

profile-wallets.mjs

score-smart-whales.mjs

audit-smart-whales.mjs

monitor-smart-whales.mjs

monitor-smart-whales-loop.mjs

monitor-watchlist.mjs

monitor-loop.mjs

```



These may still be useful, but the main current focus is the actor-aware pipeline:



```txt

market

actors

audit:actors

profit:actors

export:final

```



\---



\## Current project direction



The project is moving from:



```txt

token signal generation

```



toward:



```txt

smart-money actor discovery

profit proxy ranking

contract-aware review

wallet / actor cluster analysis

```



Future improvements:



```txt

realized PnL approximation

swap entry and exit analysis

funding source graph

contract creator analysis

contract actor review reports

better Base classification

manual review dashboard

```

