//! Deterministic falling-sand core. C ABI per plan 6.11; integers only.
#![deny(clippy::float_arithmetic)]

pub mod grid;
pub mod hash;
pub mod input;
pub mod materials;
pub mod rng;
pub mod script;
pub mod sim;
pub mod snapshot;

use core::cell::UnsafeCell;
use sim::Sim;

struct Global(UnsafeCell<Option<Sim>>);
// SAFETY: wasm32 has no threads in this project; native tests use the Sim API directly.
unsafe impl Sync for Global {}
static G: Global = Global(UnsafeCell::new(None));

fn with<R>(f: impl FnOnce(&mut Sim) -> R) -> Option<R> {
    // SAFETY: single-threaded; no re-entrancy (no host imports call back in).
    unsafe { (*G.0.get()).as_mut().map(f) }
}

unsafe fn slice<'a>(ptr: u32, len: u32) -> &'a [u8] {
    core::slice::from_raw_parts(ptr as usize as *const u8, len as usize)
}
unsafe fn out_slice<'a>(ptr: u32, len: usize) -> &'a mut [u8] {
    core::slice::from_raw_parts_mut(ptr as usize as *mut u8, len)
}

#[no_mangle]
pub extern "C" fn init(seed_lo: u32, seed_hi: u32, world_kind: u32) -> i32 {
    let seed = u64::from(seed_lo) | (u64::from(seed_hi) << 32);
    let Ok(k) = u8::try_from(world_kind) else { return -1 };
    match Sim::new(seed, k) {
        Some(s) => {
            // SAFETY: see `with`.
            unsafe { *G.0.get() = Some(s) };
            0
        }
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> u32 {
    let mut v = Vec::<u8>::with_capacity(len as usize);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p as usize as u32
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: u32, len: u32) {
    // SAFETY: caller passes a pointer/len pair returned by `alloc`.
    unsafe { drop(Vec::from_raw_parts(ptr as usize as *mut u8, 0, len as usize)) }
}

#[no_mangle]
pub extern "C" fn push_input(ptr: u32, len: u32) -> i32 {
    // SAFETY: caller guarantees the range is valid linear memory.
    let b = unsafe { slice(ptr, len) };
    with(|s| s.push_input(b)).unwrap_or(-2)
}

#[no_mangle]
pub extern "C" fn step() -> u32 {
    with(|s| s.step()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn tick() -> u32 {
    with(|s| s.tick).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn state_hash(out_ptr: u32) {
    if let Some(h) = with(|s| s.state_hash()) {
        // SAFETY: caller provides 8 writable bytes.
        unsafe { out_slice(out_ptr, 8) }.copy_from_slice(&h.to_le_bytes());
    }
}

#[no_mangle]
pub extern "C" fn chunk_hashes(out_ptr: u32) -> u32 {
    with(|s| {
        let hs = hash::chunk_hashes(&mut s.grid);
        // SAFETY: caller provides 8 bytes per chunk.
        let o = unsafe { out_slice(out_ptr, hs.len() * 8) };
        for (i, h) in hs.iter().enumerate() {
            o[i * 8..i * 8 + 8].copy_from_slice(&h.to_le_bytes());
        }
        hs.len() as u32
    })
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn snapshot_size() -> u32 {
    with(|s| snapshot::size(s) as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn snapshot_write(out_ptr: u32) -> u32 {
    with(|s| {
        let v = snapshot::write(s);
        // SAFETY: caller allocated `snapshot_size()` bytes.
        unsafe { out_slice(out_ptr, v.len()) }.copy_from_slice(&v);
        v.len() as u32
    })
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn restore(ptr: u32, len: u32) -> i32 {
    // SAFETY: caller guarantees the range is valid linear memory.
    let b = unsafe { slice(ptr, len) };
    match snapshot::restore(b) {
        Ok(s) => {
            // SAFETY: see `with`.
            unsafe { *G.0.get() = Some(s) };
            0
        }
        Err(()) => -1,
    }
}

#[no_mangle]
pub extern "C" fn mat_ptr() -> u32 {
    with(|s| s.grid.mat.as_ptr() as usize as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aux_ptr() -> u32 {
    with(|s| s.grid.aux.as_ptr() as usize as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn width() -> u32 {
    with(|s| s.grid.w as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn height() -> u32 {
    with(|s| s.grid.h as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn dirty_rects(_out_ptr: u32, _max: u32) -> u32 {
    0
}

#[no_mangle]
pub extern "C" fn events(_out_ptr: u32, _max: u32) -> u32 {
    0
}

#[no_mangle]
pub extern "C" fn entities(_out_ptr: u32, _max: u32) -> u32 {
    0
}

#[no_mangle]
pub extern "C" fn set_sleep_enabled(on: u32) {
    with(|s| s.grid.sleep_enabled = on != 0);
}
