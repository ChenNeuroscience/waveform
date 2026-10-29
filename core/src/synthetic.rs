//! Seeded virtual LTX recordings. Any record can be regenerated independently.
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
    slice,
    sync::OnceLock,
};
thread_local! {
    // Shared source data in the existing Wasm instance; this starts no threads.
    static TRAJECTORIES: RefCell<HashMap<(u32, usize), Weak<Vec<[u16; 5]>>>> = RefCell::new(HashMap::new());
}
const VARIANTS: usize = 16;
/// Position ticks are 20 ms (1,920 timestamp units at 96 kHz).
const DT: f64 = 0.02;
const TICK: u32 = 1920;
const GRID: usize = 32;
/// Shared theta rhythm phase (radians) at time `t` seconds: about 7.3 Hz, with the
/// frequency wandering ±0.4 Hz over a 37 s cycle.
fn theta(t: f64) -> f64 {
    let tau = std::f64::consts::TAU;
    tau * (7.3 * t - 0.4 * 37. / tau * (tau * t / 37.).cos())
}
const NOISE: usize = 1 << 16;
/// Template samples per channel: 50 plus one edge copy at each end, so sub-sample
/// jitter interpolation reads contiguous slices without clamping.
const PADDED: usize = 52;
const TEMPLATE: usize = 4 * PADDED;
/// Unit-RMS background noise shared by every recording: Gaussian white noise through
/// the acquisition band-pass (two 6 kHz low-pass poles, one 300 Hz high-pass pole at
/// 48 kHz), so it is smooth over a few samples like real filtered tetrode noise.
/// Spikes read random windows of it, keeping generation one lookup per sample.
fn noise_table() -> &'static [f32] {
    static TABLE: OnceLock<Vec<f32>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let tau = std::f64::consts::TAU;
        let (low, high) = (
            1. - (-tau * 6000. / 48000.).exp(),
            1. - (-tau * 300. / 48000.).exp(),
        );
        let (mut a, mut b, mut slow) = (0., 0., 0.);
        let mut out: Vec<f64> = (0..NOISE + 4096)
            .map(|i| {
                let u1 = (hash(i as u32 * 2 + 1) as f64 + 1.) / 4294967297.;
                let u2 = hash(i as u32 * 2 + 2) as f64 / 4294967296.;
                let white = (-2. * u1.ln()).sqrt() * (tau * u2).cos();
                a += (white - a) * low;
                b += (a - b) * low;
                slow += (b - slow) * high;
                b - slow
            })
            .skip(4096) // Discard the filters' start-up transient.
            .collect();
        let rms = (out.iter().map(|v| v * v).sum::<f64>() / NOISE as f64).sqrt();
        out.iter_mut().for_each(|v| *v /= rms);
        out.into_iter().map(|v| v as f32).collect()
    })
}
fn unit(x: u32) -> f32 {
    x as f32 / 4294967296.
}
/// Approximately standard normal (Irwin-Hall over the hash's four bytes).
fn normal(x: u32) -> f32 {
    (x.to_le_bytes().iter().map(|&b| b as f32).sum::<f32>() / 255. - 2.) * 3f32.sqrt()
}
fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^ (x >> 16)
}
/// LED positions (x1, y1, x2, y2 in 300 px/m) plus the true heading (0..65536 = 0..360°).
fn trajectory(seed: u32, duration: usize) -> Vec<[u16; 5]> {
    // A 50 Hz correlated walk. Low-occupancy 10 cm squares attract exploration,
    // while angular inertia, noise, speed changes and pauses keep motion varied.
    let mut state = seed;
    let mut random = || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        (state >> 8) as f64 / 16777216.
    };
    let (mut x, mut y) = (0.4 + 0.2 * random(), 0.4 + 0.2 * random());
    let mut heading = random() * std::f64::consts::TAU;
    let (mut speed, mut target_speed, mut turn) = (0.12f64, 0.18f64, 0f64);
    let (mut pause, mut target_ticks) = (0usize, 0usize);
    let (mut target_x, mut target_y) = (0.5f64, 0.5f64);
    let mut visits = [0u32; 100];
    let mut positions = Vec::with_capacity(duration * 50);
    for step in 0..duration * 50 {
        let bin_x = ((x * 10.) as usize).min(9);
        let bin_y = ((y * 10.) as usize).min(9);
        visits[bin_x + bin_y * 10] += 1;
        if target_ticks == 0 || (target_x - x).hypot(target_y - y) < 0.035 {
            let mut best = f64::INFINITY;
            for (bin, &count) in visits.iter().enumerate() {
                let tx = (bin % 10) as f64 / 10. + 0.015 + random() * 0.07;
                let ty = (bin / 10) as f64 / 10. + 0.015 + random() * 0.07;
                let score = count as f64 + 75. * (tx - x).hypot(ty - y) + random() * 25.;
                if score < best {
                    best = score;
                    target_x = tx;
                    target_y = ty;
                }
            }
            target_ticks = 50 + (random() * 100.) as usize;
        }
        target_ticks -= 1;
        if step % 35 == 0 {
            target_speed = 0.06 + 0.24 * random();
        }
        if pause == 0 && random() < 0.0006 {
            pause = ((0.4 + 2.1 * random()) * 50.) as usize;
        }
        let look_x = x + heading.cos() * speed * 0.18;
        let look_y = y + heading.sin() * speed * 0.18;
        let wall_x = ((0.04 - look_x).max(0.) - (look_x - 0.96).max(0.)) * 18.;
        let wall_y = ((0.04 - look_y).max(0.) - (look_y - 0.96).max(0.)) * 18.;
        let distance = (target_x - x).hypot(target_y - y).max(0.001);
        let wanted = ((target_y - y) / distance + heading.sin() * 0.3 + wall_y)
            .atan2((target_x - x) / distance + heading.cos() * 0.3 + wall_x);
        let delta = (wanted - heading + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU)
            - std::f64::consts::PI;
        turn += ((delta * 3.).clamp(-3., 3.) - turn) * 0.1 + (random() - 0.5) * 0.3;
        heading += turn * 0.02;
        let desired_speed = if pause > 0 {
            pause -= 1;
            0.
        } else {
            target_speed * (1. - 0.6 * wall_x.hypot(wall_y).min(1.))
        };
        speed = (speed + (desired_speed - speed) * 0.04).clamp(0., 0.35);
        x += heading.cos() * speed * 0.02;
        y += heading.sin() * speed * 0.02;
        if !(0.025..=0.975).contains(&x) {
            x = x.clamp(0.025, 0.975);
            heading = std::f64::consts::PI - heading;
        }
        if !(0.025..=0.975).contains(&y) {
            y = y.clamp(0.025, 0.975);
            heading = -heading;
        }
        heading = heading.rem_euclid(std::f64::consts::TAU);
        let jitter_x = (random() - 0.5) * 0.003;
        let jitter_y = (random() - 0.5) * 0.003;
        positions.push([
            ((x + jitter_x) * 300.).round() as u16,
            ((y + jitter_y) * 300.).round() as u16,
            ((x + heading.cos() * 0.02 + jitter_x) * 300.).round() as u16,
            ((y + heading.sin() * 0.02 + jitter_y) * 300.).round() as u16,
            (heading / std::f64::consts::TAU * 65536.) as u16,
        ]);
    }
    positions
}

/// A cell's firing rate (Hz) as a function of position or heading, as a lookup table.
enum Tuning {
    /// Gaussian place field over a GRID x GRID map of the 1 m arena.
    Place(Vec<f32>),
    Grid(Vec<f32>),
    /// Gaussian head-direction tuning over 360 one-degree bins.
    Direction(Vec<f32>),
    Flat(f32),
}

struct GridSpec {
    spacing: f32,
    orientation: f32,
    phase: [f32; 2],
    baseline: f32,
    peak: f32,
}

/// Keep grid membership stable across trials, including both sorted cells on T7.
fn grid_cells(family: u32, tetrode: u32, cells: usize) -> Vec<bool> {
    let mut selected = vec![false; cells + 1];
    if !(5..=8).contains(&tetrode) {
        return selected;
    }
    let count = if tetrode == 7 {
        2
    } else {
        2 + hash(family ^ tetrode.wrapping_mul(131) ^ 0x6a1d) as usize % 4
    };
    let mut candidates: Vec<_> = (1..=cells).collect();
    if tetrode != 7 {
        candidates.sort_by_key(|&cell| {
            hash(family ^ tetrode.wrapping_mul(131) ^ (cell as u32).wrapping_mul(977))
        });
    }
    for cell in candidates.into_iter().take(count) {
        selected[cell] = true;
    }
    selected
}
impl GridSpec {
    fn rate(&self, x: f32, y: f32) -> f32 {
        let (sin, cos) = self.orientation.sin_cos();
        let rx = (x * cos + y * sin) / self.spacing;
        let ry = (-x * sin + y * cos) / self.spacing;
        // Invert the 60-degree lattice basis, then wrap into its unit phase tile.
        let v = ry / (3f32.sqrt() / 2.);
        let u = (rx - v / 2. - self.phase[0]).rem_euclid(1.);
        let v = (v - self.phase[1]).rem_euclid(1.);
        // The phase tile is oblique: use physical distance to the nearest periodic
        // image, so fields are circular and remain continuous across tile edges.
        let mut distance = f32::INFINITY;
        for a in [-1., 0., 1.] {
            for b in [-1., 0., 1.] {
                let (du, dv) = (u + a, v + b);
                distance = distance.min(du * du + du * dv + dv * dv);
            }
        }
        self.baseline + self.peak * (-distance / (2. * 0.13f32.powi(2))).exp()
    }
}
fn grid_spec(family: u32, trial_seed: u32, tetrode: u32, cell: usize) -> GridSpec {
    let r = |k: u32| {
        unit(hash(
            family ^ tetrode.wrapping_mul(131) ^ (cell as u32).wrapping_mul(977) ^ k,
        ))
    };
    let orientation = unit(hash(family ^ 0x6a01)) * std::f32::consts::PI / 3.
        + (unit(hash(trial_seed ^ 0x6a02)) - 0.5) * std::f32::consts::PI / 30.;
    let base = 0.36 * (0.97 + 0.06 * unit(hash(trial_seed ^ 0x6a03)));
    GridSpec {
        spacing: base * 1.4f32.powi(tetrode.saturating_sub(5) as i32),
        orientation,
        phase: [r(0x6a04), r(0x6a05)],
        baseline: 0.05 + 0.25 * r(0x6a06),
        peak: 4. + 16. * r(0x6a07),
    }
}
pub struct Synthetic {
    seed: u32,
    cells: usize,
    total: usize,
    positions: Rc<Vec<[u16; 5]>>,
    tunings: Vec<Tuning>,
    /// Per-cell theta modulation: depth m and m·cos/m·sin of the preferred phase, so
    /// rate × (1 + m·cos(theta − phase)) needs one sin/cos per tick, not per cell.
    modulation: Vec<[f32; 4]>,
    /// Spikes before each position tick; tick t holds starts[t]..starts[t + 1].
    starts: Vec<u32>,
    waves: Vec<i8>,
    drift: Vec<f32>,
    /// Per-channel fractional amplitude change over the whole session. Non-zero for
    /// one or two cells per tetrode, as when the electrode moves relative to a cell;
    /// unequal channels move the cluster across the feature projections.
    trend: Vec<[f32; 4]>,
}
fn tuning(seed: u32, cell: usize, tetrode: u32) -> Tuning {
    let r = |k: u32| {
        unit(hash(
            seed ^ 0x7a11 ^ (cell as u32).wrapping_mul(977) ^ k << 24,
        ))
    };
    match hash(seed ^ 0x3c6e ^ cell as u32) % 4 {
        0 | 1 => {
            let (cx, cy) = (0.1 + 0.8 * r(1), 0.1 + 0.8 * r(2));
            let peak = 4. + 16. * r(4);
            // Broader fields and substantial background activity make the
            // non-grid spatial cells on T5–8 less sharply tuned.
            let (sigma, base) = if (5..=8).contains(&tetrode) {
                (0.16 + 0.12 * r(3), peak * (0.2 + 0.2 * r(5)))
            } else {
                (0.07 + 0.08 * r(3), 0.05 + 0.25 * r(5))
            };
            Tuning::Place(
                (0..GRID * GRID)
                    .map(|i| {
                        let x = ((i % GRID) as f32 + 0.5) / GRID as f32 - cx;
                        let y = ((i / GRID) as f32 + 0.5) / GRID as f32 - cy;
                        base + peak * (-(x * x + y * y) / (2. * sigma * sigma)).exp()
                    })
                    .collect(),
            )
        }
        2 => {
            // Tuning width (full width at half maximum) between 30 and 180 degrees.
            let (preferred, width) = (360. * r(1), 30. + 150. * r(2));
            let sigma = width / 2.355;
            let (peak, base) = (3. + 12. * r(3), 0.1 + 0.4 * r(4));
            Tuning::Direction(
                (0..360)
                    .map(|d| {
                        let delta = (d as f32 + 0.5 - preferred + 540.).rem_euclid(360.) - 180.;
                        base + peak * (-delta * delta / (2. * sigma * sigma)).exp()
                    })
                    .collect(),
            )
        }
        _ => Tuning::Flat(0.3 + 5.7 * r(1)),
    }
}
/// Poisson count by inversion; `u` is uniform on [0, 1).
fn poisson(mean: f64, u: f64) -> u32 {
    let (mut k, mut p) = (0, (-mean).exp());
    let mut cdf = p;
    while u > cdf && k < 1000 {
        k += 1;
        p *= mean / k as f64;
        cdf += p;
    }
    k
}
impl Synthetic {
    fn new(seed: u32, cells: usize, total: usize, duration: usize, tetrode: u32) -> Self {
        Self::new_trial(seed, 0, cells, total, duration, tetrode)
    }
    fn new_trial(
        family: u32,
        trial: u32,
        cells: usize,
        total: usize,
        duration: usize,
        tetrode: u32,
    ) -> Self {
        let seed = family.wrapping_add(trial.wrapping_mul(173));
        let cells = cells.clamp(1, 100);
        let positions = TRAJECTORIES.with(|cache| {
            let mut cache = cache.borrow_mut();
            if let Some(existing) = cache.get(&(seed, duration)).and_then(Weak::upgrade) {
                return existing;
            }
            let positions = Rc::new(trajectory(seed, duration));
            cache.insert((seed, duration), Rc::downgrade(&positions));
            positions
        });
        let seed = hash(seed ^ tetrode.wrapping_mul(131));
        let mut waves = vec![0; (cells + 1) * VARIANTS * TEMPLATE];
        for cell in 0..=cells {
            let polarity = if hash(seed ^ cell as u32) & 1 == 0 {
                1.
            } else {
                -1.
            };
            // Later variants are attenuated, slightly wider and later, like spikes
            // late in a complex-spike burst.
            for variation in 0..VARIANTS {
                let v = variation as f64;
                for channel in 0..4 {
                    let h = hash(
                        seed ^ (cell as u32).wrapping_mul(701)
                            ^ (channel as u32).wrapping_mul(31337),
                    );
                    let amplitude = if cell == 0 { 6. } else { 18. + (h % 85) as f64 };
                    let peak = 13. + ((h >> 12) % 4) as f64 * 0.5 + v * 0.04;
                    let width = (2.4 + ((h >> 16) % 8) as f64 * 0.12) * (1. + v * 0.02);
                    for k in 0..PADDED {
                        let t = k.clamp(1, 50) as f64 - 1.;
                        let shape = (-((t - peak) / width).powi(2)).exp()
                            - 0.35 * (-((t - peak - 8.) / 5.5).powi(2)).exp();
                        waves[(cell * VARIANTS + variation) * TEMPLATE + channel * PADDED + k] =
                            (polarity * amplitude * (1. - v * 0.025) * shape).round() as i8;
                    }
                }
            }
        }
        let drift = (0..=cells)
            .map(|cell| unit(hash(seed ^ 0xd1f7 ^ cell as u32)) * std::f32::consts::TAU)
            .collect();
        let mut trend = vec![[0f32; 4]; cells + 1];
        for k in 0..1 + (hash(seed ^ 0xd21f) & 1) {
            let cell = 1 + hash(seed ^ 0xd220 ^ k) as usize % cells;
            for (channel, t) in trend[cell].iter_mut().enumerate() {
                *t = (unit(hash(seed ^ 0xd230 ^ (k * 4 + channel as u32))) - 0.5) * 0.5;
            }
            // One channel changes strongly (±35-55%), so the drift is easy to see.
            let strong = hash(seed ^ 0xd240 ^ k) as usize % 4;
            let size = 0.35 + 0.2 * unit(hash(seed ^ 0xd250 ^ k));
            trend[cell][strong] = if hash(seed ^ 0xd260 ^ k) & 1 == 0 {
                size
            } else {
                -size
            };
        }
        noise_table();
        let grid_cells = grid_cells(family, tetrode, cells);
        let mut synthetic = Self {
            seed,
            cells,
            total,
            positions,
            tunings: (0..=cells)
                .map(|cell| {
                    if grid_cells[cell] {
                        let spec = grid_spec(
                            family,
                            family.wrapping_add(trial.wrapping_mul(173)),
                            tetrode,
                            cell,
                        );
                        Tuning::Grid(
                            (0..GRID * GRID)
                                .map(|i| {
                                    spec.rate(
                                        ((i % GRID) as f32 + 0.5) / GRID as f32,
                                        ((i / GRID) as f32 + 0.5) / GRID as f32,
                                    )
                                })
                                .collect(),
                        )
                    } else {
                        tuning(seed, cell, tetrode)
                    }
                })
                .collect(),
            modulation: (0..=cells)
                .map(|cell| {
                    let r = |k: u32| {
                        unit(hash(
                            seed ^ 0x7e7a ^ (cell as u32).wrapping_mul(613) ^ k << 24,
                        ))
                    };
                    // Mostly weak, sometimes strong; noise events are unmodulated.
                    let depth = if cell == 0 { 0. } else { 0.9 * r(1).powf(1.6) };
                    let phase = r(2) * std::f32::consts::TAU;
                    [depth, depth * phase.cos(), depth * phase.sin(), phase]
                })
                .collect(),
            starts: vec![],
            waves,
            drift,
            trend,
        };
        synthetic.spike_counts();
        synthetic
    }
    /// Firing rates at a position tick, as a running sum over cells (for sampling
    /// which cell fired); returns the total rate.
    fn rates(&self, tick: usize, cumulative: &mut Vec<f32>) -> f32 {
        let p = self.positions[tick];
        let bin = (p[0] as usize * GRID / 300).min(GRID - 1)
            + (p[1] as usize * GRID / 300).min(GRID - 1) * GRID;
        let degree = p[4] as usize * 360 >> 16;
        let (sin, cos) = (theta((tick as f64 + 0.5) * DT) as f32).sin_cos();
        cumulative.clear();
        let mut sum = 0.;
        for (t, [_, a, b, _]) in self.tunings.iter().zip(&self.modulation) {
            sum += match t {
                Tuning::Place(map) | Tuning::Grid(map) => map[bin],
                Tuning::Direction(curve) => curve[degree],
                Tuning::Flat(rate) => *rate,
            } * (1. + a * cos + b * sin);
            cumulative.push(sum);
        }
        sum
    }
    /// Inhomogeneous Poisson spike counts per tick, with rates scaled so the
    /// expected total is the requested `total`. The actual total varies around it.
    fn spike_counts(&mut self) {
        let ticks = self.positions.len();
        let mut cumulative = Vec::with_capacity(self.cells + 1);
        // Noise events (cell 0) are about 5% of all spikes.
        self.tunings[0] = Tuning::Flat(0.);
        let mut expected: Vec<f64> = (0..ticks)
            .map(|t| self.rates(t, &mut cumulative) as f64)
            .collect();
        let noise = expected.iter().sum::<f64>() / ticks.max(1) as f64 * 0.05 / 0.95;
        self.tunings[0] = Tuning::Flat(noise as f32);
        expected.iter_mut().for_each(|r| *r = (*r + noise) * DT);
        let scale = self.total as f64 / expected.iter().sum::<f64>();
        self.starts = std::iter::once(0)
            .chain(expected.iter().enumerate().scan(0u32, |sum, (t, &e)| {
                let u = unit(hash(self.seed ^ hash(t as u32 ^ 0x9015))) as f64;
                *sum += poisson(e * scale, u);
                Some(*sum)
            }))
            .collect();
        self.total = *self.starts.last().unwrap() as usize;
    }
    /// Visit spikes first..first+n in time order as (index, cell, timestamp). Each
    /// spike in a tick picks a cell by rate share, then an offset within the tick by
    /// rejection against that cell's theta modulation.
    fn each_spike(&self, first: usize, n: usize, mut f: impl FnMut(usize, usize, u32)) {
        let end = first + n;
        let mut tick = self.starts.partition_point(|&s| s as usize <= first) - 1;
        let mut cumulative = Vec::with_capacity(self.cells + 1);
        let mut spikes: Vec<(u32, usize)> = vec![];
        let mut index = first;
        while index < end {
            let (a, b) = (self.starts[tick] as usize, self.starts[tick + 1] as usize);
            if b > index {
                let sum = self.rates(tick, &mut cumulative);
                spikes.clear();
                for j in 0..b - a {
                    let mut h =
                        hash(self.seed ^ hash(tick as u32) ^ (j as u32).wrapping_mul(0x2545f491));
                    let u = unit(hash(h)) * sum;
                    let cell = cumulative.partition_point(|&c| c <= u).min(self.cells);
                    let [depth, .., phase] = self.modulation[cell];
                    let mut offset = unit(h);
                    for _ in 0..16 {
                        let t = (tick as f64 + offset as f64) * DT;
                        let accept = (1. + depth * (theta(t) as f32 - phase).cos()) / (1. + depth);
                        if unit(hash(h ^ 0xacce)) < accept {
                            break;
                        }
                        h = hash(h);
                        offset = unit(h);
                    }
                    spikes.push(((offset * TICK as f32) as u32, cell));
                }
                spikes.sort_unstable();
                for (j, &(offset, cell)) in spikes.iter().enumerate().take(end - a).skip(index - a)
                {
                    f(a + j, cell, tick as u32 * TICK + offset);
                }
                index = b.min(end);
            }
            tick += 1;
        }
    }
    fn records(&self, first: usize, output: &mut [u8]) {
        let table = noise_table();
        let window = |x: u32| &table[x as usize % (NOISE - 50)..][..50];
        let mut overlay = [0f32; 50];
        self.each_spike(first, output.len() / 216, |index, cell, ticks| {
            let record = &mut output[(index - first) * 216..][..216];
            let h = hash(self.seed.wrapping_add(index as u32).wrapping_add(0x12345));
            let r = |k: u32| hash(h ^ k.wrapping_mul(0x9e3779b9));
            // About one spike in six falls late in a burst.
            let variant = if r(1) % 6 == 0 {
                6 + r(2) as usize % 10
            } else {
                r(2) as usize % 4
            };
            let template = &self.waves[(cell * VARIANTS + variant) * TEMPLATE..][..TEMPLATE];
            // Slow per-cell drift over the session and small per-spike gain jitter.
            let phase = index as f32 / self.total as f32;
            let gain = (1. + 0.08 * (std::f32::consts::TAU * 1.5 * phase + self.drift[cell]).sin())
                * (1. + 0.05 * normal(r(3)));
            // Sub-sample trigger jitter (±0.45 samples) puts most spread on the flanks.
            let jitter = (unit(r(4)) - 0.5) * 0.9;
            let (start, frac) = ((jitter.floor() + 1.) as usize, jitter - jitter.floor());
            // Log-normal noise level gives heavy tails; noise events are noisier.
            let level = 5.5 * (0.35 * normal(r(5))).exp() * if cell == 0 { 2. } else { 1. };
            let common: &[f32; 50] = window(r(6)).try_into().unwrap();
            // Occasional overlapping spike from another unit at a random offset.
            let overlap = (r(11) % if cell == 0 { 6 } else { 25 } == 0).then(|| {
                let other = r(12) as usize % (self.cells + 1);
                (
                    &self.waves[other * VARIANTS * TEMPLATE..][..TEMPLATE],
                    (r(13) % 60) as isize - 20,
                    0.2 + 0.4 * unit(r(14)),
                )
            });
            for channel in 0..4 {
                let p = channel * 54;
                record[p..p + 4].copy_from_slice(&ticks.to_be_bytes());
                let wave = &template[channel * PADDED..][..PADDED];
                let gain = gain * (1. + self.trend[cell][channel] * (phase - 0.5));
                overlay.fill(0.);
                if let Some((other, offset, amp)) = overlap {
                    for (t, o) in overlay.iter_mut().enumerate() {
                        let u = t as isize - offset;
                        if (0..50).contains(&u) {
                            *o = amp * other[channel * PADDED + 1 + u as usize] as f32;
                        }
                    }
                }
                let out: &mut [u8; 50] = (&mut record[p + 4..p + 54]).try_into().unwrap();
                let own: &[f32; 50] = window(r(7 + channel as u32)).try_into().unwrap();
                let lo: &[i8; 50] = wave[start..start + 50].try_into().unwrap();
                let hi: &[i8; 50] = wave[start + 1..start + 51].try_into().unwrap();
                for t in 0..50 {
                    let (l, u) = (lo[t] as f32, hi[t] as f32);
                    let v = gain * (l + (u - l) * frac)
                        + level * (0.45 * common[t] + 0.9 * own[t])
                        + overlay[t];
                    // `round_ties_even` is one Wasm instruction (`round` is a libm call); the
                    // saturating float-to-int cast also clips like the ADC.
                    out[t] = v.round_ties_even() as i8 as u8;
                }
            }
        });
    }
}
#[no_mangle]
pub extern "C" fn synthetic_new(
    seed: u32,
    cells: usize,
    total: usize,
    duration: usize,
    tetrode: u32,
) -> *mut Synthetic {
    if total == 0 || total > 20_000_000 || duration == 0 || duration > 36000 {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(Synthetic::new(
        seed, cells, total, duration, tetrode,
    )))
}
/// Trial-specific trajectories and grid geometry, with stable module/cell identities.
#[no_mangle]
pub extern "C" fn synthetic_new_trial(
    seed: u32,
    trial: u32,
    cells: usize,
    total: usize,
    duration: usize,
    tetrode: u32,
) -> *mut Synthetic {
    if total == 0 || total > 20_000_000 || duration == 0 || duration > 36000 {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(Synthetic::new_trial(
        seed, trial, cells, total, duration, tetrode,
    )))
}
/// The simulated spike count (Poisson, so close to but not exactly the requested total).
#[no_mangle]
pub unsafe extern "C" fn synthetic_spikes(s: *const Synthetic) -> usize {
    (*s).total
}
#[no_mangle]
pub unsafe extern "C" fn synthetic_free(s: *mut Synthetic) {
    drop(Box::from_raw(s));
}
#[no_mangle]
pub unsafe extern "C" fn synthetic_records(
    s: *const Synthetic,
    first: usize,
    n: usize,
    out: *mut u8,
) {
    let s = &*s;
    assert!(first <= s.total && n <= s.total - first);
    s.records(first, slice::from_raw_parts_mut(out, n * 216));
}
/// Cut labels for a range. With `keep` > 0 only cells 1..=keep are sorted and all
/// other spikes stay in noise group 0, like a partially cut tetrode.
#[no_mangle]
pub unsafe extern "C" fn synthetic_cut(
    s: *const Synthetic,
    first: usize,
    n: usize,
    out: *mut u8,
    keep: usize,
) {
    let s = &*s;
    assert!(first <= s.total && n <= s.total - first);
    let output = slice::from_raw_parts_mut(out, n * 4);
    s.each_spike(first, n, |index, cell, _| {
        let cell = if keep == 0 || cell <= keep { cell } else { 0 };
        output[(index - first) * 4..][..4].copy_from_slice(&[
            b'0' + (cell / 100) as u8,
            b'0' + (cell / 10 % 10) as u8,
            b'0' + (cell % 10) as u8,
            b' ',
        ]);
    });
}
#[no_mangle]
pub unsafe extern "C" fn synthetic_position(s: *const Synthetic, out: *mut u8) {
    let s = &*s;
    let output = slice::from_raw_parts_mut(out, s.positions.len() * 20);
    output.fill(0);
    for (i, record) in output.chunks_exact_mut(20).enumerate() {
        record[..4].copy_from_slice(&(i as u32 * 1920).to_be_bytes());
        for channel in 0..4 {
            record[4 + channel * 2..6 + channel * 2]
                .copy_from_slice(&s.positions[i][channel].to_be_bytes());
        }
        record[12..14].copy_from_slice(&12u16.to_be_bytes());
        record[14..16].copy_from_slice(&8u16.to_be_bytes());
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn later_tetrodes_have_broader_place_fields_and_higher_background() {
        let mut places = 0;
        for cell in 1..=48 {
            match (tuning(4271, cell, 1), tuning(4271, cell, 5)) {
                (Tuning::Place(sharp), Tuning::Place(diffuse)) => {
                    places += 1;
                    let minimum = diffuse.iter().copied().fold(f32::INFINITY, f32::min);
                    let maximum = diffuse.iter().copied().fold(0., f32::max);
                    assert!(minimum > maximum * 0.16);
                    assert!(diffuse.iter().zip(&sharp).all(|(a, b)| a > b));
                    let half_area = |map: &[f32]| {
                        let low = map.iter().copied().fold(f32::INFINITY, f32::min);
                        let high = map.iter().copied().fold(0., f32::max);
                        map.iter().filter(|&&v| v > (low + high) / 2.).count()
                    };
                    assert!(half_area(&diffuse) > half_area(&sharp));
                }
                (Tuning::Direction(a), Tuning::Direction(b)) => assert_eq!(a, b),
                (Tuning::Flat(a), Tuning::Flat(b)) => assert_eq!(a, b),
                _ => panic!("Only the sharpness of place tuning should change"),
            }
        }
        assert!(places > 10);
    }
    #[test]
    fn only_a_few_grid_cells_are_selected_and_membership_survives_trial_changes() {
        for family in [9, 4271, 1729] {
            for tetrode in 1..=8 {
                let membership = grid_cells(family, tetrode, 12);
                let n = membership.iter().filter(|&&selected| selected).count();
                if tetrode < 5 {
                    assert_eq!(n, 0);
                } else {
                    assert!((2..=5).contains(&n));
                    for trial in 0..3 {
                        let s = Synthetic::new_trial(family, trial, 12, 500, 10, tetrode);
                        let actual: Vec<_> = s
                            .tunings
                            .iter()
                            .map(|t| matches!(t, Tuning::Grid(_)))
                            .collect();
                        assert_eq!(actual, membership);
                    }
                }
                if tetrode == 7 {
                    assert!(membership[1] && membership[2]);
                }
            }
        }
    }
    #[test]
    fn grid_modules_and_cell_phases_remain_related_across_trials() {
        for trial in 0..5 {
            let seed = 4271 + trial * 173;
            let reference = grid_spec(4271, seed, 5, 1);
            assert!((0.349..0.371).contains(&reference.spacing));
            for tetrode in 5..=8 {
                for cell in 1..=12 {
                    let spec = grid_spec(4271, seed, tetrode, cell);
                    let initial = grid_spec(4271, 4271, tetrode, cell);
                    assert_eq!(spec.phase, initial.phase);
                    assert_eq!(spec.orientation, reference.orientation);
                    assert!(
                        (spec.spacing / reference.spacing - 1.4f32.powi(tetrode as i32 - 5)).abs()
                            < 1e-5
                    );
                }
            }
        }
        let a = grid_spec(4271, 4271, 5, 1);
        let b = grid_spec(4271, 4444, 5, 1);
        assert_ne!(a.orientation, b.orientation);
        assert_ne!(a.spacing, b.spacing);
        assert_ne!(a.phase, grid_spec(4271, 4271, 5, 2).phase);
    }
    #[test]
    fn grid_rate_is_periodic_on_a_rotated_triangular_lattice() {
        let spec = grid_spec(4271, 4271, 5, 1);
        let (sin, cos) = spec.orientation.sin_cos();
        let point = |u: f32, v: f32| {
            let x = spec.spacing * (u + v / 2.);
            let y = spec.spacing * v * 3f32.sqrt() / 2.;
            (x * cos - y * sin, x * sin + y * cos)
        };
        let (u, v) = (spec.phase[0], spec.phase[1]);
        for (a, b) in [
            (0., 0.),
            (1., 0.),
            (0., 1.),
            (-1., 1.),
            (-1., 0.),
            (0., -1.),
            (1., -1.),
        ] {
            let (x, y) = point(u + a, v + b);
            assert!((spec.rate(x, y) - spec.baseline - spec.peak).abs() < 1e-4);
        }
        let (x, y) = point(u + 0.5, v + 0.5);
        assert!(spec.rate(x, y) < spec.baseline + spec.peak * 0.01);
        let s = Synthetic::new_trial(4271, 1, 12, 1000, 20, 5);
        assert!((2..=5).contains(
            &s.tunings[1..]
                .iter()
                .filter(|t| matches!(t, Tuning::Grid(_)))
                .count()
        ));
    }
    fn spikes(s: &Synthetic) -> Vec<(usize, u32)> {
        let mut out = vec![];
        s.each_spike(0, s.total, |_, cell, t| out.push((cell, t)));
        out
    }
    #[test]
    fn records_are_seeded_random_access_and_match_cut_membership() {
        let s = Synthetic::new(4271, 100, 1025, 60, 0);
        let n = s.total;
        assert!(
            (800..1250).contains(&n),
            "Poisson total near the target: {n}"
        );
        let mut whole = vec![0; n * 216];
        s.records(0, &mut whole);
        let mut piece = vec![0; 19 * 216];
        s.records(n - 30, &mut piece);
        assert_eq!(piece, whole[(n - 30) * 216..(n - 11) * 216]);
        let other = Synthetic::new(4272, 100, 1025, 60, 0);
        let mut raw = vec![0; other.total * 216];
        other.records(0, &mut raw);
        assert_ne!(whole[..216 * 100], raw[..216 * 100]);
        let mut e = crate::Engine::new(n);
        e.push(&whole);
        assert_eq!(e.times.len(), n);
        assert!(e.times.windows(2).all(|w| w[0] <= w[1]));
        assert!(e.amplitudes.iter().any(|&a| a > 50));
        for keep in [0, 2] {
            let mut cut = vec![0; n * 4];
            unsafe {
                synthetic_cut(&s, 0, n, cut.as_mut_ptr(), keep);
            }
            let labels: Vec<usize> = std::str::from_utf8(&cut)
                .unwrap()
                .split_whitespace()
                .map(|v| v.parse().unwrap())
                .collect();
            for (label, (cell, _)) in labels.iter().zip(spikes(&s)) {
                let want = if keep == 0 || cell <= keep { cell } else { 0 };
                assert_eq!(*label, want);
            }
        }
    }
    #[test]
    fn cells_are_place_direction_or_untuned_with_varied_theta_modulation() {
        let s = Synthetic::new(9, 48, 50000, 1200, 1);
        let kinds = |f: fn(&Tuning) -> bool| s.tunings[1..].iter().filter(|t| f(t)).count();
        assert!(kinds(|t| matches!(t, Tuning::Place(_))) > 10);
        assert!(kinds(|t| matches!(t, Tuning::Direction(_))) > 4);
        assert!(kinds(|t| matches!(t, Tuning::Flat(_))) > 4);
        let all = spikes(&s);
        let noise = all.iter().filter(|(c, _)| *c == 0).count() as f64 / all.len() as f64;
        assert!((0.03..0.08).contains(&noise), "noise fraction {noise}");
        // The most theta-modulated cell has more spike pairs one theta cycle apart
        // (~137 ms) than half a cycle apart (~68 ms).
        let cell = (1..=48)
            .max_by(|&a, &b| s.modulation[a][0].total_cmp(&s.modulation[b][0]))
            .unwrap();
        let times: Vec<u32> = all
            .iter()
            .filter(|(c, _)| *c == cell)
            .map(|&(_, t)| t)
            .collect();
        let mut lags = [0usize; 40];
        for (i, &a) in times.iter().enumerate() {
            for &b in &times[i + 1..] {
                let ms = (b - a) as usize / 96;
                if ms >= 200 {
                    break;
                }
                lags[ms / 5] += 1;
            }
        }
        let (half, full) = (lags[12] + lags[13], lags[26] + lags[27]);
        assert!(
            full > half * 3 / 2,
            "theta rhythmicity: {half} at ~68 ms, {full} at ~137 ms"
        );
        // A place cell fires most near its field centre; a head-direction cell most
        // near its preferred heading.
        let mut best = (0., 0.);
        for (c, t) in s.tunings.iter().enumerate().skip(1) {
            let ticks: Vec<usize> = all
                .iter()
                .filter(|(x, _)| *x == c)
                .map(|&(_, t)| (t / TICK) as usize)
                .collect();
            let peak = |f: &dyn Fn(&[u16; 5]) -> bool| {
                let occupied = s.positions.iter().filter(|p| f(p)).count().max(1);
                ticks.iter().filter(|&&k| f(&s.positions[k])).count() as f64
                    / occupied as f64
                    / (ticks.len() as f64 / s.positions.len() as f64)
            };
            match t {
                Tuning::Place(map) | Tuning::Grid(map) => {
                    let i = (0..map.len())
                        .max_by(|&a, &b| map[a].total_cmp(&map[b]))
                        .unwrap();
                    let (x, y) = (i % GRID * 300 / GRID, i / GRID * 300 / GRID);
                    let r = peak(&|p| {
                        (p[0] as usize).abs_diff(x) < 25 && (p[1] as usize).abs_diff(y) < 25
                    });
                    best.0 = f64::max(best.0, r);
                }
                Tuning::Direction(curve) => {
                    let d = (0..360)
                        .max_by(|&a, &b| curve[a].total_cmp(&curve[b]))
                        .unwrap();
                    let r = peak(&|p| {
                        ((p[4] as usize * 360 >> 16) + 360 - d) % 360 < 15
                            || (d + 360 - (p[4] as usize * 360 >> 16)) % 360 < 15
                    });
                    best.1 = f64::max(best.1, r);
                }
                Tuning::Flat(_) => {}
            }
        }
        assert!(best.0 > 3. && best.1 > 2., "in-field rate ratios {best:?}");
    }
    #[test]
    fn one_or_two_cells_drift_in_amplitude_across_the_session() {
        let s = Synthetic::new(31, 24, 50000, 1200, 3);
        let drifting: Vec<usize> = (1..=24).filter(|&c| s.trend[c] != [0.; 4]).collect();
        assert!((1..=2).contains(&drifting.len()), "{drifting:?}");
        let cell = drifting[0];
        let channel = (0..4)
            .max_by(|&a, &b| s.trend[cell][a].abs().total_cmp(&s.trend[cell][b].abs()))
            .unwrap();
        let mut raw = vec![0u8; s.total * 216];
        s.records(0, &mut raw);
        let cells = spikes(&s);
        // Mean peak-to-peak amplitude on the strongly drifting channel, first vs last
        // tenth of the session.
        let amplitude = |range: std::ops::Range<usize>| {
            let values: Vec<f32> = range
                .filter(|&i| cells[i].0 == cell)
                .map(|i| {
                    let w = &raw[i * 216 + channel * 54 + 4..][..50];
                    let (lo, hi) = w.iter().fold((127i8, -128i8), |(lo, hi), &b| {
                        (lo.min(b as i8), hi.max(b as i8))
                    });
                    (hi as f32 - lo as f32).max(0.)
                })
                .collect();
            values.iter().sum::<f32>() / values.len().max(1) as f32
        };
        let (early, late) = (
            amplitude(0..s.total / 10),
            amplitude(s.total * 9 / 10..s.total),
        );
        let change = late / early - 1.;
        assert!(
            change.abs() > 0.15 && change.signum() == s.trend[cell][channel].signum(),
            "amplitude {early} -> {late}, trend {:?}",
            s.trend[cell]
        );
    }
    #[test]
    fn noise_is_band_limited_and_its_level_varies_between_spikes() {
        let table = noise_table();
        let lag1 = table.windows(2).map(|w| w[0] * w[1]).sum::<f32>() / table.len() as f32;
        assert!(lag1 > 0.5, "neighbouring samples should correlate: {lag1}");
        let s = Synthetic::new(17, 10, 20000, 60, 0);
        let mut raw = vec![0u8; s.total * 216];
        s.records(0, &mut raw);
        // Per-spike spread on the flat pre-spike samples of one cell.
        let cells = spikes(&s);
        let cell = cells.iter().map(|&(c, _)| c).find(|&c| c > 0).unwrap();
        let rms: Vec<f32> = (0..s.total)
            .filter(|&i| cells[i].0 == cell)
            .map(|i| &raw[i * 216 + 4..i * 216 + 4 + 8])
            .map(|w| (w.iter().map(|&b| (b as i8 as f32).powi(2)).sum::<f32>() / 8.).sqrt())
            .collect();
        let (lo, hi) = rms
            .iter()
            .fold((f32::MAX, 0f32), |(a, b), &v| (a.min(v), b.max(v)));
        assert!(hi > 3. * lo.max(0.5), "noise level should vary: {lo}..{hi}");
    }
    #[test]
    fn position_clock_and_arena_are_consistent() {
        let s = Synthetic::new(12, 100, 1000, 60, 0);
        let mut raw = vec![0; 60 * 50 * 20];
        unsafe {
            synthetic_position(&s, raw.as_mut_ptr());
        }
        assert_eq!(u32::from_be_bytes(raw[20..24].try_into().unwrap()), 1920);
        for p in s.positions.iter() {
            assert!(p[0] < 300 && p[1] < 300 && p[2] < 300 && p[3] < 300);
        }
    }
    #[test]
    fn twenty_minute_walk_is_bounded_continuous_and_shared_by_tetrodes() {
        let a = Synthetic::new(12, 24, 50000, 1200, 1);
        let b = Synthetic::new(12, 48, 45000, 1200, 2);
        assert_eq!(a.positions.len(), 1200 * 50);
        assert_eq!(a.positions, b.positions);
        assert!(Rc::ptr_eq(&a.positions, &b.positions));
        let mut distance = 0.;
        for pair in a.positions.windows(2) {
            let dx = pair[1][0] as f64 - pair[0][0] as f64;
            let dy = pair[1][1] as f64 - pair[0][1] as f64;
            assert!(dx * dx + dy * dy <= 25.);
            distance += dx.hypot(dy) / 300.;
        }
        assert!(distance > 20. && distance < 450.);
        let mut occupancy = [0usize; 100];
        for p in a.positions.iter() {
            occupancy[(p[0] as usize / 30).min(9) + (p[1] as usize / 30).min(9) * 10] += 1;
        }
        assert!(occupancy.iter().all(|&n| n > 0));
        let mean = a.positions.len() as f64 / 100.;
        let cv = (occupancy
            .iter()
            .map(|&n| (n as f64 - mean).powi(2))
            .sum::<f64>()
            / 100.)
            .sqrt()
            / mean;
        assert!(cv < 0.6, "occupancy coefficient of variation {cv}");
        let centre: usize = (3..7)
            .flat_map(|y| (3..7).map(move |x| x + y * 10))
            .map(|i| occupancy[i])
            .sum();
        let fraction = centre as f64 / a.positions.len() as f64;
        assert!(
            (0.10..0.24).contains(&fraction),
            "centre occupancy {fraction}"
        );
        for axis in 0..2 {
            let lo = a.positions.iter().map(|p| p[axis]).min().unwrap();
            let hi = a.positions.iter().map(|p| p[axis]).max().unwrap();
            assert!(hi - lo > 200);
        }
    }
}
