//! Continuous (LFP) signals from `.egf` files: read and decimated, band-passed with a
//! zero-phase Butterworth filter and made analytic (the Hilbert transform), as scipy would,
//! then summarised (the distribution of instantaneous frequency).
//!
//! `.egf` files hold one signed byte per sample at 5 kHz. Theta and the like need far less,
//! so samples are averaged in blocks down to about `TARGET_RATE` as they're read. A block
//! mean's response has nulls at every multiple of the new rate, which is where aliases into
//! the low-frequency bands would come from.
use rustfft::{num_complex::Complex, FftPlanner};
use sci_rs::signal::filter::{
    design::{butter_dyn, DigitalFilter, FilterBandType, FilterOutputType},
    sosfiltfilt_dyn,
};
use std::slice;

/// The rate signals are decimated to, roughly (Hz).
pub(crate) const TARGET_RATE: f64 = 250.;
/// The Butterworth band-pass's order (as scipy's `butter`), applied forwards and backwards.
const ORDER: usize = 4;

/// A continuous signal, decimated.
pub(crate) struct Signal {
    /// Samples per second.
    pub(crate) rate: f64,
    /// When sample 0 is (s): a block mean stands for its block's middle.
    pub(crate) start: f64,
    /// Raw units (int8 sample values), averaged.
    pub(crate) samples: Vec<f32>,
}

/// Decimates an `.egf` file's samples as they're streamed in.
pub struct EgfBuilder {
    factor: usize,
    rate: f64,
    sum: i32,
    count: usize,
    samples: Vec<f32>,
}
impl EgfBuilder {
    /// For `n` samples at `rate` Hz.
    pub fn new(n: usize, rate: f64) -> Self {
        let factor = ((rate / TARGET_RATE).round() as usize).max(1);
        Self {
            factor,
            rate: rate / factor as f64,
            sum: 0,
            count: 0,
            samples: Vec::with_capacity(n / factor + 1),
        }
    }
    pub fn push(&mut self, data: &[u8]) {
        for &b in data {
            self.sum += b as i8 as i32;
            self.count += 1;
            if self.count == self.factor {
                self.samples.push(self.sum as f32 / self.factor as f32);
                (self.sum, self.count) = (0, 0);
            }
        }
    }
    /// The decimated signal; a partial last block is dropped.
    pub(crate) fn finish(self) -> Signal {
        Signal {
            rate: self.rate,
            start: (self.factor - 1) as f64 / 2. / (self.rate * self.factor as f64),
            samples: self.samples,
        }
    }
}

/// The band's edges as used: positive, and at least 0.5 Hz apart, below Nyquist.
pub(crate) fn band(low: f64, high: f64, rate: f64) -> (f64, f64) {
    let nyquist = rate / 2.;
    let low = if low.is_finite() { low } else { 6. }.clamp(0.1, nyquist - 1.);
    let high = if high.is_finite() { high } else { 12. }.clamp(low + 0.5, nyquist - 0.5);
    (low, high)
}

/// The analytic signal of `signal` band-passed between `low` and `high` Hz, as
/// `scipy.signal.hilbert(scipy.signal.sosfiltfilt(scipy.signal.butter(ORDER, [low, high],
/// "bandpass", fs=rate, output="sos"), x))`: the filter and its zero-phase application come
/// from sci-rs (a port of scipy), and the Hilbert transform is scipy's, on RustFFT. Its
/// argument is the band's phase, its magnitude the band's envelope.
pub(crate) fn analytic(signal: &Signal, low: f64, high: f64) -> Vec<Complex<f32>> {
    let n = signal.samples.len();
    // sosfiltfilt pads the ends by three times the filter's length.
    if n <= 6 * (2 * ORDER + 1) {
        return vec![Complex::default(); n];
    }
    let (low, high) = band(low, high, signal.rate);
    let DigitalFilter::Sos(filter) = butter_dyn(
        ORDER,
        vec![low, high],
        Some(FilterBandType::Bandpass),
        Some(false),
        Some(FilterOutputType::Sos),
        Some(signal.rate),
    ) else {
        unreachable!("asked for second-order sections");
    };
    let filtered = sosfiltfilt_dyn(signal.samples.iter().map(|&v| v as f64), &filter.sos);
    hilbert(&filtered)
}

/// The analytic signal of `x`, as `scipy.signal.hilbert`: its spectrum with negative
/// frequencies removed and positive ones doubled.
fn hilbert(x: &[f64]) -> Vec<Complex<f32>> {
    let n = x.len();
    let mut data: Vec<Complex<f64>> = x.iter().map(|&v| Complex::new(v, 0.)).collect();
    let mut planner = FftPlanner::new();
    planner.plan_fft_forward(n).process(&mut data);
    for (k, value) in data.iter_mut().enumerate() {
        // DC (and, for even n, Nyquist) kept once; positive frequencies doubled.
        *value *= if k == 0 || 2 * k == n {
            1.
        } else if 2 * k < n {
            2.
        } else {
            0.
        };
    }
    planner.plan_fft_inverse(n).process(&mut data);
    let scale = 1. / n as f64;
    data.iter()
        .map(|z| Complex::new((z.re * scale) as f32, (z.im * scale) as f32))
        .collect()
}

/// Each sample's instantaneous frequency (Hz): the change in phase since the previous
/// sample (the first repeats the second's), which needs no unwrapping.
pub(crate) fn instantaneous_frequency(z: &[Complex<f32>], rate: f64) -> Vec<f32> {
    let k = rate / std::f64::consts::TAU;
    let mut f: Vec<f32> = z
        .windows(2)
        .map(|w| ((w[1] * w[0].conj()).arg() as f64 * k) as f32)
        .collect();
    if let Some(&first) = f.first() {
        f.insert(0, first);
    }
    f
}

/// Bins of `bin` Hz from `low` up to `high`, at least one.
pub(crate) fn frequency_bins(low: f64, high: f64, bin: f64) -> usize {
    let bin = if bin > 0. { bin } else { 0.25 };
    (((high - low) / bin).ceil() as usize).clamp(1, 10_000)
}

/// The mean instantaneous frequency of the samples within the band (`low` to `high` Hz); NaN
/// if none are. Samples outside are phase slips and the like, not the band's frequency.
pub(crate) fn mean_frequency(frequencies: &[f32], low: f64, high: f64) -> f64 {
    let (sum, n) = frequencies
        .iter()
        .map(|&f| f as f64)
        .filter(|f| (low..=high).contains(f))
        .fold((0., 0usize), |(sum, n), f| (sum + f, n + 1));
    if n > 0 {
        sum / n as f64
    } else {
        f64::NAN
    }
}

/// Seconds at each instantaneous frequency, in `bins` bins of `bin` Hz from `low`; frequencies
/// outside them aren't counted.
pub(crate) fn frequency_distribution(
    frequencies: &[f32],
    rate: f64,
    low: f64,
    bin: f64,
    bins: usize,
) -> Vec<f32> {
    let mut counts = vec![0u32; bins];
    for &f in frequencies {
        let i = (f as f64 - low) / bin;
        if i >= 0. && (i as usize) < bins {
            counts[i as usize] += 1;
        }
    }
    counts.iter().map(|&n| (n as f64 / rate) as f32).collect()
}

/// The band's phase at each spike (at `times`, in ticks of `tb`; the signal's sample 0 at
/// `start` s, and interpolated between samples),
/// counted in `bins` bins across a cycle: 0 at the band-passed signal's peaks, half a cycle
/// at its troughs. Spikes outside the signal aren't counted. Also the spikes' mean phase
/// (radians, 0 to 2π) and the mean resultant length (0, no locking, to 1).
pub(crate) fn spike_phases(
    z: &[Complex<f32>],
    rate: f64,
    start: f64,
    times: &[u32],
    tb: f64,
    bins: usize,
) -> (Vec<f32>, f64, f64) {
    let tau = std::f64::consts::TAU;
    let mut counts = vec![0f32; bins];
    let (mut sum, mut n) = (Complex::<f64>::default(), 0usize);
    for &t in times {
        let at = (t as f64 / tb - start) * rate;
        let j = at.floor();
        if j < 0. {
            continue;
        }
        let (Some(a), Some(b)) = (z.get(j as usize), z.get(j as usize + 1)) else {
            continue;
        };
        let v = a + (b - a) * (at - j) as f32;
        let norm = v.norm();
        if norm <= 0. || norm.is_nan() {
            continue;
        }
        let phase = (v.arg() as f64).rem_euclid(tau);
        counts[((phase / tau * bins as f64) as usize).min(bins - 1)] += 1.;
        sum += Complex::new(v.re as f64, v.im as f64) / norm as f64;
        n += 1;
    }
    let mean = if n > 0 { sum / n as f64 } else { sum };
    (counts, mean.arg().rem_euclid(tau), mean.norm())
}

/// A builder to stream an `.egf` file's samples into (`egf_push`), then hand to the compute
/// graph (`compute_supply_egf`) or free.
#[no_mangle]
pub extern "C" fn egf_new(n: usize, rate: f64) -> *mut EgfBuilder {
    Box::into_raw(Box::new(EgfBuilder::new(n, rate)))
}
#[no_mangle]
pub unsafe extern "C" fn egf_push(p: *mut EgfBuilder, data: *const u8, n: usize) {
    (*p).push(slice::from_raw_parts(data, n));
}
#[no_mangle]
pub unsafe extern "C" fn egf_free(p: *mut EgfBuilder) {
    drop(Box::from_raw(p));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    /// `seconds` of a signal at 5 kHz, as `.egf` bytes, through the builder.
    fn egf(seconds: f64, f: impl Fn(f64) -> f64) -> Signal {
        let n = (seconds * 5000.) as usize;
        let bytes: Vec<u8> = (0..n)
            .map(|i| f(i as f64 / 5000.).round().clamp(-128., 127.) as i8 as u8)
            .collect();
        let mut b = EgfBuilder::new(n, 5000.);
        // In uneven chunks, as files are streamed.
        for chunk in bytes.chunks(777) {
            b.push(chunk);
        }
        b.finish()
    }

    #[test]
    fn decimates_by_block_means_to_about_250_hz() {
        let s = egf(2., |t| if t < 1. { 10. } else { -20. });
        assert_eq!(s.rate, 250.);
        assert_eq!(s.samples.len(), 500);
        assert_eq!((s.samples[0], s.samples[499]), (10., -20.));
    }

    #[test]
    fn a_theta_sine_keeps_its_phase_and_frequency_and_loses_what_is_outside_the_band() {
        // 8 Hz theta, a 1.5 Hz delta wave and 60 Hz mains, with a DC offset.
        let s = egf(30., |t| {
            5. + 40. * (TAU * 8. * t).sin()
                + 30. * (TAU * 1.5 * t).sin()
                + 20. * (TAU * 60. * t).sin()
        });
        let z = analytic(&s, 6., 12.);
        assert_eq!(z.len(), s.samples.len());
        // Away from the ends: the envelope is theta's amplitude (a Butterworth band-pass
        // passes its band's geometric centre, ~8.5 Hz, fully and 8 Hz all but fully), and
        // the phase theta's (a sine is a cosine a quarter cycle late), with no lag.
        let gain = 1.;
        let block = 5000. / s.rate;
        for (i, v) in z.iter().enumerate().skip(500).take(6000) {
            // Each decimated sample is the mean over its block, centred half a block in.
            let t = (i as f64 * block + (block - 1.) / 2.) / 5000.;
            let expected = 40. * gain as f32;
            assert!(
                (v.norm() - expected).abs() < 1.,
                "envelope {} at {t}",
                v.norm()
            );
            let expected = TAU * 8. * t - TAU / 4.;
            let error = (v.arg() as f64 - expected).rem_euclid(TAU);
            let error = error.min(TAU - error);
            assert!(error < 0.06, "phase error {error} at {t}");
        }
        let f = instantaneous_frequency(&z, s.rate);
        let middle = &f[500..f.len() - 500];
        assert!(middle.iter().all(|&f| (f - 8.).abs() < 0.2), "frequency");
        // So all of that time is in the bin holding 8 Hz (7.8 to 8.1 Hz).
        let bins = frequency_bins(6., 12., 0.3);
        assert_eq!(bins, 20);
        let d = frequency_distribution(middle, s.rate, 6., 0.3, bins);
        let total: f32 = d.iter().sum();
        assert!(d[6] / total > 0.99, "{d:?}");
        assert!((total - middle.len() as f32 / 250.).abs() < 1e-3);
    }

    #[test]
    fn a_wandering_frequency_spreads_over_the_band_it_wanders_through() {
        // The synthetic data's theta: 7.3 Hz ± 0.4 Hz over 37 s.
        let phase = |t: f64| TAU * (7.3 * t - 0.4 * 37. / TAU * (TAU * t / 37.).cos());
        let s = egf(120., |t| 50. * phase(t).sin());
        let z = analytic(&s, 6., 12.);
        let f = instantaneous_frequency(&z, s.rate);
        let middle = &f[500..f.len() - 500];
        let (lo, hi) = middle
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), &f| (a.min(f), b.max(f)));
        assert!(
            (lo - 6.9).abs() < 0.1 && (hi - 7.7).abs() < 0.1,
            "{lo}..{hi}"
        );
    }

    #[test]
    fn matches_scipy() {
        // hilbert(sosfiltfilt(butter(4, [6, 12], "bandpass", fs=250, output="sos"), x)) from
        // scipy 1.18.1, for this x.
        let samples = (0..401)
            .map(|i| {
                let i = i as f64;
                (30. * (i * 0.21).sin() + ((i as u32 * 7919) % 23) as f64 - 11.
                    + 8. * (i * 0.9).sin()) as f32
            })
            .collect();
        let z = analytic(
            &Signal {
                rate: 250.,
                start: 0.,
                samples,
            },
            6.,
            12.,
        );
        for (k, re, im) in [
            (0, 2.6675478152771515, -15.66536771177704),
            (57, -17.206623294574353, -22.95641861108946),
            (200, -27.080330976208565, 12.650077757881988),
            (343, 9.55546744264218, 30.92142946786931),
            (400, 2.940765993385676, -9.760895634634114),
        ] {
            let error = (z[k] - Complex::new(re as f32, im as f32)).norm();
            assert!(error < 1e-3, "sample {k}: {} vs {re}{im:+}i", z[k]);
        }
    }

    #[test]
    fn spikes_at_the_peaks_of_theta_lock_at_zero_phase() {
        // 8 Hz theta, spikes (1 kHz ticks) at every peak and half of them a quarter cycle on.
        let s = egf(20., |t| 40. * (TAU * 8. * t).cos());
        let z = analytic(&s, 6., 12.);
        let peaks: Vec<u32> = (16..144).map(|k| k * 125).collect();
        let (counts, mean, r) = spike_phases(&z, s.rate, s.start, &peaks, 1000., 12);
        assert_eq!(counts.iter().sum::<f32>(), 128.);
        // Peaks are 0, in the first or (just below 2π) last bin.
        assert_eq!(counts[0] + counts[11], 128.);
        let mean = mean.min(TAU - mean);
        assert!(mean < 0.1 && r > 0.99, "{mean} {r}");
        let mixed: Vec<u32> = peaks.iter().flat_map(|&t| [t, t + 31]).collect();
        let (counts, _, r) = spike_phases(&z, s.rate, s.start, &mixed, 1000., 12);
        assert!(counts[2] + counts[3] > 100.);
        assert!((r - 0.5f64.sqrt()).abs() < 0.05, "{r}");
        // Spikes after the signal ends, or before its first sample, are left out.
        assert_eq!(
            spike_phases(&z, s.rate, s.start, &[1_000_000, 0], 1000., 12)
                .0
                .iter()
                .sum::<f32>(),
            0.
        );
    }

    #[test]
    fn the_mean_frequency_leaves_out_what_is_outside_the_band() {
        assert_eq!(mean_frequency(&[7., 8., -3., 40., 9.], 6., 12.), 8.);
        assert!(mean_frequency(&[1., 2.], 6., 12.).is_nan());
    }

    #[test]
    fn band_edges_are_kept_sensible() {
        assert_eq!(band(6., 12., 250.), (6., 12.));
        assert_eq!(band(10., 8., 250.), (10., 10.5));
        assert_eq!(band(f64::NAN, 500., 250.), (6., 124.5));
        assert_eq!(frequency_bins(6., 12., 0.), 24);
    }
}
