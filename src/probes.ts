import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { retry } from "./rpc.js";

export interface ProbeSpec {
  sendIndex: number;
  priorityFeeMicroLamports: number; // per compute unit
  lamports: number; // UNIQUE per probe — encodes group+index on-chain (see probeGroups)
}

export interface ProbeGroup {
  groupId: string;
  description: string;
  intervalMs: number; // delay between sends (0 = burst)
  probes: ProbeSpec[];
}

const CU_LIMIT = 3_000; // transfer ~150 CU + 2 compute-budget ixs; 400 was too low (found by localnet run: "Computational budget exceeded")

function specs(groupNum: number, n: number, feeFn: (i: number) => number): ProbeSpec[] {
  // lamports MUST be unique per probe: identical (payer, blockhash, ix) bytes
  // produce an identical signature — the "probes" collapse into one tx and
  // the rest are rejected as duplicates (found in devnet run #3).
  return Array.from({ length: n }, (_, i) => ({
    sendIndex: i,
    priorityFeeMicroLamports: feeFn(i),
    lamports: groupNum * 100 + i + 1,
  }));
}

/**
 * Probe groups — one variable changes per group (design doc §2):
 *  A: constant fee, fixed send interval  -> does send order survive?
 *  B: fee ascending with send order     -> can a later, pricier tx jump the queue?
 *  C: constant fee, burst send          -> ordering under simultaneity / path effects
 *  D: exact repeat of A                 -> stability / noise floor
 */
export function probeGroups(n = 8): ProbeGroup[] {
  return [
    { groupId: "A", description: "constant fee, sequential", intervalMs: 150, probes: specs(1, n, () => 1_000) },
    { groupId: "B", description: "fee ascending with send order", intervalMs: 150, probes: specs(2, n, (i) => (i + 1) * 5_000) },
    { groupId: "C", description: "constant fee, burst", intervalMs: 0, probes: specs(3, n, () => 1_000) },
    { groupId: "D", description: "repeat of A (stability)", intervalMs: 150, probes: specs(4, n, () => 1_000) },
  ];
}

/**
 * Group E — the fee-effect microscope: a WIDE geometric fee ladder
 * (500 → ~480k micro-lamports/CU at n=16) sent in ascending order, burst.
 * Run #1 showed position follows fee; E maps HOW MUCH position each fee
 * step buys, with enough probes per block for a real fee→position curve.
 * Even the top rung costs only ~1.4k lamports of priority fee at 3,000 CU.
 */
export function feeLadderGroup(n = 16): ProbeGroup {
  const lo = 500;
  const hi = 480_000;
  const ratio = Math.pow(hi / lo, 1 / Math.max(1, n - 1));
  return {
    groupId: "E",
    description: "fee ascending, wide geometric ladder, burst",
    intervalMs: 0,
    probes: specs(5, n, (i) => Math.round(lo * Math.pow(ratio, i))),
  };
}

/** Estimated total fee in lamports for one probe tx. */
export function estimateFeeLamports(priorityFeeMicroLamports: number): number {
  const priority = Math.ceil((priorityFeeMicroLamports * CU_LIMIT) / 1_000_000);
  return 5_000 + priority; // 5000 = base fee for 1 signature
}

export function buildProbeTxWithBlockhash(
  payer: PublicKey,
  spec: ProbeSpec,
  blockhash: string,
  lastValidBlockHeight: number
): Transaction {
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: spec.priorityFeeMicroLamports }));
  // self-transfer: no external state, minimal contention; amount is unique
  // per probe so every probe is a distinct transaction (see specs()).
  tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: spec.lamports }));
  return tx;
}

export async function buildProbeTx(
  conn: Connection,
  payer: PublicKey,
  spec: ProbeSpec
): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } = await retry(() => conn.getLatestBlockhash("finalized"));
  return buildProbeTxWithBlockhash(payer, spec, blockhash, lastValidBlockHeight);
}

export interface ProbeRecord extends ProbeSpec {
  groupId: string;
  sendWallISO: string;
  sendMonoMs: number;
  signature: string | null;
  slot: number | null;
  feeLamportsActual: number | null;
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SentProbe {
  spec: ProbeSpec;
  est: number;
  sendWallISO: string;
  sendMonoMs: number;
  signature: string | null;
  sendError: string | null;
}

export interface PreparedProbe {
  spec: ProbeSpec;
  est: number;
  raw: Buffer;
  expectedSig: string;
}

/** Reserve budget and pre-sign a whole group on one blockhash. Splitting
 *  preparation from firing is what window-targeted bursts need: everything
 *  is signed BEFORE the leader window opens, so firing is pure network. */
export function prepareGroup(
  payer: Keypair,
  group: ProbeGroup,
  blockhash: string,
  lastValidBlockHeight: number,
  onReserve: (lamports: number) => void
): PreparedProbe[] {
  return group.probes.map((spec) => {
    const est = estimateFeeLamports(spec.priorityFeeMicroLamports);
    onReserve(est); // throws if cap would be breached — before anything is sent
    const tx = buildProbeTxWithBlockhash(payer.publicKey, spec, blockhash, lastValidBlockHeight);
    tx.sign(payer);
    return { spec, est, raw: tx.serialize(), expectedSig: tx.signature ? bs58.encode(tx.signature) : "" };
  });
}

/** Fire prepared probes concurrently (interval groups keep their stagger).
 *  Returns as soon as the sends are accepted/rejected — NO confirmation
 *  waiting, so callers can fire at several leader windows back-to-back and
 *  confirm everything afterwards. */
export async function firePrepared(conn: Connection, prepared: PreparedProbe[], group: ProbeGroup): Promise<SentProbe[]> {
  const fired = prepared.map((p, idx) => {
    const promise = (async (): Promise<SentProbe> => {
      if (group.intervalMs > 0 && idx > 0) await sleep(group.intervalMs * idx);
      const sendWallISO = new Date().toISOString();
      const sendMonoMs = performance.now();
      try {
        const signature = await retry(async () => {
          try {
            return await conn.sendRawTransaction(p.raw, { skipPreflight: false });
          } catch (e) {
            if (e instanceof Error && /already processed/i.test(e.message)) return p.expectedSig;
            throw e;
          }
        });
        return { spec: p.spec, est: p.est, sendWallISO, sendMonoMs, signature, sendError: null };
      } catch (e) {
        return {
          spec: p.spec,
          est: p.est,
          sendWallISO,
          sendMonoMs,
          signature: null,
          sendError: e instanceof Error ? e.message : String(e),
        };
      }
    })();
    return promise;
  });
  return Promise.all(fired);
}

/** Poll signatures to confirmation, fetch actual fees, settle the cap. */
export async function confirmSent(
  conn: Connection,
  sent: SentProbe[],
  groupId: string,
  onSettle: (reserved: number, actual: number) => void
): Promise<ProbeRecord[]> {
  const records: ProbeRecord[] = [];
  for (const s of sent) {
    if (!s.signature) {
      onSettle(s.est, 0);
      records.push({
        ...s.spec,
        groupId,
        sendWallISO: s.sendWallISO,
        sendMonoMs: s.sendMonoMs,
        signature: null,
        slot: null,
        feeLamportsActual: null,
        error: s.sendError,
      });
      continue;
    }
    let slot: number | null = null;
    let txErr: string | null = null;
    for (let i = 0; i < 40 && slot === null; i++) {
      const st = await retry(() => conn.getSignatureStatuses([s.signature as string]));
      const v = st.value[0];
      if (v) {
        slot = v.slot;
        txErr = v.err ? JSON.stringify(v.err) : null;
      } else {
        await sleep(1500);
      }
    }
    let actual = s.est;
    try {
      const meta = await retry(() => conn.getTransaction(s.signature as string, { maxSupportedTransactionVersion: 0 }));
      if (meta?.meta?.fee != null) actual = meta.meta.fee;
    } catch {
      /* keep estimate */
    }
    onSettle(s.est, slot === null ? 0 : actual);
    records.push({
      ...s.spec,
      groupId,
      sendWallISO: s.sendWallISO,
      sendMonoMs: s.sendMonoMs,
      signature: s.signature,
      slot,
      feeLamportsActual: slot === null ? null : actual,
      error: slot === null ? "not confirmed within polling window" : txErr,
    });
  }
  return records;
}

/**
 * Two phases, deliberately:
 *  Phase 1 fires every probe in the group back-to-back (only intervalMs
 *  apart) WITHOUT waiting for confirmations — otherwise each probe lands
 *  in its own slot and there is no within-block ordering left to measure
 *  (exactly what the first devnet run showed: 32 probes, 32 slots).
 *  Phase 2 polls all signatures to confirmation and settles the spend cap.
 */
export async function sendGroup(
  conn: Connection,
  payer: Keypair,
  group: ProbeGroup,
  onReserve: (lamports: number) => void,
  onSettle: (reserved: number, actual: number) => void
): Promise<ProbeRecord[]> {
  // Pre-build & pre-sign the whole group on ONE blockhash (valid ~150
  // slots). Building per-probe inserted an RPC round-trip between sends
  // that alone exceeded a slot time and destroyed co-block landing.
  const { blockhash, lastValidBlockHeight } = await retry(() => conn.getLatestBlockhash("finalized"));
  const prepared = prepareGroup(payer, group, blockhash, lastValidBlockHeight, onReserve);
  const sent = await firePrepared(conn, prepared, group);
  return confirmSent(conn, sent, group.groupId, onSettle);
}
