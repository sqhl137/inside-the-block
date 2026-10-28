/**
 * Fallback importer for Phantom UI versions that only expose the recovery
 * phrase: derive the account keypair from a 12/24-word mnemonic LOCALLY
 * (Phantom derivation path m/44'/501'/i'/0', account indices 0..9 are tried)
 * and write the standard JSON keypair file — but ONLY when the derived
 * address matches --expect, so a wrong phrase/path can never write a
 * wrong key.
 *
 * SECURITY: run ONLY on your own machine. The phrase is typed into a
 * hidden local prompt and never printed, logged, or sent anywhere.
 * Never type your recovery phrase into any website or chat.
 *
 * Usage: npm run import-seed -- --expect <your-public-address>
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Keypair } from "@solana/web3.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { derivePath } from "ed25519-hd-key";

function promptHidden(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  process.stdout.write(query);
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim().replace(/\s+/g, " "));
    });
  });
}

async function main() {
  const expectIdx = process.argv.indexOf("--expect");
  const expect = expectIdx >= 0 ? process.argv[expectIdx + 1] : null;
  if (!expect) throw new Error("--expect <address> is required (safety check)");
  const phrase = await promptHidden("Type your recovery phrase (input hidden): ");
  const words = phrase.split(" ").filter(Boolean);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(`expected 12 or 24 words, got ${words.length} — nothing written`);
  }
  const seed = mnemonicToSeedSync(phrase);
  for (let i = 0; i < 10; i++) {
    const p = `m/44'/501'/${i}'/0'`;
    const { key } = derivePath(p, Buffer.from(seed).toString("hex"));
    const kp = Keypair.fromSeed(key);
    if (kp.publicKey.toBase58() === expect) {
      const out = path.resolve("keys", "mainnet.json");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
      console.log(`match at account index ${i} (${p})`);
      console.log("keypair written to keys/mainnet.json for address:", expect);
      return;
    }
  }
  throw new Error("no account index 0..9 derives your address from that phrase — nothing written");
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
