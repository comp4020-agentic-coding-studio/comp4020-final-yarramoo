// What the memory admission gates read (D-236): how much memory is left before the kernel kills the process.
//
// The gates used to read only cgroup v2's `memory.current`, which Docker provides and every capacity run measured. The
// Fly machine is a Firecracker VM with cgroup v1 and no limit on its root cgroup, so the file was missing, the reader
// returned undefined, and both gates were silently off in production until a live load test OOM-killed the machine.
//
// A source counts only if it has a real limit: a cgroup with no limit (v2 "max", or v1's huge sentinel) limits
// nothing, and the kernel's OOM killer then works against the whole machine, which `/proc/meminfo` describes. The
// gates compare headroom (limit - used) with a reserve, not used with an absolute cap, so a source's "used" on a big
// host (a CI runner's GBs) does not refuse every room.

import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

export type MemorySource = "cgroup2" | "cgroup1" | "meminfo" | "rss";

export interface MemoryReading {
  usedBytes: number;
  limitBytes: number;
}

/** One reader per source, in the order they are tried. Each returns undefined if it is absent or has no limit. */
export type MemoryReaders = Record<MemorySource, () => MemoryReading | undefined>;

export const MEMORY_SOURCES: readonly MemorySource[] = ["cgroup2", "cgroup1", "meminfo", "rss"];

/** What the readers touch, so a test can stand in the Fly VM's files. */
export interface MemoryIo {
  readFile(path: string): string | undefined;
  rss(): number;
  totalmem(): number;
}

export const NODE_MEMORY_IO: MemoryIo = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  rss: () => process.memoryUsage().rss,
  totalmem,
};

export function memoryReaders(io: MemoryIo = NODE_MEMORY_IO): MemoryReaders {
  // A cgroup limit at or above the machine's memory limits nothing (v1's "unlimited" is about 2^63).
  const realLimit = (limit: number): boolean => Number.isFinite(limit) && limit > 0 && limit < io.totalmem();
  const cgroup = (usagePath: string, limitPath: string): MemoryReading | undefined => {
    const used = io.readFile(usagePath);
    const max = io.readFile(limitPath);
    if (used === undefined || max === undefined) return undefined;
    const limitBytes = Number(max.trim()); // v2 "max" is NaN, so not a real limit
    const usedBytes = Number(used.trim());
    return realLimit(limitBytes) && Number.isFinite(usedBytes) ? { usedBytes, limitBytes } : undefined;
  };
  return {
    // cgroup v2 (Docker with --memory): memory.current against memory.max. The capacity runs measured this figure.
    cgroup2: () => cgroup("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.max"),
    // cgroup v1: usage_in_bytes against limit_in_bytes. On Fly this is the root cgroup with no limit, so it is skipped:
    // its usage also counts about 80 MB of reclaimable page cache, which would close the gates at idle.
    cgroup1: () => cgroup("/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    // The whole machine (Fly): MemTotal - MemAvailable, what the kernel's global OOM killer works against.
    meminfo() {
      const text = io.readFile("/proc/meminfo");
      if (text === undefined) return undefined;
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? NaN) * 1024;
      const total = kb("MemTotal");
      const avail = kb("MemAvailable");
      return Number.isFinite(total) && Number.isFinite(avail) ? { usedBytes: total - avail, limitBytes: total } : undefined;
    },
    // Anywhere else (macOS dev): the process RSS, which includes worker threads' memory, against the machine's memory.
    rss: () => ({ usedBytes: io.rss(), limitBytes: io.totalmem() }),
  };
}

export interface MemoryProbe {
  source: MemorySource | null;
  /** The limit the chosen source reported at start, in bytes (for the start-up line). */
  limitBytes: number | undefined;
  /** Bytes left before the limit, or undefined if the source cannot be read now (the gates then skip their check). */
  freeBytes(): number | undefined;
}

/** Pick the first source that reads now and keep it: the gates must not switch figures mid-run. */
export function pickMemorySource(readers: MemoryReaders = memoryReaders()): MemoryProbe {
  for (const source of MEMORY_SOURCES) {
    const first = readers[source]();
    if (first === undefined) continue;
    return {
      source,
      limitBytes: first.limitBytes,
      freeBytes() {
        const r = readers[source]();
        return r === undefined ? undefined : r.limitBytes - r.usedBytes;
      },
    };
  }
  return { source: null, limitBytes: undefined, freeBytes: () => undefined };
}
