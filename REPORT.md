# Report — Inside the Block (working draft)

## Measurement rounds

| Date | Cluster | Purpose | Result |
|---|---|---|---|
| 2026-10-28 | localnet (Agave 2.0.24 test-validator) | pipeline: probe build/simulate path against a live validator | build+simulate path exercised for all 32 probes (found & fixed the CU bug); sustained send rounds blocked by sandbox (see “what went wrong” #4) → validation moves to devnet |
| 2026-10-28 | devnet | end-to-end with real network path | **passed** — run #4: 32 records, 32 unique signatures, 0 errors, 0.00016 SOL fees; 10 (group, slot) buckets with ≥2 probes in one block and discriminating pair metrics (see below); runs #1–#3 caught three measurement-destroying bugs (see “what went wrong” #6–#9) |
| — | mainnet | dry-run plan + leader-window computation | plan/cost verified; window computation needs a dedicated RPC (public endpoints time out on getVoteAccounts/getLeaderSchedule from this network) |
| 2026-10-28 | mainnet | live measurement run #1, 6 rounds × 32 probes | **192/192 probes landed, 0 errors, total fees 0.000964 SOL** (cap 0.05). Window targeting missed in practice (see “what went wrong” #11); every probe was re-attributed to its block's *actual* leader via the epoch-1070 leader schedule, yielding an observational sample across **48 distinct leaders** (162 probes under leaders reporting version 4.3.2, 24 under 26.10.4, 6 other). Results below. |
| 2026-10-28 | mainnet | live measurement run #2 (burst mode, the #11 fix): 8 windows × 1 pre-signed group, fired 5 slots early, confirmation deferred | **64/64 probes landed, 0 errors, 0.000321 SOL.** Targeting measurably improved — 9/64 in-window and 24/64 within ±8 slots (vs 0/192 in-window in run #1) — but remained unreliable from a residential connection via a shared RPC: path-latency variance, not the firing logic, is the binding constraint (see #11). One further independent fee-effect bucket at Spearman −1. Combined dataset: 256 probes, 0.001285 SOL total. |
| 2026-10-28 | mainnet | live measurement run #3: 11 windows × 8 probes, A–D rotation (an intended fee-heavy run that executed the previous build on the sender's machine — kept and pooled as additional A–D control data; the mixup is visible in the raw files' group composition) | 88/88 landed, 0 errors, 0.000442 SOL. |
| 2026-10-28 | mainnet | live measurement run #4 (fee-heavy): 12 windows × 16 probes — 8 windows of the new **group E wide fee ladder** (500 → 480,000 micro-lamports/CU, geometric, 16 rungs) + A/C controls | **192/192 landed, 0 errors, 0.000992 SOL.** Group E produced the report's central result: a monotone fee→position dose–response (§6). **Dataset total: 536 probes, 536 landed, 0 failures, 0.002718 SOL all-in.** |

## Devnet round — findings (pipeline validation only)

Devnet has a single client implementation in practice and far emptier blocks
than mainnet, so **no ordering conclusions are drawn from it**. What it proved,
beyond the localnet round:

- the full network path works unattended: send → confirm (HTTP polling) →
  locate every probe inside its block → per-(group, slot) pair metrics;
- the spend cap held across all runs (devnet ledger total 0.00064 SOL vs the
  0.05 cap) and every raw run is preserved under `data/raw/`;
- the metrics discriminate: run #4 preservation rates spread across
  0 / 0.5 / 0.667 / 1.0 rather than pinning at an artifact value, and
  constant-fee groups correctly report a null fee correlation.

## Localnet round — findings (pipeline validation only)

Localnet has exactly one validator and near-empty blocks, so **no ordering
conclusions are drawn from it** (per the bounty: devnet/localnet prove the
pipeline, mainnet is where measurement happens). What it proved:

- probe construction, spend-cap accounting, block parsing and the metrics
  module all run end-to-end unattended;
- raw records (signature, slot, block index, fees, send timestamps) are
  written for every probe — see `data/raw/run-localnet-*.json`.

## What went wrong (honest log)

1. **Agave 4.3.2 test-validator cannot start in this sandbox** — panics with
   `assertion failed: io_uring_supported()` (io_uring is seccomp-blocked).
   Pinned Agave **2.0.24** for local work instead; the harness itself is
   client-version agnostic.
2. **CU limit 400 was too small** — first live run failed every probe with
   "Computational budget exceeded" (the two ComputeBudget instructions plus
   the transfer exceed 400 CU). Raised to 3,000 CU; priority-fee cost impact
   is negligible (<100 lamports/probe at our prices).
3. **Public devnet RPC faucet is closed** (HTTP 410 from
   `requestAirdrop`); localnet faucet also returned Internal error under
   this sandbox, so localnet funding uses a genesis `--account` file
   (10 SOL test funds) instead.
4. **Localnet cannot stay up in this sandbox — root cause established.**
   The test-validator *wrapper* must discover its own node via UDP gossip;
   this sandbox intermittently returns EPERM on UDP sends, so discovery
   eventually fails ("Discover failed") and the wrapper kills the validator
   child — sometimes at startup, sometimes minutes in, after RPC already
   served traffic. Two other local routes are also sandbox-blocked:
   Agave 4.3.2 panics on `io_uring_supported()` (seccomp), and a direct
   `agave-validator` cannot raise its fd limit (hard limit 4096).
   Conclusion: local validation moves to **devnet** (same code path,
   real network); localnet remains the documented first step on any
   normal machine (Docker compose reproduces it there).
5. **Public mainnet RPC is not enough for the schedule step** —
   `getVoteAccounts`/`getLeaderSchedule` time out from this network.
   Live stage will use a dedicated RPC endpoint (standard practice; the
   endpoint is configurable via `RPC_URL`).
6. **Per-probe blockhash fetches destroyed co-block landing (devnet run #1).**
   Building each probe with its own `getLatestBlockhash` round-trip inserted
   >1 slot of latency between sends, so 32 probes landed in 32 different
   slots and there was nothing to measure. Fix: one blockhash per group,
   pre-build/pre-sign everything, fire sends concurrently.
7. **`getBlock` rejects blocks containing v1 transactions** when
   `maxSupportedTransactionVersion: 0` (devnet run #2): all sends succeeded,
   then the parse phase crashed *before saving anything* and the run was
   lost. Two fixes: request version 1, and save raw send-records to disk
   *before* parsing — a later failure can never lose a completed run again.
8. **Identical transactions collapse into one (devnet run #3, the expensive
   lesson).** Probes were byte-identical within constant-fee groups (same
   payer, blockhash, instructions, 1-lamport self-transfer), hence had
   identical signatures: the “8 probes in one block, preservation 0” result
   was one transaction located 8 times, and sibling copies were rejected as
   “already processed”. Fix: the transfer amount encodes group+index
   (101…408 lamports), making every probe a distinct, on-chain-identifiable
   transaction.
9. **Spearman on tied values fabricates correlation.** Constant-fee groups
   reported fee↔position ρ = 1 because tied fees were assigned distinct
   ranks. Fix: average ranks for ties; correlation against a constant
   returns null. (A metric that always answers “1” is worse than no metric.)
10. **The sandbox egress proxy intermittently drops RPC requests**
    (“fetch failed”) and websocket subscriptions are unreliable through it:
    all RPC calls now go through an exponential-backoff retry wrapper
    (resending identical raw bytes is idempotent), and confirmation uses
    HTTP polling of `getSignatureStatuses` instead of websockets.
11. **Window targeting failed in the mainnet run — and the data says so.**
    The design aimed each 32-probe round at one leader's 4-slot window
    (1.6 s). In practice **0 of 192 probes landed inside the targeted
    window** and only 10 landed under the targeted leader at all: a round's
    four groups fire sequentially with confirmation polling between them
    (~60 s per round), so groups B–D fired long after the window closed,
    and even group A's path latency (sender → RPC → forwarding) usually
    missed a 1.6 s slot range. Probes spread across **48 actual leaders**.
    Consequences, handled rather than hidden: (a) all analysis attributes
    probes to their block's *actual* leader from the epoch schedule;
    (b) per-validator claims were dropped — samples per leader are too
    thin; (c) the pooled and per-family conclusions stand, because they
    only need co-block probe pairs, not window precision. The fix for a
    follow-up run is clear: one probe group per window, all four groups
    pre-signed before the window, and confirmation deferred until after
    the last group fires. We report the miss because “the probes went to
    the leader we aimed at” is exactly the kind of unverified assumption
    this bounty exists to test.
    **Fix attempted (run #2, same day):** burst mode implemented exactly
    as above, plus firing 5 slots before the window (devnet smoke test:
    in-window hits improved 1/8 → 6/8). On mainnet it helped but did not
    solve targeting: 9/64 probes in-window, 24/64 within ±8 slots, the
    rest scattered by path-latency spikes of 10–40 slots on a residential
    connection via a shared free-tier RPC. Conclusion #4 records the
    consequence. The remaining lever is sender placement (co-located /
    dedicated ingest such as staked connections), which a follow-up study
    with a VPS next to major validator regions could close.

## Mainnet results (2026-10-28, epoch 1070)

Sample: 192 self-transfer probes in 4 designs (A: constant fee, 150 ms spacing ·
B: priority fee ascending with send order · C: constant fee, burst ·
D: exact repeat of A), fired from a single sender in 6 rounds; all 192 landed
and were located inside their blocks (`data/raw/run-mainnet-r1..r6*.json`).
Blocks were real mainnet blocks: 69–1,002 transactions each (median 346).
Attribution to actual block producers: `data/raw/attribution-mainnet-2026-10-28.json`
(leader schedule for epoch 1070 + `getClusterNodes` version strings).
Comparable pairs = pairs of probes from the same group that landed in the
same block (177 pairs total).

### 1. At equal priority fee, send order does not survive (≈ coin flip)

| Group | Design | Pairs | Preserved | Rate |
|---|---|---|---|---|
| A | constant fee, sequential | 29 | 13 | 0.45 |
| C | constant fee, burst | 72 | 41 | 0.57 |
| D | constant fee, sequential (repeat) | 37 | 13 | 0.35 |
| **A+C+D pooled** | | **138** | **67** | **0.49** |

Pooled preservation is 0.49 ± 0.04 — indistinguishable from chance. The two
identical designs (A vs D) differ by 0.10 with ~30 pairs each, which is the
empirical noise floor of this instrument at this sample size; any claimed
per-validator effect smaller than that needs more data than one window
provides. Whatever ordering an equal-fee transaction receives is decided by
factors other than the sender's emission order (arrival jitter across the
sender→RPC→leader path is one candidate we cannot separate — see §5).

### 2. Priority fee overrides send order when the two conflict

Group B sent probes with fees ascending 5k→40k micro-lamports/CU, so the
last-sent probe paid 8× the first. Send-order preservation fell to **0.28
(11/39)** — the lowest of all groups — and in every bucket with ≥3 co-block
probes, the Spearman correlation between fee and block position was negative
(−1, −1, −0.5, −0.89, 0 across buckets): higher fee → earlier block
position, against send order. Split by the actual leader's reported version,
the effect was stronger in 26.10.4 blocks (preservation 0.13, 2/15) than in
4.3.2 blocks (0.38, 9/24); the 26.10.4 subsample is small, so we report this
as a direction to test with a larger sample, not a settled difference.

### 3. No baseline ordering difference between version families

Across all groups, preservation in blocks produced by leaders reporting
version 4.3.2 was 0.417 (53/127) vs 0.478 (22/46) for 26.10.4 — confidence
intervals overlap widely; **we do not claim a client difference in baseline
ordering** from this sample. (Version strings are what each node's RPC
reports; they are a proxy for, not proof of, the consensus client build.)

### 4. Run #2 (burst mode) and pooled numbers

Run #2 (`data/raw/run-mainnet-b1..b8*.json`, attribution in the same files'
window fields + epoch schedule) fired one pre-signed group per window at
8 different leaders. Pooled across both runs:

- **Equal-fee designs (A+C+D): 85/172 pairs preserved = 0.49** — run #2
  independently reproduces run #1's coin-flip result (18/34).
- **Fee-ascending design (B): 11/45 pairs preserved = 0.24**, and run #2
  added a second independent co-block bucket with fee↔position Spearman
  exactly **−1** (highest fee earliest, no exceptions in that block).
- In the one clean targeted block of run #2 (group C, 4 probes inside the
  target leader's window), send order was fully reversed (0/6 pairs) —
  a single block, reported as an anecdote consistent with §1, not a
  per-validator claim.

### 5. What this measurement does *not* separate

- **Sender-path jitter vs leader behavior.** Our probes traverse a public
  internet path to one RPC endpoint, then forwarding. At equal fees the
  observed scramble could be produced before the leader ever sees the
  transactions. Separating these needs co-located senders or leader-side
  arrival data we do not have.
- **Jito bundles/tips** — out of scope by design; all probes are plain
  priority-fee transactions.
- **Per-validator signatures.** With window targeting ineffective (#11),
  per-leader samples are thin (top leader: 18 probes). One round's raw
  stats suggested a 0.70-preservation leader; after actual-leader
  attribution that effect disappeared — it belonged to other leaders'
  blocks. We treat it as a cautionary artifact, not a finding.

### 6. The fee ladder (group E): a dose–response curve

Run #4 added design **E**: 16 probes fired as one burst with priority fees
on a geometric ladder from **500 to 480,000 micro-lamports/CU** (≈1000×),
cheapest sent first. If position ignored fee, send-order preservation
would again be ≈0.5. Instead:

- **Send-order preservation in E: 0.09 (9/100 pairs)** — block position
  almost perfectly *reverses* send order; the last-sent, most expensive
  probes land first.
- **13 of E's co-block buckets (≥4 probes) have a fee↔position Spearman
  of −1 in 9 cases**, −0.8 and −0.5 in two more (one +0.5 outlier bucket
  of 4 probes is reported, not hidden).
- **Dose–response**: pooling E's buckets, mean normalized block position
  by fee rung falls monotonically from **1.00 at 500 micro-lamports/CU
  (latest) to 0.00 at 480,000 (earliest)** — see
  `assets/fee-curve.png`. Position is not a binary “paid / not paid”
  effect: each fee step buys a measurably earlier slot in the block,
  with the steepest gains between ~10k and ~200k micro-lamports/CU in
  this sample.
- Final pooled numbers across all four runs (536 probes):
  equal-fee designs (A+C+D) **0.53 preserved (127/240 pairs)** — subgroup
  rates straddle 0.5 (0.40–0.56), i.e. no practically meaningful
  send-order effect; fee-ascending designs (B+E) **0.13 preserved
  (20/152 pairs)** — position follows fee, decisively.

## Mainnet conclusions

1. **Send order is not a lever** at equal priority fee: across 48+ leaders
   and four runs, equal-fee preservation is 0.53 over 240 pairs with
   subgroup rates straddling chance — any send-order effect is small
   next to measurement noise, and dwarfed by the fee effect.
2. **Priority fee is *the* lever, and it is graded, not binary**: when
   fee order opposes send order, position follows fee (0.13 pooled
   preservation, n=152); the wide ladder shows a monotone dose–response
   from latest-in-block at 500 micro-lamports/CU to earliest at 480,000
   (group E preservation 0.09; 9 buckets at Spearman exactly −1).
   A sender who wants early placement should spend on fee, not on
   emission timing.
3. **Client/version claims need bigger samples**: the only family-level
   signal (stronger fee effect in 26.10.4 blocks) rests on 15 pairs. The
   harness is built to scale this: more windows is a configuration
   change, not new code.
4. **Window-precise targeting needs a better seat**: from a residential
   connection through a shared RPC, even a pre-signed, early-fired burst
   lands in-window only ~4–14% of the time — the variance of the
   sender→RPC→leader path exceeds a 1.6 s window. Controlled per-leader
   experiments of this kind require a co-located or dedicated-ingest
   sender; we quantify the effect instead of pretending otherwise.

## Appendix — per-leader descriptive table (all runs pooled)

Actual block producers (epoch-1070 leader schedule) with ≥8 probes landed in their blocks.
Descriptive only: per-leader pair counts are small and mix designs, so no per-validator
ordering verdict is drawn from this table — the pooled results above are the findings.

| Leader (identity) | Reported version | Probes | Blocks | Co-block pairs | Send-order preserved |
|---|---|---|---|---|---|
| C8Bey3LKVJHVqN6xPTeW8WJfUgFQAeGNBpT4Rp99JP1k | 4.3.2 | 33 | 18 | 18 | 0.39 (7/18) |
| DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy | 4.3.2 | 31 | 14 | 36 | 0.42 (15/36) |
| E1r4Psq84tHfQ6aPTvvDka4U3u8zPVD7gEUrH25RdxHL | 4.3.2 | 20 | 11 | 14 | 0.50 (7/14) |
| HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU | 4.3.2 | 17 | 14 | 3 | 0.67 (2/3) |
| Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk | 4.3.2 | 17 | 10 | 12 | 0.67 (8/12) |
| JUPiTERrZqgf1jUyR7dSkhMx4Kn2qJyekWsg3LT1h4b | 26.10.4 | 14 | 2 | 43 | 0.49 (21/43) |
| GBQ2GvTzmjXMu97dr7WUnLKYTNim1aoZsYS53KYXAAAA | 4.3.2 | 12 | 3 | 22 | 0.09 (2/22) |
| GSTampk6BJRKSDkzhaMM49R7qRx98MTPYYWvKbp83XKc | 4.3.2 | 12 | 8 | 6 | 0.17 (1/6) |
| 6y7V8dL673XFzm9QyC5vvh3itWkp7wztahBd2yDqsyrK | 4.3.2 | 11 | 6 | 4 | 0.75 (3/4) |
| 2GUnfxZavKoPfS9s3VSEjaWDzB3vNf5RojUhprCS1rSx | 4.3.2 | 11 | 4 | 10 | 0.30 (3/10) |
| 9jxgosAfHgHzwnxsHw4RAZYaLVokMbnYtmiZBreynGFP | 26.10.4 | 10 | 7 | 3 | 0.33 (1/3) |
| HLnodbYkL5PFA8hjAZDkm5pGzV7eLTvcs671AW2L6St9 | 4.3.2 | 9 | 2 | 16 | 0.50 (8/16) |
| Ninja1spj6n9t5hVYgF3PdnYz2PLnkt7rvaw3firmjs | 4.3.2 | 9 | 5 | 7 | 0.00 (0/7) |
| 9UM8wQ8F5oMiRcP5YdqD6Lr4krpBWCD8LtgQYoisJd9i | 4.3.2 | 8 | 5 | 2 | 1.00 (2/2) |
| GzDfKKoZ6E8ReqKfH96k5bkmA6CEWtnUrQnZjSqW4ZzG | 4.3.2 | 8 | 7 | 1 | 1.00 (1/1) |
| BUv44cVtsdvU9z2BfFGk6s5JZZWrmVnq5qCaii5ARyyB | 4.3.2 | 8 | 4 | 7 | 0.57 (4/7) |
| Fc6NNdS2j3EmrWbU6Uqt6wsKB5ef72NjaWfNxKYbULGD | 4.3.2 | 8 | 8 | 0 | — |
| HpcB5Qg8Y9E73dUkot5e8HkgAJbExsYeUzniY4bCuKac | 4.3.2 | 8 | 4 | 3 | 0.33 (1/3) |
| A1vqhA2fS6K7CvHsJKX1ACcHJFEmyRg4KuR5pctHANy4 | 4.3.2 | 8 | 4 | 6 | 0.17 (1/6) |
