/**
 * Convert a base58 private key (e.g. Phantom → Settings → Export Private Key)
 * into the Solana CLI JSON keypair format this harness loads.
 *
 * SECURITY: run this ONLY on your own machine. The key is typed into a
 * hidden local prompt, written to keys/mainnet.json, and never printed,
 * logged, or sent anywhere. Never paste a private key or seed phrase into
 * any chat — including to an AI assistant.
 *
 * Usage: npm run import-key [-- --expect <your-public-address>]
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function promptHidden(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // mute echo of typed characters
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  process.stdout.write(query);
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main() {
  const expectIdx = process.argv.indexOf("--expect");
  const expect = expectIdx >= 0 ? process.argv[expectIdx + 1] : null;
  const b58 = await promptHidden("Paste your base58 private key (input hidden): ");
  if (!b58) throw new Error("empty input");
  let secret: Uint8Array;
  try {
    secret = bs58.decode(b58);
  } catch {
    throw new Error("input is not valid base58");
  }
  if (secret.length !== 64) throw new Error(`expected a 64-byte secret key, got ${secret.length} bytes`);
  const kp = Keypair.fromSecretKey(secret);
  const address = kp.publicKey.toBase58();
  if (expect && expect !== address) {
    throw new Error(`address mismatch: key belongs to ${address}, expected ${expect} — nothing written`);
  }
  const out = path.resolve("keys", "mainnet.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(Array.from(secret)), { mode: 0o600 });
  console.log("keypair written to keys/mainnet.json for address:", address);
  console.log("Verify this is the wallet you funded. Delete the exported key text from your clipboard now.");
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
