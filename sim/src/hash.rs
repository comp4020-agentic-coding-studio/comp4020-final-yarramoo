//! Chunk and state hashes (plan 6.10). Fixed-width integers only.

use crate::grid::{Grid, CHUNK};
use xxhash_rust::xxh3::{xxh3_64, Xxh3};

fn compute_chunk(g: &Grid, c: usize) -> u64 {
    let (cx, cy) = (c % g.cw, c / g.cw);
    let mut h = Xxh3::new();
    for plane in [&g.mat, &g.aux] {
        for y in cy * CHUNK..(cy + 1) * CHUNK {
            let s = y * g.w + cx * CHUNK;
            h.update(&plane[s..s + CHUNK]);
        }
    }
    h.digest()
}

/// Refresh and return all chunk hashes in index order.
pub fn chunk_hashes(g: &mut Grid) -> &[u64] {
    for c in 0..g.chunk_count() {
        if g.dirty_since_hash[c] {
            g.hash_cache[c] = compute_chunk(g, c);
            g.dirty_since_hash[c] = false;
        }
    }
    &g.hash_cache
}

/// xxh3 over tick (u32 LE), the 16 room-config bytes, entity bytes, then chunk hashes (u64 LE). The config is
/// in the hash so two clients with different configs fail the first hash check.
pub fn state_hash(g: &mut Grid, tick: u32, cfg: &[u8], entity_bytes: &[u8]) -> u64 {
    let mut buf = Vec::new();
    buf.extend_from_slice(&tick.to_le_bytes());
    buf.extend_from_slice(cfg);
    buf.extend_from_slice(entity_bytes);
    for h in chunk_hashes(g) {
        buf.extend_from_slice(&h.to_le_bytes());
    }
    xxh3_64(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_invalidates_on_change() {
        let mut g = Grid::new(64, 64);
        let a = state_hash(&mut g, 0, &[], &[]);
        assert_eq!(a, state_hash(&mut g, 0, &[], &[]));
        g.set(5, 4, 0);
        assert_ne!(a, state_hash(&mut g, 0, &[], &[]));
        assert_ne!(state_hash(&mut g, 0, &[], &[]), state_hash(&mut g, 1, &[], &[]));
    }
}
