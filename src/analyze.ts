import type { PositionedProbe } from "./blockparse.js";

export interface GroupStats {
  groupId: string;
  slot: number | null;
  landed: number;
  pairsTotal: number;
  pairsPreserved: number;
  preservationRate: number | null; // share of send-order pairs kept in block order
  feePositionSpearman: number | null; // fee rank vs block-position rank
}

function ranks(values: number[]): number[] {
  // average ranks for ties — assigning distinct ranks to equal values
  // fabricates a perfect correlation out of thin air (constant-fee groups!)
  const sorted = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(0);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) out[sorted[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

function hasVariance(values: number[]): boolean {
  return values.some((v) => v !== values[0]);
}

function spearman(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  if (!hasVariance(a) || !hasVariance(b)) return null; // correlation with a constant is meaningless
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/**
 * Per (group, slot): how much of the send order survived into block order,
 * and whether priority fee explains position. Cross-slot groups are split
 * by slot — ordering claims only make sense inside one block.
 */
export function analyze(records: PositionedProbe[]): GroupStats[] {
  const key = (r: PositionedProbe) => `${r.groupId}|${r.slot}`;
  const buckets = new Map<string, PositionedProbe[]>();
  for (const r of records) {
    const arr = buckets.get(key(r)) ?? [];
    arr.push(r);
    buckets.set(key(r), arr);
  }
  const out: GroupStats[] = [];
  for (const [k, recs] of buckets) {
    const [groupId] = k.split("|");
    const landed = recs.filter((r) => r.blockIndex != null).sort((a, b) => a.sendIndex - b.sendIndex);
    let total = 0;
    let preserved = 0;
    for (let i = 0; i < landed.length; i++) {
      for (let j = i + 1; j < landed.length; j++) {
        total++;
        if ((landed[i].blockIndex as number) < (landed[j].blockIndex as number)) preserved++;
      }
    }
    out.push({
      groupId,
      slot: landed[0]?.slot ?? recs[0]?.slot ?? null,
      landed: landed.length,
      pairsTotal: total,
      pairsPreserved: preserved,
      preservationRate: total ? preserved / total : null,
      feePositionSpearman: spearman(
        landed.map((r) => r.priorityFeeMicroLamports),
        landed.map((r) => r.blockIndex as number)
      ),
    });
  }
  return out.sort((a, b) => a.groupId.localeCompare(b.groupId));
}
