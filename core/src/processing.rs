//! Full-population parsing, sampling, display preparation, history and export.
use crate::{Engine, MAX_CELLS, RECORD};
use std::{collections::HashSet, fmt::Write, slice};
const CAP: usize = 128;
#[derive(Default)]
struct Reservoir {
    seen: u32,
    indices: Vec<u32>,
    waves: Vec<i8>,
}
#[derive(Default)]
pub(crate) struct Samples {
    groups: Vec<Reservoir>,
    pub(crate) indices: Vec<u32>,
    pub(crate) waves: Vec<i8>,
    labels: Vec<u16>,
    plan: Vec<u32>,
}
impl Samples {
    pub fn push(&mut self, index: u32, cell: u16, spike: &[u8]) {
        if self.groups.is_empty() {
            self.groups = (0..MAX_CELLS).map(|_| Reservoir::default()).collect();
        }
        let r = &mut self.groups[cell as usize];
        r.seen += 1;
        let slot = if r.seen <= CAP as u32 {
            r.seen - 1
        } else {
            index.wrapping_add(1).wrapping_mul(2654435761) % r.seen
        } as usize;
        if slot >= CAP {
            return;
        }
        if slot == r.indices.len() {
            r.indices.push(index);
            r.waves.resize((slot + 1) * 200, 0);
        } else {
            r.indices[slot] = index;
        }
        for c in 0..4 {
            for t in 0..50 {
                r.waves[slot * 200 + c * 50 + t] = spike[c * 54 + 4 + t] as i8;
            }
        }
    }
    fn finish(&mut self) {
        for r in self.groups.drain(..) {
            self.indices.extend(r.indices);
            self.waves.extend(r.waves);
        }
        self.groups = vec![];
    }
    fn refresh(&mut self, labels: &[u16]) {
        if self.indices.len() > 32768 {
            let mut counts = vec![0; MAX_CELLS];
            let keep: Vec<usize> = self
                .indices
                .iter()
                .enumerate()
                .filter_map(|(i, &idx)| {
                    let c = &mut counts[labels[idx as usize] as usize];
                    *c += 1;
                    if *c <= CAP {
                        Some(i)
                    } else {
                        None
                    }
                })
                .collect();
            if keep.len() < self.indices.len() {
                let mut indices = Vec::with_capacity(keep.len());
                let mut waves = Vec::with_capacity(keep.len() * 200);
                for i in keep {
                    indices.push(self.indices[i]);
                    waves.extend_from_slice(&self.waves[i * 200..i * 200 + 200]);
                }
                self.indices = indices;
                self.waves = waves;
            }
        }
        self.labels = self.indices.iter().map(|&i| labels[i as usize]).collect();
    }
    fn plan(&mut self, labels: &[u16], cell: u16, count: usize) {
        self.plan.clear();
        let have = self
            .indices
            .iter()
            .filter(|&&i| labels[i as usize] == cell)
            .count();
        if have >= count.min(64) {
            return;
        }
        let mut ids = Vec::with_capacity(CAP);
        let mut seen = 0u32;
        for (i, &c) in labels.iter().enumerate() {
            if c != cell {
                continue;
            }
            seen += 1;
            let slot = if seen <= CAP as u32 {
                seen - 1
            } else {
                (i as u32).wrapping_add(1).wrapping_mul(2654435761) % seen
            } as usize;
            if slot < CAP {
                if slot == ids.len() {
                    ids.push(i as u32);
                } else {
                    ids[slot] = i as u32;
                }
            }
        }
        let existing: HashSet<u32> = self.indices.iter().copied().collect();
        self.plan = ids.into_iter().filter(|i| !existing.contains(i)).collect();
    }
}
#[derive(Default)]
pub(crate) struct Display {
    budget: usize,
    amps: Vec<u8>,
    times: Vec<f32>,
    labels: Vec<u16>,
    indices: Vec<u32>,
}
#[derive(Default)]
pub(crate) struct Gate {
    channel: usize,
    sample: usize,
    column: Vec<i8>,
}
#[derive(Default)]
pub(crate) struct EditState {
    before: Option<Vec<u16>>,
    patch: Vec<u8>,
    preview: Option<PreviewWaves>,
}
struct PreviewWaves {
    source: u16,
    indices: Vec<u32>,
    waves: Vec<i8>,
    ready: bool,
}
pub(crate) struct CutParser {
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
impl Engine {
    fn prepare_view(&mut self, budget: usize) {
        let n = self.labels.len();
        let m = budget.min(n);
        if self.display.budget != budget || self.display.indices.len() != m {
            self.display = Display {
                budget,
                amps: Vec::with_capacity(m * 4),
                times: Vec::with_capacity(m),
                labels: vec![0; m],
                indices: Vec::with_capacity(m),
            };
            let max = self.times.last().copied().unwrap_or(1).max(1) as f32;
            for j in 0..m {
                let i = j * n / m;
                self.display.indices.push(i as u32);
                self.display
                    .amps
                    .extend_from_slice(&self.amplitudes[i * 4..i * 4 + 4]);
                self.display.times.push(self.times[i] as f32 / max);
            }
        }
        for (j, &i) in self.display.indices.iter().enumerate() {
            self.display.labels[j] = self.labels[i as usize];
        }
        self.samples.refresh(&self.labels);
    }
    fn finish_edit(&mut self) -> usize {
        let before = self
            .edit
            .before
            .take()
            .expect("edit_begin precedes edit_finish");
        let changed = before
            .iter()
            .zip(&self.labels)
            .filter(|(a, b)| a != b)
            .count();
        self.edit.patch.clear();
        if changed == 0 {
            return 0;
        }
        let dense = changed * 8 >= before.len() * 4;
        self.edit
            .patch
            .reserve(8 + if dense { before.len() * 4 } else { changed * 8 });
        self.edit
            .patch
            .extend_from_slice(&(dense as u32).to_le_bytes());
        self.edit
            .patch
            .extend_from_slice(&(if dense { before.len() } else { changed } as u32).to_le_bytes());
        for (i, (&a, &b)) in before.iter().zip(&self.labels).enumerate() {
            if !dense && a == b {
                continue;
            }
            if !dense {
                self.edit.patch.extend_from_slice(&(i as u32).to_le_bytes());
            }
            self.edit.patch.extend_from_slice(&a.to_le_bytes());
            self.edit.patch.extend_from_slice(&b.to_le_bytes());
        }
        changed
    }
}
fn apply_patch(labels: &mut [u16], p: &[u8], redo: bool) -> i32 {
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
#[no_mangle]
pub unsafe extern "C" fn engine_cut_begin(e: *mut Engine, clu: u32) {
    (*e).cut = Some(CutParser::new((*e).labels.len(), clu != 0));
}
#[no_mangle]
pub unsafe extern "C" fn engine_cut_abort(e: *mut Engine) {
    (*e).cut = None;
}
#[no_mangle]
pub unsafe extern "C" fn engine_unsorted(e: *mut Engine) {
    (*e).labels.fill(0);
    (*e).recount();
}
#[no_mangle]
pub unsafe extern "C" fn engine_cut_feed(e: *mut Engine, p: *const u8, n: usize) -> i32 {
    (*e).cut.as_mut().unwrap().feed(slice::from_raw_parts(p, n))
}
#[no_mangle]
pub unsafe extern "C" fn engine_cut_finish(e: *mut Engine) -> i32 {
    let mut parser = (*e).cut.take().unwrap();
    let status = parser.finish();
    if status == 0 {
        (*e).labels = parser.labels;
        (*e).recount();
    }
    status
}
#[no_mangle]
pub unsafe extern "C" fn engine_samples_finish(e: *mut Engine) {
    (*e).samples.finish();
}
#[no_mangle]
pub unsafe extern "C" fn engine_prepare_view(e: *mut Engine, budget: usize) {
    (*e).prepare_view(budget);
}
macro_rules! getter{($ptr:ident,$len:ident,[$($field:ident).+],$typ:ty)=>{
 #[no_mangle]pub unsafe extern "C" fn $ptr(e:*mut Engine)->*const $typ{let e=&*e;e.$($field).+.as_ptr()}
 #[no_mangle]pub unsafe extern "C" fn $len(e:*mut Engine)->usize{let e=&*e;e.$($field).+.len()}
};}
getter!(engine_view_amps, engine_view_amps_len, [display.amps], u8);
getter!(
    engine_view_times,
    engine_view_times_len,
    [display.times],
    f32
);
getter!(
    engine_view_labels,
    engine_view_labels_len,
    [display.labels],
    u16
);
getter!(
    engine_view_indices,
    engine_view_indices_len,
    [display.indices],
    u32
);
getter!(
    engine_sample_indices,
    engine_sample_count,
    [samples.indices],
    u32
);
getter!(
    engine_sample_waves,
    engine_sample_waves_len,
    [samples.waves],
    i8
);
getter!(
    engine_sample_labels,
    engine_sample_labels_len,
    [samples.labels],
    u16
);
getter!(
    engine_sample_plan_indices,
    engine_sample_plan_len,
    [samples.plan],
    u32
);
getter!(engine_patch, engine_patch_len, [edit.patch], u8);
getter!(engine_output, engine_output_len, [output], u8);
#[no_mangle]
pub unsafe extern "C" fn engine_sample_plan(e: *mut Engine, cell: u16) {
    let e = &mut *e;
    e.samples
        .plan(&e.labels, cell, e.counts[cell as usize] as usize);
}
#[no_mangle]
pub unsafe extern "C" fn engine_sample_record(e: *mut Engine, index: u32, p: *const u8) {
    let e = &mut *e;
    let record = slice::from_raw_parts(p, RECORD);
    e.density.remove(&e.labels[index as usize]);
    e.samples.indices.push(index);
    for c in 0..4 {
        for t in 0..50 {
            e.samples.waves.push(record[c * 54 + 4 + t] as i8);
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn engine_gate_begin(e: *mut Engine, channel: usize, sample: usize) -> i32 {
    let e = &mut *e;
    if channel > 3 || sample > 49 {
        return -1;
    }
    if e.gates
        .iter()
        .any(|g| g.channel == channel && g.sample == sample)
    {
        return 1;
    }
    if e.gates.len() == 2 {
        e.gates.remove(0);
    }
    e.gates.push(Gate {
        channel,
        sample,
        column: vec![0; e.labels.len()],
    });
    0
}
#[no_mangle]
pub unsafe extern "C" fn engine_gate_feed(e: *mut Engine, first: usize, p: *const u8, n: usize) {
    let e = &mut *e;
    let g = e.gates.last_mut().unwrap();
    for (i, r) in slice::from_raw_parts(p, n).chunks_exact(RECORD).enumerate() {
        if let Some(cache) = e.edit.preview.as_mut().filter(|c| !c.ready) {
            let index = first + i;
            if e.edit.before.as_ref().unwrap()[index] == cache.source {
                cache.indices.push(index as u32);
                for c in 0..4 {
                    cache
                        .waves
                        .extend(r[c * 54 + 4..c * 54 + 54].iter().map(|&v| v as i8));
                }
            }
        }
        g.column[first + i] = r[g.channel * 54 + 4 + g.sample] as i8;
    }
}
#[no_mangle]
pub unsafe extern "C" fn engine_gate_apply(
    e: *mut Engine,
    src: *const u16,
    ns: usize,
    dest: u16,
    channel: usize,
    sample: usize,
    threshold: i32,
    above: u32,
) -> usize {
    let e = &mut *e;
    let sources = slice::from_raw_parts(src, ns);
    let g = e
        .gates
        .iter()
        .find(|g| g.channel == channel && g.sample == sample)
        .unwrap();
    let mut changed = 0;
    for (c, &v) in e.labels.iter_mut().zip(&g.column) {
        if *c != dest && sources.contains(c) && ((v as i32 >= threshold) == (above != 0)) {
            *c = dest;
            changed += 1;
        }
    }
    e.recount();
    changed
}
/// Insert the new half immediately after its source, matching the original tile
/// split. Higher cell numbers move up together in the same undoable operation.
#[no_mangle]
pub unsafe extern "C" fn engine_split_gate(
    e: *mut Engine,
    source: u16,
    channel: usize,
    sample: usize,
    threshold: i32,
) -> i32 {
    let e = &mut *e;
    let base = e
        .edit
        .before
        .as_ref()
        .expect("split begins an edit transaction");
    if source as usize >= MAX_CELLS - 1 || base.contains(&((MAX_CELLS - 1) as u16)) {
        return -1;
    }
    let cached = e
        .edit
        .preview
        .as_ref()
        .filter(|c| c.ready && c.source == source);
    let gate = if cached.is_none() {
        Some(
            &e.gates
                .iter()
                .find(|g| g.channel == channel && g.sample == sample)
                .unwrap()
                .column,
        )
    } else {
        None
    };
    let mut above = 0;
    for (i, (&before, label)) in base.iter().zip(e.labels.iter_mut()).enumerate() {
        *label = if before > source { before + 1 } else { before };
        if before == source && gate.is_some_and(|g| g[i] as i32 > threshold) {
            *label = source + 1;
            above += 1;
        }
    }
    if let Some(cache) = cached {
        for (i, &id) in cache.indices.iter().enumerate() {
            if cache.waves[i * 200 + channel * 50 + sample] as i32 > threshold {
                e.labels[id as usize] = source + 1;
                above += 1;
            }
        }
    }
    e.recount();
    above
}
/// Cache complete source waveforms during the first required column scan. This
/// keeps further sample/channel adjustments in memory for ordinary cells, with a
/// 81.6 MB cap; very large groups retain the two-column fallback instead.
#[no_mangle]
pub unsafe extern "C" fn engine_split_cache_begin(e: *mut Engine, source: u16) {
    let e = &mut *e;
    let n = e.counts[source as usize] as usize;
    e.edit.preview = if n <= 400000 {
        Some(PreviewWaves {
            source,
            indices: Vec::with_capacity(n),
            waves: Vec::with_capacity(n * 200),
            ready: false,
        })
    } else {
        None
    };
}
#[no_mangle]
pub unsafe extern "C" fn engine_split_cached(e: *mut Engine) -> u32 {
    (*e).edit.preview.as_ref().is_some_and(|p| p.ready) as u32
}
#[no_mangle]
pub unsafe extern "C" fn engine_split_cache_finish(e: *mut Engine) {
    let e = &mut *e;
    if let Some(p) = e.edit.preview.as_mut() {
        p.ready = p.indices.len()
            == e.edit
                .before
                .as_ref()
                .unwrap()
                .iter()
                .filter(|&&c| c == p.source)
                .count();
    }
}

#[no_mangle]
pub unsafe extern "C" fn engine_brush(
    e: *mut Engine,
    src: *const u16,
    ns: usize,
    dest: u16,
    ax: usize,
    ay: usize,
    p: *const f32,
    n: usize,
) -> usize {
    let mut mask = vec![0u8; 65536];
    for xy in slice::from_raw_parts(p, n).chunks_exact(2) {
        let x = (xy[0] * 255.).round() as i32;
        let y = (xy[1] * 255.).round() as i32;
        for dy in -10..=10 {
            for dx in -10..=10 {
                if dx * dx + dy * dy <= 100
                    && (0..256).contains(&(x + dx))
                    && (0..256).contains(&(y + dy))
                {
                    mask[((y + dy) * 256 + x + dx) as usize] = 1;
                }
            }
        }
    }
    (*e).mask(slice::from_raw_parts(src, ns), dest, ax, ay, &mask)
}
#[no_mangle]
pub unsafe extern "C" fn engine_edit_begin(e: *mut Engine) {
    (*e).edit.preview = None;
    (*e).edit.before = Some((*e).labels.clone());
    (*e).edit.patch.clear();
}
#[no_mangle]
pub unsafe extern "C" fn engine_edit_finish(e: *mut Engine) -> usize {
    (*e).finish_edit()
}
#[no_mangle]
pub unsafe extern "C" fn engine_edit_rollback(e: *mut Engine) {
    let e = &mut *e;
    if let Some(before) = e.edit.before.take() {
        e.labels = before;
    } else {
        apply_patch(&mut e.labels, &e.edit.patch, false);
    }
    e.edit.patch.clear();
    e.edit.preview = None;
    e.recount();
}
#[no_mangle]
pub unsafe extern "C" fn engine_patch_clear(e: *mut Engine) {
    (*e).edit.patch = vec![];
    (*e).edit.preview = None;
}
#[no_mangle]
pub unsafe extern "C" fn engine_patch_apply(
    e: *mut Engine,
    p: *const u8,
    n: usize,
    redo: u32,
) -> i32 {
    let e = &mut *e;
    let status = apply_patch(&mut e.labels, slice::from_raw_parts(p, n), redo != 0);
    if status == 0 {
        e.recount();
    }
    status
}
#[no_mangle]
pub unsafe extern "C" fn engine_export_chunk(e: *mut Engine, first: usize, count: usize, clu: u32) {
    let e = &mut *e;
    let mut out = String::with_capacity(count * 4);
    for &c in &e.labels[first..(first + count).min(e.labels.len())] {
        if clu != 0 {
            writeln!(&mut out, "{}", c as u32 + 1).unwrap();
        } else {
            write!(&mut out, "{} ", c).unwrap();
        }
    }
    out.push('\n');
    e.output = out.into_bytes();
}
#[no_mangle]
pub unsafe extern "C" fn engine_resident_bytes(e: *mut Engine) -> usize {
    let e = &*e;
    e.groups.iter().map(|g| g.capacity() * 4).sum::<usize>()
        + e.density.values().map(|d| d.capacity() * 2).sum::<usize>()
        + e.density_atlas.capacity() * 2
        + e.times.capacity() * 4
        + e.amplitudes.capacity()
        + e.labels.capacity() * 2
        + e.samples.waves.capacity()
        + e.samples.indices.capacity() * 4
        + e.display.amps.capacity()
        + e.display.times.capacity() * 4
        + e.display.indices.capacity() * 4
        + e.display.labels.capacity() * 2
        + e.edit
            .preview
            .as_ref()
            .map(|p| p.waves.capacity() + p.indices.capacity() * 4)
            .unwrap_or(0)
        + e.gates.iter().map(|g| g.column.capacity()).sum::<usize>()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tile_split_inserts_a_cell_and_undo_restores_higher_labels() {
        let mut e = Engine::new(5);
        e.labels = vec![1, 1, 1, 1, 2];
        e.recount();
        e.gates.push(Gate {
            channel: 0,
            sample: 14,
            column: vec![20, 30, 90, 100, 50],
        });
        unsafe {
            engine_edit_begin(&mut e);
            assert_eq!(engine_split_gate(&mut e, 1, 0, 14, 60), 2);
            assert_eq!(e.labels, vec![1, 1, 2, 2, 3]);
            engine_edit_finish(&mut e);
            assert_eq!(apply_patch(&mut e.labels, &e.edit.patch, false), 0);
            assert_eq!(e.labels, vec![1, 1, 1, 1, 2]);
            e.recount();
            engine_edit_begin(&mut e);
            assert_eq!(engine_split_gate(&mut e, 1, 0, 14, 127), 0);
            assert_eq!(e.labels, vec![1, 1, 1, 1, 3]);
            assert_eq!(engine_split_gate(&mut e, 1, 0, 14, 95), 1);
            assert_eq!(e.labels, vec![1, 1, 1, 2, 3]);
            engine_edit_rollback(&mut e);
            assert_eq!(e.labels, vec![1, 1, 1, 1, 2]);
        }
    }
    #[test]
    fn split_waveform_cache_reuses_original_membership_across_columns() {
        let mut e = Engine::new(5);
        let mut raw = vec![0; 5 * RECORD];
        for (i, v) in [20, 30, 90, 100, 50].iter().enumerate() {
            raw[i * RECORD + 4 + 14] = *v;
            raw[i * RECORD + 54 + 4 + 20] = if i == 3 { 100 } else { 0 };
        }
        e.push(&raw);
        e.labels = vec![1, 1, 1, 1, 2];
        e.recount();
        unsafe {
            engine_edit_begin(&mut e);
            engine_split_cache_begin(&mut e, 1);
            engine_gate_begin(&mut e, 0, 14);
            engine_gate_feed(&mut e, 0, raw.as_ptr(), raw.len());
            engine_split_cache_finish(&mut e);
            assert_eq!(engine_split_cached(&mut e), 1);
            engine_split_gate(&mut e, 1, 0, 14, 60);
            assert_eq!(e.labels, vec![1, 1, 2, 2, 3]);
            // No channel 1 gate column was loaded. The complete source cache supplies it.
            engine_split_gate(&mut e, 1, 1, 20, 60);
            assert_eq!(e.labels, vec![1, 1, 1, 2, 3]);
            engine_edit_rollback(&mut e);
            assert_eq!(e.labels, vec![1, 1, 1, 1, 2]);
        }
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
            let mut e = Engine::new(n);
            e.labels = (0..n).map(|i| (i % 101) as u16).collect();
            let original = e.labels.clone();
            e.edit.before = Some(original.clone());
            for i in (0..n).step_by(if n > 3 { 100 } else { 1 }) {
                e.labels[i] = 99;
            }
            let changed = e.labels.clone();
            e.finish_edit();
            assert_eq!(apply_patch(&mut e.labels, &e.edit.patch, false), 0);
            assert_eq!(e.labels, original);
            assert_eq!(apply_patch(&mut e.labels, &e.edit.patch, true), 0);
            assert_eq!(e.labels, changed);
        }
    }
}
