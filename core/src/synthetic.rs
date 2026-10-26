//! Seeded virtual LTX recordings. Any record can be regenerated independently.
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
    slice,
};
thread_local! {
    // Shared source data in the existing Wasm instance; this starts no threads.
    static TRAJECTORIES: RefCell<HashMap<(u32, usize), Weak<Vec<[u16; 4]>>>> = RefCell::new(HashMap::new());
}
const VARIANTS: usize = 16;
fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^ (x >> 16)
}
fn trajectory(seed: u32, duration: usize) -> Vec<[u16; 4]> {
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
        ]);
    }
    positions
}

pub struct Synthetic {
    seed: u32,
    cells: usize,
    total: usize,
    ticks: u64,
    positions: Rc<Vec<[u16; 4]>>,
    waves: Vec<i8>,
    noise: [i8; 256],
}
impl Synthetic {
    fn new(seed: u32, cells: usize, total: usize, duration: usize, tetrode: u32) -> Self {
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
        let mut waves = vec![0; (cells + 1) * VARIANTS * 200];
        for cell in 0..=cells {
            let polarity = if hash(seed ^ cell as u32) & 1 == 0 {
                1.
            } else {
                -1.
            };
            for variation in 0..VARIANTS {
                for channel in 0..4 {
                    let h = hash(
                        seed ^ (cell as u32).wrapping_mul(701)
                            ^ (channel as u32).wrapping_mul(31337),
                    );
                    let amplitude = if cell == 0 { 6. } else { 18. + (h % 85) as f64 };
                    let peak = 13. + ((h >> 12) % 4) as f64 * 0.5;
                    let width = 2.4 + ((h >> 16) % 8) as f64 * 0.12;
                    for sample in 0..50 {
                        let t = sample as f64;
                        let shape = (-((t - peak) / width).powi(2)).exp()
                            - 0.35 * (-((t - peak - 8.) / 5.5).powi(2)).exp();
                        waves[(cell * VARIANTS + variation) * 200 + channel * 50 + sample] =
                            (polarity * amplitude * (0.92 + variation as f64 * 0.01) * shape)
                                .round() as i8;
                    }
                }
            }
        }
        let mut noise = [0; 256];
        for (i, n) in noise.iter_mut().enumerate() {
            *n = (hash(seed ^ i as u32) % 33) as i8 - 16;
        }
        Self {
            seed,
            cells,
            total,
            ticks: duration as u64 * 96000,
            positions,
            waves,
            noise,
        }
    }
    fn cell(&self, index: usize) -> usize {
        let h = hash(self.seed ^ index as u32);
        if h % 23 == 0 {
            return 0;
        }
        if h % 4 == 0 {
            return 1 + (h as usize >> 8) % self.cells;
        }
        let pos = self.positions
            [(index as u64 * self.positions.len() as u64 / self.total as u64) as usize];
        let cols = (self.cells as f64).sqrt().ceil() as usize;
        let rows = self.cells.div_ceil(cols);
        let field = (pos[0] as usize * cols / 300).min(cols - 1)
            + (pos[1] as usize * rows / 300).min(rows - 1) * cols;
        1 + (field as isize + ((h >> 20) % 3) as isize - 1).clamp(0, self.cells as isize - 1)
            as usize
    }
    fn records(&self, first: usize, output: &mut [u8]) {
        for (j, record) in output.chunks_exact_mut(216).enumerate() {
            let index = first + j;
            let h = hash(self.seed.wrapping_add(index as u32).wrapping_add(0x12345));
            let cell = self.cell(index);
            let template = (cell * VARIANTS + (h as usize & 15)) * 200;
            let ticks = ((index as u64 * self.ticks) / self.total as u64) as u32;
            for channel in 0..4 {
                let p = channel * 54;
                record[p..p + 4].copy_from_slice(&ticks.to_be_bytes());
                for t in 0..50 {
                    let noise = self.noise[(h as usize + channel * 53 + t) & 255] as i16
                        * if cell == 0 { 2 } else { 1 };
                    record[p + 4 + t] = (self.waves[template + channel * 50 + t] as i16 + noise)
                        .clamp(-128, 127) as i8 as u8;
                }
            }
        }
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
#[no_mangle]
pub unsafe extern "C" fn synthetic_cut(s: *const Synthetic, first: usize, n: usize, out: *mut u8) {
    let s = &*s;
    assert!(first <= s.total && n <= s.total - first);
    let output = slice::from_raw_parts_mut(out, n * 4);
    for (j, record) in output.chunks_exact_mut(4).enumerate() {
        let cell = s.cell(first + j);
        record.copy_from_slice(&[
            b'0' + (cell / 100) as u8,
            b'0' + (cell / 10 % 10) as u8,
            b'0' + (cell % 10) as u8,
            b' ',
        ]);
    }
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
    fn records_are_seeded_random_access_and_match_cut_membership() {
        let s = Synthetic::new(4271, 100, 1025, 60, 0);
        let mut whole = vec![0; 1025 * 216];
        s.records(0, &mut whole);
        let mut piece = vec![0; 19 * 216];
        s.records(995, &mut piece);
        assert_eq!(piece, whole[995 * 216..1014 * 216]);
        let mut other = vec![0; 1025 * 216];
        Synthetic::new(4272, 100, 1025, 60, 0).records(0, &mut other);
        assert_ne!(whole, other);
        let mut e = crate::Engine::new(1025);
        e.push(&whole);
        assert_eq!(e.times.len(), 1025);
        assert!(e.amplitudes.iter().any(|&a| a > 50));
        let mut cut = vec![0; 1025 * 4];
        unsafe {
            synthetic_cut(&s, 0, 1025, cut.as_mut_ptr());
        }
        let labels: Vec<usize> = std::str::from_utf8(&cut)
            .unwrap()
            .split_whitespace()
            .map(|v| v.parse().unwrap())
            .collect();
        assert!(labels.iter().all(|&v| v <= 100));
        for (i, &cell) in labels.iter().enumerate() {
            assert_eq!(cell, s.cell(i));
        }
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
