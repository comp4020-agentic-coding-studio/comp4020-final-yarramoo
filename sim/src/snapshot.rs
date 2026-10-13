//! Canonical snapshot (plan 6.10). Little-endian, fixed-width fields only.

use crate::grid::{CHUNK, CHUNK_AREA};
use crate::sim::Sim;

pub const MAGIC: &[u8; 4] = b"SAND";
pub const FORMAT_VERSION: u16 = 1;
const HEADER: usize = 4 + 2 + 32 + 8 + 1 + 4 + 2 + 2;

pub fn write(s: &Sim) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(MAGIC);
    v.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    v.extend_from_slice(&[0u8; 32]); // sim_build_hash: filled in by the TS side
    v.extend_from_slice(&s.seed.to_le_bytes());
    v.push(s.world_kind);
    v.extend_from_slice(&s.tick.to_le_bytes());
    v.extend_from_slice(&(s.grid.w as u16).to_le_bytes());
    v.extend_from_slice(&(s.grid.h as u16).to_le_bytes());
    let e = s.entity_bytes();
    v.extend_from_slice(&(0u32).to_le_bytes()); // entity count
    v.extend_from_slice(&e);
    let live: Vec<usize> = (0..s.grid.chunk_count()).filter(|&c| !s.grid.pristine[c]).collect();
    v.extend_from_slice(&(live.len() as u32).to_le_bytes());
    for c in live {
        v.extend_from_slice(&(c as u16).to_le_bytes());
        for plane in [&s.grid.mat, &s.grid.aux] {
            let (cx, cy) = (c % s.grid.cw, c / s.grid.cw);
            for y in cy * CHUNK..(cy + 1) * CHUNK {
                let o = y * s.grid.w + cx * CHUNK;
                v.extend_from_slice(&plane[o..o + CHUNK]);
            }
        }
    }
    v
}

pub fn size(s: &Sim) -> usize {
    let live = (0..s.grid.chunk_count()).filter(|&c| !s.grid.pristine[c]).count();
    HEADER + 4 + 4 + live * (2 + 2 * CHUNK_AREA)
}

pub fn restore(b: &[u8]) -> Result<Sim, ()> {
    if b.len() < HEADER + 8 || &b[0..4] != MAGIC {
        return Err(());
    }
    let u16_at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    if u16_at(4) != FORMAT_VERSION {
        return Err(());
    }
    let mut sd = [0u8; 8];
    sd.copy_from_slice(&b[38..46]);
    let seed = u64::from_le_bytes(sd);
    let kind = b[46];
    let tick = u32_at(47);
    let (w, h) = (u16_at(51) as usize, u16_at(53) as usize);
    let mut s = Sim::new(seed, kind).ok_or(())?;
    if s.grid.w != w || s.grid.h != h {
        return Err(());
    }
    let mut o = HEADER;
    if u32_at(o) != 0 {
        return Err(()); // entities not supported yet
    }
    o += 4;
    let n = u32_at(o) as usize;
    o += 4;
    let rec = 2 + 2 * CHUNK_AREA;
    if b.len() != o + n * rec {
        return Err(());
    }
    let mut prev: Option<usize> = None;
    for _ in 0..n {
        let c = u16_at(o) as usize;
        if c >= s.grid.chunk_count() || prev.is_some_and(|p| c <= p) {
            return Err(());
        }
        prev = Some(c);
        o += 2;
        let (cx, cy) = (c % s.grid.cw, c / s.grid.cw);
        for plane in 0..2 {
            for r in 0..CHUNK {
                let d = (cy * CHUNK + r) * w + cx * CHUNK;
                let src = &b[o..o + CHUNK];
                if plane == 0 {
                    s.grid.mat[d..d + CHUNK].copy_from_slice(src);
                } else {
                    s.grid.aux[d..d + CHUNK].copy_from_slice(src);
                }
                o += CHUNK;
            }
        }
        s.grid.mark_chunk(c);
    }
    s.tick = tick;
    Ok(s)
}
