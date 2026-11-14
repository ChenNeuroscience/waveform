//! Positions and cell analyses through the session cache (cache.rs). This is where each
//! value is computed and stored, so it is where each decides what its key ignores (only
//! what it is known not to depend on) and how many of it to keep.
use crate::cache::{self, Cache, Leaf::*, Node, Part, L};
use crate::position::{direction_bins, refractory, speed_bins, temporal_ac, Analysis, Position};
use crate::spatial_ac::autocorrelation;
use crate::Engine;
use std::{
    cell::RefCell,
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    rc::Rc,
};

/// Rate-map colours are applied when the map is drawn, never computed with.
const COLOURS: [Part; 2] = [L(MaxRate), L(RateMapSteps)];
/// How many of each value to keep: few positions (each holds every sample), more of what
/// is derived from one, and many per-cell results, since every visible tile has one.
const RAW_POSITIONS: usize = 2;
const POSITIONS: usize = 4;
const PER_POSITION: usize = 8;
const PER_CELL: usize = 200;

/// A spatial grid of values.
struct Grid {
    w: usize,
    h: usize,
    values: Vec<f32>,
}
struct Ratemap {
    grid: Grid,
    peak: f32,
}
struct CellStats {
    count: usize,
    refractory: f64,
    rate: f64,
}

/// What JavaScript copies out after a request.
#[derive(Default)]
struct Output {
    meta: [f64; 9],
    spatial: Rc<Vec<f32>>,
    sc: Rc<Vec<f32>>,
    spikes: Rc<Vec<f32>>,
    direction: Rc<Vec<f32>>,
    speed: Rc<Vec<f32>>,
    speed_dwell: Rc<Vec<f32>>,
    ac: Rc<Vec<f32>>,
    path: Rc<Vec<f32>>,
    /// Two u32 halves each of the last answer's analysis, path and speed dwell digests.
    keys: [u32; 6],
}
impl From<Analysis> for Output {
    fn from(a: Analysis) -> Self {
        Self {
            meta: a.meta,
            spatial: Rc::new(a.spatial),
            sc: Rc::new(a.sc),
            spikes: Rc::new(a.spikes),
            direction: Rc::new(a.direction),
            speed: Rc::new(a.speed),
            speed_dwell: Rc::new(a.speed_dwell),
            ac: Rc::new(a.ac),
            ..Default::default()
        }
    }
}
thread_local! {
    static OUTPUT: RefCell<Output> = RefCell::new(Output::default());
}
fn output<T>(f: impl FnOnce(&mut Output) -> T) -> T {
    OUTPUT.with(|o| f(&mut o.borrow_mut()))
}
fn halves(digest: u64) -> [u32; 2] {
    [digest as u32, (digest >> 32) as u32]
}

/// The processed position for the current inputs, if they name one and it has been read.
fn position(c: &mut Cache) -> Option<Rc<Position>> {
    if c.inputs.pos_file.is_empty() {
        return None;
    }
    let key = c.inputs.key(Node::Position, "", &[]);
    c.get_or(key, POSITIONS, |c| {
        let raw = c.get::<Position>(&c.inputs.key(Node::PosRaw, "", &[]))?;
        let i = &c.inputs;
        Some(raw.variant(
            i.number(Leds) as u32,
            i.number(MaxSpeed) as f32,
            i.number(PosSmooth),
            i.number(Sync),
        ))
    })
}
/// The trajectory and its key digest. The sync offset moves spikes along the path, not
/// the path.
fn path(c: &mut Cache) -> Option<(Rc<Vec<f32>>, u64)> {
    let p = position(c)?;
    let key = c.inputs.key(Node::Path, "", &[L(Sync)]);
    let digest = key.digest();
    Some((c.get_or(key, PER_POSITION, |_| Some(p.path()))?, digest))
}

/// One cell's request: its number, the recording's clock, and the engine holding its spikes
/// (None to only look in the cache).
struct Cell<'a> {
    engine: Option<&'a mut Engine>,
    cell: u16,
    tb: f64,
    duration: f64,
}
impl Cell<'_> {
    /// The cell's spike set: named by cut and revision if the inputs give one, else its
    /// membership hash, which needs the engine.
    fn spikes(&mut self, c: &Cache) -> Option<String> {
        if !c.inputs.cell_prefix.is_empty() {
            return Some(format!("{}:{}", c.inputs.cell_prefix, self.cell));
        }
        let e = self.engine.as_deref_mut()?;
        let count = e.counts[self.cell as usize];
        let hashes = e.cell_hashes();
        let i = self.cell as usize * 2;
        Some(format!("{count}:{}:{}", hashes[i], hashes[i + 1]))
    }
    /// The engine's spike times and this cell's spike indices.
    fn ids(&mut self) -> Option<(&[u32], &[u32])> {
        let e = self.engine.as_deref_mut()?;
        e.ensure_groups();
        Some((&e.times, &e.groups[self.cell as usize]))
    }
}

/// Every analysis of a cell, from the cache where it can be, into the output. False if
/// something isn't cached and can't be computed: no engine, or an unread position.
fn analyse(c: &mut Cache, mut r: Cell, spatial_ac: bool) -> bool {
    let Some(spikes) = r.spikes(c) else {
        return false;
    };
    let (tb, duration) = (r.tb, r.duration);
    let i = c.inputs.clone();
    let mut digests = vec![];
    let mut key = |c: &Cache, node: Node, ignore: &[Part]| {
        let key = c.inputs.key(node, &spikes, ignore);
        digests.push(key.digest());
        key
    };

    let stats = c.get_or(key(c, Node::CellStats, &[]), PER_CELL, |_| {
        let (times, ids) = r.ids()?;
        Some(CellStats {
            count: ids.len(),
            refractory: refractory(times, ids, tb),
            rate: if duration > 0. {
                ids.len() as f64 / duration
            } else {
                0.
            },
        })
    });
    let ac = c.get_or(key(c, Node::TemporalAc, &[]), PER_CELL, |_| {
        let (times, ids) = r.ids()?;
        Some(temporal_ac(
            times,
            ids,
            tb,
            i.number(AcWindow),
            i.number(AcBinMs),
        ))
    });
    let (Some(stats), Some(ac)) = (stats, ac) else {
        return false;
    };
    let (speed_bin, speed_max, ns) =
        speed_bins(i.number(SpeedBin) as f32, i.number(SpeedMax) as f32);
    let nd = direction_bins(i.number(DirBin) as f32);

    let mut out = Output {
        ac,
        sc: Rc::default(),
        ..Default::default()
    };
    let (w, h, peak, arena) = if i.pos_file.is_empty() {
        // Without a position, every positional analysis is empty.
        out.direction = Rc::new(vec![0.; nd]);
        out.speed = Rc::new(vec![0.; ns]);
        out.speed_dwell = Rc::new(vec![0.; ns]);
        (0, 0, 0., [0., 0.])
    } else {
        let Some(p) = position(c) else {
            return false;
        };
        let samples = c.get_or(key(c, Node::SpikeSamples, &[]), PER_CELL, |_| {
            let (times, ids) = r.ids()?;
            Some(p.spike_samples(times, ids, tb))
        });
        let Some(samples) = samples else {
            return false;
        };
        let (w, h) = p.grid(i.number(BinCm) as f32);
        // Time in each place, direction or speed bin depends on where the animal was, not
        // when, so not on the sync offset; and the spatial one not on smoothing either.
        let occupancy = c
            .get_or(
                key(
                    c,
                    Node::SpatialOccupancy,
                    &[L(Sync), L(Smooth), COLOURS[0], COLOURS[1]],
                ),
                PER_POSITION,
                |_| {
                    Some(Grid {
                        w,
                        h,
                        values: p.spatial_occupancy(w, h),
                    })
                },
            )
            .unwrap();
        let ratemap = c
            .get_or(key(c, Node::Ratemap, &COLOURS), PER_CELL, |_| {
                let (values, peak) =
                    p.rate_map(&samples, &occupancy.values, w, h, i.number(Smooth) as usize);
                Some(Ratemap {
                    grid: Grid { w, h, values },
                    peak,
                })
            })
            .unwrap();
        if spatial_ac {
            out.sc = c
                .get_or(key(c, Node::SpatialAc, &COLOURS), PER_CELL, |_| {
                    let g = &ratemap.grid;
                    Some(autocorrelation(
                        &g.values,
                        g.w,
                        g.h,
                        i.number(ScMinOverlap) as usize,
                    ))
                })
                .unwrap();
        }
        let od = c
            .get_or(
                key(c, Node::DirectionOccupancy, &[L(Sync), L(DirSmooth)]),
                PER_POSITION,
                |_| Some(p.direction_occupancy(nd)),
            )
            .unwrap();
        out.direction = c
            .get_or(key(c, Node::Direction, &[]), PER_CELL, |_| {
                Some(p.direction_map(&samples, &od, nd, i.number(DirSmooth) as usize))
            })
            .unwrap();
        let dwell_key = key(c, Node::SpeedDwell, &[L(Sync)]);
        out.keys[4..6].copy_from_slice(&halves(dwell_key.digest()));
        out.speed_dwell = c
            .get_or(dwell_key, PER_POSITION, |_| {
                Some(p.speed_dwell(speed_bin, speed_max, ns))
            })
            .unwrap();
        out.speed = c
            .get_or(key(c, Node::Speed, &[]), PER_CELL, |_| {
                Some(p.speed_map(&samples, &out.speed_dwell, speed_bin, speed_max))
            })
            .unwrap();
        // Per-spike positions are as many as the spikes, so made for each request.
        out.spikes = Rc::new(p.spike_positions(&samples));
        out.spatial = Rc::new(ratemap.grid.values.clone());
        (w, h, ratemap.peak, p.arena())
    };
    out.meta = [
        r.cell as f64,
        w as f64,
        h as f64,
        peak as f64,
        stats.refractory,
        stats.rate,
        arena[0] as f64,
        arena[1] as f64,
        stats.count as f64,
    ];
    let mut hasher = DefaultHasher::new();
    digests.hash(&mut hasher);
    spatial_ac.hash(&mut hasher);
    out.keys[0..2].copy_from_slice(&halves(hasher.finish()));
    output(|o| *o = out);
    true
}

/// Whether the position file and calibration in the inputs have been read.
#[no_mangle]
pub extern "C" fn cache_has_raw() -> u32 {
    cache::with(|c| {
        let key = c.inputs.key(Node::PosRaw, "", &[]);
        c.get::<Position>(&key).is_some() as u32
    })
}
/// Takes a read, unprocessed position for the current inputs.
#[no_mangle]
pub unsafe extern "C" fn cache_put_raw(p: *mut Position) {
    let position = *Box::from_raw(p);
    cache::with(|c| {
        let key = c.inputs.key(Node::PosRaw, "", &[]);
        c.put(key, position, RAW_POSITIONS);
    })
}
/// The processed position for the current inputs, or null. Valid only until the next
/// `cache_*` call, which may evict it.
#[no_mangle]
pub extern "C" fn cache_position() -> *const Position {
    cache::with(|c| position(c).map_or(std::ptr::null(), |p| Rc::as_ptr(&p)))
}
/// Puts the current inputs' path in the output (see `output_path`): 0 without a position.
#[no_mangle]
pub extern "C" fn cache_path() -> u32 {
    let Some((path, digest)) = cache::with(path) else {
        return 0;
    };
    output(|o| {
        o.path = path;
        o.keys[2..4].copy_from_slice(&halves(digest));
    });
    1
}
/// Puts a position's path in the output, without the cache.
#[no_mangle]
pub unsafe extern "C" fn position_path(p: *const Position) {
    let path = Rc::new((*p).path());
    output(|o| o.path = path);
}
#[no_mangle]
pub extern "C" fn output_path() -> *const f32 {
    output(|o| o.path.as_ptr())
}
#[no_mangle]
pub extern "C" fn output_path_len() -> usize {
    output(|o| o.path.len())
}
/// Puts a cell's analyses in the output: 1 if done, 0 if something isn't cached and can't
/// be computed (no engine, or the position hasn't been read). `e` may be null to only look.
#[no_mangle]
pub unsafe extern "C" fn cache_analysis(
    e: *mut Engine,
    cell: u16,
    tb: f64,
    duration: f64,
    spatial_ac: u32,
) -> u32 {
    let request = Cell {
        engine: e.as_mut(),
        cell,
        tb,
        duration,
    };
    cache::with(|c| analyse(c, request, spatial_ac != 0)) as u32
}
/// Two u32 halves each of the last answer's analysis, path and speed dwell key digests.
#[no_mangle]
pub extern "C" fn cache_keys() -> *const u32 {
    output(|o| o.keys.as_ptr())
}
/// Computes every analysis of a cell into the output, without the cache.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn engine_analyse(
    e: *mut Engine,
    p: *const Position,
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
) {
    let a = crate::position::analyse(
        &mut *e,
        p.as_ref(),
        cell,
        tb,
        duration,
        bin,
        smoothing,
        window,
        ac_bin_ms,
        dir_bin,
        dir_smoothing,
        speed_bin,
        speed_max,
    );
    output(|o| *o = a.into());
}
/// Adds the spatial autocorrelogram to an analysis computed without the cache.
#[no_mangle]
pub extern "C" fn analysis_add_sc(minimum: usize) {
    output(|o| {
        o.sc = Rc::new(autocorrelation(
            &o.spatial,
            o.meta[1] as usize,
            o.meta[2] as usize,
            minimum,
        ))
    });
}
#[no_mangle]
pub extern "C" fn analysis_meta() -> *const f64 {
    output(|o| o.meta.as_ptr())
}
macro_rules! getter {
    ($ptr:ident,$len:ident,$field:ident) => {
        #[no_mangle]
        pub extern "C" fn $ptr() -> *const f32 {
            output(|o| o.$field.as_ptr())
        }
        #[no_mangle]
        pub extern "C" fn $len() -> usize {
            output(|o| o.$field.len())
        }
    };
}
getter!(analysis_spatial, analysis_spatial_len, spatial);
getter!(analysis_spikes, analysis_spikes_len, spikes);
getter!(analysis_direction, analysis_direction_len, direction);
getter!(analysis_speed, analysis_speed_len, speed);
getter!(analysis_speed_dwell, analysis_speed_dwell_len, speed_dwell);
getter!(analysis_ac, analysis_ac_len, ac);
getter!(analysis_sc, analysis_sc_len, sc);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::NUMBERS;
    use crate::position::tests::recording;

    fn set(c: &mut Cache, values: &[(cache::Leaf, f64)]) {
        for &(leaf, value) in values {
            let j = NUMBERS.iter().position(|(l, _)| *l == leaf).unwrap();
            c.inputs.numbers[j] = value;
        }
    }
    fn same(a: &[f32], b: &[f32]) -> bool {
        a.len() == b.len()
            && a.iter()
                .zip(b)
                .all(|(x, y)| x == y || (x.is_nan() && y.is_nan()))
    }

    #[test]
    fn cached_analyses_match_computing_them_together() {
        // A walk over a 10 by 5 grid, with spikes spread through it.
        let rows: Vec<_> = (0..50u16)
            .map(|i| [20 + (i % 10) * 5, 20 + (i / 10) * 5, 1023, 1023, 12, 0])
            .collect();
        let raw = recording(&rows, 100., 50.);
        let mut e = Engine::new(30);
        e.times = (0..30).map(|i| i * 31).collect();
        e.labels = (0..30).map(|i| 1 + (i % 2) as u16).collect();
        let (tb, duration) = (1000., 1.);
        let mut c = Cache::default();
        c.inputs.pos_file = "trial|a.pos".into();
        c.inputs.recording = "t1".into();
        set(
            &mut c,
            &[
                (Leds, 1.),
                (MaxSpeed, 0.),
                (PosSmooth, 0.),
                (BinCm, 5.),
                (Smooth, 1.),
                (MaxRate, 0.),
                (RateMapSteps, 5.),
                (ScMinOverlap, 2.),
                (DirBin, 30.),
                (DirSmooth, 1.),
                (SpeedBin, 4.),
                (SpeedMax, 45.),
                (AcWindow, 100.),
                (AcBinMs, 5.),
                (Ppm, f64::NAN),
                (Sync, 20.),
            ],
        );
        let key = c.inputs.key(Node::PosRaw, "", &[]);
        c.put(key, raw.variant(1, 0., 0., 0.), RAW_POSITIONS);
        let processed = raw.variant(1, 0., 0., 20.);
        for cell in [1, 2] {
            let request = Cell {
                engine: Some(&mut e),
                cell,
                tb,
                duration,
            };
            assert!(analyse(&mut c, request, true));
            let cached = OUTPUT.with(|o| std::mem::take(&mut *o.borrow_mut()));
            let mut direct = crate::position::analyse(
                &mut e,
                Some(&processed),
                cell,
                tb,
                duration,
                5.,
                1,
                100.,
                5.,
                30.,
                1,
                4.,
                45.,
            );
            direct.sc = autocorrelation(
                &direct.spatial,
                direct.meta[1] as usize,
                direct.meta[2] as usize,
                2,
            );
            assert_eq!(cached.meta, direct.meta, "cell {cell}");
            for (name, a, b) in [
                ("spatial", &cached.spatial, &direct.spatial),
                ("sc", &cached.sc, &direct.sc),
                ("spikes", &cached.spikes, &direct.spikes),
                ("direction", &cached.direction, &direct.direction),
                ("speed", &cached.speed, &direct.speed),
                ("speed dwell", &cached.speed_dwell, &direct.speed_dwell),
                ("ac", &cached.ac, &direct.ac),
            ] {
                assert!(same(a, b), "cell {cell} {name}: {a:?} != {b:?}");
            }
            assert!(
                !cached.spikes.is_empty(),
                "cell {cell} has spikes on the path"
            );
        }
        // The second cell shared the first's position-only values, and a repeat is all hits:
        // even without the engine, which only a cell named by cut and revision allows.
        c.inputs.cell_prefix = "cut|0".into();
        fn request(engine: Option<&mut Engine>) -> Cell<'_> {
            Cell {
                engine,
                cell: 1,
                tb: 1000.,
                duration: 1.,
            }
        }
        assert!(!analyse(&mut c, request(None), false));
        assert!(analyse(&mut c, request(Some(&mut e)), false));
        let first = OUTPUT.with(|o| o.borrow().keys);
        assert!(analyse(&mut c, request(None), false));
        assert_eq!(OUTPUT.with(|o| o.borrow().keys), first);
        // Colours never change a key. A bin width does, but not the speed dwell's, and the
        // new rate map is made from the cached spike samples, so it still needs no engine.
        set(&mut c, &[(MaxRate, 9.)]);
        assert!(analyse(&mut c, request(None), false));
        assert_eq!(OUTPUT.with(|o| o.borrow().keys), first);
        set(&mut c, &[(BinCm, 2.)]);
        assert!(analyse(&mut c, request(None), false));
        assert_ne!(OUTPUT.with(|o| o.borrow().keys)[0..2], first[0..2]);
        assert_eq!(OUTPUT.with(|o| o.borrow().keys)[4..6], first[4..6]);
    }
}
