//! Masked Pearson autocorrelation at every linear lag, using zero-padded 2D FFTs.
//! Correlations of the mask, rates and squared rates supply every overlap's
//! count, sums, second moments and cross product without looping over lag pairs.
use crate::dsp::Fft2;
use rustfft::num_complex::Complex;

fn correlate(a: &[Complex<f64>], b: &[Complex<f64>], fft: &mut Fft2) -> Vec<f64> {
    let mut product: Vec<_> = a.iter().zip(b).map(|(a, b)| a * b.conj()).collect();
    fft.transform(&mut product, true);
    product.into_iter().map(|v| v.re).collect()
}

/// Row-major output (2w-1) by (2h-1); zero displacement is at (w-1,h-1).
/// Nonfinite bins are excluded pairwise. Too few pairs or zero variance give NaN.
pub(crate) fn autocorrelation(
    map: &[f32],
    width: usize,
    height: usize,
    minimum: usize,
) -> Vec<f32> {
    if width == 0 || height == 0 {
        return vec![];
    }
    assert_eq!(map.len(), width * height);
    let (ow, oh) = (2 * width - 1, 2 * height - 1);
    let mut out = vec![f32::NAN; ow * oh];
    let valid = map.iter().filter(|v| v.is_finite()).count();
    if valid < minimum.max(2) {
        return out;
    }
    // A global offset/scale leaves Pearson r unchanged and stabilises local moments.
    let mean = map
        .iter()
        .filter(|v| v.is_finite())
        .map(|&v| v as f64)
        .sum::<f64>()
        / valid as f64;
    let scale = map
        .iter()
        .filter(|v| v.is_finite())
        .map(|&v| (v as f64 - mean).abs())
        .fold(0., f64::max);
    if scale == 0. {
        return out;
    }
    let (fw, fh) = (ow.next_power_of_two(), oh.next_power_of_two());
    let mut mask = vec![Complex::default(); fw * fh];
    let mut rates = mask.clone();
    let mut squares = mask.clone();
    for y in 0..height {
        for x in 0..width {
            let value = map[y * width + x];
            if value.is_finite() {
                let v = (value as f64 - mean) / scale;
                mask[y * fw + x].re = 1.;
                rates[y * fw + x].re = v;
                squares[y * fw + x].re = v * v;
            }
        }
    }
    let mut fft = Fft2::new(fw, fh);
    fft.transform(&mut mask, false);
    fft.transform(&mut rates, false);
    fft.transform(&mut squares, false);
    let counts = correlate(&mask, &mask, &mut fft);
    let cross = correlate(&rates, &rates, &mut fft);
    let sums = correlate(&rates, &mask, &mut fft);
    let ss = correlate(&squares, &mask, &mut fft);
    let at = |dx: isize, dy: isize| {
        dy.rem_euclid(fh as isize) as usize * fw + dx.rem_euclid(fw as isize) as usize
    };
    for y in 0..oh {
        for x in 0..ow {
            let (dx, dy) = (
                x as isize - width as isize + 1,
                y as isize - height as isize + 1,
            );
            let (a, b) = (at(dx, dy), at(-dx, -dy));
            let n = counts[a].round();
            if n < minimum.max(2) as f64 {
                continue;
            }
            let (va, vb) = (n * ss[a] - sums[a].powi(2), n * ss[b] - sums[b].powi(2));
            let tolerance = 1e-12 * n * n;
            if va <= tolerance || vb <= tolerance {
                continue;
            }
            let covariance = n * (cross[a] + cross[b]) / 2. - sums[a] * sums[b];
            out[y * ow + x] = (covariance / (va * vb).sqrt()).clamp(-1., 1.) as f32;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn direct(map: &[f32], w: usize, h: usize, dx: isize, dy: isize, minimum: usize) -> f32 {
        let mut pairs = vec![];
        for y in 0..h {
            for x in 0..w {
                let (xx, yy) = (x as isize + dx, y as isize + dy);
                if xx >= 0 && yy >= 0 && xx < w as isize && yy < h as isize {
                    let (a, b) = (map[y * w + x], map[yy as usize * w + xx as usize]);
                    if a.is_finite() && b.is_finite() {
                        pairs.push((a as f64, b as f64));
                    }
                }
            }
        }
        let n = pairs.len() as f64;
        if pairs.len() < minimum.max(2) {
            return f32::NAN;
        }
        let ma = pairs.iter().map(|p| p.0).sum::<f64>() / n;
        let mb = pairs.iter().map(|p| p.1).sum::<f64>() / n;
        let va = pairs.iter().map(|p| (p.0 - ma).powi(2)).sum::<f64>();
        let vb = pairs.iter().map(|p| (p.1 - mb).powi(2)).sum::<f64>();
        if va == 0. || vb == 0. {
            return f32::NAN;
        }
        (pairs.iter().map(|p| (p.0 - ma) * (p.1 - mb)).sum::<f64>() / (va * vb).sqrt()) as f32
    }
    #[test]
    fn fft_matches_pairwise_pearson_with_masks_at_every_linear_lag() {
        for (w, h) in [(7, 5), (8, 6), (1, 9)] {
            for minimum in [3, 12] {
                let map: Vec<_> = (0..w * h)
                    .map(|i| {
                        if i % 7 == 1 {
                            f32::NAN
                        } else {
                            ((i * 17 + 3) % 23) as f32
                        }
                    })
                    .collect();
                let result = autocorrelation(&map, w, h, minimum);
                for y in 0..2 * h - 1 {
                    for x in 0..2 * w - 1 {
                        let expected = direct(
                            &map,
                            w,
                            h,
                            x as isize - w as isize + 1,
                            y as isize - h as isize + 1,
                            minimum,
                        );
                        let actual = result[y * (2 * w - 1) + x];
                        assert_eq!(actual.is_nan(), expected.is_nan(), "lag {x},{y}");
                        if expected.is_finite() {
                            assert!((actual - expected).abs() < 1e-5, "{actual} != {expected}");
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn centre_symmetry_insufficient_overlap_and_constant_maps() {
        let map: Vec<_> = (0..36).map(|i| ((i * 7) % 13) as f32).collect();
        let result = autocorrelation(&map, 6, 6, 20);
        assert_eq!(result[5 * 11 + 5], 1.);
        assert!(result[0].is_nan());
        for (a, b) in result.iter().zip(result.iter().rev()) {
            assert!(a.is_nan() && b.is_nan() || (a - b).abs() < 1e-6);
        }
        assert!(autocorrelation(&[2.; 36], 6, 6, 3)
            .iter()
            .all(|v| v.is_nan()));
        assert!(autocorrelation(&[f32::NAN; 36], 6, 6, 3)
            .iter()
            .all(|v| v.is_nan()));
    }
}
