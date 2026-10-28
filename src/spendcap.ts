import fs from "node:fs";
import path from "node:path";

/**
 * Hard spend cap. The bounty budget is ~0.05 SOL for the whole measurement.
 * Every live send must be accounted BEFORE broadcasting: estimated fee is
 * reserved, actual fee is settled after confirmation. If the reservation
 * would breach the cap, the send is refused. State persists on disk so
 * separate runs share one budget.
 */
export class SpendCap {
  private file: string;
  capLamports: number;
  spentLamports = 0;
  reservedLamports = 0;

  constructor(dataDir: string, capSol: number, scope = "mainnet") {
    // one ledger per cluster: test-cluster fees must never eat the mainnet budget
    this.file = path.join(dataDir, `spend-${scope}.json`);
    this.capLamports = Math.floor(capSol * 1_000_000_000);
    if (fs.existsSync(this.file)) {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.spentLamports = s.spentLamports ?? 0;
    }
  }

  reserve(lamports: number) {
    if (this.spentLamports + this.reservedLamports + lamports > this.capLamports) {
      throw new Error(
        `SPEND CAP: reserving ${lamports} would exceed cap ${this.capLamports} ` +
          `(spent=${this.spentLamports}, reserved=${this.reservedLamports})`
      );
    }
    this.reservedLamports += lamports;
  }

  settle(reserved: number, actual: number) {
    this.reservedLamports -= reserved;
    this.spentLamports += actual;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify(
        { spentLamports: this.spentLamports, capLamports: this.capLamports, updatedAt: new Date().toISOString() },
        null,
        2
      )
    );
  }
}
