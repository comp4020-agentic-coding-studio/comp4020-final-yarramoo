// Test-only verifier worker that accepts a job and never answers (a hung restore).
import { parentPort } from "node:worker_threads";
parentPort!.on("message", () => {});
