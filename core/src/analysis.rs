//! The handlers that compute positions and cell analyses. Each is a plain function of the
//! inputs: it gets what it needs by calling other handlers (`cx.call::<H>()`), which the
//! cache answers when it can (cache.rs), and does its own work with the pure functions in
//! position.rs. Each also says what its value doesn't depend on (its key's ignores) and how
//! many to keep. A value may carry by-products of its work (a rate map's peak) for other
//! handlers to take from it, rather than computing them again.
use crate::cache::{
    answer, f32s, supply, Answer, Buffer, Context, Handler, Leaf::*, Missing, Node, Part, Route, L,
};
use crate::position::{direction_bins, refractory, speed_bins, temporal_ac, Position};
use crate::spatial_ac::autocorrelation;

/// Rate-map colours are applied when the map is drawn, never computed with.
const COLOURS: [Part; 2] = [L(MaxRate), L(RateMapSteps)];
/// How many to keep: few positions (each holds every sample), more of what is derived from
/// one, and many per-cell results, since every visible tile has some.
const RAW_POSITIONS: usize = 2;
const POSITIONS: usize = 4;
const PER_POSITION: usize = 8;
const PER_CELL: usize = 200;

/// The handlers JavaScript can ask for, by name.
pub(crate) static ROUTES: &[Route] = &[
    ("path", answer::<Path>),
    ("positionInfo", answer::<PositionInfo>),
    ("cellStats", answer::<CellStats>),
    ("spikePositions", answer::<SpikePositions>),
    ("ratemap", answer::<Ratemap>),
    ("spatialAc", answer::<SpatialAc>),
    ("direction", answer::<Direction>),
    ("speed", answer::<Speed>),
    ("speedDwell", answer::<SpeedDwell>),
    ("temporalAc", answer::<TemporalAc>),
];

/// A position file as read. Only JavaScript can read it (`cache_put_raw`).
pub(crate) struct RawPosition;
impl Handler for RawPosition {
    type Value = Position;
    const NODE: Node = Node::PosRaw;
    const LIMIT: usize = RAW_POSITIONS;
    fn compute(_: &mut Context) -> Result<Position, Missing> {
        Err(Missing::Position)
    }
}
/// Takes a read, unprocessed position for the current inputs.
#[no_mangle]
pub unsafe extern "C" fn cache_put_raw(p: *mut Position) {
    supply::<RawPosition>(*Box::from_raw(p));
}

/// A processed position.
pub(crate) struct ProcessedPosition;
impl Handler for ProcessedPosition {
    type Value = Position;
    const NODE: Node = Node::Position;
    const LIMIT: usize = POSITIONS;
    fn compute(cx: &mut Context) -> Result<Position, Missing> {
        let raw = cx.call::<RawPosition>()?;
        Ok(raw.variant(
            cx.number(Leds) as u32,
            cx.number(MaxSpeed) as f32,
            cx.number(PosSmooth),
            cx.number(Sync),
        ))
    }
}

/// Values JavaScript copies out as one buffer.
pub(crate) struct Values(Vec<f32>);
impl Answer for Values {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![("values", f32s(&self.0))]
    }
}

/// The trajectory. The sync offset moves spikes along it, not the path itself.
pub(crate) struct Path;
impl Handler for Path {
    type Value = Values;
    const NODE: Node = Node::Path;
    const IGNORE: &'static [Part] = &[L(Sync)];
    const LIMIT: usize = PER_POSITION;
    fn compute(cx: &mut Context) -> Result<Values, Missing> {
        Ok(Values(cx.call::<ProcessedPosition>()?.path()))
    }
}

/// The arena's width and height (cm), the calibration, and whether it is only a guess.
pub(crate) struct PositionInfo;
pub(crate) struct Info([f64; 4]);
impl Handler for PositionInfo {
    type Value = Info;
    const NODE: Node = Node::PositionInfo;
    const IGNORE: &'static [Part] = &[L(Sync)];
    const LIMIT: usize = PER_POSITION;
    fn compute(cx: &mut Context) -> Result<Info, Missing> {
        let p = cx.call::<ProcessedPosition>()?;
        let [w, h] = p.arena();
        Ok(Info([
            w as f64,
            h as f64,
            p.ppm() as f64,
            p.ppm_estimated() as u8 as f64,
        ]))
    }
}
impl Answer for Info {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![("info", Buffer::F64(self.0.to_vec()))]
    }
}

/// A cell's spike count, refractory violations (%) and rate (Hz).
pub(crate) struct CellStats;
pub(crate) struct Stats([f64; 3]);
impl Handler for CellStats {
    type Value = Stats;
    const NODE: Node = Node::CellStats;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Context) -> Result<Stats, Missing> {
        let (tb, duration) = (cx.tb, cx.duration);
        let (times, ids) = cx.spike_times()?;
        let rate = if duration > 0. {
            ids.len() as f64 / duration
        } else {
            0.
        };
        Ok(Stats([ids.len() as f64, refractory(times, ids, tb), rate]))
    }
}
impl Answer for Stats {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![("stats", Buffer::F64(self.0.to_vec()))]
    }
}

/// The position sample of each of a cell's spikes in the arena.
pub(crate) struct SpikeSamples;
impl Handler for SpikeSamples {
    type Value = Vec<u32>;
    const NODE: Node = Node::SpikeSamples;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Context) -> Result<Vec<u32>, Missing> {
        let p = cx.call::<ProcessedPosition>()?;
        let tb = cx.tb;
        let (times, ids) = cx.spike_times()?;
        Ok(p.spike_samples(times, ids, tb))
    }
}
/// Where each of a cell's spikes was, normalised, for the path plot. As many as the spikes,
/// so few are kept.
pub(crate) struct SpikePositions;
impl Handler for SpikePositions {
    type Value = Values;
    const NODE: Node = Node::SpikePositions;
    const LIMIT: usize = 16;
    fn compute(cx: &mut Context) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        Ok(Values(
            cx.call::<ProcessedPosition>()?.spike_positions(&samples),
        ))
    }
}

/// A spatial grid of values.
pub(crate) struct Grid {
    w: usize,
    h: usize,
    values: Vec<f32>,
}
/// Seconds in each spatial bin. Where the animal was, not when, so not the sync offset; and
/// smoothing is applied to the rate map, not this.
pub(crate) struct SpatialOccupancy;
impl Handler for SpatialOccupancy {
    type Value = Grid;
    const NODE: Node = Node::SpatialOccupancy;
    const IGNORE: &'static [Part] = &[L(Sync), L(Smooth), COLOURS[0], COLOURS[1]];
    const LIMIT: usize = PER_POSITION;
    fn compute(cx: &mut Context) -> Result<Grid, Missing> {
        let p = cx.call::<ProcessedPosition>()?;
        let (w, h) = p.grid(cx.number(BinCm) as f32);
        Ok(Grid {
            w,
            h,
            values: p.spatial_occupancy(w, h),
        })
    }
}
/// A cell's spatial rate map (NaN where unvisited), with its peak as a by-product.
pub(crate) struct Ratemap;
pub(crate) struct Rates {
    grid: Grid,
    peak: f32,
}
impl Handler for Ratemap {
    type Value = Rates;
    const NODE: Node = Node::Ratemap;
    const IGNORE: &'static [Part] = &COLOURS;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Context) -> Result<Rates, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let occupancy = cx.call::<SpatialOccupancy>()?;
        let p = cx.call::<ProcessedPosition>()?;
        let (w, h) = (occupancy.w, occupancy.h);
        let (values, peak) = p.rate_map(
            &samples,
            &occupancy.values,
            w,
            h,
            cx.number(Smooth) as usize,
        );
        Ok(Rates {
            grid: Grid { w, h, values },
            peak,
        })
    }
}
impl Answer for Rates {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        let g = &self.grid;
        vec![
            ("values", f32s(&g.values)),
            (
                "shape",
                Buffer::F64(vec![g.w as f64, g.h as f64, self.peak as f64]),
            ),
        ]
    }
}
/// The spatial autocorrelogram of a cell's rate map.
pub(crate) struct SpatialAc;
impl Handler for SpatialAc {
    type Value = Values;
    const NODE: Node = Node::SpatialAc;
    const IGNORE: &'static [Part] = &COLOURS;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Context) -> Result<Values, Missing> {
        let rates = cx.call::<Ratemap>()?;
        let g = &rates.grid;
        Ok(Values(autocorrelation(
            &g.values,
            g.w,
            g.h,
            cx.number(ScMinOverlap) as usize,
        )))
    }
}

/// Seconds facing each direction. Where the animal was, not when, so not the sync offset;
/// and smoothing is applied to the map, not this.
pub(crate) struct DirectionOccupancy;
impl Handler for DirectionOccupancy {
    type Value = Vec<f32>;
    const NODE: Node = Node::DirectionOccupancy;
    const IGNORE: &'static [Part] = &[L(Sync), L(DirSmooth)];
    const LIMIT: usize = PER_POSITION;
    fn compute(cx: &mut Context) -> Result<Vec<f32>, Missing> {
        let nd = direction_bins(cx.number(DirBin) as f32);
        Ok(cx.call::<ProcessedPosition>()?.direction_occupancy(nd))
    }
}
/// A cell's directional rate map.
pub(crate) struct Direction;
impl Handler for Direction {
    type Value = Values;
    const NODE: Node = Node::Direction;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Context) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let occupancy = cx.call::<DirectionOccupancy>()?;
        let p = cx.call::<ProcessedPosition>()?;
        let nd = occupancy.len();
        Ok(Values(p.direction_map(
            &samples,
            &occupancy,
            nd,
            cx.number(DirSmooth) as usize,
        )))
    }
}

/// Seconds at each speed. How fast the animal went, not when, so not the sync offset.
pub(crate) struct SpeedDwell;
impl Handler for SpeedDwell {
    type Value = Values;
    const NODE: Node = Node::SpeedDwell;
    const IGNORE: &'static [Part] = &[L(Sync)];
    const LIMIT: usize = PER_POSITION;
    fn compute(cx: &mut Context) -> Result<Values, Missing> {
        let (bin, max, ns) = speed_bins(cx.number(SpeedBin) as f32, cx.number(SpeedMax) as f32);
        Ok(Values(
            cx.call::<ProcessedPosition>()?.speed_dwell(bin, max, ns),
        ))
    }
}
/// A cell's rate at each speed.
pub(crate) struct Speed;
impl Handler for Speed {
    type Value = Values;
    const NODE: Node = Node::Speed;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Context) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let dwell = cx.call::<SpeedDwell>()?;
        let p = cx.call::<ProcessedPosition>()?;
        let (bin, max, _) = speed_bins(cx.number(SpeedBin) as f32, cx.number(SpeedMax) as f32);
        Ok(Values(p.speed_map(&samples, &dwell.0, bin, max)))
    }
}

/// A cell's temporal autocorrelogram.
pub(crate) struct TemporalAc;
impl Handler for TemporalAc {
    type Value = Values;
    const NODE: Node = Node::TemporalAc;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Context) -> Result<Values, Missing> {
        let (window, bin, tb) = (cx.number(AcWindow), cx.number(AcBinMs), cx.tb);
        let (times, ids) = cx.spike_times()?;
        Ok(Values(temporal_ac(times, ids, tb, window, bin)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{Cache, NUMBERS};
    use crate::position::tests::recording;
    use crate::Engine;

    fn set(c: &mut Cache, values: &[(crate::cache::Leaf, f64)]) {
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
    fn cache() -> Cache {
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
        c
    }
    /// A walk over a 10 by 5 grid, unprocessed, and 30 spikes in two cells spread through it.
    fn data() -> (Position, Engine) {
        let rows: Vec<_> = (0..50u16)
            .map(|i| [20 + (i % 10) * 5, 20 + (i / 10) * 5, 1023, 1023, 12, 0])
            .collect();
        let mut e = Engine::new(30);
        e.times = (0..30).map(|i| i * 31).collect();
        e.labels = (0..30).map(|i| 1 + (i % 2) as u16).collect();
        (recording(&rows, 100., 50.), e)
    }
    fn supply_raw(c: &mut Cache, raw: Position) {
        let key = Context::new(c, None, 0, 0., 0.)
            .key::<RawPosition>()
            .unwrap();
        c.put(key, raw, RAW_POSITIONS);
    }

    #[test]
    fn handlers_give_what_computing_everything_together_gives() {
        let (raw, mut e) = data();
        let mut c = cache();
        supply_raw(&mut c, raw.variant(1, 0., 0., 0.));
        let processed = raw.variant(1, 0., 0., 20.);
        for cell in [1, 2] {
            let mut cx = Context::new(&mut c, Some(&mut e), cell, 1000., 1.);
            let stats = cx.call::<CellStats>().unwrap();
            let rates = cx.call::<Ratemap>().unwrap();
            let sc = cx.call::<SpatialAc>().unwrap();
            let direction = cx.call::<Direction>().unwrap();
            let speed = cx.call::<Speed>().unwrap();
            let dwell = cx.call::<SpeedDwell>().unwrap();
            let ac = cx.call::<TemporalAc>().unwrap();
            let spikes = cx.call::<SpikePositions>().unwrap();
            drop(cx);
            let direct = crate::position::analyse(
                &mut e,
                Some(&processed),
                cell,
                1000.,
                1.,
                5.,
                1,
                100.,
                5.,
                30.,
                1,
                4.,
                45.,
            );
            let m = direct.meta;
            let direct_sc = autocorrelation(&direct.spatial, m[1] as usize, m[2] as usize, 2);
            assert_eq!(
                [rates.grid.w as f64, rates.grid.h as f64, rates.peak as f64],
                [m[1], m[2], m[3]]
            );
            assert_eq!(stats.0, [m[8], m[4], m[5]]);
            for (name, a, b) in [
                ("spatial", &rates.grid.values, &direct.spatial),
                ("sc", &sc.0, &direct_sc),
                ("spikes", &spikes.0, &direct.spikes),
                ("direction", &direction.0, &direct.direction),
                ("speed", &speed.0, &direct.speed),
                ("speed dwell", &dwell.0, &direct.speed_dwell),
                ("ac", &ac.0, &direct.ac),
            ] {
                assert!(same(a, b), "cell {cell} {name}: {a:?} != {b:?}");
            }
            assert!(!spikes.0.is_empty(), "cell {cell} has spikes on the path");
        }
    }

    #[test]
    fn handlers_say_what_they_miss_and_reuse_what_is_cached() {
        let (raw, mut e) = data();
        let mut c = cache();
        // Named by cut, so a cell can be found without its spikes once computed.
        c.inputs.cell_prefix = "cut|0".into();
        fn ask<H: Handler>(c: &mut Cache, e: Option<&mut Engine>) -> Result<u64, Missing> {
            let mut cx = Context::new(c, e, 1, 1000., 1.);
            cx.call::<H>()?;
            Ok(cx.key::<H>()?.digest())
        }
        assert_eq!(ask::<Ratemap>(&mut c, Some(&mut e)), Err(Missing::Position));
        supply_raw(&mut c, raw.variant(1, 0., 0., 0.));
        assert_eq!(ask::<Ratemap>(&mut c, None), Err(Missing::Engine));
        let first = ask::<Ratemap>(&mut c, Some(&mut e)).unwrap();
        assert_eq!(ask::<Ratemap>(&mut c, None), Ok(first));
        // Colours never change the key. A bin width does, and that rate map is made from the
        // cached spike samples, so it still needs no engine; the speed dwell is unchanged.
        let dwell = ask::<SpeedDwell>(&mut c, None).unwrap();
        set(&mut c, &[(MaxRate, 9.)]);
        assert_eq!(ask::<Ratemap>(&mut c, None), Ok(first));
        set(&mut c, &[(BinCm, 2.)]);
        let binned = ask::<Ratemap>(&mut c, None).unwrap();
        assert_ne!(binned, first);
        assert_eq!(ask::<SpeedDwell>(&mut c, None), Ok(dwell));
        // Another trial's position hasn't been read.
        c.inputs.pos_file = "other|a.pos".into();
        assert_eq!(ask::<Ratemap>(&mut c, Some(&mut e)), Err(Missing::Position));
    }
}
