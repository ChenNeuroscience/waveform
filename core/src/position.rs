//! Position decoding/post-processing and numeric cell analysis, entirely in Wasm.
#[cfg(test)]
use crate::Engine;
use std::{cell::OnceCell, slice, sync::Arc};
#[derive(Default, Clone)]
struct Raw {
    spots: Vec<[f32; 4]>,
    pixels: Vec<[u16; 2]>,
    pixel_stats: OnceCell<Option<[PixelStats; 2]>>,
}
#[derive(Clone, Copy)]
struct PixelStats {
    mean: f64,
    sd: f64,
}
fn valid_pixels(n: u16) -> bool {
    n != 0 && n != 1023
}
impl PixelStats {
    fn from_counts(pixels: &[[u16; 2]], led: usize) -> Option<Self> {
        let (count, sum) = pixels
            .iter()
            .map(|p| p[led])
            .filter(|&n| valid_pixels(n))
            .fold((0usize, 0u64), |(count, sum), n| {
                (count + 1, sum + n as u64)
            });
        if count == 0 {
            return None;
        }
        let mean = sum as f64 / count as f64;
        let variance = pixels
            .iter()
            .map(|p| p[led])
            .filter(|&n| valid_pixels(n))
            .map(|n| (n as f64 - mean).powi(2))
            .sum::<f64>()
            / count as f64;
        Some(Self {
            mean,
            sd: variance.sqrt(),
        })
    }
    fn z(&self, delta: f64) -> f64 {
        if self.sd > 0. {
            delta / self.sd
        } else if delta == 0. {
            0.
        } else {
            delta.signum() * f64::INFINITY
        }
    }
}
fn pixel_swap_candidate(pixels: [u16; 2], stats: [PixelStats; 2]) -> bool {
    if !pixels.iter().all(|&n| valid_pixels(n)) || stats[0].mean == stats[1].mean {
        return false;
    }
    // v1's size evidence: the first spot has shifted toward the other LED's
    // pixel-count distribution. Also support recordings whose first LED is smaller.
    let a = stats[0].z(stats[0].mean - pixels[0] as f64);
    let b = stats[1].z(pixels[0] as f64 - stats[1].mean);
    if stats[0].mean > stats[1].mean {
        a > b
    } else {
        a < b
    }
}
pub(crate) struct Position {
    raw: Arc<Raw>,
    x: Vec<f32>,
    y: Vec<f32>,
    dir: Vec<f32>,
    speed: Vec<f32>,
    width: f32,
    height: f32,
    rate: f64,
    ppm: f32,
    /// The window's width and height, in the file's pixels.
    span: [f32; 2],
    min_x: f32,
    min_y: f32,
    bearing: f32,
    /// Shift applied to position times, in seconds: sample i is at i / rate + sync.
    sync: f64,
    /// Whether `ppm` is only a guess, with no calibration from the file or an edit.
    estimated: bool,
}
impl Position {
    fn new(n: usize, ppm: f32, rate: f64, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> Self {
        Self {
            raw: Arc::new(Raw {
                spots: Vec::with_capacity(n),
                pixels: Vec::with_capacity(n),
                pixel_stats: OnceCell::new(),
            }),
            x: vec![],
            y: vec![],
            dir: vec![],
            speed: vec![],
            width: (max_x - min_x) * 100. / ppm,
            height: (max_y - min_y) * 100. / ppm,
            rate,
            ppm,
            span: [max_x - min_x, max_y - min_y],
            min_x,
            min_y,
            bearing: 0.,
            sync: 0.,
            estimated: false,
        }
    }
    /// Sets the calibration, before processing.
    fn set_ppm(&mut self, ppm: f32, estimated: bool) {
        self.ppm = ppm;
        self.estimated = estimated;
        self.width = self.span[0] * 100. / ppm;
        self.height = self.span[1] * 100. / ppm;
    }
    /// The larger of the width and height the LEDs covered, in pixels: 0 if they were never seen.
    fn used_extent(&self) -> f32 {
        let (mut min, mut max) = ([f32::INFINITY; 2], [f32::NEG_INFINITY; 2]);
        for spot in &self.raw.spots {
            for led in spot.chunks_exact(2) {
                if led[0].is_finite() && led[1].is_finite() {
                    for axis in 0..2 {
                        min[axis] = min[axis].min(led[axis]);
                        max[axis] = max[axis].max(led[axis]);
                    }
                }
            }
        }
        if min[0] > max[0] {
            return 0.;
        }
        (max[0] - min[0]).max(max[1] - min[1])
    }
    fn push(&mut self, data: &[u8]) {
        let r = Arc::get_mut(&mut self.raw).unwrap();
        r.pixel_stats.take();
        for row in data.chunks_exact(20) {
            // Sample index and the nominal rate define time; ignore the record timestamp.
            let word = |p: usize| u16::from_be_bytes([row[p], row[p + 1]]);
            let mut v = [
                word(4) as f32,
                word(6) as f32,
                word(8) as f32,
                word(10) as f32,
            ];
            if v[0] == 1023. || v[1] == 1023. || word(12) == 0 {
                v[0] = f32::NAN;
                v[1] = f32::NAN;
            }
            if v[2] == 1023. || v[3] == 1023. || word(14) == 0 {
                v[2] = f32::NAN;
                v[3] = f32::NAN;
            }
            r.spots.push(v);
            r.pixels.push([word(12), word(14)]);
        }
    }
    fn process(&mut self, leds: u32, max_speed: f32, smoothing: f64, sync_ms: f64) {
        // Spike times are the reference; sync moves the position track against them.
        self.sync = if sync_ms.is_finite() {
            sync_ms.clamp(-10000., 10000.) / 1000.
        } else {
            0.
        };
        let n = self.raw.spots.len();
        let (mut x1, mut y1, mut x2, mut y2) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let mut previous = [f32::NAN; 4];
        let dist = |a: f32, b: f32, c: f32, d: f32| (a - c).hypot(b - d);
        let statistics = if leds == 2 {
            *self.raw.pixel_stats.get_or_init(|| {
                Some([
                    PixelStats::from_counts(&self.raw.pixels, 0)?,
                    PixelStats::from_counts(&self.raw.pixels, 1)?,
                ])
            })
        } else {
            None
        };
        for (i, &v) in self.raw.spots.iter().enumerate() {
            let mut a = v;
            if leds == 2
                && statistics.is_some_and(|s| pixel_swap_candidate(self.raw.pixels[i], s))
                && dist(a[0], a[1], previous[2], previous[3]) + self.ppm * 0.01
                    < dist(a[0], a[1], previous[0], previous[1])
                && dist(a[2], a[3], previous[0], previous[1]) + self.ppm * 0.01
                    < dist(a[2], a[3], previous[2], previous[3])
            {
                a.swap(0, 2);
                a.swap(1, 3);
            }
            // Corrected positions retain identities across consecutive swapped frames.
            previous = a;
            x1.push(a[0] * 100. / self.ppm);
            y1.push(a[1] * 100. / self.ppm);
            x2.push(a[2] * 100. / self.ppm);
            y2.push(a[3] * 100. / self.ppm);
        }
        for (x, y) in [(&mut x1, &mut y1), (&mut x2, &mut y2)] {
            let mut last: Option<usize> = None;
            for i in 0..n {
                if !x[i].is_finite() {
                    continue;
                }
                let mut valid = true;
                if let Some(j) = last {
                    let dt = (i - j) as f64 / self.rate;
                    if dt > 0.
                        && max_speed > 0.
                        && (x[i] - x[j]).hypot(y[i] - y[j]) as f64 / dt > max_speed as f64 * 100.
                    {
                        valid = false;
                    }
                }
                if valid {
                    last = Some(i);
                } else {
                    x[i] = f32::NAN;
                    y[i] = f32::NAN;
                }
            }
            interpolate(x);
            interpolate(y);
            smooth(x, (smoothing * self.rate / 2.).round() as usize);
            smooth(y, (smoothing * self.rate / 2.).round() as usize);
        }
        self.x = Vec::with_capacity(n);
        self.y = Vec::with_capacity(n);
        self.dir = Vec::with_capacity(n);
        self.speed = Vec::with_capacity(n);
        for i in 0..n {
            let dual = leds == 2 && x2[i].is_finite();
            let x = if dual { (x1[i] + x2[i]) / 2. } else { x1[i] };
            let y = if dual { (y1[i] + y2[i]) / 2. } else { y1[i] };
            let (dx, dy) = if dual {
                (x2[i] - x1[i], y2[i] - y1[i])
            } else if i > 0 {
                (x - self.x[i - 1], y - self.y[i - 1])
            } else {
                (0., 0.)
            };
            let dir = if dx.abs() < 0.001 && dy.abs() < 0.001 {
                f32::NAN
            } else {
                (dy.atan2(dx) + if dual { self.bearing } else { 0. } + std::f32::consts::PI)
                    .rem_euclid(2. * std::f32::consts::PI)
                    - std::f32::consts::PI
            };
            // LTX coordinates are already relative to the tracked window, so the
            // window minimum is not subtracted.
            self.x.push(x);
            self.y.push(y);
            self.dir.push(dir);
        }
        if n > 1 && leds == 1 {
            self.dir[0] = self.dir[1];
        }
        for i in 0..n {
            self.speed.push(if i + 1 < n {
                (self.x[i + 1] - self.x[i]).hypot(self.y[i + 1] - self.y[i]) * self.rate as f32
            } else {
                f32::NAN
            });
        }
    }
    /// Every valid sample represents one interval at the nominal sample rate.
    fn dwell(&self, i: usize) -> Option<f32> {
        let (x, y) = (self.x[i] / self.width, self.y[i] / self.height);
        if !(x.is_finite() && y.is_finite() && (0. ..1.).contains(&x) && (0. ..1.).contains(&y)) {
            return None;
        }
        Some((1. / self.rate) as f32)
    }
    pub(crate) fn variant(&self, leds: u32, max_speed: f32, smoothing: f64, sync_ms: f64) -> Self {
        let mut p = Self {
            raw: self.raw.clone(),
            x: vec![],
            y: vec![],
            dir: vec![],
            speed: vec![],
            width: self.width,
            height: self.height,
            rate: self.rate,
            ppm: self.ppm,
            span: self.span,
            min_x: self.min_x,
            min_y: self.min_y,
            bearing: self.bearing,
            sync: 0.,
            estimated: self.estimated,
        };
        p.process(leds, max_speed, smoothing, sync_ms);
        p
    }
}
fn interpolate(a: &mut [f32]) {
    let mut last: Option<usize> = None;
    for i in 0..a.len() {
        if !a[i].is_finite() {
            continue;
        }
        if let Some(j) = last {
            for k in j + 1..i {
                a[k] = a[j] + (a[i] - a[j]) * (k - j) as f32 / (i - j) as f32;
            }
        } else {
            let v = a[i];
            a[..i].fill(v);
        }
        last = Some(i);
    }
    if let Some(j) = last {
        let v = a[j];
        a[j + 1..].fill(v);
    }
}
fn smooth(a: &mut [f32], k: usize) {
    if k == 0 {
        return;
    }
    let mut sum = vec![0f64; a.len() + 1];
    for (i, &v) in a.iter().enumerate() {
        sum[i + 1] = sum[i] + v as f64;
    }
    let n = a.len();
    for (i, v) in a.iter_mut().enumerate() {
        let lo = i.saturating_sub(k);
        let hi = (i + k + 1).min(n);
        *v = ((sum[hi] - sum[lo]) / (hi - lo) as f64) as f32;
    }
}
/// Every analysis of a cell, computed together (see `analyse`).
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Analysis {
    /// Cell, map width and height, peak, refractory %, rate, arena width and height, spikes.
    pub(crate) meta: [f64; 9],
    pub(crate) spatial: Vec<f32>,
    pub(crate) sc: Vec<f32>,
    pub(crate) spikes: Vec<f32>,
    pub(crate) direction: Vec<f32>,
    pub(crate) speed: Vec<f32>,
    pub(crate) speed_dwell: Vec<f32>,
    pub(crate) ac: Vec<f32>,
}
fn box2(a: &[f32], w: usize, h: usize, k: usize) -> Vec<f32> {
    let mut integral = vec![0f64; (w + 1) * (h + 1)];
    for y in 0..h {
        for x in 0..w {
            let i = (y + 1) * (w + 1) + x + 1;
            integral[i] =
                a[y * w + x] as f64 + integral[i - 1] + integral[i - w - 1] - integral[i - w - 2];
        }
    }
    let mut out = vec![0.; a.len()];
    for y in 0..h {
        for x in 0..w {
            let (x0, y0, x1, y1) = (
                x.saturating_sub(k),
                y.saturating_sub(k),
                (x + k + 1).min(w),
                (y + k + 1).min(h),
            );
            out[y * w + x] = (integral[y1 * (w + 1) + x1]
                - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0]
                + integral[y0 * (w + 1) + x0]) as f32;
        }
    }
    out
}
/// The speed histogram's bin width, maximum and bin count, from its settings.
pub(crate) fn speed_bins(speed_bin: f32, speed_max: f32) -> (f32, f32, usize) {
    let speed_bin = speed_bin.clamp(0.5, 100.);
    let speed_max = speed_max.clamp(1., 1000.);
    (
        speed_bin,
        speed_max,
        (speed_max / speed_bin).ceil() as usize,
    )
}
/// The directional map's bin count, from its bin width in degrees.
pub(crate) fn direction_bins(dir_bin: f32) -> usize {
    (360. / dir_bin).ceil() as usize
}
impl Position {
    /// The spatial grid's width and height in bins of `bin` cm.
    pub(crate) fn grid(&self, bin: f32) -> (usize, usize) {
        (
            ((self.width / bin).ceil() as usize).clamp(1, 200),
            ((self.height / bin).ceil() as usize).clamp(1, 200),
        )
    }
    pub(crate) fn arena(&self) -> [f32; 2] {
        [self.width, self.height]
    }
    pub(crate) fn ppm(&self) -> f32 {
        self.ppm
    }
    /// Whether `ppm` is only a guess, with no calibration from the file or an edit.
    pub(crate) fn ppm_estimated(&self) -> bool {
        self.estimated
    }
    /// Sample `i`'s spatial bin in a `w` by `h` grid; it must be in the arena.
    fn spatial_bin(&self, i: usize, w: usize, h: usize) -> usize {
        let x = ((self.x[i] / self.width * w as f32) as usize).min(w - 1);
        let y = ((self.y[i] / self.height * h as f32) as usize).min(h - 1);
        y * w + x
    }
    fn direction_bin(&self, i: usize, nd: usize) -> Option<usize> {
        self.dir[i].is_finite().then(|| {
            (((self.dir[i] as f64 + std::f64::consts::PI) / (2. * std::f64::consts::PI) * nd as f64)
                .floor() as usize)
                .min(nd - 1)
        })
    }
    fn speed_bin(&self, i: usize, speed_bin: f32, speed_max: f32, ns: usize) -> Option<usize> {
        let s = self.speed[i];
        (s.is_finite() && s >= 0. && s < speed_max)
            .then(|| ((s / speed_bin).floor() as usize).min(ns - 1))
    }
    /// Normalised (x, y) of every sample in the arena, for the trajectory plot.
    pub(crate) fn path(&self) -> Vec<f32> {
        (0..self.x.len())
            .filter(|&i| self.dwell(i).is_some())
            .flat_map(|i| [self.x[i] / self.width, self.y[i] / self.height])
            .collect()
    }
    /// Seconds spent in each spatial bin.
    pub(crate) fn spatial_occupancy(&self, w: usize, h: usize) -> Vec<f32> {
        let mut occupancy = vec![0.; w * h];
        for i in 0..self.x.len() {
            if let Some(dt) = self.dwell(i) {
                occupancy[self.spatial_bin(i, w, h)] += dt;
            }
        }
        occupancy
    }
    /// Seconds spent facing each direction, in the arena.
    pub(crate) fn direction_occupancy(&self, nd: usize) -> Vec<f32> {
        let mut occupancy = vec![0.; nd];
        for i in 0..self.x.len() {
            if let (Some(dt), Some(b)) = (self.dwell(i), self.direction_bin(i, nd)) {
                occupancy[b] += dt;
            }
        }
        occupancy
    }
    /// Seconds spent at each speed, in the arena.
    pub(crate) fn speed_dwell(&self, speed_bin: f32, speed_max: f32, ns: usize) -> Vec<f32> {
        let mut dwell = vec![0.; ns];
        for i in 0..self.x.len() {
            if let (Some(dt), Some(b)) =
                (self.dwell(i), self.speed_bin(i, speed_bin, speed_max, ns))
            {
                dwell[b] += dt;
            }
        }
        dwell
    }
    /// The position sample of each of `ids`' spikes that falls in the arena.
    pub(crate) fn spike_samples(&self, times: &[u32], ids: &[u32], tb: f64) -> Vec<u32> {
        // Spike times are the reference clock; the position track was moved by
        // `sync`, so a spike at time t takes the sample recorded at t - sync.
        let shift = self.sync * tb;
        ids.iter()
            .filter_map(|&id| {
                let at = (times[id as usize] as f64 - shift) * self.rate / tb;
                let cursor = at.floor() as usize;
                (at >= 0. && cursor < self.x.len() && self.dwell(cursor).is_some())
                    .then_some(cursor as u32)
            })
            .collect()
    }
    /// Normalised (x, y) of each spike's sample.
    pub(crate) fn spike_positions(&self, samples: &[u32]) -> Vec<f32> {
        samples
            .iter()
            .flat_map(|&i| {
                [
                    self.x[i as usize] / self.width,
                    self.y[i as usize] / self.height,
                ]
            })
            .collect()
    }
    /// Spikes per second in each spatial bin (NaN where unvisited), and the peak.
    pub(crate) fn rate_map(
        &self,
        samples: &[u32],
        occupancy: &[f32],
        w: usize,
        h: usize,
        smoothing: usize,
    ) -> (Vec<f32>, f32) {
        let mut hits = vec![0.; w * h];
        for &i in samples {
            hits[self.spatial_bin(i as usize, w, h)] += 1.;
        }
        let so = box2(occupancy, w, h, smoothing);
        let sh = box2(&hits, w, h, smoothing);
        let mut peak = 0f32;
        let map = so
            .iter()
            .zip(sh)
            .enumerate()
            .map(|(i, (&o, h))| {
                let v = if occupancy[i] > 0. && o > 0. {
                    h / o
                } else {
                    f32::NAN
                };
                if v.is_finite() {
                    peak = peak.max(v);
                }
                v
            })
            .collect();
        (map, peak)
    }
    /// Spikes per second facing each direction, smoothed around the circle.
    pub(crate) fn direction_map(
        &self,
        samples: &[u32],
        occupancy: &[f32],
        nd: usize,
        smoothing: usize,
    ) -> Vec<f32> {
        let mut hits = vec![0.; nd];
        for &i in samples {
            if let Some(b) = self.direction_bin(i as usize, nd) {
                hits[b] += 1.;
            }
        }
        let radius = smoothing.min(nd) as isize;
        (0..nd)
            .map(|i| {
                let (mut a, mut b) = (0., 0.);
                for j in -radius..=radius {
                    let k = (i as isize + j).rem_euclid(nd as isize) as usize;
                    a += hits[k];
                    b += occupancy[k];
                }
                if b > 0. {
                    a / b
                } else {
                    0.
                }
            })
            .collect()
    }
    /// Spikes per second at each speed.
    pub(crate) fn speed_map(
        &self,
        samples: &[u32],
        dwell: &[f32],
        speed_bin: f32,
        speed_max: f32,
    ) -> Vec<f32> {
        let mut hits = vec![0.; dwell.len()];
        for &i in samples {
            if let Some(b) = self.speed_bin(i as usize, speed_bin, speed_max, dwell.len()) {
                hits[b] += 1.;
            }
        }
        dwell
            .iter()
            .zip(hits)
            .map(|(&o, h)| if o > 0. { h / o } else { 0. })
            .collect()
    }
}
/// Counts of spike pairs by lag, up to `window` ms in bins of `ac_bin_ms`.
pub(crate) fn temporal_ac(
    times: &[u32],
    ids: &[u32],
    tb: f64,
    window: f64,
    ac_bin_ms: f64,
) -> Vec<f32> {
    let window = if window.is_finite() {
        window.clamp(1., 10000.)
    } else {
        1000.
    };
    let ac_bin_ms = if ac_bin_ms.is_finite() {
        ac_bin_ms.clamp(0.1, window)
    } else {
        5.
    };
    let mut ac = vec![0.; (window / ac_bin_ms).ceil() as usize];
    // Every spike pair within the window; the cost scales with those pairs only.
    for j in 0..ids.len() {
        let t = times[ids[j] as usize];
        for &k in &ids[j + 1..] {
            let dt = times[k as usize].saturating_sub(t) as f64 / tb * 1000.;
            if dt >= window {
                break;
            }
            let bin = ((dt / ac_bin_ms).floor() as usize).min(ac.len() - 1);
            ac[bin] += 1.;
        }
    }
    ac
}
/// The percentage of interspike intervals under 2 ms.
pub(crate) fn refractory(times: &[u32], ids: &[u32], tb: f64) -> f64 {
    let violations = ids
        .windows(2)
        .filter(|pair| {
            times[pair[1] as usize].saturating_sub(times[pair[0] as usize]) as f64 / tb < 0.002
        })
        .count();
    if ids.len() > 1 {
        violations as f64 / (ids.len() - 1) as f64 * 100.
    } else {
        0.
    }
}
/// Every analysis of a cell at once, in one function: the reference that the handlers in
/// compute_handlers.rs, which compute each separately through the cache, are tested against.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn analyse(
    e: &mut Engine,
    pos: Option<&Position>,
    cell: u16,
    tb: f64,
    duration: f64,
    bin: f32,
    smoothing: usize,
    window: f64,
    ac_bin_ms: f64,
    dir_bin: f32,
    dir_smoothing: usize,
    speed_bin: f32,
    speed_max: f32,
) -> Analysis {
    let (speed_bin, speed_max, ns) = speed_bins(speed_bin, speed_max);
    let nd = direction_bins(dir_bin);
    e.ensure_groups();
    let ids = &e.groups[cell as usize];
    let n = ids.len();
    let ac = temporal_ac(&e.times, ids, tb, window, ac_bin_ms);
    let (w, h) = pos.map(|p| p.grid(bin)).unwrap_or((0, 0));
    let (spatial, peak, spikes, direction, speed, speed_dwell) = match pos {
        Some(p) => {
            let samples = p.spike_samples(&e.times, ids, tb);
            let (spatial, peak) = p.rate_map(&samples, &p.spatial_occupancy(w, h), w, h, smoothing);
            let dwell = p.speed_dwell(speed_bin, speed_max, ns);
            (
                spatial,
                peak,
                p.spike_positions(&samples),
                p.direction_map(&samples, &p.direction_occupancy(nd), nd, dir_smoothing),
                p.speed_map(&samples, &dwell, speed_bin, speed_max),
                dwell,
            )
        }
        None => (vec![], 0., vec![], vec![0.; nd], vec![0.; ns], vec![0.; ns]),
    };
    let arena = pos.map(|p| p.arena()).unwrap_or([0., 0.]);
    Analysis {
        meta: [
            cell as f64,
            w as f64,
            h as f64,
            peak as f64,
            refractory(&e.times, ids, tb),
            if duration > 0. {
                n as f64 / duration
            } else {
                0.
            },
            arena[0] as f64,
            arena[1] as f64,
            n as f64,
        ],
        spatial,
        sc: vec![],
        spikes,
        direction,
        speed,
        speed_dwell,
        ac,
    }
}
#[no_mangle]
pub extern "C" fn position_new(
    n: usize,
    ppm: f32,
    rate: f64,
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
) -> *mut Position {
    Box::into_raw(Box::new(Position::new(
        n, ppm, rate, min_x, min_y, max_x, max_y,
    )))
}
#[no_mangle]
pub unsafe extern "C" fn position_push(p: *mut Position, data: *const u8, n: usize) {
    (*p).push(slice::from_raw_parts(data, n));
}
#[no_mangle]
pub unsafe extern "C" fn position_set_ppm(p: *mut Position, ppm: f32, estimated: u32) {
    (*p).set_ppm(ppm, estimated != 0);
}
#[no_mangle]
pub unsafe extern "C" fn position_used_extent(p: *const Position) -> f32 {
    (*p).used_extent()
}
#[no_mangle]
pub unsafe extern "C" fn position_free(p: *mut Position) {
    drop(Box::from_raw(p));
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn recording(rows: &[[u16; 6]], ppm: f32, rate: f64) -> Position {
        let mut p = Position::new(rows.len(), ppm, rate, 0., 0., ppm, ppm);
        let mut bytes = vec![0u8; rows.len() * 20];
        for (i, row) in rows.iter().enumerate() {
            // Offsets, gaps and repeated timestamps must not change the nominal clock.
            bytes[i * 20..i * 20 + 4].copy_from_slice(&((i % 3) as u32 * 1_000_000).to_be_bytes());
            for (j, value) in row.iter().enumerate() {
                bytes[i * 20 + 4 + j * 2..i * 20 + 6 + j * 2].copy_from_slice(&value.to_be_bytes());
            }
        }
        p.push(&bytes);
        p
    }
    #[test]
    fn used_extent_is_the_largest_dimension_of_either_led() {
        // x spans 100 to 400 with both LEDs together; y only 200 to 250. 1023 is a missing LED.
        let rows = [[100, 200, 1023, 1023, 10, 0], [300, 250, 400, 220, 10, 10]];
        let mut p = recording(&rows, 300., 50.);
        assert_eq!(p.used_extent(), 300.);
        p.set_ppm(150., false);
        assert_eq!(p.width, 200., "the window, in cm");
        assert_eq!(
            recording(&[[1023, 1023, 1023, 1023, 0, 0]], 1., 50.).used_extent(),
            0.
        );
    }
    #[test]
    fn led_pixel_gate_preserves_real_turns() {
        let mut rows = vec![[20, 20, 30, 20, 30, 10]; 8];
        // A real half-turn exchanges positions, but not LED spot sizes.
        rows[7] = [30, 20, 20, 20, 30, 10];
        let mut p = recording(&rows, 100., 50.);
        p.process(2, 0., 0., 0.);
        assert!((p.dir[7].abs() - std::f32::consts::PI).abs() < 1e-6);
        assert!(p.x.iter().all(|&x| x == 25.));
    }
    #[test]
    fn led_swaps_follow_size_evidence_through_bursts_and_variants() {
        for sizes in [[30, 10], [10, 30]] {
            let rows: Vec<_> = (0..24)
                .map(|i| {
                    let d = (i % 3) as u16;
                    if (8..11).contains(&i) {
                        [30, 20, 20, 20, sizes[1] + d, sizes[0] + d]
                    } else {
                        [20, 20, 30, 20, sizes[0] + d, sizes[1] + d]
                    }
                })
                .collect();
            let mut p = recording(&rows, 100., 50.);
            p.process(2, 0., 0., 0.);
            assert!(p.dir.iter().all(|&d| d.abs() < 1e-6));
            assert!(p.x.iter().all(|&x| x == 25.));
            let single = p.variant(1, 0., 0., 0.);
            assert_eq!(single.x[8], 30.);
            let dual = single.variant(2, 0., 0., 0.);
            assert!(dual.dir.iter().all(|&d| d.abs() < 1e-6));
            assert!(Arc::ptr_eq(&p.raw, &dual.raw));
            assert!(dual.raw.pixel_stats.get().is_some());
        }
    }
    #[test]
    fn led_swap_requires_one_cm_improvement_for_each_spot() {
        let mut rows = vec![[40, 80, 56, 80, 30, 10]; 20];
        // At 400 pixels/metre, only one spot improves by more than 1 cm.
        // The summed-distance criterion alone would incorrectly swap these.
        rows[19] = [49, 80, 32, 80, 10, 30];
        let mut p = recording(&rows, 400., 50.);
        p.process(2, 0., 0., 0.);
        assert!((p.dir[19].abs() - std::f32::consts::PI).abs() < 1e-6);
    }
    #[test]
    fn pixel_statistics_ignore_missing_counts_and_handle_constant_sizes() {
        let pixels = [[30, 10], [0, 1023], [32, 12]];
        let a = PixelStats::from_counts(&pixels, 0).unwrap();
        let b = PixelStats::from_counts(&pixels, 1).unwrap();
        assert_eq!((a.mean, a.sd, b.mean, b.sd), (31., 1., 11., 1.));
        assert!(PixelStats::from_counts(&[[0, 1023]], 0).is_none());
        let stats = [
            PixelStats { mean: 30., sd: 0. },
            PixelStats { mean: 10., sd: 0. },
        ];
        assert!(!pixel_swap_candidate([30, 10], stats));
        assert!(pixel_swap_candidate([10, 30], stats));
        assert!(!pixel_swap_candidate([0, 30], stats));
        assert!(!pixel_swap_candidate([10, 1023], stats));
        assert!(!pixel_swap_candidate([10, 30], [stats[0]; 2]));
    }
    #[test]
    fn directional_smoothing_is_independent_of_spatial_binning_and_smoothing() {
        let mut p = recording(
            &[
                [30, 20, 20, 20, 12, 12],
                [20, 30, 20, 20, 12, 12],
                [10, 20, 20, 20, 12, 12],
                [20, 10, 20, 20, 12, 12],
            ],
            100.,
            1.,
        );
        p.process(2, 0., 0., 0.);
        let mut e = Engine::new(1);
        e.times = vec![0];
        e.labels = vec![1];
        let a = analyse(
            &mut e,
            Some(&p),
            1,
            1000.,
            4.,
            5.,
            0,
            1000.,
            5.,
            90.,
            0,
            4.,
            45.,
        );
        let b = analyse(
            &mut e,
            Some(&p),
            1,
            1000.,
            4.,
            5.,
            0,
            1000.,
            5.,
            90.,
            1,
            4.,
            45.,
        );
        let c = analyse(
            &mut e,
            Some(&p),
            1,
            1000.,
            4.,
            10.,
            2,
            1000.,
            5.,
            90.,
            0,
            4.,
            45.,
        );
        assert_ne!(a.direction, b.direction);
        assert_eq!(a.direction, c.direction);
        assert!(a
            .spatial
            .iter()
            .zip(&b.spatial)
            .all(|(a, b)| a == b || (a.is_nan() && b.is_nan())));
    }

    #[test]
    fn temporal_window_and_bin_width_are_independent() {
        let mut e = Engine::new(4);
        e.times = vec![0, 5, 15, 25];
        e.labels = vec![1; 4];
        let a = analyse(&mut e, None, 1, 1000., 1., 3., 1, 20., 5., 6., 1, 4., 45.);
        assert_eq!(a.ac, vec![0., 1., 2., 1.]);
        let b = analyse(&mut e, None, 1, 1000., 1., 3., 1, 18., 7., 6., 1, 4., 45.);
        assert_eq!(b.ac, vec![1., 2., 1.]);
        let c = analyse(&mut e, None, 1, 1000., 1., 3., 1, 20., 50., 6., 1, 4., 45.);
        assert_eq!(c.ac, vec![4.]);
    }

    #[test]
    fn nominal_sampling_controls_dwell_speed_and_spike_assignment() {
        let rows: Vec<_> = (20..24).map(|x| [x, 20, 1023, 1023, 12, 0]).collect();
        let mut p = recording(&rows, 100., 50.);
        p.process(1, 0., 0., 0.);
        for i in 0..4 {
            assert_eq!(p.dwell(i), Some(0.02));
        }
        assert_eq!(&p.speed[..3], &[50., 50., 50.]);
        assert!(p.speed[3].is_nan());
        let mut e = Engine::new(10);
        e.times = vec![0, 10, 20, 39, 40, 59, 60, 79, 80, 1000];
        e.labels = vec![1; 10];
        let a = analyse(
            &mut e,
            Some(&p),
            1,
            1000.,
            1.,
            1.,
            0,
            100.,
            1.,
            6.,
            1,
            4.,
            100.,
        );
        let x: Vec<_> = a
            .spikes
            .chunks_exact(2)
            .map(|xy| (xy[0] * 100.).round() as u32)
            .collect();
        assert_eq!(x, vec![20, 20, 21, 21, 22, 22, 23, 23]);
        assert!((a.meta[3] - 100.).abs() < 1e-3);
    }
    #[test]
    fn sync_offset_moves_the_position_track_under_fixed_spikes() {
        let rows: Vec<_> = (20..24).map(|x| [x, 20, 1023, 1023, 12, 0]).collect();
        let mut p = recording(&rows, 100., 50.);
        let mut e = Engine::new(4);
        e.times = vec![0, 20, 40, 60];
        e.labels = vec![1; 4];
        let mut xs = |sync: f64| -> Vec<u32> {
            p.process(1, 0., 0., sync);
            analyse(
                &mut e,
                Some(&p),
                1,
                1000.,
                1.,
                1.,
                0,
                100.,
                1.,
                6.,
                1,
                4.,
                100.,
            )
            .spikes
            .chunks_exact(2)
            .map(|xy| (xy[0] * 100.).round() as u32)
            .collect()
        };
        assert_eq!(xs(0.), vec![20, 21, 22, 23]);
        // Position moved 20 ms earlier: each spike meets the next sample; the last
        // spike falls after the track ends.
        assert_eq!(xs(-20.), vec![21, 22, 23]);
        // Position moved 40 ms later: spikes before the track starts are dropped.
        assert_eq!(xs(40.), vec![20, 21]);
        assert_eq!(xs(f64::NAN), vec![20, 21, 22, 23]);
    }
    #[test]
    fn jump_filter_uses_elapsed_sample_count() {
        let mut p = recording(
            &[
                [20, 20, 1023, 1023, 12, 0],
                [30, 20, 1023, 1023, 12, 0],
                [20, 20, 1023, 1023, 12, 0],
            ],
            100.,
            50.,
        );
        p.process(1, 4., 0., 0.);
        assert_eq!(p.x, vec![20., 20., 20.]);
        let mut p = recording(
            &[
                [20, 20, 1023, 1023, 12, 0],
                [1023, 1023, 1023, 1023, 0, 0],
                [30, 20, 1023, 1023, 12, 0],
            ],
            100.,
            50.,
        );
        p.process(1, 4., 0., 0.);
        assert_eq!(p.x, vec![20., 25., 30.]);
    }
    #[test]
    fn smoothing_retains_the_original_unvisited_bin_mask() {
        let mut p = recording(&vec![[5, 5, 1023, 1023, 12, 0]; 100], 100., 50.);
        p.process(1, 0., 0., 0.);
        let mut e = Engine::new(10);
        e.times = (0..10).map(|i| i * 100).collect();
        e.labels = vec![1; 10];
        let a = analyse(
            &mut e,
            Some(&p),
            1,
            1000.,
            2.,
            5.,
            1,
            100.,
            1.,
            6.,
            1,
            4.,
            45.,
        );
        assert_eq!(a.spatial.iter().filter(|v| v.is_finite()).count(), 1);
        assert!((a.spatial[21] - 5.).abs() < 1e-4);
        assert!(a.spatial[0].is_nan());
        assert!((a.meta[3] - 5.).abs() < 1e-4);
    }
    #[test]
    fn every_visited_bin_is_valid_even_with_submillisecond_dwell() {
        let mut p = recording(&[[5, 5, 1023, 1023, 12, 0]], 100., 2000.);
        p.process(1, 0., 0., 0.);
        let mut e = Engine::new(1);
        e.times = vec![0];
        e.labels = vec![1];
        let a = analyse(
            &mut e,
            Some(&p),
            1,
            1000.,
            1.,
            5.,
            0,
            100.,
            1.,
            6.,
            1,
            4.,
            45.,
        );
        assert_eq!(a.spatial.iter().filter(|v| v.is_finite()).count(), 1);
        assert!((a.spatial[21] - 2000.).abs() < 1e-3);
    }
    #[test]
    fn occupancy_normalisation_and_self_exclusion() {
        let p = Position {
            raw: Arc::new(Raw::default()),
            x: vec![1., 1., 8., 8.],
            y: vec![1., 1., 8., 8.],
            dir: vec![0.; 4],
            speed: vec![0.; 4],
            width: 10.,
            height: 10.,
            rate: 1.,
            ppm: 100.,
            span: [10., 10.],
            min_x: 0.,
            min_y: 0.,
            bearing: 0.,
            sync: 0.,
            estimated: false,
        };
        let mut e = Engine::new(3);
        e.times = vec![100, 1100, 2100];
        e.labels = vec![1; 3];
        let a = analyse(
            &mut e,
            Some(&p),
            1,
            1000.,
            3.,
            5.,
            0,
            100.,
            1.,
            6.,
            1,
            4.,
            45.,
        );
        assert_eq!(a.spatial[0], 1.);
        assert_eq!(a.spatial[3], 0.5);
        assert_eq!(a.ac.iter().sum::<f32>(), 0.);
        assert_eq!(a.meta[5], 1.);
    }
    #[test]
    fn interpolation_and_smoothing() {
        let mut a = vec![f32::NAN, 1., f32::NAN, 3., f32::NAN];
        interpolate(&mut a);
        assert_eq!(a, vec![1., 1., 2., 3., 3.]);
        smooth(&mut a, 1);
        assert!((a[2] - 2.).abs() < 1e-6);
    }
}

#[no_mangle]
pub unsafe extern "C" fn position_bearing(p: *mut Position, degrees: f32) {
    (*p).bearing = degrees.to_radians();
}
