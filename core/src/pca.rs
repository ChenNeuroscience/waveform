//! Four global waveform PCs, fitted on bounded, time-stratified sample blocks.
//! Covariance and eigendecomposition use nalgebra, as in prekk/src/extract.rs.
//! Projection and scaling cover every spike; labels never influence the basis.
use crate::{Engine, RECORD};
use nalgebra::{linalg::SymmetricEigen, DMatrix};
use std::slice;

const DIM: usize = 4 * 50;
const PCS: usize = 4;

struct Model {
    mean: [f32; DIM],
    weights: [[f32; PCS]; DIM],
}

impl Model {
    fn fit(mut samples: Vec<f64>, count: usize) -> Option<Self> {
        let mut mean = [0.; DIM];
        for sample in samples.chunks_exact(DIM) {
            for (i, &value) in sample.iter().enumerate() {
                mean[i] += value;
            }
        }
        for value in &mut mean {
            *value /= count.max(1) as f64;
        }
        for sample in samples.chunks_exact_mut(DIM) {
            for (i, value) in sample.iter_mut().enumerate() {
                *value -= mean[i];
            }
        }
        let data = DMatrix::from_vec(DIM, count, samples);
        let covariance = (&data * data.transpose()) / count.saturating_sub(1).max(1) as f64;
        let mut weights = [[0.; PCS]; DIM];
        if count < 2 || covariance.amax() == 0. {
            for (pc, row) in weights.iter_mut().take(PCS).enumerate() {
                row[pc] = 1.;
            }
        } else {
            // Constant sample positions add no information and can make the
            // eigensystem unnecessarily singular (dead channels, flat baselines).
            let maximum = (0..DIM).map(|i| covariance[(i, i)]).fold(0., f64::max);
            let active: Vec<_> = (0..DIM)
                .filter(|&i| covariance[(i, i)] > maximum * 1e-12)
                .collect();
            let covariance = DMatrix::from_fn(active.len(), active.len(), |i, j| {
                covariance[(active[i], active[j])]
            });
            let eigen = SymmetricEigen::try_new(covariance, f64::EPSILON, 100_000)?;
            if !eigen
                .eigenvalues
                .iter()
                .chain(eigen.eigenvectors.iter())
                .all(|v| v.is_finite())
            {
                return None;
            }
            let mut order: Vec<_> = (0..active.len()).collect();
            order.sort_by(|&a, &b| eigen.eigenvalues[b].total_cmp(&eigen.eigenvalues[a]));
            for (pc, &column) in order.iter().take(PCS).enumerate() {
                // Do not stretch round-off in null directions into a visible axis.
                if eigen.eigenvalues[column]
                    <= (eigen.eigenvalues[order[0]].abs() * 1e-10).max(1e-12)
                {
                    continue;
                }
                let direction = eigen.eigenvectors.column(column);
                for (i, &original) in active.iter().enumerate() {
                    weights[original][pc] = direction[i] as f32;
                }
                let pivot = (0..DIM)
                    .max_by(|&a, &b| weights[a][pc].abs().total_cmp(&weights[b][pc].abs()))
                    .unwrap();
                if weights[pivot][pc] < 0. {
                    for weight in &mut weights {
                        weight[pc] = -weight[pc];
                    }
                }
            }
        }
        Some(Self {
            mean: mean.map(|v| v as f32),
            weights,
        })
    }

    fn project(&self, record: &[u8]) -> [f32; PCS] {
        let mut score = [0.; PCS];
        for channel in 0..4 {
            for sample in 0..50 {
                let i = channel * 50 + sample;
                let value = record[channel * 54 + 4 + sample] as i8 as f32 - self.mean[i];
                // Four adjacent weights let LLVM use four-lane Wasm SIMD.
                for (pc, result) in score.iter_mut().enumerate() {
                    *result += value * self.weights[i][pc];
                }
            }
        }
        score
    }
}

#[derive(Default)]
pub(crate) struct Pca {
    pub(crate) ranges: Vec<u32>,
    pub(crate) samples: usize,
    input: Vec<f64>,
    model: Option<Model>,
    pub(crate) values: Vec<f32>,
    minimum: [f32; PCS],
    maximum: [f32; PCS],
    pub(crate) ready: bool,
}

impl Pca {
    fn new(spikes: usize, limit: usize) -> Self {
        let samples = spikes.min(limit.clamp(4, 20_000));
        let mut ranges = vec![];
        if samples == spikes && spikes > 0 {
            ranges.extend([0, spikes as u32]);
        } else if samples > 0 {
            // Small blocks avoid thousands of tiny file reads. Stratifying over
            // the full recording includes drift; seeded jitter avoids periodic bias.
            let blocks = samples.div_ceil(32);
            let extra = spikes - samples;
            let skipped = |block: usize| (block as u64 * extra as u64 / blocks as u64) as usize;
            for block in 0..blocks {
                let count = (samples - block * 32).min(32);
                let gap = skipped(block + 1) - skipped(block);
                let jitter =
                    (crate::waves::mix(block as u64 ^ 0x706361) % (gap + 1) as u64) as usize;
                let first = block * 32 + skipped(block) + jitter;
                ranges.extend([first as u32, count as u32]);
            }
        }
        Self {
            ranges,
            samples,
            input: Vec::with_capacity(samples * DIM),
            minimum: [f32::INFINITY; PCS],
            maximum: [f32::NEG_INFINITY; PCS],
            ..Default::default()
        }
    }

    fn sample(&mut self, raw: &[u8]) {
        for record in raw.chunks_exact(RECORD) {
            for channel in 0..4 {
                self.input.extend(
                    record[channel * 54 + 4..channel * 54 + 54]
                        .iter()
                        .map(|&v| v as i8 as f64),
                );
            }
        }
    }

    fn fit(&mut self) -> bool {
        if self.input.len() != self.samples * DIM {
            return false;
        }
        self.model = Model::fit(std::mem::take(&mut self.input), self.samples);
        self.ranges = vec![];
        self.model.is_some()
    }

    fn project(&mut self, raw: &[u8]) {
        let model = self.model.as_ref().expect("Fit PCA before projection");
        for record in raw.chunks_exact(RECORD) {
            let score = model.project(record);
            for pc in 0..PCS {
                self.minimum[pc] = self.minimum[pc].min(score[pc]);
                self.maximum[pc] = self.maximum[pc].max(score[pc]);
            }
            self.values.extend(score);
        }
    }

    fn finish(&mut self, spikes: usize) -> bool {
        if self.model.is_none() || self.values.len() != spikes * PCS {
            return false;
        }
        for point in self.values.chunks_exact_mut(PCS) {
            for pc in 0..PCS {
                let span = self.maximum[pc] - self.minimum[pc];
                point[pc] = if span > 1e-5 {
                    ((point[pc] - self.minimum[pc]) / span).clamp(0., 1.)
                } else {
                    0.5
                };
            }
        }
        self.ready = true;
        true
    }

    pub(crate) fn bytes(&self) -> usize {
        self.input.capacity() * 8 + self.values.capacity() * 4 + self.ranges.capacity() * 4
    }
}

#[no_mangle]
pub unsafe extern "C" fn engine_pca_begin(e: *mut Engine, limit: usize) {
    let e = &mut *e;
    e.pca = Pca::new(e.labels.len(), limit);
}
#[no_mangle]
pub unsafe extern "C" fn engine_pca_sample(e: *mut Engine, p: *const u8, bytes: usize) {
    (*e).pca.sample(slice::from_raw_parts(p, bytes));
}
#[no_mangle]
pub unsafe extern "C" fn engine_pca_fit(e: *mut Engine) -> u32 {
    let e = &mut *e;
    if !e.pca.fit() {
        return 0;
    }
    e.pca.values = Vec::with_capacity(e.labels.len() * PCS);
    1
}
#[no_mangle]
pub unsafe extern "C" fn engine_pca_project(e: *mut Engine, p: *const u8, bytes: usize) {
    (*e).pca.project(slice::from_raw_parts(p, bytes));
}
#[no_mangle]
pub unsafe extern "C" fn engine_pca_finish(e: *mut Engine) -> u32 {
    let e = &mut *e;
    e.pca.finish(e.labels.len()) as u32
}
#[no_mangle]
pub unsafe extern "C" fn engine_pca_clear(e: *mut Engine) {
    (*e).pca = Pca::default();
}
getter!(engine_pca_ranges, engine_pca_ranges_len, [pca.ranges], u32);
getter!(engine_pca_values, engine_pca_values_len, [pca.values], f32);

#[cfg(test)]
mod tests {
    use super::*;

    fn records(n: usize) -> Vec<u8> {
        let mut raw = vec![0; n * RECORD];
        for (i, record) in raw.chunks_exact_mut(RECORD).enumerate() {
            for ch in 0..4 {
                record[ch * 54..ch * 54 + 4].copy_from_slice(&(i as u32 * 100).to_be_bytes());
                record[ch * 54 + 4..ch * 54 + 54].fill(8 + ch as u8);
                for (pc, coefficient) in [30, 15, 8, 3].iter().enumerate() {
                    let sign = if (i >> pc) & 1 == 0 { -1 } else { 1 };
                    let channel_sign = if ch < 2 { 1 } else { -1 };
                    record[ch * 54 + 4 + pc * 11 + 7] =
                        (8 + ch as i32 + sign * channel_sign * coefficient) as i8 as u8;
                }
            }
        }
        raw
    }

    fn fitted(raw: &[u8], limit: usize) -> Pca {
        let n = raw.len() / RECORD;
        let mut p = Pca::new(n, limit);
        for range in p.ranges.clone().chunks_exact(2) {
            let (first, count) = (range[0] as usize, range[1] as usize);
            for block in raw[first * RECORD..(first + count) * RECORD].chunks(7 * RECORD) {
                p.sample(block);
            }
        }
        assert!(p.fit());
        p
    }

    #[test]
    fn sample_plan_is_bounded_reproducible_and_never_overlaps() {
        for n in [
            0, 1, 31, 32, 33, 65, 4999, 5000, 5001, 5010, 9_000_000, 20_000_000,
        ] {
            for limit in [4, 64, 500, 5000, 20000] {
                let p = Pca::new(n, limit);
                assert_eq!(p.ranges, Pca::new(n, limit).ranges);
                let (mut end, mut total) = (0, 0);
                for range in p.ranges.chunks_exact(2) {
                    let (first, count) = (range[0] as usize, range[1] as usize);
                    assert!(first >= end && count > 0 && first + count <= n);
                    end = first + count;
                    total += count;
                }
                assert_eq!(total, n.min(limit));
            }
        }
    }

    #[test]
    fn global_pcs_recover_four_known_cross_channel_signals_in_variance_order() {
        let raw = records(64);
        let p = fitted(&raw, 64);
        let model = p.model.unwrap();
        let scores: Vec<_> = raw
            .chunks_exact(RECORD)
            .map(|record| model.project(record))
            .collect();
        for a in 0..PCS {
            let mean = scores.iter().map(|v| v[a]).sum::<f32>() / 64.;
            assert!(
                mean.abs() < 1e-4,
                "PC {a} mean {mean}, scores {:?}, fitted mean {:?}",
                &scores[..4],
                &model.mean[..20]
            );
            let variance = scores.iter().map(|v| v[a].powi(2)).sum::<f32>() / 64.;
            assert!((variance - [3600., 900., 256., 36.][a]).abs() < 0.01);
            let pivot = (0..DIM)
                .max_by(|&i, &j| {
                    model.weights[i][a]
                        .abs()
                        .total_cmp(&model.weights[j][a].abs())
                })
                .unwrap();
            assert!(model.weights[pivot][a] > 0.);
            for b in 0..PCS {
                let dot = model.weights.iter().map(|w| w[a] * w[b]).sum::<f32>();
                assert!((dot - if a == b { 1. } else { 0. }).abs() < 1e-5);
                if a != b {
                    let covariance = scores.iter().map(|v| v[a] * v[b]).sum::<f32>() / 64.;
                    assert!(covariance.abs() < 0.001);
                }
            }
        }
    }

    #[test]
    fn sampled_basis_projects_every_spike_and_pca_cuts_use_the_displayed_coordinates() {
        let n = 1024;
        let raw = records(n);
        let mut p = fitted(&raw, 64);
        let mut full = fitted(&raw, n);
        for block in raw.chunks(19 * RECORD) {
            p.project(block);
        }
        full.project(&raw);
        assert!(p.finish(n) && full.finish(n));
        for (&a, &b) in p.values.iter().zip(&full.values) {
            assert!((a - b).abs() < 1e-5);
        }
        let mut e = Engine::new(n);
        e.push(&raw);
        e.labels.fill(1);
        e.recount();
        e.pca = p;
        let polygon = [0.75, -0.1, 1.1, -0.1, 1.1, 1.1, 0.75, 1.1];
        assert_eq!(e.polygon(&[1], 2, 0, 1, &polygon), 0);
        unsafe {
            crate::processing::engine_edit_begin(&mut e);
        }
        assert_eq!(
            e.polygon(&[1], 2, 5, 6, &polygon),
            n / 2,
            "scores {:?}, bounds {:?}/{:?}",
            &e.pca.values[..16],
            e.pca.minimum,
            e.pca.maximum
        );
        for (i, &label) in e.labels.iter().enumerate() {
            assert_eq!(label, if e.pca.values[i * 4] > 0.75 { 2 } else { 1 });
        }
        unsafe {
            crate::processing::engine_edit_finish(&mut e);
            let patch = slice::from_raw_parts(
                crate::processing::engine_patch(&mut e),
                crate::processing::engine_patch_len(&mut e),
            )
            .to_vec();
            assert_eq!(
                crate::processing::engine_patch_apply(&mut e, patch.as_ptr(), patch.len(), 0),
                0
            );
        }
        assert!(e.labels.iter().all(|&c| c == 1));
    }

    #[test]
    fn empty_single_and_constant_recordings_stay_finite_and_centred() {
        for n in [0, 1, 24] {
            let raw = vec![17; n * RECORD];
            let mut p = fitted(&raw, 64);
            p.project(&raw);
            assert!(p.finish(n));
            assert!(p.values.iter().all(|&v| v == 0.5));
        }
    }
}
