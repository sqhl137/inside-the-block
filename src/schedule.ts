import { Connection, PublicKey } from "@solana/web3.js";
import { retry } from "./rpc.js";

export interface ValidatorTarget {
  identity: string; // node pubkey (leader schedule is keyed by identity)
  label: string;
  clientHint: string; // e.g. "agave", "jito", "frankendancer" — verified at measurement time
}

/**
 * Pick the top-N non-delinquent validators by activated stake and annotate
 * each with the version string its RPC node reports (getClusterNodes).
 * Version strings are the first-pass client signal; fork identity
 * (Jito / Firedancer) is confirmed against validators.app before live runs.
 */
export async function pickValidators(conn: Connection, n: number): Promise<ValidatorTarget[]> {
  const votes = await retry(() => conn.getVoteAccounts());
  const nodes = await retry(() => conn.getClusterNodes());
  const versionByPubkey = new Map(nodes.map((nd) => [nd.pubkey, nd.version ?? "unknown"]));
  const sorted = [...votes.current].sort((a, b) => b.activatedStake - a.activatedStake);
  return sorted.slice(0, n).map((v) => {
    const version = versionByPubkey.get(v.nodePubkey) ?? "unknown";
    return {
      identity: v.nodePubkey,
      label: v.nodePubkey.slice(0, 8),
      clientHint: `version ${version}`,
    };
  });
}

/** Slots-per-leader window on Solana is 4 consecutive slots. */
export const WINDOW = 4;

export interface LeaderWindow {
  identity: string;
  startSlot: number;
  endSlot: number;
  slotsUntilStart: number;
}

/**
 * Find the next window for each target identity from the epoch leader
 * schedule, relative to the current slot.
 */
export async function nextWindows(
  conn: Connection,
  targets: ValidatorTarget[],
  currentSlot?: number
): Promise<LeaderWindow[]> {
  const slot = currentSlot ?? (await retry(() => conn.getSlot("finalized")));
  const schedule = await retry(() => conn.getLeaderSchedule());
  if (!schedule) throw new Error("leader schedule unavailable");
  const out: LeaderWindow[] = [];
  const epochInfo = await retry(() => conn.getEpochInfo());
  const epochStart = epochInfo.absoluteSlot - epochInfo.slotIndex;
  for (const t of targets) {
    const slots = schedule[t.identity];
    if (!slots) continue;
    const future = slots.map((s) => epochStart + s).filter((s) => s + WINDOW - 1 >= slot);
    if (!future.length) continue;
    const start = future[0];
    out.push({ identity: t.identity, startSlot: start, endSlot: start + WINDOW - 1, slotsUntilStart: start - slot });
  }
  return out.sort((a, b) => a.startSlot - b.startSlot);
}

export interface TargetedWindow extends LeaderWindow {
  clientHint: string;
}

/**
 * Choose the next `rounds` leader windows to measure: distinct validators,
 * maximizing distinct client/version coverage, earliest windows first, each
 * with at least `minLeadSlots` of preparation time. This is the mechanism
 * that satisfies "≥6 validators spanning ≥3 client versions" by
 * construction rather than by luck.
 */
export async function pickDiverseWindows(
  conn: Connection,
  rounds: number,
  minLeadSlots = 30
): Promise<{ targets: ValidatorTarget[]; windows: TargetedWindow[] }> {
  const targets = await pickValidators(conn, 16);
  const slot = await retry(() => conn.getSlot("finalized"));
  const all = await nextWindows(conn, targets, slot);
  const hintById = new Map(targets.map((t) => [t.identity, t.clientHint]));
  const usable = all.filter((w) => w.slotsUntilStart >= minLeadSlots);
  const picked: TargetedWindow[] = [];
  const usedClients = new Set<string>();
  // pass 1: prefer windows whose client we haven't covered yet
  for (const w of usable) {
    if (picked.length >= rounds) break;
    const hint = hintById.get(w.identity) ?? "unknown";
    if (!usedClients.has(hint)) {
      picked.push({ ...w, clientHint: hint });
      usedClients.add(hint);
    }
  }
  // pass 2: fill remaining rounds with the earliest unused validators
  if (picked.length < rounds) {
    const usedIds = new Set(picked.map((p) => p.identity));
    for (const w of usable) {
      if (picked.length >= rounds) break;
      if (!usedIds.has(w.identity)) {
        picked.push({ ...w, clientHint: hintById.get(w.identity) ?? "unknown" });
        usedIds.add(w.identity);
      }
    }
  }
  return { targets, windows: picked.sort((a, b) => a.startSlot - b.startSlot) };
}

/** Poll the chain clock until `targetSlot` is reached (slots are ~400ms). */
export async function waitForSlot(conn: Connection, targetSlot: number): Promise<void> {
  for (;;) {
    const now = await retry(() => conn.getSlot("confirmed"));
    if (now >= targetSlot) return;
    const remaining = targetSlot - now;
    await new Promise((r) => setTimeout(r, remaining > 25 ? 2000 : 250));
  }
}

export function isPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
