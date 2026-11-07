// Test-only verifier worker: the real one (server/verify-worker.ts), except that a lane prewarmed with seed 666 accepts
// verify jobs and never answers them (a hung restore in one room only), and one prewarmed with seed 667 never finishes
// generating (a hung warm-up). Other lanes behave exactly as the real worker.
import { parentPort } from "node:worker_threads";
const port = parentPort!;
const realOn = port.on.bind(port);
let hang = false;
(port as unknown as { on: (ev: string, fn: (m: unknown) => void) => void }).on = (ev, fn) =>
  realOn(ev, (m: { prewarm?: boolean; seed?: bigint }) => {
    if (m?.prewarm && m.seed === 667n) return;
    if (m?.prewarm) hang = m.seed === 666n;
    if (hang && !m?.prewarm) return;
    fn(m);
  });
await import("../../server/verify-worker.ts");
