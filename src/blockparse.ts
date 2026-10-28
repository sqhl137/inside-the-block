import { Connection } from "@solana/web3.js";
import type { ProbeRecord } from "./probes.js";
import { retry } from "./rpc.js";

export interface PositionedProbe extends ProbeRecord {
  blockIndex: number | null; // index inside the block's transaction list
  blockTxCount: number | null;
}

/**
 * Locate each of our signatures inside its block. Conclusions are drawn
 * ONLY from our own transactions (per bounty rules); other transactions
 * in the block are background, never evidence.
 */
export async function locateProbes(conn: Connection, records: ProbeRecord[]): Promise<PositionedProbe[]> {
  const bySlot = new Map<number, ProbeRecord[]>();
  for (const r of records) {
    if (r.slot != null && r.signature) {
      const arr = bySlot.get(r.slot) ?? [];
      arr.push(r);
      bySlot.set(r.slot, arr);
    }
  }
  const indexBySig = new Map<string, { index: number; count: number }>();
  for (const [slot, recs] of bySlot) {
    const block = await retry(() =>
      conn.getBlock(slot, {
        // devnet/mainnet blocks now contain v1 transactions; 0 makes the
        // RPC reject the whole block (found in the first devnet run)
        maxSupportedTransactionVersion: 1,
        transactionDetails: "full",
        rewards: false,
      })
    );
    if (!block) continue;
    const wanted = new Set(recs.map((r) => r.signature));
    block.transactions.forEach((tx, i) => {
      const sig = tx.transaction.signatures[0];
      if (wanted.has(sig)) indexBySig.set(sig, { index: i, count: block.transactions.length });
    });
  }
  return records.map((r) => {
    const hit = r.signature ? indexBySig.get(r.signature) : undefined;
    return { ...r, blockIndex: hit?.index ?? null, blockTxCount: hit?.count ?? null };
  });
}
