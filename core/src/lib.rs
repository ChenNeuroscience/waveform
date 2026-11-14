//! Chunk-fed LTX decoding and exact population cut operations.
//!
//! Nothing here holds state between requests. A recording's spikes are read into a
//! `Population` and kept by the compute graph (compute.rs), as are its labels at each point
//! of its edit history; edits are commands (commands.rs) that make new labels from the
//! current ones, working on an `Edit`.
//!
//! ABI safety contract: builder pointers must be live pointers from their `*_new`; byte
//! allocations must be freed once with their original length; inputs must be in-bounds.
//! This module is called only by the trusted worker wrapper; raw ABI functions are not a
//! public input API.
use std::slice;
mod cache;
mod commands;
mod compute;
mod compute_handlers;
mod dsp;
mod pca;
mod position;
mod processing;
mod projection;
mod spatial_ac;
pub mod synthetic;
mod waves;
pub const RECORD: usize = 216;
pub const MAX_CELLS: usize = 1024;

/// A recording's spikes as read from its file: each spike's time and four peak-to-peak
/// amplitudes. Raw waveforms are never kept.
#[derive(Default)]
pub struct Population {
    pub(crate) times: Vec<u32>,
    pub(crate) amplitudes: Vec<u8>,
}
impl Population {
    pub fn new(n: usize) -> Self {
        Self {
            times: Vec::with_capacity(n),
            amplitudes: Vec::with_capacity(n * 4),
        }
    }
    pub fn push(&mut self, data: &[u8]) {
        for spike in data.chunks_exact(RECORD) {
            self.times
                .push(u32::from_be_bytes(spike[..4].try_into().unwrap()));
            for ch in 0..4 {
                let p = ch * 54 + 4;
                let (mut lo, mut hi) = (127i16, -128i16);
                for &b in &spike[p..p + 50] {
                    let v = b as i8 as i16;
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
                self.amplitudes.push((hi - lo) as u8);
            }
        }
    }
    pub fn len(&self) -> usize {
        self.times.len()
    }
    pub(crate) fn bytes(&self) -> usize {
        self.times.capacity() * 4 + self.amplitudes.capacity()
    }
}

/// Spikes per cell.
pub(crate) fn counts(labels: &[u16]) -> Vec<u32> {
    let mut counts = vec![0; MAX_CELLS];
    for &c in labels {
        counts[c as usize] += 1;
    }
    counts
}
/// Each cell's spike indices, ascending.
pub(crate) fn groups(labels: &[u16], counts: &[u32]) -> Vec<Vec<u32>> {
    let mut groups: Vec<Vec<u32>> = counts
        .iter()
        .map(|&n| Vec::with_capacity(n as usize))
        .collect();
    for (i, &c) in labels.iter().enumerate() {
        groups[c as usize].push(i as u32);
    }
    groups
}
/// Two u32 halves per cell of an order-independent hash of its spike set, so values made
/// from a cell's spikes survive edits that leave them unchanged (including number swaps).
pub(crate) fn cell_hashes(labels: &[u16]) -> Vec<u32> {
    let mut sums = vec![0u64; MAX_CELLS];
    for (i, &c) in labels.iter().enumerate() {
        sums[c as usize] = sums[c as usize].wrapping_add(waves::mix(i as u64));
    }
    sums.iter()
        .flat_map(|&h| [h as u32, (h >> 32) as u32])
        .collect()
}

/// A working copy of a recording's labels for a command to change, with what it selects
/// spikes by: their amplitudes, times and, if fitted, principal components.
pub(crate) struct Edit<'a> {
    pub(crate) population: &'a Population,
    pub(crate) pca: Option<&'a [f32]>,
    pub(crate) labels: Vec<u16>,
}
impl Edit<'_> {
    /// A spike's normalised coordinate on a feature axis: four amplitudes, time, then four
    /// principal components.
    fn axis(&self, i: usize, axis: usize) -> f32 {
        let p = self.population;
        if axis < 4 {
            p.amplitudes[i * 4 + axis] as f32 / 255.
        } else if axis == 4 {
            p.times[i] as f32 / p.times.last().copied().unwrap_or(1).max(1) as f32
        } else if let (5..9, Some(pca)) = (axis, self.pca) {
            pca[i * 4 + axis - 5]
        } else {
            0.5
        }
    }
    pub(crate) fn relabel(&mut self, source: u16, dest: u16, swap: bool) -> usize {
        let mut n = 0;
        for c in &mut self.labels {
            if *c == source {
                *c = dest;
                n += 1;
            } else if swap && *c == dest {
                *c = source;
                n += 1;
            }
        }
        n
    }
    pub(crate) fn polygon(
        &mut self,
        sources: &[u16],
        dest: u16,
        ax: usize,
        ay: usize,
        poly: &[f32],
    ) -> usize {
        if poly.len() < 6 || poly.len() % 2 != 0 {
            return 0;
        }
        let mut n = 0;
        for i in 0..self.labels.len() {
            if self.labels[i] != dest
                && sources.contains(&self.labels[i])
                && inside(self.axis(i, ax), self.axis(i, ay), poly)
            {
                self.labels[i] = dest;
                n += 1;
            }
        }
        n
    }
    pub(crate) fn mask(
        &mut self,
        sources: &[u16],
        dest: u16,
        ax: usize,
        ay: usize,
        mask: &[u8],
    ) -> usize {
        let mut n = 0;
        for i in 0..self.labels.len() {
            let x = (self.axis(i, ax) * 255.).round() as usize;
            let y = (self.axis(i, ay) * 255.).round() as usize;
            if self.labels[i] != dest
                && sources.contains(&self.labels[i])
                && mask[y.min(255) * 256 + x.min(255)] != 0
            {
                self.labels[i] = dest;
                n += 1;
            }
        }
        n
    }
}
fn inside(x: f32, y: f32, p: &[f32]) -> bool {
    let mut hit = false;
    let mut j = p.len() - 2;
    for i in (0..p.len()).step_by(2) {
        if (p[i + 1] > y) != (p[j + 1] > y)
            && x < (p[j] - p[i]) * (y - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]
        {
            hit = !hit;
        }
        j = i;
    }
    hit
}
#[no_mangle]
pub extern "C" fn alloc_bytes(n: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; n].into_boxed_slice()) as *mut u8
}
#[no_mangle]
pub unsafe extern "C" fn free_bytes(p: *mut u8, n: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(p, n)));
}
/// A population to stream a recording into (`population_push`), then hand to the compute
/// graph (`compute_supply_population`) or free.
#[no_mangle]
pub extern "C" fn population_new(n: usize) -> *mut Population {
    Box::into_raw(Box::new(Population::new(n)))
}
#[no_mangle]
pub unsafe extern "C" fn population_push(p: *mut Population, data: *const u8, n: usize) {
    (*p).push(slice::from_raw_parts(data, n));
}
#[no_mangle]
pub unsafe extern "C" fn population_free(p: *mut Population) {
    drop(Box::from_raw(p));
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    /// A population with these times and amplitudes.
    pub(crate) fn population(times: Vec<u32>, amplitudes: Vec<u8>) -> Population {
        Population { times, amplitudes }
    }
    fn edit<'a>(p: &'a Population, labels: Vec<u16>) -> Edit<'a> {
        Edit {
            population: p,
            pca: None,
            labels,
        }
    }
    #[test]
    fn signed_samples_big_endian_timestamps() {
        let mut p = Population::new(2);
        let mut d = vec![0u8; RECORD * 2];
        for i in 0..2 {
            for c in 0..4 {
                let q = i * RECORD + c * 54;
                d[q..q + 4].copy_from_slice(&(4000u32 + i as u32).to_be_bytes());
                d[q + 4] = 128;
                d[q + 5] = 127;
            }
        }
        p.push(&d[..RECORD]);
        p.push(&d[RECORD..]);
        assert_eq!(p.times, vec![4000, 4001]);
        assert_eq!(p.amplitudes, vec![255; 8]);
    }
    #[test]
    fn exact_polygon_and_swap() {
        let p = population(
            vec![1, 2, 3, 4],
            vec![25, 25, 0, 0, 230, 230, 0, 0, 50, 50, 0, 0, 200, 200, 0, 0],
        );
        let mut e = edit(&p, vec![1, 1, 2, 2]);
        assert_eq!(
            e.polygon(&[1, 2], 3, 0, 1, &[0., 0., 0.5, 0., 0.5, 0.5, 0., 0.5]),
            2
        );
        assert_eq!(e.labels, vec![3, 1, 3, 2]);
        e.relabel(1, 2, true);
        assert_eq!(e.labels, vec![3, 2, 3, 1]);
        assert_eq!(counts(&e.labels).iter().sum::<u32>(), 4);
    }
    #[test]
    fn nine_million_spikes_one_hundred_cells() {
        let p = Population::default();
        let labels = (0..9_000_000).map(|i| (i % 101) as u16).collect();
        let mut e = edit(&p, labels);
        let before = counts(&e.labels);
        assert_eq!(before.iter().sum::<u32>(), 9_000_000);
        e.relabel(100, 1, false);
        let after = counts(&e.labels);
        assert_eq!(after[1], before[1] + before[100]);
        assert_eq!(after[100], 0);
    }
    #[test]
    fn brush_mask_preserves_other_labels() {
        let p = population(vec![1, 2, 3, 4], vec![0; 16]);
        let mut e = edit(&p, vec![0, 7, 7, 5]);
        let mask = vec![1u8; 65536];
        assert_eq!(e.mask(&[7], 3, 0, 1, &mask), 2);
        assert_eq!(e.labels, vec![0, 3, 3, 5]);
        let c = counts(&e.labels);
        assert_eq!((c[3], c[0]), (2, 1));
    }
}
