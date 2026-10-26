//! Chunk-fed LTX decoding and exact population cut operations. No dependencies.
//!
//! ABI safety contract: engine pointers must be live pointers from engine_new; byte
//! allocations must be freed once with their original length; inputs must be in-bounds
//! and labels must be validated to 0..MAX_CELLS before recounting. This module is called
//! only by the trusted worker wrapper; raw ABI functions are not a public input API.
use std::slice;
mod density;
mod position;
mod processing;
pub const RECORD: usize = 216;
pub const MAX_CELLS: usize = 1024;
#[derive(Default)]
pub struct Engine {
    times: Vec<u32>,
    amplitudes: Vec<u8>,
    labels: Vec<u16>,
    counts: Vec<u32>,
    samples: processing::Samples,
    display: processing::Display,
    gates: Vec<processing::Gate>,
    edit: processing::EditState,
    cut: Option<processing::CutParser>,
    analysis: position::Analysis,
    output: Vec<u8>,
    groups: Vec<Vec<u32>>,
    groups_dirty: bool,
    density: std::collections::HashMap<u16, Vec<u16>>,
    density_atlas: Vec<u16>,
    density_sizes: Vec<u32>,
}
impl Engine {
    pub fn new(n: usize) -> Self {
        Self {
            times: Vec::with_capacity(n),
            amplitudes: Vec::with_capacity(n * 4),
            labels: vec![0; n],
            counts: vec![0; MAX_CELLS],
            samples: Default::default(),
            display: Default::default(),
            gates: vec![],
            edit: Default::default(),
            cut: None,
            analysis: Default::default(),
            output: vec![],
            groups: vec![],
            groups_dirty: true,
            density: Default::default(),
            density_atlas: vec![],
            density_sizes: vec![],
        }
    }
    pub fn push(&mut self, data: &[u8]) {
        for spike in data.chunks_exact(RECORD) {
            let index = self.times.len();
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
            self.samples.push(index as u32, self.labels[index], spike);
        }
    }
    pub fn recount(&mut self) {
        self.groups_dirty = true;
        self.density.clear();
        self.counts.fill(0);
        for &c in &self.labels {
            self.counts[c as usize] += 1;
        }
    }
    fn ensure_groups(&mut self) {
        if !self.groups_dirty {
            return;
        }
        self.groups = vec![];
        self.groups = self
            .counts
            .iter()
            .map(|&n| Vec::with_capacity(n as usize))
            .collect();
        for (i, &c) in self.labels.iter().enumerate() {
            self.groups[c as usize].push(i as u32);
        }
        self.groups_dirty = false;
    }
    fn axis(&self, i: usize, axis: usize) -> f32 {
        if axis < 4 {
            self.amplitudes[i * 4 + axis] as f32 / 255.
        } else {
            self.times[i] as f32 / self.times.last().copied().unwrap_or(1).max(1) as f32
        }
    }
    pub fn relabel(&mut self, source: u16, dest: u16, swap: bool) -> usize {
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
        self.recount();
        n
    }
    pub fn polygon(
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
        self.recount();
        n
    }
    pub fn mask(&mut self, sources: &[u16], dest: u16, ax: usize, ay: usize, mask: &[u8]) -> usize {
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
        self.recount();
        n
    }
    pub fn gate(
        &mut self,
        sources: &[u16],
        dest: u16,
        column: &[i8],
        threshold: i32,
        above: bool,
    ) -> usize {
        let mut n = 0;
        for (i, &v) in column.iter().enumerate() {
            if self.labels[i] != dest
                && sources.contains(&self.labels[i])
                && ((v as i32 >= threshold) == above)
            {
                self.labels[i] = dest;
                n += 1;
            }
        }
        self.recount();
        n
    }
    pub fn sort_labels(&mut self) -> usize {
        let mut groups: Vec<usize> = (1..MAX_CELLS).filter(|&c| self.counts[c] > 0).collect();
        groups.sort_by_key(|&c| std::cmp::Reverse(self.counts[c]));
        let mut map = vec![0u16; MAX_CELLS];
        for (i, &c) in groups.iter().enumerate() {
            map[c] = (i + 1) as u16;
        }
        let mut n = 0;
        for c in &mut self.labels {
            let next = map[*c as usize];
            if next != *c {
                n += 1;
                *c = next;
            }
        }
        self.recount();
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
#[no_mangle]
pub extern "C" fn engine_new(n: usize) -> *mut Engine {
    Box::into_raw(Box::new(Engine::new(n)))
}
/// A label-only engine for exporting an inactive cut; waveform arrays stay empty.
#[no_mangle]
pub extern "C" fn engine_new_cut(n: usize) -> *mut Engine {
    let mut e = Engine::new(0);
    e.labels = vec![0; n];
    Box::into_raw(Box::new(e))
}
#[no_mangle]
pub unsafe extern "C" fn engine_free(e: *mut Engine) {
    drop(Box::from_raw(e));
}
#[no_mangle]
pub unsafe extern "C" fn engine_push(e: *mut Engine, p: *const u8, n: usize) {
    (*e).push(slice::from_raw_parts(p, n));
}
#[no_mangle]
pub unsafe extern "C" fn engine_times(e: *mut Engine) -> *const u32 {
    (*e).times.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn engine_amps(e: *mut Engine) -> *const u8 {
    (*e).amplitudes.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn engine_labels(e: *mut Engine) -> *mut u16 {
    (*e).labels.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn engine_counts(e: *mut Engine) -> *const u32 {
    (*e).counts.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn engine_recount(e: *mut Engine) {
    (*e).recount();
}
#[no_mangle]
pub unsafe extern "C" fn engine_relabel(e: *mut Engine, a: u16, b: u16, swap: u32) -> usize {
    (*e).relabel(a, b, swap != 0)
}
#[no_mangle]
pub unsafe extern "C" fn engine_polygon(
    e: *mut Engine,
    src: *const u16,
    ns: usize,
    dest: u16,
    ax: usize,
    ay: usize,
    p: *const f32,
    n: usize,
) -> usize {
    (*e).polygon(
        slice::from_raw_parts(src, ns),
        dest,
        ax,
        ay,
        slice::from_raw_parts(p, n),
    )
}
#[no_mangle]
pub unsafe extern "C" fn engine_mask(
    e: *mut Engine,
    src: *const u16,
    ns: usize,
    dest: u16,
    ax: usize,
    ay: usize,
    p: *const u8,
) -> usize {
    (*e).mask(
        slice::from_raw_parts(src, ns),
        dest,
        ax,
        ay,
        slice::from_raw_parts(p, 65536),
    )
}
#[no_mangle]
pub unsafe extern "C" fn engine_gate(
    e: *mut Engine,
    src: *const u16,
    ns: usize,
    dest: u16,
    p: *const i8,
    threshold: i32,
    above: u32,
) -> usize {
    let n = (*e).labels.len();
    (*e).gate(
        slice::from_raw_parts(src, ns),
        dest,
        slice::from_raw_parts(p, n),
        threshold,
        above != 0,
    )
}
#[no_mangle]
pub unsafe extern "C" fn engine_sort(e: *mut Engine) -> usize {
    (*e).sort_labels()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_samples_big_endian_timestamps() {
        let mut e = Engine::new(2);
        let mut d = vec![0u8; RECORD * 2];
        for i in 0..2 {
            for c in 0..4 {
                let p = i * RECORD + c * 54;
                d[p..p + 4].copy_from_slice(&(4000u32 + i as u32).to_be_bytes());
                d[p + 4] = 128;
                d[p + 5] = 127;
            }
        }
        e.push(&d[..RECORD]);
        e.push(&d[RECORD..]);
        assert_eq!(e.times, vec![4000, 4001]);
        assert_eq!(e.amplitudes, vec![255; 8]);
    }
    #[test]
    fn exact_polygon_and_swap() {
        let mut e = Engine::new(4);
        e.times = vec![1, 2, 3, 4];
        e.amplitudes = vec![25, 25, 0, 0, 230, 230, 0, 0, 50, 50, 0, 0, 200, 200, 0, 0];
        e.labels = vec![1, 1, 2, 2];
        assert_eq!(
            e.polygon(&[1, 2], 3, 0, 1, &[0., 0., 0.5, 0., 0.5, 0.5, 0., 0.5]),
            2
        );
        assert_eq!(e.labels, vec![3, 1, 3, 2]);
        e.relabel(1, 2, true);
        assert_eq!(e.labels, vec![3, 2, 3, 1]);
        assert_eq!(e.counts.iter().sum::<u32>(), 4);
    }
    #[test]
    fn nine_million_spikes_one_hundred_cells() {
        let mut e = Engine::new(9_000_000);
        for (i, c) in e.labels.iter_mut().enumerate() {
            *c = (i % 101) as u16;
        }
        e.recount();
        assert_eq!(e.counts.iter().sum::<u32>(), 9_000_000);
        let before = e.counts[1] + e.counts[100];
        e.relabel(100, 1, false);
        assert_eq!(e.counts[1], before);
        assert_eq!(e.counts[100], 0);
    }
    #[test]
    fn waveform_gate_brush_and_sort() {
        let mut e = Engine::new(4);
        e.labels = vec![0, 5, 5, 5];
        e.times = vec![1, 2, 3, 4];
        e.amplitudes = vec![0; 16];
        e.recount();
        assert_eq!(e.gate(&[5], 7, &[-10, 20, 30, -10], 0, true), 2);
        assert_eq!(e.labels, vec![0, 7, 7, 5]);
        e.sort_labels();
        assert_eq!(e.labels, vec![0, 1, 1, 2]);
        let mask = vec![1u8; 65536];
        assert_eq!(e.mask(&[1], 3, 0, 1, &mask), 2);
        assert_eq!(e.counts[3], 2);
        assert_eq!(e.counts[0], 1);
    }
}
