import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SpendCap } from "./spendcap.js";
import { nextWindows, pickDiverseWindows, pickValidators, waitForSlot, type TargetedWindow } from "./schedule.js";
import { confirmSent, estimateFeeLamports, feeLadderGroup, firePrepared, prepareGroup, probeGroups, sendGroup, type ProbeGroup, type ProbeRecord, type SentProbe } from "./probes.js";
import { retry } from "./rpc.js";
import { locateProbes } from "./blockparse.js";
import { analyze } from "./analyze.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name: string) => args.includes(name);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const cluster = opt("--cluster", "devnet") as "devnet" | "mainnet" | "localnet";
const live = flag("--live");
const capSol = parseFloat(opt("--cap-sol", "0.05"));
const dataDir = process.env.DATA_DIR ?? path.resolve("data");
const rpcUrl =
  process.env.RPC_URL ??
  (cluster === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : cluster === "localnet"
      ? "http://127.0.0.1:8899"
      : "https://api.devnet.solana.com");
const conn = new Connection(rpcUrl, "confirmed");

fs.mkdirSync(path.join(dataDir, "raw"), { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function loadKeypair(): Keypair {
  const p = process.env.KEYPAIR_PATH;
  if (!p) throw new Error("KEYPAIR_PATH not set (keys only via env/volume, never in repo)");
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  if (cmd === "faucet") {
    if (cluster === "mainnet") throw new Error("no faucet on mainnet");
    // note: the public devnet RPC faucet is closed (410) — devnet SOL comes
    // from https://faucet.solana.com (web). localnet validators airdrop freely.
    const kp = loadKeypair();
    console.log("address:", kp.publicKey.toBase58());
    for (let i = 0; i < 3; i++) {
      try {
        const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
        await conn.confirmTransaction(sig, "confirmed");
        console.log("airdrop ok:", sig);
        break;
      } catch (e) {
        console.log("airdrop attempt", i + 1, "failed:", e instanceof Error ? e.message : e);
      }
    }
    console.log("balance SOL:", (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL);
    return;
  }

  if (cmd === "windows") {
    const targets = await pickValidators(conn, 6);
    const slot = await conn.getSlot("finalized");
    const windows = await nextWindows(conn, targets, slot);
    const payload = { cluster, atISO: new Date().toISOString(), currentSlot: slot, targets, windows };
    const file = path.join(dataDir, `windows-${cluster}-${stamp()}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    console.log(JSON.stringify(payload, null, 2));
    console.log("saved:", file);
    return;
  }

  if (cmd === "probe") {
    const probesN = parseInt(opt("--probes", "8"), 10);
    const groups = probeGroups(probesN);
    const totalEst = groups.flatMap((g) => g.probes).reduce((s, p) => s + estimateFeeLamports(p.priorityFeeMicroLamports), 0);
    if (!live) {
      // DRY-RUN: build the full plan, touch nothing on-chain.
      const plan = {
        mode: "dry-run",
        cluster,
        groups: groups.map((g) => ({ groupId: g.groupId, description: g.description, intervalMs: g.intervalMs, probes: g.probes.length })),
        totalProbes: groups.reduce((s, g) => s + g.probes.length, 0),
        estimatedTotalFeeLamports: totalEst,
        capLamports: Math.floor(capSol * LAMPORTS_PER_SOL),
        note: "No transactions sent. Re-run with --live and KEYPAIR_PATH set to execute.",
      };
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    const payer = loadKeypair();
    const balance = await conn.getBalance(payer.publicKey);
    console.log(`payer ${payer.publicKey.toBase58()} balance ${balance / LAMPORTS_PER_SOL} SOL`);
    if (balance < totalEst + 100_000) throw new Error("insufficient balance for planned probes + rent margin");
    const cap = new SpendCap(dataDir, capSol, cluster);

    const runRound = async (windowMeta: TargetedWindow | null, roundIdx: number) => {
      const all: ProbeRecord[] = [];
      for (const g of groups) {
        console.log(`sending group ${g.groupId} (${g.description})...`);
        const recs = await sendGroup(conn, payer, g, (l) => cap.reserve(l), (r, a) => cap.settle(r, a));
        all.push(...recs);
      }
      // save raw send records FIRST: a parse/analyze failure must never lose a run
      const earlyFile = path.join(dataDir, "raw", `records-${cluster}-r${roundIdx}-${stamp()}.json`);
      fs.writeFileSync(earlyFile, JSON.stringify({ cluster, atISO: new Date().toISOString(), payer: payer.publicKey.toBase58(), window: windowMeta, records: all }, null, 2));
      console.log("raw records saved:", earlyFile);
      const positioned = await locateProbes(conn, all);
      const stats = analyze(positioned);
      const payload = { cluster, atISO: new Date().toISOString(), payer: payer.publicKey.toBase58(), window: windowMeta, records: positioned, stats };
      const file = path.join(dataDir, "raw", `run-${cluster}-r${roundIdx}-${stamp()}.json`);
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      console.log(JSON.stringify(stats, null, 2));
      console.log("saved:", file);
    };

    const burstN = parseInt(opt("--burst-windows", "0"), 10);
    if (burstN > 0) {
      // BURST mode — the fix for run #1's targeting miss: ONE group per
      // leader window, group pre-signed ~90 slots ahead, fired the slot
      // before the window opens, and ALL confirmation deferred until every
      // window has been fired at. Nothing may wait between windows.
      const { windows } = await pickDiverseWindows(conn, burstN, 90);
      if (!windows.length) throw new Error("no suitable leader windows found");
      console.log("burst target windows:", windows.map((w) => `${w.identity.slice(0, 8)}@${w.startSlot} (${w.clientHint})`).join(", "));
      // Plan: "rotate" cycles A/B/C/D; "fee-heavy" spends most windows on
      // the wide fee ladder (E) with A/C as equal-fee controls — the
      // optimal allocation once run #1 showed fee is the active variable.
      const planName = opt("--plan", "rotate");
      const planGroups: ProbeGroup[] = windows.map((_, i) => {
        if (planName === "fee-heavy") {
          const pattern = [feeLadderGroup(probesN), feeLadderGroup(probesN), groups[2], feeLadderGroup(probesN), feeLadderGroup(probesN), groups[0]];
          return pattern[i % pattern.length];
        }
        return groups[i % groups.length];
      });
      const firedRounds: { window: TargetedWindow; groupId: string; sent: SentProbe[] }[] = [];
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        const group = planGroups[i];
        await waitForSlot(conn, w.startSlot - 90);
        const { blockhash, lastValidBlockHeight } = await retry(() => conn.getLatestBlockhash("finalized"));
        const prepared = prepareGroup(payer, group, blockhash, lastValidBlockHeight, (l) => cap.reserve(l));
        console.log(`burst ${i + 1}/${windows.length}: group ${group.groupId} -> leader ${w.identity.slice(0, 8)} slots ${w.startSlot}-${w.endSlot} (${w.clientHint})`);
        // Fire BEFORE the window opens: nodes forward transactions to the
        // upcoming leader, and the sender→RPC→leader path eats several
        // slots (devnet smoke: firing at start-1 landed at end..end+5;
        // start-5 centers the burst on the window).
        const FIRE_LEAD_SLOTS = 5;
        await waitForSlot(conn, w.startSlot - FIRE_LEAD_SLOTS);
        const sent = await firePrepared(conn, prepared, group);
        const firedFile = path.join(dataDir, "raw", `fired-${cluster}-b${i + 1}-${stamp()}.json`);
        fs.writeFileSync(firedFile, JSON.stringify({ cluster, atISO: new Date().toISOString(), payer: payer.publicKey.toBase58(), window: w, groupId: group.groupId, sent }, null, 2));
        console.log("fired, raw saved:", firedFile);
        firedRounds.push({ window: w, groupId: group.groupId, sent });
      }
      console.log("all windows fired — confirming and analyzing...");
      for (let i = 0; i < firedRounds.length; i++) {
        const fr = firedRounds[i];
        const recs = await confirmSent(conn, fr.sent, fr.groupId, (r, a) => cap.settle(r, a));
        const positioned = await locateProbes(conn, recs);
        const stats = analyze(positioned);
        const payload = { cluster, atISO: new Date().toISOString(), payer: payer.publicKey.toBase58(), window: fr.window, records: positioned, stats };
        const file = path.join(dataDir, "raw", `run-${cluster}-b${i + 1}-${stamp()}.json`);
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
        console.log(JSON.stringify(stats, null, 2));
        console.log("saved:", file);
      }
    } else if (parseInt(opt("--windows", "0"), 10) > 0) {
      const rounds = parseInt(opt("--windows", "0"), 10);
      // Window-targeted measurement: one full probe plan per leader window,
      // windows chosen for validator + client diversity (see schedule.ts).
      const { windows } = await pickDiverseWindows(conn, rounds);
      if (!windows.length) throw new Error("no suitable leader windows found");
      console.log("target windows:", windows.map((w) => `${w.identity.slice(0, 8)}@${w.startSlot} (${w.clientHint})`).join(", "));
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        console.log(`waiting for window ${i + 1}/${windows.length}: leader ${w.identity.slice(0, 8)} slots ${w.startSlot}-${w.endSlot} (${w.clientHint})`);
        await waitForSlot(conn, w.startSlot - 2); // fire just before the window opens
        await runRound(w, i + 1);
      }
    } else {
      await runRound(null, 0);
    }
    return;
  }

  if (cmd === "analyze") {
    const file = opt("--file", "");
    if (!file) throw new Error("usage: analyze --file data/raw/run-....json");
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const stats = analyze(payload.records);
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log("commands: faucet | windows --cluster <devnet|mainnet> | probe [--live] --cluster <...> | analyze --file <...>");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
