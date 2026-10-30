//! Position decoding/post-processing and numeric cell analysis, entirely in Wasm.
use crate::Engine;
use std::{
    cell::{OnceCell, RefCell},
    slice,
    sync::Arc,
};
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
/// Cell-independent results derived from a processed position, computed on first
/// use and reused by every cell's analysis.
#[derive(Default)]
struct Derived {
    /// Normalised (x, y) of every binnable sample, for the trajectory plot.
    path: Option<Vec<f32>>,
    /// Occupancy (spatial, direction, speed dwell) for one set of bin settings.
    occupancy: Option<(OccupancyKey, [Vec<f32>; 3])>,
}
type OccupancyKey = (usize, usize, usize, u32, u32);
pub(crate) struct Position {
    derived: RefCell<Derived>,
    raw: Arc<Raw>,
    x: Vec<f32>,
    y: Vec<f32>,
    dir: Vec<f32>,
    speed: Vec<f32>,
    width: f32,
    height: f32,
    rate: f64,
    ppm: f32,
    min_x: f32,
    min_y: f32,
    bearing: f32,
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
            min_x,
            min_y,
            bearing: 0.,
            derived: Default::default(),
        }
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
    fn process(&mut self, leds: u32, max_speed: f32, smoothing: f64) {
        self.derived = Default::default();
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
    fn path(&self) -> std::cell::Ref<'_, Vec<f32>> {
        if self.derived.borrow().path.is_none() {
            let path = (0..self.x.len())
                .filter(|&i| self.dwell(i).is_some())
                .flat_map(|i| [self.x[i] / self.width, self.y[i] / self.height])
                .collect();
            self.derived.borrow_mut().path = Some(path);
        }
        std::cell::Ref::map(self.derived.borrow(), |d| d.path.as_ref().unwrap())
    }
    fn variant(&self, leds: u32, max_speed: f32, smoothing: f64) -> Self {
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
            min_x: self.min_x,
            min_y: self.min_y,
            bearing: self.bearing,
            derived: Default::default(),
        };
        p.process(leds, max_speed, smoothing);
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
#[derive(Default)]
pub(crate) struct Analysis {
    meta: [f64; 8],
    spatial: Vec<f32>,
    sc: Vec<f32>,
    spikes: Vec<f32>,
    direction: Vec<f32>,
    speed: Vec<f32>,
    speed_dwell: Vec<f32>,
    ac: Vec<f32>,
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
fn analyse(
    e: &mut Engine,
    pos: Option<&Position>,
    cell: u16,
    tb: f64,
    duration: f64,
    bin: f32,
    smoothing: usize,
    window: f64,
    dir_bin: f32,
    speed_bin: f32,
    speed_max: f32,
) -> Analysis {
    let speed_bin = speed_bin.clamp(0.5, 100.);
    let speed_max = speed_max.clamp(1., 1000.);
    e.ensure_groups();
    let ids = &e.groups[cell as usize];
    let n = ids.len();
    let mut ac = vec![0.; 100];
    let mut violations = 0;
    for pair in ids.windows(2) {
        if e.times[pair[1] as usize].saturating_sub(e.times[pair[0] as usize]) as f64 / tb < 0.002 {
            violations += 1;
        }
    }
    // Every spike pair within the window; the cost scales with those pairs only.
    for j in 0..n {
        let t = e.times[ids[j] as usize];
        for k in j + 1..n {
            let dt = e.times[ids[k] as usize].saturating_sub(t) as f64 / tb * 1000.;
            if dt >= window {
                break;
            }
            ac[((dt / window * 100.).floor() as usize).min(99)] += 1.;
        }
    }
    let (w, h) = pos
        .map(|p| {
            (
                ((p.width / bin).ceil() as usize).clamp(1, 200),
                ((p.height / bin).ceil() as usize).clamp(1, 200),
            )
        })
        .unwrap_or((0, 0));
    let nd = (360. / dir_bin).ceil() as usize;
    let ns = (speed_max / speed_bin).ceil() as usize;
    let (mut hits, mut hd, mut hs) = (vec![0.; w * h], vec![0.; nd], vec![0.; ns]);
    let mut spikes = vec![];
    let mut occupancy = [vec![0.; w * h], vec![0.; nd], vec![0.; ns]];
    if let Some(p) = pos {
        let bin = |i: usize| -> Option<usize> {
            let x = (p.x[i] / p.width * w as f32).floor();
            let y = (p.y[i] / p.height * h as f32).floor();
            if x.is_finite() && y.is_finite() && x >= 0. && x < w as f32 && y >= 0. && y < h as f32
            {
                Some(y as usize * w + x as usize)
            } else {
                None
            }
        };
        let db = |i: usize| {
            (((p.dir[i] as f64 + std::f64::consts::PI) / (2. * std::f64::consts::PI) * nd as f64)
                .floor() as usize)
                .min(nd - 1)
        };
        let sb = |i: usize| {
            if p.speed[i].is_finite() && p.speed[i] >= 0. && p.speed[i] < speed_max {
                Some(((p.speed[i] / speed_bin).floor() as usize).min(ns - 1))
            } else {
                None
            }
        };
        // Occupancy depends only on the position and bin settings, so it is
        // computed once and shared by every cell's analysis.
        let key = (w, h, nd, speed_bin.to_bits(), speed_max.to_bits());
        let cached = p
            .derived
            .borrow()
            .occupancy
            .as_ref()
            .filter(|(k, _)| *k == key)
            .map(|(_, o)| o.clone());
        occupancy = cached.unwrap_or_else(|| {
            let [mut occ, mut od, mut os] = [vec![0.; w * h], vec![0.; nd], vec![0.; ns]];
            for i in 0..p.x.len() {
                let (Some(b), Some(dt)) = (bin(i), p.dwell(i)) else {
                    continue;
                };
                occ[b] += dt;
                if p.dir[i].is_finite() {
                    od[db(i)] += dt;
                }
                if let Some(b) = sb(i) {
                    os[b] += dt;
                }
            }
            let maps = [occ, od, os];
            p.derived.borrow_mut().occupancy = Some((key, maps.clone()));
            maps
        });
        for &id in ids {
            let cursor = (e.times[id as usize] as f64 * p.rate / tb).floor() as usize;
            if cursor >= p.x.len() {
                continue;
            }
            if let Some(b) = bin(cursor) {
                hits[b] += 1.;
                if p.dir[cursor].is_finite() {
                    hd[db(cursor)] += 1.;
                }
                if let Some(b) = sb(cursor) {
                    hs[b] += 1.;
                }
                spikes.extend([p.x[cursor] / p.width, p.y[cursor] / p.height]);
            }
        }
    }
    let [occ, od, os] = occupancy;
    let so = box2(&occ, w, h, smoothing);
    let sh = box2(&hits, w, h, smoothing);
    let mut peak = 0f32;
    let spatial: Vec<f32> = so
        .iter()
        .zip(sh)
        .enumerate()
        .map(|(i, (&o, h))| {
            let v = if occ[i] > 0. && o > 0. {
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
    let mut direction = vec![0.; nd];
    for (i, v) in direction.iter_mut().enumerate() {
        let (mut a, mut b) = (0., 0.);
        for j in -(smoothing as isize)..=smoothing as isize {
            let k = (i as isize + j).rem_euclid(nd as isize) as usize;
            a += hd[k];
            b += od[k];
        }
        *v = if b > 0. { a / b } else { 0. };
    }
    let speed = os
        .iter()
        .zip(hs)
        .map(|(&o, h)| if o > 0. { h / o } else { 0. })
        .collect();
    Analysis {
        meta: [
            cell as f64,
            w as f64,
            h as f64,
            peak as f64,
            if n > 1 {
                violations as f64 / (n - 1) as f64 * 100.
            } else {
                0.
            },
            if duration > 0. {
                n as f64 / duration
            } else {
                0.
            },
            pos.map(|p| p.width as f64).unwrap_or(0.),
            pos.map(|p| p.height as f64).unwrap_or(0.),
        ],
        spatial,
        sc: vec![],
        spikes,
        direction,
        speed,
        speed_dwell: os,
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
pub unsafe extern "C" fn position_finish(
    p: *mut Position,
    leds: u32,
    max_speed: f32,
    smoothing: f64,
) {
    (*p).process(leds, max_speed, smoothing);
}
#[no_mangle]
pub unsafe extern "C" fn position_variant(
    p: *const Position,
    leds: u32,
    max_speed: f32,
    smoothing: f64,
) -> *mut Position {
    Box::into_raw(Box::new((*p).variant(leds, max_speed, smoothing)))
}
/// The trajectory (normalised x, y pairs), computed once per processed position.
#[no_mangle]
pub unsafe extern "C" fn position_path(p: *const Position) -> *const f32 {
    (*p).path().as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn position_path_len(p: *const Position) -> usize {
    (*p).path().len()
}
#[no_mangle]
pub unsafe extern "C" fn position_size(p: *const Position, out: *mut f32) {
    let out = slice::from_raw_parts_mut(out, 2);
    out.copy_from_slice(&[(*p).width, (*p).height]);
}
#[no_mangle]
pub unsafe extern "C" fn position_free(p: *mut Position) {
    drop(Box::from_raw(p));
}
#[no_mangle]
pub unsafe extern "C" fn engine_analyse(
    e: *mut Engine,
    p: *const Position,
    cell: u16,
    tb: f64,
    duration: f64,
    bin: f32,
    smoothing: usize,
    window: f64,
    dir_bin: f32,
    speed_bin: f32,
    speed_max: f32,
) {
    let e = &mut *e;
    e.analysis = analyse(
        e,
        p.as_ref(),
        cell,
        tb,
        duration,
        bin,
        smoothing,
        window,
        dir_bin,
        speed_bin,
        speed_max,
    );
}
#[no_mangle]
pub unsafe extern "C" fn engine_analysis_meta(e: *const Engine) -> *const f64 {
    (*e).analysis.meta.as_ptr()
}
macro_rules! getter {
    ($ptr:ident,$len:ident,$field:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $ptr(e: *const Engine) -> *const f32 {
            let e = &*e;
            e.analysis.$field.as_ptr()
        }
        #[no_mangle]
        pub unsafe extern "C" fn $len(e: *const Engine) -> usize {
            let e = &*e;
            e.analysis.$field.len()
        }
    };
}
getter!(
    engine_analysis_spatial,
    engine_analysis_spatial_len,
    spatial
);
getter!(engine_analysis_spikes, engine_analysis_spikes_len, spikes);
getter!(
    engine_analysis_direction,
    engine_analysis_direction_len,
    direction
);
getter!(engine_analysis_speed, engine_analysis_speed_len, speed);
getter!(
    engine_analysis_speed_dwell,
    engine_analysis_speed_dwell_len,
    speed_dwell
);
getter!(engine_analysis_ac, engine_analysis_ac_len, ac);
/// Computed only when the spatial autocorrelation plot is requested.
#[no_mangle]
pub unsafe extern "C" fn engine_analyse_sc(e: *mut Engine, minimum: usize) {
    let a = &mut (*e).analysis;
    a.sc = crate::spatial_ac::autocorrelation(
        &a.spatial,
        a.meta[1] as usize,
        a.meta[2] as usize,
        minimum,
    );
}
getter!(engine_analysis_sc, engine_analysis_sc_len, sc);
#[cfg(test)]
mod tests {
    use super::*;
    fn recording(rows: &[[u16; 6]], ppm: f32, rate: f64) -> Position {
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
    fn led_pixel_gate_preserves_real_turns() {
        let mut rows = vec![[20, 20, 30, 20, 30, 10]; 8];
        // A real half-turn exchanges positions, but not LED spot sizes.
        rows[7] = [30, 20, 20, 20, 30, 10];
        let mut p = recording(&rows, 100., 50.);
        p.process(2, 0., 0.);
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
            p.process(2, 0., 0.);
            assert!(p.dir.iter().all(|&d| d.abs() < 1e-6));
            assert!(p.x.iter().all(|&x| x == 25.));
            let single = p.variant(1, 0., 0.);
            assert_eq!(single.x[8], 30.);
            let dual = single.variant(2, 0., 0.);
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
        p.process(2, 0., 0.);
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
    fn nominal_sampling_controls_dwell_speed_and_spike_assignment() {
        let rows: Vec<_> = (20..24).map(|x| [x, 20, 1023, 1023, 12, 0]).collect();
        let mut p = recording(&rows, 100., 50.);
        p.process(1, 0., 0.);
        for i in 0..4 {
            assert_eq!(p.dwell(i), Some(0.02));
        }
        assert_eq!(&p.speed[..3], &[50., 50., 50.]);
        assert!(p.speed[3].is_nan());
        let mut e = Engine::new(10);
        e.times = vec![0, 10, 20, 39, 40, 59, 60, 79, 80, 1000];
        e.labels = vec![1; 10];
        let a = analyse(&mut e, Some(&p), 1, 1000., 1., 1., 0, 100., 6., 4., 100.);
        let x: Vec<_> = a
            .spikes
            .chunks_exact(2)
            .map(|xy| (xy[0] * 100.).round() as u32)
            .collect();
        assert_eq!(x, vec![20, 20, 21, 21, 22, 22, 23, 23]);
        assert!((a.meta[3] - 100.).abs() < 1e-3);
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
        p.process(1, 4., 0.);
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
        p.process(1, 4., 0.);
        assert_eq!(p.x, vec![20., 25., 30.]);
    }
    #[test]
    fn smoothing_retains_the_original_unvisited_bin_mask() {
        let mut p = recording(&vec![[5, 5, 1023, 1023, 12, 0]; 100], 100., 50.);
        p.process(1, 0., 0.);
        let mut e = Engine::new(10);
        e.times = (0..10).map(|i| i * 100).collect();
        e.labels = vec![1; 10];
        let a = analyse(&mut e, Some(&p), 1, 1000., 2., 5., 1, 100., 6., 4., 45.);
        assert_eq!(a.spatial.iter().filter(|v| v.is_finite()).count(), 1);
        assert!((a.spatial[21] - 5.).abs() < 1e-4);
        assert!(a.spatial[0].is_nan());
        assert!((a.meta[3] - 5.).abs() < 1e-4);
    }
    #[test]
    fn every_visited_bin_is_valid_even_with_submillisecond_dwell() {
        let mut p = recording(&[[5, 5, 1023, 1023, 12, 0]], 100., 2000.);
        p.process(1, 0., 0.);
        let mut e = Engine::new(1);
        e.times = vec![0];
        e.labels = vec![1];
        let a = analyse(&mut e, Some(&p), 1, 1000., 1., 5., 0, 100., 6., 4., 45.);
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
            min_x: 0.,
            min_y: 0.,
            bearing: 0.,
            derived: Default::default(),
        };
        let mut e = Engine::new(3);
        e.times = vec![100, 1100, 2100];
        e.labels = vec![1; 3];
        let a = analyse(&mut e, Some(&p), 1, 1000., 3., 5., 0, 100., 6., 4., 45.);
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
