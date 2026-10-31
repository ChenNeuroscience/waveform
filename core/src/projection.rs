//! Cuts through the current orthographic camera, over every spike at every depth.
use super::{inside, Engine};
use std::slice;

struct Region<'a> {
    sources: &'a [u16],
    dest: u16,
    offset: usize,
    matrix: &'a [f32],
    points: &'a [f32],
    radius: f32,
    width: usize,
    height: usize,
}

/** Rasterise connected brush capsules once; the population pass is O(spikes),
 * independent of stroke length. The mask is bounded to 4 MiB for large panes. */
fn brush_mask(points: &[f32], width: usize, height: usize, radius: f32) -> (Vec<u8>, usize, usize) {
    let (mw, mh) = (width.min(2048), height.min(2048));
    let mut mask = vec![0; mw * mh];
    let mut previous = [points[0] * width as f32, points[1] * height as f32];
    for point in points.chunks_exact(2) {
        let next = [point[0] * width as f32, point[1] * height as f32];
        let bounds = |a: f32, b: f32, size: usize, pixels: usize| {
            let lo = (((a.min(b) - radius) / size as f32 * pixels as f32).floor() as isize)
                .clamp(0, pixels as isize - 1) as usize;
            let hi = (((a.max(b) + radius) / size as f32 * pixels as f32).ceil() as isize)
                .clamp(0, pixels as isize - 1) as usize;
            (lo, hi)
        };
        let (left, right) = bounds(previous[0], next[0], width, mw);
        let (bottom, top) = bounds(previous[1], next[1], height, mh);
        let dx = next[0] - previous[0];
        let dy = next[1] - previous[1];
        let length = dx * dx + dy * dy;
        for y in bottom..=top {
            for x in left..=right {
                let px = (x as f32 + 0.5) * width as f32 / mw as f32 - previous[0];
                let py = (y as f32 + 0.5) * height as f32 / mh as f32 - previous[1];
                let t = if length > 0. {
                    ((px * dx + py * dy) / length).clamp(0., 1.)
                } else {
                    0.
                };
                if (px - t * dx).powi(2) + (py - t * dy).powi(2) <= radius * radius {
                    mask[y * mw + x] = 1;
                }
            }
        }
        previous = next;
    }
    (mask, mw, mh)
}

impl Engine {
    fn projected_region(&mut self, r: Region<'_>) -> usize {
        if r.matrix.len() != 8
            || r.points.len() % 2 != 0
            || r.points.len() < if r.radius > 0. { 2 } else { 6 }
            || !r.matrix.iter().chain(r.points).all(|v| v.is_finite())
            || !r.radius.is_finite()
            || !(0. ..=64.).contains(&r.radius)
            || r.width == 0
            || r.height == 0
            || !matches!(r.offset, 0 | 5)
            || (r.offset == 5 && !self.pca.ready)
        {
            return 0;
        }
        let mask = (r.radius > 0.).then(|| brush_mask(r.points, r.width, r.height, r.radius));
        let mut changed = 0;
        for i in 0..self.labels.len() {
            if self.labels[i] == r.dest || !r.sources.contains(&self.labels[i]) {
                continue;
            }
            let xyz = [
                self.axis(i, r.offset),
                self.axis(i, r.offset + 1),
                self.axis(i, r.offset + 2),
            ];
            let project = |row: usize| {
                r.matrix[row] * xyz[0]
                    + r.matrix[row + 1] * xyz[1]
                    + r.matrix[row + 2] * xyz[2]
                    + r.matrix[row + 3]
            };
            let (x, y) = (project(0), project(4));
            if !(0. ..=1.).contains(&x) || !(0. ..=1.).contains(&y) {
                continue;
            }
            let hit = if let Some((mask, w, h)) = &mask {
                let px = ((x * *w as f32) as usize).min(w - 1);
                let py = ((y * *h as f32) as usize).min(h - 1);
                mask[py * w + px] != 0
            } else {
                inside(x, y, r.points)
            };
            if hit {
                self.labels[i] = r.dest;
                changed += 1;
            }
        }
        if changed > 0 {
            self.recount();
        }
        changed
    }
}

#[no_mangle]
pub unsafe extern "C" fn engine_projected_region(
    e: *mut Engine,
    sources: *const u16,
    ns: usize,
    dest: u16,
    offset: usize,
    matrix: *const f32,
    points: *const f32,
    n: usize,
    radius: f32,
    width: usize,
    height: usize,
) -> usize {
    (*e).projected_region(Region {
        sources: slice::from_raw_parts(sources, ns),
        dest,
        offset,
        matrix: slice::from_raw_parts(matrix, 8),
        points: slice::from_raw_parts(points, n),
        radius,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Engine {
        let mut e = Engine::new(6);
        e.times = vec![1; 6];
        // First two overlap in x/y but have different depth; the fourth channel
        // must have no effect. Label 7 is never a source.
        e.amplitudes = vec![
            51, 51, 0, 255, 51, 51, 255, 0, 204, 51, 51, 0, 51, 51, 51, 0, 51, 204, 51, 0, 51, 51,
            51, 0,
        ];
        e.labels = vec![1, 1, 1, 7, 1, 3];
        e.recount();
        e
    }
    const XY: [f32; 8] = [1., 0., 0., 0., 0., 1., 0., 0.];

    #[test]
    fn lasso_includes_all_depths_and_preserves_other_sources() {
        let mut e = fixture();
        let points = [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3];
        assert_eq!(
            e.projected_region(Region {
                sources: &[1],
                dest: 3,
                offset: 0,
                matrix: &XY,
                points: &points,
                radius: 0.,
                width: 300,
                height: 200
            }),
            2
        );
        assert_eq!(e.labels, [3, 3, 1, 7, 1, 3]);
        assert_eq!(e.counts[3], 3);
    }

    #[test]
    fn camera_rotation_and_pan_change_the_cut() {
        let mut e = fixture();
        let matrix = [0., 0., 1., 0., 0., 1., 0., 0.]; // Look along the first axis.
        let points = [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3];
        assert_eq!(
            e.projected_region(Region {
                sources: &[1],
                dest: 3,
                offset: 0,
                matrix: &matrix,
                points: &points,
                radius: 0.,
                width: 300,
                height: 200
            }),
            1
        );
        assert_eq!(e.labels, [1, 1, 3, 7, 1, 3]);
        let offscreen = [1., 0., 0., 2., 0., 1., 0., 0.];
        assert_eq!(
            e.projected_region(Region {
                sources: &[1],
                dest: 3,
                offset: 0,
                matrix: &offscreen,
                points: &points,
                radius: 0.,
                width: 300,
                height: 200
            }),
            0
        );
    }

    #[test]
    fn brush_connects_fast_strokes_and_keeps_a_circular_pixel_radius() {
        let mut e = fixture();
        assert_eq!(
            e.projected_region(Region {
                sources: &[1],
                dest: 3,
                offset: 0,
                matrix: &XY,
                points: &[0.1, 0.2, 0.9, 0.2],
                radius: 9.,
                width: 400,
                height: 200
            }),
            3
        );
        assert_eq!(e.labels, [3, 3, 3, 7, 1, 3]);
        let (mask, w, h) = brush_mask(&[0.5, 0.5], 400, 200, 9.);
        assert_ne!(mask[100 * w + 207], 0);
        assert_eq!(mask[108 * w + 208], 0);
        assert_eq!(h, 200);
    }
}
