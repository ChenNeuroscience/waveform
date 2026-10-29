//! Position decoding/post-processing and numeric cell analysis, entirely in Wasm.
use crate::Engine;
use std::{cell::RefCell, slice, sync::Arc};
#[derive(Default, Clone)]
struct Raw {
    time: Vec<f64>,
    spots: Vec<[f32; 4]>,
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
    timebase: f64,
    bearing: f32,
}
impl Position {
    fn new(
        n: usize,
        ppm: f32,
        rate: f64,
        timebase: f64,
        min_x: f32,
        min_y: f32,
        max_x: f32,
        max_y: f32,
    ) -> Self {
        Self {
            raw: Arc::new(Raw {
                time: Vec::with_capacity(n),
                spots: Vec::with_capacity(n),
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
            timebase,
            bearing: 0.,
            derived: Default::default(),
        }
    }
    fn push(&mut self, data: &[u8]) {
        let r = Arc::get_mut(&mut self.raw).unwrap();
        for row in data.chunks_exact(20) {
            let word = |p: usize| u16::from_be_bytes([row[p], row[p + 1]]);
            r.time
                .push(u32::from_be_bytes(row[..4].try_into().unwrap()) as f64 / self.timebase);
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
        for &v in &self.raw.spots {
            let mut a = v;
            if leds == 2
                && dist(a[0], a[1], previous[0], previous[1])
                    + dist(a[2], a[3], previous[2], previous[3])
                    > dist(a[2], a[3], previous[0], previous[1])
                        + dist(a[0], a[1], previous[2], previous[3])
                        + self.ppm * 0.02
            {
                a.swap(0, 2);
                a.swap(1, 3);
            }
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
                    let dt = self.raw.time[i] - self.raw.time[j];
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
            let dt = if i + 1 < n {
                self.raw.time[i + 1] - self.raw.time[i]
            } else {
                0.
            };
            self.speed.push(if dt > 0. {
                (self.x[i + 1] - self.x[i]).hypot(self.y[i + 1] - self.y[i]) / (dt as f32)
            } else {
                f32::NAN
            });
        }
    }
    /// The duration of sample i, if it lies in the arena with a usable interval.
    fn dwell(&self, i: usize) -> Option<f32> {
        let (x, y) = (self.x[i] / self.width, self.y[i] / self.height);
        if !(x.is_finite() && y.is_finite() && (0. ..1.).contains(&x) && (0. ..1.).contains(&y)) {
            return None;
        }
        let dt = if i + 1 < self.raw.time.len() {
            self.raw.time[i + 1] - self.raw.time[i]
        } else {
            1. / self.rate
        };
        (dt > 0. && dt <= 1.).then_some(dt as f32)
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
            timebase: self.timebase,
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
        let mut cursor = 0;
        for &id in ids {
            let t = e.times[id as usize] as f64 / tb;
            while cursor + 1 < p.raw.time.len() && p.raw.time[cursor + 1] <= t {
                cursor += 1;
            }
            if p.raw.time.is_empty()
                || t < p.raw.time[0]
                || t > p.raw.time[p.raw.time.len() - 1] + 1. / p.rate
            {
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
        .map(|(&o, h)| {
            let v = if o > 0.001 { h / o } else { f32::NAN };
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
    timebase: f64,
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
) -> *mut Position {
    Box::into_raw(Box::new(Position::new(
        n, ppm, rate, timebase, min_x, min_y, max_x, max_y,
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
    #[test]
    fn occupancy_normalisation_and_self_exclusion() {
        let p = Position {
            raw: Arc::new(Raw {
                time: vec![0., 1., 2., 3.],
                spots: vec![],
            }),
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
            timebase: 1.,
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
