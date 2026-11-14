//! Cut files, edit patches, split scans and export: the pieces commands and the compute
//! graph's handlers use.
use crate::{MAX_CELLS, RECORD};
use std::{fmt::Write, slice};

/// A cut (or .clu) file's labels, parsed as the file streams past.
pub struct CutParser {
    labels: Vec<u16>,
    at: usize,
    value: u64,
    has: bool,
    skip: bool,
    clu: bool,
    error: i32,
}
impl CutParser {
    fn new(n: usize, clu: bool) -> Self {
        Self {
            labels: vec![0; n],
            at: 0,
            value: 0,
            has: false,
            skip: clu,
            clu,
            error: 0,
        }
    }
    fn emit(&mut self) {
        if !self.has || self.error != 0 {
            return;
        }
        if self.skip {
            self.skip = false;
        } else {
            let value = if self.clu {
                self.value.checked_sub(1)
            } else {
                Some(self.value)
            };
            if value.is_none() || value.unwrap() >= MAX_CELLS as u64 {
                self.error = -3;
                return;
            }
            if self.at >= self.labels.len() {
                self.error = -2;
                return;
            }
            self.labels[self.at] = value.unwrap() as u16;
            self.at += 1;
        }
        self.value = 0;
        self.has = false;
    }
    fn feed(&mut self, data: &[u8]) -> i32 {
        for &b in data {
            if self.error != 0 {
                break;
            }
            match b {
                b'0'..=b'9' => {
                    match self
                        .value
                        .checked_mul(10)
                        .and_then(|v| v.checked_add((b - b'0') as u64))
                    {
                        Some(v) => self.value = v,
                        None => self.error = -5,
                    }
                    self.has = true;
                }
                b' ' | b'\t' | b'\r' | b'\n' => self.emit(),
                _ => self.error = -1,
            }
        }
        self.error
    }
    fn finish(&mut self) -> i32 {
        self.emit();
        if self.error != 0 {
            return self.error;
        }
        if self.skip || self.at != self.labels.len() {
            -4
        } else {
            0
        }
    }
}
#[no_mangle]
pub extern "C" fn cut_new(n: usize, clu: u32) -> *mut CutParser {
    Box::into_raw(Box::new(CutParser::new(n, clu != 0)))
}
#[no_mangle]
pub unsafe extern "C" fn cut_feed(p: *mut CutParser, data: *const u8, n: usize) -> i32 {
    (*p).feed(slice::from_raw_parts(data, n))
}
/// 0 if the file had exactly one valid label per spike.
#[no_mangle]
pub unsafe extern "C" fn cut_finish(p: *mut CutParser) -> i32 {
    (*p).finish()
}
#[no_mangle]
pub unsafe extern "C" fn cut_free(p: *mut CutParser) {
    drop(Box::from_raw(p));
}
impl CutParser {
    pub(crate) fn into_labels(self) -> Vec<u16> {
        self.labels
    }
}

/// How many spikes changed from `before` to `after`, and the patch that undoes and redoes
/// the change: sparse (index, before, after) rows, or dense (before, after) pairs when that
/// is smaller.
pub(crate) fn diff(before: &[u16], after: &[u16]) -> (usize, Vec<u8>) {
    let changed = before.iter().zip(after).filter(|(a, b)| a != b).count();
    if changed == 0 {
        return (0, vec![]);
    }
    let dense = changed * 8 >= before.len() * 4;
    let mut patch = Vec::with_capacity(8 + if dense { before.len() * 4 } else { changed * 8 });
    patch.extend_from_slice(&(dense as u32).to_le_bytes());
    patch.extend_from_slice(&(if dense { before.len() } else { changed } as u32).to_le_bytes());
    for (i, (&a, &b)) in before.iter().zip(after).enumerate() {
        if !dense && a == b {
            continue;
        }
        if !dense {
            patch.extend_from_slice(&(i as u32).to_le_bytes());
        }
        patch.extend_from_slice(&a.to_le_bytes());
        patch.extend_from_slice(&b.to_le_bytes());
    }
    (changed, patch)
}
/// Applies a patch from `diff` to `labels`, forwards (`redo`) or back; nonzero if it doesn't
/// fit them, leaving them unchanged.
pub(crate) fn apply_patch(labels: &mut [u16], p: &[u8], redo: bool) -> i32 {
    if p.len() < 8 {
        return -1;
    }
    let kind = u32::from_le_bytes(p[..4].try_into().unwrap());
    let n = u32::from_le_bytes(p[4..8].try_into().unwrap()) as usize;
    let stride = if kind == 1 { 4 } else { 8 };
    if kind > 1 || p.len() != 8 + n * stride || (kind == 1 && n != labels.len()) {
        return -1;
    }
    for row in p[8..].chunks_exact(stride) {
        let i = if kind == 1 {
            0
        } else {
            u32::from_le_bytes(row[..4].try_into().unwrap()) as usize
        };
        let off = if kind == 1 { 0 } else { 4 };
        let v = u16::from_le_bytes(
            row[off + if redo { 2 } else { 0 }..off + if redo { 4 } else { 2 }]
                .try_into()
                .unwrap(),
        );
        if i >= labels.len() || v as usize >= MAX_CELLS {
            return -1;
        }
    }
    for (j, row) in p[8..].chunks_exact(stride).enumerate() {
        let i = if kind == 1 {
            j
        } else {
            u32::from_le_bytes(row[..4].try_into().unwrap()) as usize
        };
        let off = if kind == 1 { 0 } else { 4 };
        labels[i] = u16::from_le_bytes(
            row[off + if redo { 2 } else { 0 }..off + if redo { 4 } else { 2 }]
                .try_into()
                .unwrap(),
        );
    }
    0
}

/// The largest cell whose every waveform a split keeps in memory (81.6 MB); bigger ones read
/// one sample column per adjustment instead.
pub(crate) const CELL_WAVES_CAP: usize = 400_000;
/// Every waveform (4 channels by 50 samples) of some spikes, by spike index.
pub(crate) struct CellWaves {
    pub(crate) indices: Vec<u32>,
    pub(crate) waves: Vec<i8>,
}
/// Reads, as the tetrode file streams past, one sample column for every spike and/or every
/// waveform of some spikes, for a split.
pub struct Scan {
    pub(crate) column: Option<(usize, usize, Vec<i8>)>,
    pub(crate) cell: Option<(Vec<u32>, Vec<i8>)>,
    next: usize,
}
impl Scan {
    pub(crate) fn new(n: usize, column: Option<(usize, usize)>, cell: Option<Vec<u32>>) -> Self {
        Self {
            column: column.map(|(c, s)| (c, s, vec![0; n])),
            cell: cell.map(|indices| {
                let waves = Vec::with_capacity(indices.len() * 200);
                (indices, waves)
            }),
            next: 0,
        }
    }
    /// Records from spike `first` on, in order.
    pub(crate) fn feed(&mut self, first: usize, data: &[u8]) {
        for (i, r) in data.chunks_exact(RECORD).enumerate() {
            let index = first + i;
            if let Some((channel, sample, column)) = &mut self.column {
                column[index] = r[*channel * 54 + 4 + *sample] as i8;
            }
            if let Some((indices, waves)) = &mut self.cell {
                if indices.get(self.next) == Some(&(index as u32)) {
                    self.next += 1;
                    for c in 0..4 {
                        waves.extend(r[c * 54 + 4..c * 54 + 54].iter().map(|&v| v as i8));
                    }
                }
            }
        }
    }
    /// Whether every wanted waveform was read.
    pub(crate) fn complete(&self) -> bool {
        self.cell
            .as_ref()
            .is_none_or(|(indices, _)| self.next == indices.len())
    }
}
#[no_mangle]
pub unsafe extern "C" fn scan_feed(s: *mut Scan, first: usize, p: *const u8, n: usize) {
    (*s).feed(first, slice::from_raw_parts(p, n));
}
#[no_mangle]
pub unsafe extern "C" fn scan_free(s: *mut Scan) {
    drop(Box::from_raw(s));
}

/// What a split thresholds: every waveform of the source cell, or one sample column for
/// every spike.
pub(crate) enum SplitBy<'a> {
    Waves(&'a CellWaves),
    Column(&'a [i8]),
}
/// The labels after splitting `source` at a channel's sample: spikes above `threshold` become
/// a new cell numbered just after it (so their tiles sit side by side), and higher cells move
/// up. None if there is no room for another cell.
pub(crate) fn split(
    base: &[u16],
    source: u16,
    channel: usize,
    sample: usize,
    threshold: i32,
    by: SplitBy,
) -> Option<Vec<u16>> {
    if source as usize >= MAX_CELLS - 1 || base.contains(&((MAX_CELLS - 1) as u16)) {
        return None;
    }
    let mut labels: Vec<u16> = base
        .iter()
        .map(|&c| if c > source { c + 1 } else { c })
        .collect();
    match by {
        SplitBy::Column(column) => {
            for (i, &c) in base.iter().enumerate() {
                if c == source && column[i] as i32 > threshold {
                    labels[i] = source + 1;
                }
            }
        }
        SplitBy::Waves(cell) => {
            for (i, &id) in cell.indices.iter().enumerate() {
                if cell.waves[i * 200 + channel * 50 + sample] as i32 > threshold {
                    labels[id as usize] = source + 1;
                }
            }
        }
    }
    Some(labels)
}

/// Labels `first..first + count` as cut-file text (or .clu, one per line, from 1).
pub(crate) fn export(labels: &[u16], first: usize, count: usize, clu: bool) -> Vec<u8> {
    let mut out = String::with_capacity(count * 4);
    for &c in &labels[first.min(labels.len())..(first + count).min(labels.len())] {
        if clu {
            writeln!(&mut out, "{}", c as u32 + 1).unwrap();
        } else {
            write!(&mut out, "{} ", c).unwrap();
        }
    }
    out.push('\n');
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_inserts_a_cell_after_its_source_and_its_patch_restores_higher_labels() {
        let base = [1, 1, 1, 1, 2];
        let column = [20, 30, 90, 100, 50];
        let by = || SplitBy::Column(&column);
        let split_at = |t| split(&base, 1, 0, 14, t, by()).unwrap();
        let labels = split_at(60);
        assert_eq!(labels, vec![1, 1, 2, 2, 3]);
        let (changed, patch) = diff(&base, &labels);
        assert_eq!(changed, 3);
        let mut undone = labels.clone();
        assert_eq!(apply_patch(&mut undone, &patch, false), 0);
        assert_eq!(undone, base);
        assert_eq!(split_at(127), vec![1, 1, 1, 1, 3]);
        assert_eq!(split_at(95), vec![1, 1, 1, 2, 3]);
        assert!(split(&[1, 1023], 1, 0, 14, 0, by()).is_none());
    }
    #[test]
    fn a_scan_keeps_the_source_cells_waveforms_for_any_column() {
        let mut raw = vec![0; 5 * RECORD];
        for (i, v) in [20, 30, 90, 100, 50].iter().enumerate() {
            raw[i * RECORD + 4 + 14] = *v;
            raw[i * RECORD + 54 + 4 + 20] = if i == 3 { 100 } else { 0 };
        }
        let mut scan = Scan::new(5, Some((0, 14)), Some(vec![0, 1, 2, 3]));
        for (i, chunk) in raw.chunks(2 * RECORD).enumerate() {
            scan.feed(i * 2, chunk);
        }
        assert!(scan.complete());
        let (indices, waves) = scan.cell.take().unwrap();
        let cell = CellWaves { indices, waves };
        let base = [1, 1, 1, 1, 2];
        assert_eq!(
            split(&base, 1, 0, 14, 60, SplitBy::Waves(&cell)).unwrap(),
            vec![1, 1, 2, 2, 3]
        );
        // No channel 1 column was read; the source's waveforms supply it.
        assert_eq!(
            split(&base, 1, 1, 20, 60, SplitBy::Waves(&cell)).unwrap(),
            vec![1, 1, 1, 2, 3]
        );
        assert_eq!(scan.column.unwrap().2, vec![20, 30, 90, 100, 50]);
    }
    #[test]
    fn cell_hashes_follow_membership() {
        let before = crate::cell_hashes(&[1, 1, 2, 3]);
        let after = crate::cell_hashes(&[2, 2, 1, 3]);
        assert_eq!(after[2..4], before[4..6]);
        assert_eq!(after[4..6], before[2..4]);
        assert_eq!(after[6..8], before[6..8]);
        assert_ne!(crate::cell_hashes(&[1, 1, 2, 1])[2..4], before[2..4]);
    }
    #[test]
    fn streaming_cut_is_transactional_and_handles_split_tokens() {
        let mut p = CutParser::new(3, false);
        assert_eq!(p.feed(b"0 10"), 0);
        assert_eq!(p.feed(b"0 2"), 0);
        assert_eq!(p.finish(), 0);
        assert_eq!(p.labels, vec![0, 100, 2]);
        let mut c = CutParser::new(3, true);
        c.feed(b"3\n1\n2\n3");
        assert_eq!(c.finish(), 0);
        assert_eq!(c.labels, vec![0, 1, 2]);
        let mut bad = CutParser::new(2, false);
        bad.feed(b"1 1024");
        assert_eq!(bad.finish(), -3);
        let mut short = CutParser::new(2, false);
        short.feed(b"1");
        assert_eq!(short.finish(), -4);
    }
    #[test]
    fn sparse_and_dense_patches_restore_every_label() {
        for n in [1, 3, 10000] {
            let original: Vec<u16> = (0..n).map(|i| (i % 101) as u16).collect();
            let mut changed = original.clone();
            for i in (0..n).step_by(if n > 3 { 100 } else { 1 }) {
                changed[i] = 99;
            }
            let (_, patch) = diff(&original, &changed);
            let mut labels = changed.clone();
            assert_eq!(apply_patch(&mut labels, &patch, false), 0);
            assert_eq!(labels, original);
            assert_eq!(apply_patch(&mut labels, &patch, true), 0);
            assert_eq!(labels, changed);
        }
    }
}
