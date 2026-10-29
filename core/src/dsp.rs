//! Numerical adapters built on RustFFT. Plans and working storage are reused
//! across transforms; inverse transforms include the usual 1/(width*height) scale.
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

pub(crate) struct Fft2 {
    width: usize,
    height: usize,
    rows: [Arc<dyn Fft<f64>>; 2],
    columns: [Arc<dyn Fft<f64>>; 2],
    column: Vec<Complex<f64>>,
    scratch: Vec<Complex<f64>>,
}

impl Fft2 {
    pub(crate) fn new(width: usize, height: usize) -> Self {
        assert!(width > 0 && height > 0);
        let mut planner = FftPlanner::new();
        let rows = [
            planner.plan_fft_forward(width),
            planner.plan_fft_inverse(width),
        ];
        let columns = [
            planner.plan_fft_forward(height),
            planner.plan_fft_inverse(height),
        ];
        let scratch_len = rows
            .iter()
            .chain(&columns)
            .map(|fft| fft.get_inplace_scratch_len())
            .max()
            .unwrap();
        Self {
            width,
            height,
            rows,
            columns,
            column: vec![Complex::default(); height],
            scratch: vec![Complex::default(); scratch_len],
        }
    }

    /// Transform a row-major matrix in place. RustFFT batches all contiguous rows.
    pub(crate) fn transform(&mut self, data: &mut [Complex<f64>], inverse: bool) {
        assert_eq!(data.len(), self.width * self.height);
        let direction = usize::from(inverse);
        self.rows[direction].process_with_scratch(data, &mut self.scratch);
        for x in 0..self.width {
            for y in 0..self.height {
                self.column[y] = data[y * self.width + x];
            }
            self.columns[direction].process_with_scratch(&mut self.column, &mut self.scratch);
            for y in 0..self.height {
                data[y * self.width + x] = self.column[y];
            }
        }
        if inverse {
            let scale = data.len() as f64;
            for value in data {
                *value /= scale;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rectangular_transform_matches_dft_and_round_trips() {
        for (w, h) in [(3, 5), (1, 4)] {
            let original: Vec<_> = (0..w * h)
                .map(|i| Complex::new((i * 7 % 13) as f64, i as f64 / 10.))
                .collect();
            let mut actual = original.clone();
            let mut fft = Fft2::new(w, h);
            fft.transform(&mut actual, false);
            for ky in 0..h {
                for kx in 0..w {
                    let mut expected = Complex::default();
                    for y in 0..h {
                        for x in 0..w {
                            let angle = -std::f64::consts::TAU
                                * (kx as f64 * x as f64 / w as f64
                                    + ky as f64 * y as f64 / h as f64);
                            expected += original[y * w + x] * Complex::from_polar(1., angle);
                        }
                    }
                    assert!((actual[ky * w + kx] - expected).norm() < 1e-10);
                }
            }
            fft.transform(&mut actual, true);
            for (a, b) in actual.iter().zip(&original) {
                assert!((*a - *b).norm() < 1e-10);
            }
        }
    }
}
