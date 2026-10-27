//! Waveform residency for the GPU. Up to WAVE_CAP evenly spaced records are resident;
//! the shader reads samples directly from raw 216-byte records, so no transposition is
//! needed. Unsampled files are uploaded straight from Blob slices; only sampled files
//! pass through `feed`, which copies whole resident records sequentially.
use crate::{Engine, MAX_CELLS, RECORD};
use std::slice;
pub const WAVE_CAP: usize = 1_000_000;
#[derive(Default)]
pub(crate) struct Waves {
    first: usize,
    batch: Vec<u8>,
    /// Resident slots grouped by label, ascending within each cell.
    order: Vec<u32>,
    starts: Vec<u32>,
    /// Two u32 halves of an order-independent 64-bit hash of each cell's slot set.
    hashes: Vec<u32>,
}
fn mix(s: u64) -> u64 {
    let mut z = s.wrapping_add(0x9e3779b97f4a7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}
impl Engine {
    pub(crate) fn wave_slots(&self) -> usize {
        self.labels.len().min(WAVE_CAP)
    }
    pub(crate) fn wave_record(&self, s: usize) -> usize {
        (s as u64 * self.labels.len() as u64 / self.wave_slots() as u64) as usize
    }
    /// The first slot whose record index is at least `i`.
    fn wave_slot_from(&self, i: usize) -> usize {
        let (n, m) = (self.labels.len() as u64, self.wave_slots() as u64);
        ((i as u64 * m).div_ceil(n.max(1))) as usize
    }
    fn wave_begin(&mut self, first: usize, count: usize) -> usize {
        let count = count.min(self.wave_slots().saturating_sub(first));
        self.waves.first = first;
        self.waves.batch.clear();
        self.waves.batch.resize(count * RECORD, 0);
        count
    }
    fn wave_feed(&mut self, first_record: usize, data: &[u8]) {
        let records = data.len() / RECORD;
        let end = self.waves.first + self.waves.batch.len() / RECORD;
        let lo = self.wave_slot_from(first_record).max(self.waves.first);
        let hi = self.wave_slot_from(first_record + records).min(end);
        for s in lo..hi {
            let r = (self.wave_record(s) - first_record) * RECORD;
            let o = (s - self.waves.first) * RECORD;
            self.waves.batch[o..o + RECORD].copy_from_slice(&data[r..r + RECORD]);
        }
    }
    /// Counting sort of resident slots by label, plus per-cell set hashes so the
    /// renderer can reuse cached images for cells whose membership is unchanged.
    pub(crate) fn wave_order(&mut self) {
        let m = self.wave_slots();
        let sampled = m < self.labels.len();
        let label = |e: &Engine, s: usize| {
            e.labels[if sampled { e.wave_record(s) } else { s }] as usize
        };
        let mut starts = vec![0u32; MAX_CELLS + 1];
        let mut sums = vec![0u64; MAX_CELLS];
        for s in 0..m {
            let c = label(self, s);
            starts[c + 1] += 1;
            sums[c] = sums[c].wrapping_add(mix(s as u64));
        }
        for c in 0..MAX_CELLS {
            starts[c + 1] += starts[c];
        }
        let mut next = starts.clone();
        let mut order = std::mem::take(&mut self.waves.order);
        order.resize(m, 0);
        for s in 0..m {
            let c = label(self, s);
            order[next[c] as usize] = s as u32;
            next[c] += 1;
        }
        self.waves.order = order;
        self.waves.starts = starts;
        self.waves.hashes = sums
            .iter()
            .flat_map(|&h| [h as u32, (h >> 32) as u32])
            .collect();
    }
    pub(crate) fn wave_bytes(&self) -> usize {
        self.waves.batch.capacity()
            + self.waves.order.capacity() * 4
            + self.waves.starts.capacity() * 4
            + self.waves.hashes.capacity() * 4
    }
}
#[no_mangle]
pub unsafe extern "C" fn engine_wave_slots(e: *const Engine) -> usize {
    (*e).wave_slots()
}
#[no_mangle]
pub unsafe extern "C" fn engine_wave_record(e: *const Engine, s: usize) -> usize {
    (*e).wave_record(s)
}
#[no_mangle]
pub unsafe extern "C" fn engine_wave_begin(e: *mut Engine, first: usize, count: usize) -> usize {
    (*e).wave_begin(first, count)
}
#[no_mangle]
pub unsafe extern "C" fn engine_wave_feed(e: *mut Engine, first_record: usize, p: *const u8, n: usize) {
    (*e).wave_feed(first_record, slice::from_raw_parts(p, n));
}
getter!(engine_wave_batch, engine_wave_batch_len, [waves.batch], u8);
getter!(engine_wave_order, engine_wave_order_len, [waves.order], u32);
getter!(engine_wave_starts, engine_wave_starts_len, [waves.starts], u32);
getter!(engine_wave_hashes, engine_wave_hashes_len, [waves.hashes], u32);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batches_copy_resident_records_across_chunk_boundaries() {
        let n = 25;
        let mut e = Engine::new(0);
        e.labels = vec![0; n];
        let raw: Vec<u8> = (0..n * RECORD).map(|i| (i / RECORD) as u8).collect();
        assert_eq!(e.wave_begin(20, 10), 5);
        for (i, chunk) in raw.chunks(7 * RECORD).enumerate() {
            e.wave_feed(i * 7, chunk);
        }
        let got: Vec<u8> = e.waves.batch.chunks(RECORD).map(|r| r[0]).collect();
        assert_eq!(got, vec![20, 21, 22, 23, 24]);
        // Sampled: 3 slots from a 2.3x-sampled population, fed in 5-record chunks.
        e.labels = vec![0; 2_345_678];
        let first = 500_000;
        let (r0, r1) = (e.wave_record(first), e.wave_record(first + 2) + 1);
        assert_eq!(e.wave_begin(first, 3), 3);
        let raw: Vec<u8> = (r0..r1)
            .flat_map(|r| std::iter::repeat_n(r as u8, RECORD))
            .collect();
        for (i, chunk) in raw.chunks(5 * RECORD).enumerate() {
            e.wave_feed(r0 + i * 5, chunk);
        }
        let got: Vec<u8> = e.waves.batch.chunks(RECORD).map(|r| r[RECORD - 1]).collect();
        let want: Vec<u8> = (first..first + 3).map(|s| e.wave_record(s) as u8).collect();
        assert_eq!(got, want);
    }
    #[test]
    fn slot_mapping_is_inverse_of_record_mapping_when_sampled() {
        let mut e = Engine::new(0);
        e.labels = vec![0; 2_345_678];
        let m = e.wave_slots();
        assert_eq!(m, WAVE_CAP);
        for s in [0, 1, 2, 999, 123_456, m - 1] {
            let r = e.wave_record(s);
            assert_eq!(e.wave_slot_from(r), s);
            assert_eq!(e.wave_slot_from(r + 1), s + 1);
        }
        assert!(e.wave_record(m - 1) < e.labels.len());
    }
    #[test]
    fn order_groups_slots_and_hashes_follow_membership_not_label() {
        let mut e = Engine::new(0);
        e.labels = vec![2, 1, 2, 1, 3];
        e.wave_order();
        assert_eq!(e.waves.order, vec![1, 3, 0, 2, 4]);
        assert_eq!(&e.waves.starts[..5], &[0, 0, 2, 4, 5]);
        let (h1, h2) = (e.waves.hashes[2..4].to_vec(), e.waves.hashes[4..6].to_vec());
        e.relabel(1, 2, true);
        e.wave_order();
        assert_eq!(e.waves.hashes[2..4], h2[..]);
        assert_eq!(e.waves.hashes[4..6], h1[..]);
    }
}
