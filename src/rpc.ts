/** Retry with exponential backoff — the egress proxy in some environments
 *  intermittently drops RPC requests ("fetch failed"); every on-chain call
 *  in this harness goes through here so one dropped packet never kills a run. */
export async function retry<T>(fn: () => Promise<T>, tries = 6, baseMs = 700): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = baseMs * 2 ** i + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
