//! Seeded virtual LTX recordings. Any record can be regenerated independently.
use std::slice;
const VARIANTS: usize = 16;
fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^ (x >> 16)
}
pub struct Synthetic {
    seed: u32,
    cells: usize,
    total: usize,
    ticks: u64,
    linear: bool,
    positions: Vec<[u16; 4]>,
    waves: Vec<i8>,
    noise: [i8; 256],
}
impl Synthetic {
    fn new(
        seed: u32,
        cells: usize,
        total: usize,
        duration: usize,
        linear: bool,
        tetrode: u32,
    ) -> Self {
        let cells = cells.clamp(1, 100);
        let arena = |t: f64| {
            if linear {
                (150. + 133. * (t * 0.27).sin(), 30. + 18. * (t * 0.31).sin())
            } else {
                (
                    150. + 127. * (t * 0.41).sin() + 12. * (t * 1.17).sin(),
                    150. + 127. * (t * 0.37).sin() + 12. * (t * 1.31).sin(),
                )
            }
        };
        let phase = (seed % 1000) as f64 / 100.;
        let positions = (0..duration * 50)
            .map(|i| {
                let t = i as f64 / 50. + phase;
                let (x, y) = arena(t);
                let (xx, yy) = arena(t + 0.02);
                let distance = ((xx - x).powi(2) + (yy - y).powi(2)).sqrt().max(0.00001);
                [
                    x.round() as u16,
                    y.round() as u16,
                    (x + 6. * (xx - x) / distance).round() as u16,
                    (y + 6. * (yy - y) / distance).round() as u16,
                ]
            })
            .collect();
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
            *n = (hash(seed ^ i as u32) % 9) as i8 - 4;
        }
        Self {
            seed,
            cells,
            total,
            ticks: duration as u64 * 96000,
            linear,
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
        let field = if self.linear {
            pos[0] as usize * self.cells / 300
        } else {
            let cols = (self.cells as f64).sqrt().ceil() as usize;
            let rows = self.cells.div_ceil(cols);
            (pos[0] as usize * cols / 300).min(cols - 1)
                + (pos[1] as usize * rows / 300).min(rows - 1) * cols
        };
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
                        * if cell == 0 { 5 } else { 1 };
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
    linear: u32,
    tetrode: u32,
) -> *mut Synthetic {
    if total == 0 || total > 20_000_000 || duration == 0 || duration > 36000 {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(Synthetic::new(
        seed,
        cells,
        total,
        duration,
        linear != 0,
        tetrode,
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
        let s = Synthetic::new(4271, 100, 1025, 60, false, 0);
        let mut whole = vec![0; 1025 * 216];
        s.records(0, &mut whole);
        let mut piece = vec![0; 19 * 216];
        s.records(995, &mut piece);
        assert_eq!(piece, whole[995 * 216..1014 * 216]);
        let mut other = vec![0; 1025 * 216];
        Synthetic::new(4272, 100, 1025, 60, false, 0).records(0, &mut other);
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
        let s = Synthetic::new(12, 100, 1000, 60, true, 0);
        let mut raw = vec![0; 60 * 50 * 20];
        unsafe {
            synthetic_position(&s, raw.as_mut_ptr());
        }
        assert_eq!(u32::from_be_bytes(raw[20..24].try_into().unwrap()), 1920);
        for p in &s.positions {
            assert!(p[0] < 300 && p[1] < 60 && p[2] < 300 && p[3] < 60);
        }
    }
}
