//! Waveform residency for the GPU. Up to WAVE_CAP evenly spaced records are resident;
//! the shader reads samples directly from raw 216-byte records, so no transposition is
//! needed. Unsampled files are uploaded straight from Blob slices; only sampled files
//! pass through a `WaveBatch`, which copies whole resident records sequentially.
use crate::{MAX_CELLS, RECORD};
use std::slice;
pub const WAVE_CAP: usize = 1_000_000;
pub(crate) fn mix(s: u64) -> u64 {
    let mut z = s.wrapping_add(0x9e3779b97f4a7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

/// How many of `n` records are resident.
pub(crate) fn slots(n: usize) -> usize {
    n.min(WAVE_CAP)
}
/// The record resident in slot `s` of `n` records.
pub(crate) fn record(n: usize, s: usize) -> usize {
    (s as u64 * n as u64 / slots(n).max(1) as u64) as usize
}
/// The first slot whose record index is at least `i`.
fn slot_from(n: usize, i: usize) -> usize {
    ((i as u64 * slots(n) as u64).div_ceil(n.max(1) as u64)) as usize
}

/// Resident slots grouped by label, ascending within each cell, with each cell's range of
/// them and two u32 halves of an order-independent hash of its slot set, so the renderer
/// can reuse images of cells whose membership is unchanged.
pub(crate) struct WaveOrder {
    pub(crate) order: Vec<u32>,
    pub(crate) starts: Vec<u32>,
    pub(crate) hashes: Vec<u32>,
}
/// The resident slots' order for `labels`: a counting sort by label.
pub(crate) fn order(labels: &[u16]) -> WaveOrder {
    let n = labels.len();
    let m = slots(n);
    let label = |s: usize| labels[if m < n { record(n, s) } else { s }] as usize;
    let mut starts = vec![0u32; MAX_CELLS + 1];
    let mut sums = vec![0u64; MAX_CELLS];
    for s in 0..m {
        let c = label(s);
        starts[c + 1] += 1;
        sums[c] = sums[c].wrapping_add(mix(s as u64));
    }
    for c in 0..MAX_CELLS {
        starts[c + 1] += starts[c];
    }
    let mut next = starts.clone();
    let mut order = vec![0; m];
    for s in 0..m {
        let c = label(s);
        order[next[c] as usize] = s as u32;
        next[c] += 1;
    }
    WaveOrder {
        order,
        starts,
        hashes: sums
            .iter()
            .flat_map(|&h| [h as u32, (h >> 32) as u32])
            .collect(),
    }
}

/// One GPU batch of resident records from a sampled file, filled as the file streams past.
pub struct WaveBatch {
    n: usize,
    first: usize,
    batch: Vec<u8>,
}
impl WaveBatch {
    fn new(n: usize, first: usize, count: usize) -> Self {
        let count = count.min(slots(n).saturating_sub(first));
        Self {
            n,
            first,
            batch: vec![0; count * RECORD],
        }
    }
    fn feed(&mut self, first_record: usize, data: &[u8]) {
        let records = data.len() / RECORD;
        let end = self.first + self.batch.len() / RECORD;
        let lo = slot_from(self.n, first_record).max(self.first);
        let hi = slot_from(self.n, first_record + records).min(end);
        for s in lo..hi {
            let r = (record(self.n, s) - first_record) * RECORD;
            let o = (s - self.first) * RECORD;
            self.batch[o..o + RECORD].copy_from_slice(&data[r..r + RECORD]);
        }
    }
}
#[no_mangle]
pub extern "C" fn wave_slots(n: usize) -> usize {
    slots(n)
}
#[no_mangle]
pub extern "C" fn wave_record(n: usize, s: usize) -> usize {
    record(n, s)
}
#[no_mangle]
pub extern "C" fn wave_batch_new(n: usize, first: usize, count: usize) -> *mut WaveBatch {
    Box::into_raw(Box::new(WaveBatch::new(n, first, count)))
}
#[no_mangle]
pub unsafe extern "C" fn wave_batch_feed(
    b: *mut WaveBatch,
    first_record: usize,
    p: *const u8,
    n: usize,
) {
    (*b).feed(first_record, slice::from_raw_parts(p, n));
}
#[no_mangle]
pub unsafe extern "C" fn wave_batch_data(b: *const WaveBatch) -> *const u8 {
    (*b).batch.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn wave_batch_len(b: *const WaveBatch) -> usize {
    (*b).batch.len()
}
#[no_mangle]
pub unsafe extern "C" fn wave_batch_free(b: *mut WaveBatch) {
    drop(Box::from_raw(b));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batches_copy_resident_records_across_chunk_boundaries() {
        let n = 25;
        let raw: Vec<u8> = (0..n * RECORD).map(|i| (i / RECORD) as u8).collect();
        let mut b = WaveBatch::new(n, 20, 10);
        assert_eq!(b.batch.len() / RECORD, 5);
        for (i, chunk) in raw.chunks(7 * RECORD).enumerate() {
            b.feed(i * 7, chunk);
        }
        let got: Vec<u8> = b.batch.chunks(RECORD).map(|r| r[0]).collect();
        assert_eq!(got, vec![20, 21, 22, 23, 24]);
        // Sampled: 3 slots from a 2.3x-sampled population, fed in 5-record chunks.
        let n = 2_345_678;
        let first = 500_000;
        let (r0, r1) = (record(n, first), record(n, first + 2) + 1);
        let mut b = WaveBatch::new(n, first, 3);
        assert_eq!(b.batch.len() / RECORD, 3);
        let raw: Vec<u8> = (r0..r1)
            .flat_map(|r| std::iter::repeat_n(r as u8, RECORD))
            .collect();
        for (i, chunk) in raw.chunks(5 * RECORD).enumerate() {
            b.feed(r0 + i * 5, chunk);
        }
        let got: Vec<u8> = b.batch.chunks(RECORD).map(|r| r[RECORD - 1]).collect();
        let want: Vec<u8> = (first..first + 3).map(|s| record(n, s) as u8).collect();
        assert_eq!(got, want);
    }
    #[test]
    fn slot_mapping_is_inverse_of_record_mapping_when_sampled() {
        let n = 2_345_678;
        let m = slots(n);
        assert_eq!(m, WAVE_CAP);
        for s in [0, 1, 2, 999, 123_456, m - 1] {
            let r = record(n, s);
            assert_eq!(slot_from(n, r), s);
            assert_eq!(slot_from(n, r + 1), s + 1);
        }
        assert!(record(n, m - 1) < n);
    }
    #[test]
    fn order_groups_slots_and_hashes_follow_membership_not_label() {
        let w = order(&[2, 1, 2, 1, 3]);
        assert_eq!(w.order, vec![1, 3, 0, 2, 4]);
        assert_eq!(&w.starts[..5], &[0, 0, 2, 4, 5]);
        // Swapping cells 1 and 2 swaps their hashes.
        let swapped = order(&[1, 2, 1, 2, 3]);
        assert_eq!(swapped.hashes[2..4], w.hashes[4..6]);
        assert_eq!(swapped.hashes[4..6], w.hashes[2..4]);
    }
}
