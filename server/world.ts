// One in-memory sandbox world: connected clients, player ids, the closed-tick log, the tick clock.
// The server never loads or steps sim.wasm (invariant 11).
import { KIND_LEAVE, KIND_JOIN } from "../shared/inputs.ts";
import { encodeTick, encodeWelcome, TICK_HZ, type TickInput } from "../shared/protocol.ts";
import { TickClock, type ClosedTick } from "./clock.ts";

export const SANDBOX_SEED = 1n;
export const WORLD_KIND = 0;
/** About 55 minutes of running time. Snapshots replace the full log in the next slice. */
export const MAX_LOG_TICKS = 200_000;
/** Drop a client whose socket send queue grows past this: it is not keeping up. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface Peer {
  send(frame: Uint8Array): void;
  /** Bytes queued but not yet written to the socket. */
  buffered(): number;
  close(code: number, reason: string): void;
}

export class World {
  readonly seed = SANDBOX_SEED;
  readonly kind = WORLD_KIND;
  /** log[k - 1] is the encoded TICK frame for tick k. */
  readonly log: Uint8Array[] = [];
  readonly peers = new Map<number, Peer>();
  readonly clock: TickClock;
  private nextPlayer = 1;

  constructor(now: () => number) {
    this.clock = new TickClock(now, (t) => this.onClosed(t), TICK_HZ);
  }

  get playerCount(): number {
    return this.peers.size;
  }

  get full(): boolean {
    return this.log.length >= MAX_LOG_TICKS;
  }

  private onClosed(t: ClosedTick): void {
    const frame = encodeTick(t.tick, t.inputs);
    this.log.push(frame);
    for (const [id, p] of this.peers) {
      if (p.buffered() > MAX_BUFFERED_BYTES) {
        p.close(1013, "too slow");
        continue;
      }
      try {
        p.send(frame);
      } catch {
        this.peers.delete(id);
      }
    }
  }

  /**
   * Admit a peer: WELCOME, then every closed tick from `fromTick` + 1 (0 = from the start; a snapshot
   * will supply a later start), then live. All in one synchronous run, so no tick can fall between.
   */
  join(peer: Peer, fromTick = 0): number {
    this.clock.resume();
    this.clock.advance();
    const id = this.nextPlayer++;
    peer.send(encodeWelcome(id, this.seed, this.kind, TICK_HZ, this.clock.lastClosed));
    for (let k = fromTick; k < this.log.length; k++) peer.send(this.log[k]);
    this.peers.set(id, peer);
    this.stamp({ player: id, kind: KIND_JOIN, payload: new Uint8Array(0) });
    return id;
  }

  leave(id: number): void {
    if (!this.peers.delete(id)) return;
    this.stamp({ player: id, kind: KIND_LEAVE, payload: new Uint8Array(0) });
    if (this.peers.size === 0) this.clock.pause();
  }

  stamp(input: TickInput): number {
    return this.clock.stamp(input);
  }

  /** Called from the server's timer. */
  tick(): void {
    this.clock.advance();
  }
}
