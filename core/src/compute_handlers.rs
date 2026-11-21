//! The handlers that compute positions and cell analyses. Each is a plain function of the
//! inputs: it gets what it needs by calling other handlers (`cx.call::<H>()`, memoised by
//! compute.rs), and does its own work with the pure functions in position.rs. Each also says what its value doesn't depend on (its key's ignores) and how
//! many to keep. A value may carry by-products of its work (a rate map's peak) for other
//! handlers to take from it, rather than computing them again.
use crate::compute::{
    answer, f32s, staged_request, supply, u16s, u32s, u8s, Answer, Answered, Buffer, Handler, Key,
    Leaf::*, Missing, Node, Part, Request, Route, L,
};
use crate::lfp::{
    analytic, band, frequency_bins, frequency_distribution, instantaneous_frequency,
    mean_frequency, spike_phases, EgfBuilder, Signal,
};
use crate::pca::PcaBuilder;
use crate::position::{direction_bins, refractory, speed_bins, temporal_ac, Position, Samples};
use crate::processing::{apply_patch, CellWaves as Waves, CutParser, Scan};
use crate::spatial_ac::autocorrelation;
use crate::time_labels::{self, Method, Rules};
use crate::waves::WaveOrder as Order;
use crate::Population as Spikes;
use rustfft::num_complex::Complex;
use std::{cell::RefCell, rc::Rc, slice};

/// Rate-map colours are applied when the map is drawn, never computed with.
const COLOURS: [Part; 2] = [L(MaxRate), L(RateMapSteps)];
/// How many to keep: few positions (each holds every sample), more of what is derived from
/// one, and many per-cell results, since every visible tile has some.
const RAW_POSITIONS: usize = 2;
const POSITIONS: usize = 4;
const PER_POSITION: usize = 8;
const PER_CELL: usize = 200;
/// Recordings and their labels are large; the memo's budget bounds them too.
const RECORDINGS: usize = 4;
const LABELS: usize = 8;
/// Continuous signals: a few files, and a few band-passes of each.
const SIGNALS: usize = 4;
const PER_SIGNAL: usize = 8;
/// Logs are small, and rules are edited as they're typed: keep recent variants.
const LOGS: usize = 4;
const PER_LOG: usize = 16;

/// A scan to stream the file through, and where to keep its sample column and cell waveforms.
type PendingScan = (Scan, Option<Key>, Option<Key>);
thread_local! {
    /// What JavaScript was last told is missing, when it needs more than the kind: a patch's
    /// id, or the scan to stream the file through and where to keep what it reads.
    static MISSING_PATCH: RefCell<Rc<str>> = RefCell::new("".into());
    static PENDING_SCAN: RefCell<Option<PendingScan>> = const { RefCell::new(None) };
}

/// The handlers JavaScript can ask for, by name.
pub(crate) static ROUTES: &[Route] = &[
    ("population", answer::<Population>),
    ("view", answer::<View>),
    ("membership", membership),
    ("pca", answer::<Pca>),
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
    ("spatialDrift", answer::<SpatialDrift>),
    ("spikeDrift", answer::<SpikeDrift>),
    ("lfpFrequency", answer::<LfpFrequency>),
    ("spikePhase", answer::<SpikePhase>),
    ("timeLabels", answer::<TimeLabels>),
    ("timeMask", answer::<TimeMask>),
];

/// A recording's spike times and amplitudes. Only JavaScript can read its file
/// (`compute_supply_population`).
pub(crate) struct Population;
impl Handler for Population {
    type Value = Spikes;
    const NODE: Node = Node::Population;
    const LIMIT: usize = RECORDINGS;
    fn compute(_: &mut Request) -> Result<Spikes, Missing> {
        Err(Missing::Population)
    }
    fn bytes(p: &Spikes) -> usize {
        p.bytes()
    }
}
impl Answer for Spikes {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![
            ("features", u8s(&self.amplitudes)),
            ("times", u32s(&self.times)),
        ]
    }
}
/// Takes a population read for the staged inputs.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_population(p: *mut Spikes) {
    supply::<Population>(*Box::from_raw(p));
}

/// A cut file's labels, or none for an unsorted recording. Only JavaScript can read the file
/// (`compute_supply_cut`).
pub(crate) struct CutLabels;
impl Handler for CutLabels {
    type Value = Vec<u16>;
    const NODE: Node = Node::CutLabels;
    const LIMIT: usize = RECORDINGS;
    fn compute(cx: &mut Request) -> Result<Vec<u16>, Missing> {
        match &*cx.inputs().cut_source {
            "unsorted" => Ok(vec![0; cx.inputs().n]),
            _ => Err(Missing::Cut),
        }
    }
    fn bytes(labels: &Vec<u16>) -> usize {
        labels.len() * 2
    }
}
/// Takes a finished cut parser for the staged inputs.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_cut(p: *mut CutParser) {
    supply::<CutLabels>(Box::from_raw(p).into_labels());
}

/// One edit's patch. Only JavaScript has it (`compute_supply_patch`).
pub(crate) struct Patch;
impl Handler for Patch {
    type Value = Vec<u8>;
    const NODE: Node = Node::Patch;
    const LIMIT: usize = 64;
    fn compute(cx: &mut Request) -> Result<Vec<u8>, Missing> {
        let id = cx.inputs().patch.clone();
        MISSING_PATCH.with(|m| *m.borrow_mut() = id);
        Err(Missing::Patch)
    }
    fn bytes(patch: &Vec<u8>) -> usize {
        patch.len()
    }
}
/// The id of the patch last reported missing, as UTF-8.
#[no_mangle]
pub extern "C" fn missing_patch() -> *const u8 {
    MISSING_PATCH.with(|m| m.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn missing_patch_len() -> usize {
    MISSING_PATCH.with(|m| m.borrow().len())
}
/// Takes the bytes of the patch last reported missing.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_patch(p: *const u8, n: usize) {
    let id = MISSING_PATCH.with(|m| m.borrow().clone());
    let mut cx = staged_request();
    let _ = cx.keep_with::<Patch>(slice::from_raw_parts(p, n).to_vec(), |i| i.patch = id);
}

/// The labels after the edit history: the nearest kept earlier labels (or the cut's) with
/// the patches since applied, in order.
pub(crate) struct Labels;
impl Handler for Labels {
    type Value = Vec<u16>;
    const NODE: Node = Node::Labels;
    const LIMIT: usize = LABELS;
    fn compute(cx: &mut Request) -> Result<Vec<u16>, Missing> {
        let history = cx.inputs().history.clone();
        let ids: Vec<&str> = history.split(',').filter(|id| !id.is_empty()).collect();
        let kept = (1..ids.len()).rev().find_map(|k| {
            let earlier = ids[..k].join(",");
            Some((k, cx.peek_with::<Labels>(|i| i.history = earlier.into())?))
        });
        let (from, mut labels) = match kept {
            Some((k, labels)) => (k, (*labels).clone()),
            None => (0, (*cx.call::<CutLabels>()?).clone()),
        };
        for id in &ids[from..] {
            let patch = cx.call_with::<Patch>(|i| i.patch = (*id).into())?;
            if apply_patch(&mut labels, &patch, true) != 0 {
                return Err(Missing::Invalid);
            }
        }
        Ok(labels)
    }
    fn bytes(labels: &Vec<u16>) -> usize {
        labels.len() * 2
    }
}
pub(crate) struct Counts;
impl Handler for Counts {
    type Value = Vec<u32>;
    const NODE: Node = Node::Counts;
    const LIMIT: usize = LABELS;
    fn compute(cx: &mut Request) -> Result<Vec<u32>, Missing> {
        Ok(crate::counts(&cx.call::<Labels>()?))
    }
}
/// Each cell's spike indices, ascending.
pub(crate) struct Groups;
impl Handler for Groups {
    type Value = Vec<Vec<u32>>;
    const NODE: Node = Node::Groups;
    const LIMIT: usize = 2;
    fn compute(cx: &mut Request) -> Result<Vec<Vec<u32>>, Missing> {
        let labels = cx.call::<Labels>()?;
        Ok(crate::groups(&labels, &cx.call::<Counts>()?))
    }
    fn bytes(groups: &Vec<Vec<u32>>) -> usize {
        groups.iter().map(|g| g.len() * 4).sum()
    }
}
pub(crate) struct CellHashes;
impl Handler for CellHashes {
    type Value = Vec<u32>;
    const NODE: Node = Node::CellHashes;
    const LIMIT: usize = LABELS;
    fn compute(cx: &mut Request) -> Result<Vec<u32>, Missing> {
        Ok(crate::cell_hashes(&cx.call::<Labels>()?))
    }
}
pub(crate) struct WaveOrder;
impl Handler for WaveOrder {
    type Value = Order;
    const NODE: Node = Node::WaveOrder;
    const LIMIT: usize = 2;
    fn compute(cx: &mut Request) -> Result<Order, Missing> {
        Ok(crate::waves::order(&cx.call::<Labels>()?))
    }
    fn bytes(order: &Order) -> usize {
        order.order.len() * 4
    }
}
/// What the page shows of the labels.
pub(crate) struct View;
pub(crate) struct Shown {
    labels: Rc<Vec<u16>>,
    counts: Rc<Vec<u32>>,
    hashes: Rc<Vec<u32>>,
    order: Rc<Order>,
}
impl Handler for View {
    type Value = Shown;
    const NODE: Node = Node::View;
    const LIMIT: usize = 2;
    fn compute(cx: &mut Request) -> Result<Shown, Missing> {
        Ok(Shown {
            labels: cx.call::<Labels>()?,
            counts: cx.call::<Counts>()?,
            hashes: cx.call::<CellHashes>()?,
            order: cx.call::<WaveOrder>()?,
        })
    }
}
impl Answer for Shown {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![
            ("labels", u16s(&self.labels)),
            ("counts", u32s(&self.counts)),
            ("cellHashes", u32s(&self.hashes)),
            ("waveOrder", u32s(&self.order.order)),
            ("waveStarts", u32s(&self.order.starts)),
            ("waveHashes", u32s(&self.order.hashes)),
        ]
    }
}

/// The cell's spike count and membership hash, without copying the labels: so the page can
/// tell whether an analysis was made from its cell's current spikes.
fn membership(cx: &mut Request) -> Result<Answered, Missing> {
    let cell = cx.cell() as usize;
    let count = cx.call::<Counts>()?[cell];
    let hashes = cx.call::<CellHashes>()?;
    let values = vec![
        count as f64,
        hashes[cell * 2] as f64,
        hashes[cell * 2 + 1] as f64,
    ];
    Ok(Answered::new(
        0,
        vec![("membership", Buffer::F64(values))],
        None,
    ))
}

/// Every waveform of a cell's spikes, read by streaming the file through a scan.
pub(crate) struct CellWaves;
impl Handler for CellWaves {
    type Value = Waves;
    const NODE: Node = Node::CellWaves;
    const LIMIT: usize = 2;
    fn compute(cx: &mut Request) -> Result<Waves, Missing> {
        let indices = cx.call::<Groups>()?[cx.cell() as usize].clone();
        let key = cx.key::<Self>()?;
        let scan = Scan::new(cx.inputs().n, None, Some(indices));
        PENDING_SCAN.with(|p| *p.borrow_mut() = Some((scan, None, Some(key))));
        Err(Missing::Scan)
    }
    fn bytes(w: &Waves) -> usize {
        w.waves.len() + w.indices.len() * 4
    }
}
/// One sample of one channel for every spike, read by streaming the file through a scan.
pub(crate) struct Gate;
impl Handler for Gate {
    type Value = Vec<i8>;
    const NODE: Node = Node::Gate;
    const LIMIT: usize = 2;
    fn compute(cx: &mut Request) -> Result<Vec<i8>, Missing> {
        let [channel, sample] = cx.inputs().gate;
        let key = cx.key::<Self>()?;
        let scan = Scan::new(
            cx.inputs().n,
            Some((channel as usize, sample as usize)),
            None,
        );
        PENDING_SCAN.with(|p| *p.borrow_mut() = Some((scan, Some(key), None)));
        Err(Missing::Scan)
    }
    fn bytes(column: &Vec<i8>) -> usize {
        column.len()
    }
}
/// The scan last reported missing, to stream the whole tetrode file through (`scan_feed`).
#[no_mangle]
pub extern "C" fn scan_take() -> *mut Scan {
    PENDING_SCAN.with(|p| {
        let (scan, gate, cell) = p.borrow_mut().take().expect("a scan was reported missing");
        let scan = Box::into_raw(Box::new(scan));
        // The keys stay behind for `compute_supply_scan`.
        *p.borrow_mut() = Some((Scan::new(0, None, None), gate, cell));
        scan
    })
}
/// Keeps what a finished scan read where its request needed it.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_scan(s: *mut Scan) {
    let mut scan = *Box::from_raw(s);
    let Some((_, gate, cell)) = PENDING_SCAN.with(|p| p.borrow_mut().take()) else {
        return;
    };
    if let (Some(key), Some((_, _, column))) = (gate, scan.column.take()) {
        crate::cache::put(key, column, Gate::LIMIT, Gate::bytes);
    }
    if scan.complete() {
        if let (Some(key), Some((indices, waves))) = (cell, scan.cell.take()) {
            crate::cache::put(
                key,
                Waves { indices, waves },
                CellWaves::LIMIT,
                CellWaves::bytes,
            );
        }
    }
}

/// Four principal components of every spike. Only JavaScript can stream the samples and
/// projection (`compute_supply_pca`).
pub(crate) struct Pca;
impl Handler for Pca {
    type Value = Values;
    const NODE: Node = Node::Pca;
    const LIMIT: usize = 2;
    fn compute(_: &mut Request) -> Result<Values, Missing> {
        Err(Missing::Pca)
    }
    fn bytes(v: &Values) -> usize {
        v.0.len() * 4
    }
}
/// Takes a finished PCA for the staged inputs.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_pca(b: *mut PcaBuilder) {
    supply::<Pca>(Values(Box::from_raw(b).values()));
}

/// A position file as read. Only JavaScript can read it (`compute_supply_position`).
pub(crate) struct RawPosition;
impl Handler for RawPosition {
    type Value = Position;
    const NODE: Node = Node::PosRaw;
    const LIMIT: usize = RAW_POSITIONS;
    fn compute(_: &mut Request) -> Result<Position, Missing> {
        Err(Missing::Position)
    }
}
/// Takes a read, unprocessed position for the current inputs.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_position(p: *mut Position) {
    supply::<RawPosition>(*Box::from_raw(p));
}

/// A processed position.
pub(crate) struct ProcessedPosition;
impl Handler for ProcessedPosition {
    type Value = Position;
    const NODE: Node = Node::Position;
    const LIMIT: usize = POSITIONS;
    fn compute(cx: &mut Request) -> Result<Position, Missing> {
        let raw = cx.call::<RawPosition>()?;
        Ok(raw.variant(
            cx.input(Leds) as u32,
            cx.input(MaxSpeed) as f32,
            cx.input(PosSmooth),
            cx.input(Sync),
        ))
    }
}

/// Values JavaScript copies out as one buffer.
pub(crate) struct Values(pub(crate) Vec<f32>);
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
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
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
    fn compute(cx: &mut Request) -> Result<Info, Missing> {
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

/// A cell's spike times.
pub(crate) struct CellSpikes;
impl Handler for CellSpikes {
    type Value = Vec<u32>;
    const NODE: Node = Node::Spikes;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Vec<u32>, Missing> {
        let groups = cx.call::<Groups>()?;
        let population = cx.call::<Population>()?;
        let group = &groups[cx.cell() as usize];
        Ok(group
            .iter()
            .map(|&i| population.times[i as usize])
            .collect())
    }
    fn bytes(times: &Vec<u32>) -> usize {
        times.len() * 4
    }
}

/// A cell's spike count, refractory violations (%) and rate (Hz).
pub(crate) struct CellStats;
pub(crate) struct Stats([f64; 3]);
impl Handler for CellStats {
    type Value = Stats;
    const NODE: Node = Node::CellStats;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Stats, Missing> {
        let tb = cx.tb();
        let times = cx.call::<CellSpikes>()?;
        // Without one in the header, the recording lasts until its last spike.
        let duration = match cx.duration() {
            d if d > 0. => d,
            _ => cx
                .call::<Population>()?
                .times
                .last()
                .map_or(0., |&t| t as f64 / tb),
        };
        let rate = if duration > 0. {
            times.len() as f64 / duration
        } else {
            0.
        };
        Ok(Stats([times.len() as f64, refractory(&times, tb), rate]))
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
    type Value = Samples;
    const NODE: Node = Node::SpikeSamples;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Samples, Missing> {
        let p = cx.call::<ProcessedPosition>()?;
        let times = cx.call::<CellSpikes>()?;
        Ok(p.spike_samples(&times, cx.tb()))
    }
}
/// Where each of a cell's spikes was, normalised, for the path plot. As many as the spikes,
/// so few are kept.
pub(crate) struct SpikePositions;
impl Handler for SpikePositions {
    type Value = Values;
    const NODE: Node = Node::SpikePositions;
    const LIMIT: usize = 16;
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        Ok(Values(
            cx.call::<ProcessedPosition>()?
                .spike_positions(&samples.samples),
        ))
    }
}

/// When each spike on the path was, from 0 (the recording's start) to 1 (its last spike).
pub(crate) struct SpikeDrift;
impl Handler for SpikeDrift {
    type Value = Values;
    const NODE: Node = Node::SpikeDrift;
    const LIMIT: usize = 16;
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let last = last_spike(cx)?;
        Ok(Values(
            samples
                .times
                .iter()
                .map(|&t| t as f32 / last.max(1) as f32)
                .collect(),
        ))
    }
}
/// The recording's last spike time, which drift colours scale to.
fn last_spike(cx: &mut Request) -> Result<u32, Missing> {
    Ok(cx.call::<Population>()?.times.last().copied().unwrap_or(0))
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
    fn compute(cx: &mut Request) -> Result<Grid, Missing> {
        let p = cx.call::<ProcessedPosition>()?;
        let (w, h) = p.grid(cx.input(BinCm) as f32);
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
    fn compute(cx: &mut Request) -> Result<Rates, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let occupancy = cx.call::<SpatialOccupancy>()?;
        let p = cx.call::<ProcessedPosition>()?;
        let (w, h) = (occupancy.w, occupancy.h);
        let (values, peak) = p.rate_map(
            &samples.samples,
            &occupancy.values,
            w,
            h,
            cx.input(Smooth) as usize,
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
/// The mean spike time in each bin of a cell's rate map, from 0 (the recording's start) to 1
/// (its last spike), smoothed like the map; NaN where there are no spikes.
pub(crate) struct SpatialDrift;
impl Handler for SpatialDrift {
    type Value = Values;
    const NODE: Node = Node::SpatialDrift;
    const IGNORE: &'static [Part] = &COLOURS;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let occupancy = cx.call::<SpatialOccupancy>()?;
        let last = last_spike(cx)?;
        let p = cx.call::<ProcessedPosition>()?;
        let smoothing = cx.input(Smooth) as usize;
        Ok(Values(p.drift_map(
            &samples,
            &occupancy.values,
            last,
            occupancy.w,
            occupancy.h,
            smoothing,
        )))
    }
}
/// The spatial autocorrelogram of a cell's rate map, with the map's shape, so it can be shown
/// without the map.
pub(crate) struct SpatialAc;
pub(crate) struct Correlation {
    values: Vec<f32>,
    w: usize,
    h: usize,
}
impl Handler for SpatialAc {
    type Value = Correlation;
    const NODE: Node = Node::SpatialAc;
    const IGNORE: &'static [Part] = &COLOURS;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Correlation, Missing> {
        let rates = cx.call::<Ratemap>()?;
        let g = &rates.grid;
        Ok(Correlation {
            values: autocorrelation(&g.values, g.w, g.h, cx.input(ScMinOverlap) as usize),
            w: g.w,
            h: g.h,
        })
    }
}
impl Answer for Correlation {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![
            ("values", f32s(&self.values)),
            ("shape", Buffer::F64(vec![self.w as f64, self.h as f64])),
        ]
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
    fn compute(cx: &mut Request) -> Result<Vec<f32>, Missing> {
        let nd = direction_bins(cx.input(DirBin) as f32);
        Ok(cx.call::<ProcessedPosition>()?.direction_occupancy(nd))
    }
}
/// A cell's directional rate map.
pub(crate) struct Direction;
impl Handler for Direction {
    type Value = Values;
    const NODE: Node = Node::Direction;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let occupancy = cx.call::<DirectionOccupancy>()?;
        let p = cx.call::<ProcessedPosition>()?;
        let nd = occupancy.len();
        Ok(Values(p.direction_map(
            &samples.samples,
            &occupancy,
            nd,
            cx.input(DirSmooth) as usize,
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
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
        let (bin, max, ns) = speed_bins(cx.input(SpeedBin) as f32, cx.input(SpeedMax) as f32);
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
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
        let samples = cx.call::<SpikeSamples>()?;
        let dwell = cx.call::<SpeedDwell>()?;
        let p = cx.call::<ProcessedPosition>()?;
        let (bin, max, _) = speed_bins(cx.input(SpeedBin) as f32, cx.input(SpeedMax) as f32);
        Ok(Values(p.speed_map(&samples.samples, &dwell.0, bin, max)))
    }
}

/// A cell's temporal autocorrelogram.
pub(crate) struct TemporalAc;
impl Handler for TemporalAc {
    type Value = Values;
    const NODE: Node = Node::TemporalAc;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Values, Missing> {
        let times = cx.call::<CellSpikes>()?;
        let (window, bin) = (cx.input(AcWindow), cx.input(AcBinMs));
        Ok(Values(temporal_ac(&times, cx.tb(), window, bin)))
    }
}

/// An `.egf` file's signal, decimated. Only JavaScript can read it (`compute_supply_egf`).
pub(crate) struct RawEgf;
impl Handler for RawEgf {
    type Value = Signal;
    const NODE: Node = Node::EgfRaw;
    const LIMIT: usize = SIGNALS;
    fn compute(_: &mut Request) -> Result<Signal, Missing> {
        Err(Missing::Egf)
    }
    fn bytes(s: &Signal) -> usize {
        s.samples.len() * 4
    }
}
/// Takes a finished `.egf` builder for the staged inputs.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_egf(p: *mut EgfBuilder) {
    supply::<RawEgf>(Box::from_raw(p).finish());
}

/// The band-passed signal, analytic: its argument is the band's phase, its magnitude its
/// envelope. With the band as used and the rate, for what is made from it.
pub(crate) struct Analytic;
pub(crate) struct AnalyticSignal {
    pub(crate) rate: f64,
    pub(crate) start: f64,
    pub(crate) band: (f64, f64),
    pub(crate) z: Vec<Complex<f32>>,
}
impl Handler for Analytic {
    type Value = AnalyticSignal;
    const NODE: Node = Node::Analytic;
    const LIMIT: usize = PER_SIGNAL;
    fn compute(cx: &mut Request) -> Result<AnalyticSignal, Missing> {
        let signal = cx.call::<RawEgf>()?;
        let (low, high) = (cx.input(LfpLow), cx.input(LfpHigh));
        Ok(AnalyticSignal {
            rate: signal.rate,
            start: signal.start,
            band: band(low, high, signal.rate),
            z: analytic(&signal, low, high),
        })
    }
    fn bytes(a: &AnalyticSignal) -> usize {
        a.z.len() * 8
    }
}

/// Seconds at each instantaneous frequency of the band-passed signal over the whole
/// recording, in bins of the set width from the band's low edge to (at least) its high edge;
/// with where they start, their width, and the mean frequency (`lfp::mean_frequency`).
pub(crate) struct LfpFrequency;
pub(crate) struct Distribution {
    values: Vec<f32>,
    shape: [f64; 3],
}
impl Handler for LfpFrequency {
    type Value = Distribution;
    const NODE: Node = Node::LfpFrequency;
    const LIMIT: usize = PER_SIGNAL;
    fn compute(cx: &mut Request) -> Result<Distribution, Missing> {
        let a = cx.call::<Analytic>()?;
        let (low, high) = a.band;
        let bin = match cx.input(LfpFreqBin) {
            b if b > 0. => b,
            _ => 0.25,
        };
        let bins = frequency_bins(low, high, bin);
        let frequencies = instantaneous_frequency(&a.z, a.rate);
        Ok(Distribution {
            values: frequency_distribution(&frequencies, a.rate, low, bin, bins),
            shape: [low, bin, mean_frequency(&frequencies, low, high)],
        })
    }
}
impl Answer for Distribution {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![
            ("values", f32s(&self.values)),
            ("shape", Buffer::F64(self.shape.to_vec())),
        ]
    }
}

/// The band's phase at a cell's spikes: counts in bins of the set width (degrees) across a
/// cycle, from the band-passed signal's peaks; and their circular mean (radians, 0 to 2π).
pub(crate) struct SpikePhase;
pub(crate) struct Phases {
    counts: Vec<f32>,
    mean: f64,
}
impl Handler for SpikePhase {
    type Value = Phases;
    const NODE: Node = Node::SpikePhase;
    const LIMIT: usize = PER_CELL;
    fn compute(cx: &mut Request) -> Result<Phases, Missing> {
        let a = cx.call::<Analytic>()?;
        let times = cx.call::<CellSpikes>()?;
        let bin = match cx.input(LfpPhaseBin) {
            b if b > 0. => b,
            _ => 15.,
        };
        let bins = ((360. / bin).round() as usize).clamp(2, 360);
        let (counts, mean, _) = spike_phases(&a.z, a.rate, a.start, &times, cx.tb(), bins);
        Ok(Phases { counts, mean })
    }
}
impl Answer for Phases {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![
            ("values", f32s(&self.counts)),
            ("stats", Buffer::F64(vec![self.mean])),
        ]
    }
}

/// A log file's bytes. Only JavaScript can read it (`compute_supply_log`).
pub(crate) struct RawLog;
impl Handler for RawLog {
    type Value = Vec<u8>;
    const NODE: Node = Node::LogRaw;
    const LIMIT: usize = LOGS;
    fn compute(_: &mut Request) -> Result<Vec<u8>, Missing> {
        Err(Missing::Log)
    }
    fn bytes(log: &Vec<u8>) -> usize {
        log.len()
    }
}
/// Takes a log file's `n` bytes at `p` for the staged inputs.
#[no_mangle]
pub unsafe extern "C" fn compute_supply_log(p: *const u8, n: usize) {
    supply::<RawLog>(if n == 0 {
        vec![]
    } else {
        slice::from_raw_parts(p, n).to_vec()
    });
}

/// Where the log's rules change the label, and how many lines each rule matched; or why the
/// rules can't be used.
pub(crate) struct LogChanges;
pub(crate) struct Changes {
    names: Vec<String>,
    changes: Result<time_labels::Changes, String>,
}
impl Handler for LogChanges {
    type Value = Changes;
    const NODE: Node = Node::LogChanges;
    const LIMIT: usize = PER_LOG;
    fn compute(cx: &mut Request) -> Result<Changes, Missing> {
        let rules = match Rules::parse(&cx.inputs().time_rules) {
            Ok(rules) => rules,
            Err(e) => {
                return Ok(Changes {
                    names: vec![],
                    changes: Err(e),
                })
            }
        };
        let Method::Log(list) = &rules.method else {
            return Ok(Changes {
                names: rules.names,
                changes: Err("These rules don't read a log.".into()),
            });
        };
        let log = cx.call::<RawLog>()?;
        Ok(Changes {
            changes: Ok(time_labels::log_changes(list, &log)),
            names: rules.names,
        })
    }
}

/// The trial's labelled segments (see `time_labels::segments`), each label's name, total
/// seconds and segment count, how many lines each log rule matched, and any error (with no
/// segments).
pub(crate) struct TimeLabels;
pub(crate) struct Labelled {
    segments: Vec<(f64, f64, u16)>,
    duration: f64,
    names: Vec<String>,
    matched: Vec<u32>,
    error: String,
    // As answered.
    flat: Vec<f64>,
    labels: Vec<u16>,
    seconds: Vec<f64>,
    counts: Vec<u32>,
    text: Vec<u8>,
}
impl Labelled {
    fn new(
        segments: Vec<(f64, f64, u16)>,
        duration: f64,
        names: Vec<String>,
        matched: Vec<u32>,
        error: String,
    ) -> Self {
        let (seconds, counts) = time_labels::label_stats(&segments, names.len());
        Self {
            flat: segments.iter().flat_map(|s| [s.0, s.1]).collect(),
            labels: segments.iter().map(|s| s.2).collect(),
            text: names.join("\n").into_bytes(),
            seconds,
            counts,
            segments,
            duration,
            names,
            matched,
            error,
        }
    }
}
impl Handler for TimeLabels {
    type Value = Labelled;
    const NODE: Node = Node::TimeLabels;
    const LIMIT: usize = PER_LOG;
    fn compute(cx: &mut Request) -> Result<Labelled, Missing> {
        // The header's duration, else (an interrupted recording) its last spike.
        let duration = match cx.duration() {
            d if d > 0. => d,
            _ => last_spike(cx)? as f64 / cx.tb(),
        };
        let failed = |names, matched, error: String| {
            Ok(Labelled::new(vec![], duration, names, matched, error))
        };
        let rules = match Rules::parse(&cx.inputs().time_rules) {
            Ok(rules) => rules,
            Err(e) => return failed(vec![], vec![], e),
        };
        let segments = match rules.method {
            Method::Off => vec![(0., duration, 0)]
                .into_iter()
                .filter(|s| s.1 > 0.)
                .collect(),
            Method::Split(labels) => time_labels::split(&labels, duration),
            Method::Times(times) => time_labels::segments(times[0].1, &times, duration),
            Method::Log(_) if cx.inputs().log_file.is_empty() => {
                return failed(rules.names, vec![], "This trial has no log file.".into())
            }
            Method::Log(_) => {
                let changes = cx.call::<LogChanges>()?;
                return match &changes.changes {
                    Ok(c) => Ok(Labelled::new(
                        time_labels::segments(0, &c.points, duration),
                        duration,
                        changes.names.clone(),
                        c.matched.clone(),
                        String::new(),
                    )),
                    Err(e) => failed(changes.names.clone(), vec![], e.clone()),
                };
            }
        };
        Ok(Labelled::new(
            segments,
            duration,
            rules.names,
            vec![],
            String::new(),
        ))
    }
}
impl Answer for Labelled {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![
            ("segments", Buffer::F64(self.flat.clone())),
            ("labels", u16s(&self.labels)),
            ("names", u8s(&self.text)),
            ("seconds", Buffer::F64(self.seconds.clone())),
            ("counts", u32s(&self.counts)),
            ("matched", u32s(&self.matched)),
            ("error", u8s(self.error.as_bytes())),
            ("stats", Buffer::F64(vec![self.duration])),
        ]
    }
}

/// The times one label covers, as merged (start, end) intervals in seconds; and their total
/// and the trial's duration. With no label, the whole trial (the "total" plots compare labels
/// with); a label the trial doesn't have covers nothing.
pub(crate) struct TimeMask;
pub(crate) struct Mask {
    intervals: Vec<f64>,
    stats: [f64; 2],
}
impl Handler for TimeMask {
    type Value = Mask;
    const NODE: Node = Node::TimeMask;
    const LIMIT: usize = PER_LOG;
    fn compute(cx: &mut Request) -> Result<Mask, Missing> {
        let labelled = cx.call::<TimeLabels>()?;
        let label = cx.inputs().time_label.clone();
        let intervals = if label.is_empty() {
            vec![[0., labelled.duration]]
        } else {
            let wanted = labelled.names.iter().position(|n| **n == *label);
            time_labels::mask(&labelled.segments, |l| Some(l as usize) == wanted)
        };
        Ok(Mask {
            stats: [
                intervals.iter().map(|i| i[1] - i[0]).sum(),
                labelled.duration,
            ],
            intervals: intervals.into_iter().flatten().collect(),
        })
    }
}
impl Answer for Mask {
    fn buffers(&self) -> Vec<(&'static str, Buffer)> {
        vec![
            ("intervals", Buffer::F64(self.intervals.clone())),
            ("stats", Buffer::F64(self.stats.to_vec())),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::{Inputs, NUMBERS};
    use crate::position::tests::recording;
    use crate::Population as Spikes;

    fn set(i: &mut Inputs, values: &[(crate::compute::Leaf, f64)]) {
        for &(leaf, value) in values {
            let j = NUMBERS.iter().position(|(l, _)| *l == leaf).unwrap();
            i.numbers[j] = value;
        }
    }
    fn same(a: &[f32], b: &[f32]) -> bool {
        a.len() == b.len()
            && a.iter()
                .zip(b)
                .all(|(x, y)| x == y || (x.is_nan() && y.is_nan()))
    }
    fn inputs() -> Inputs {
        let mut i = Inputs {
            pos_file: "trial|a.pos".into(),
            recording: "t1".into(),
            cut_source: "t1.cut".into(),
            n: 30,
            cell: 1,
            tb: 1000.,
            duration: 1.,
            ..Default::default()
        };
        set(
            &mut i,
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
        i
    }
    /// A walk over a 10 by 5 grid, unprocessed, and 30 spikes in two cells spread through it.
    fn data() -> (Position, Vec<u32>, Vec<u16>) {
        let rows: Vec<_> = (0..50u16)
            .map(|i| [20 + (i % 10) * 5, 20 + (i / 10) * 5, 1023, 1023, 12, 0])
            .collect();
        let times = (0..30).map(|i| i * 31).collect();
        let labels = (0..30).map(|i| 1 + (i % 2) as u16).collect();
        (recording(&rows, 100., 50.), times, labels)
    }
    /// Keeps `value` as `H`'s for `i`, as JavaScript supplies what handlers can't compute.
    fn supply<H: Handler>(i: &Inputs, value: H::Value) {
        let key = Request::new(i.clone()).key::<H>().unwrap();
        crate::cache::put(key, value, H::LIMIT, H::bytes);
    }
    /// Supplies the recording's spikes (times only) and cut.
    fn supply_recording(i: &Inputs, times: Vec<u32>, labels: Vec<u16>) {
        supply::<Population>(
            i,
            Spikes {
                times,
                amplitudes: vec![0; 120],
            },
        );
        supply::<CutLabels>(i, labels);
    }

    #[test]
    fn handlers_give_what_computing_everything_together_gives() {
        let (raw, times, labels) = data();
        let i = inputs();
        supply_recording(&i, times.clone(), labels.clone());
        supply::<RawPosition>(&i, raw.variant(1, 0., 0., 0.));
        let processed = raw.variant(1, 0., 0., 20.);
        for cell in [1, 2] {
            let mut cx = Request::new(Inputs { cell, ..i.clone() });
            let stats = cx.call::<CellStats>().unwrap();
            let rates = cx.call::<Ratemap>().unwrap();
            let sc = cx.call::<SpatialAc>().unwrap();
            let direction = cx.call::<Direction>().unwrap();
            let speed = cx.call::<Speed>().unwrap();
            let dwell = cx.call::<SpeedDwell>().unwrap();
            let ac = cx.call::<TemporalAc>().unwrap();
            let spikes = cx.call::<SpikePositions>().unwrap();
            let direct = crate::position::analyse(
                &times,
                &labels,
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
                ("sc", &sc.values, &direct_sc),
                ("spikes", &spikes.0, &direct.spikes),
                ("direction", &direction.0, &direct.direction),
                ("speed", &speed.0, &direct.speed),
                ("speed dwell", &dwell.0, &direct.speed_dwell),
                ("ac", &ac.0, &direct.ac),
            ] {
                assert!(same(a, b), "cell {cell} {name}: {a:?} != {b:?}");
            }
            assert!(!spikes.0.is_empty(), "cell {cell} has spikes on the path");
            // Drift: a time for each dot, in order, and for each bin with spikes.
            let drift = cx.call::<SpikeDrift>().unwrap();
            assert_eq!(drift.0.len() * 2, spikes.0.len());
            assert!(drift.0.windows(2).all(|t| t[0] <= t[1]));
            assert!(drift.0.iter().all(|t| (0. ..=1.).contains(t)));
            let map = cx.call::<SpatialDrift>().unwrap();
            assert_eq!(map.0.len(), rates.grid.values.len());
            for (t, rate) in map.0.iter().zip(&rates.grid.values) {
                assert_eq!(
                    t.is_finite(),
                    rate.is_finite() && *rate > 0.,
                    "{t} at {rate} Hz"
                );
                assert!(!t.is_finite() || (0. ..=1.).contains(t));
            }
        }
    }

    fn ask<H: Handler>(i: &Inputs) -> Result<u64, Missing> {
        let mut cx = Request::new(i.clone());
        cx.call::<H>()?;
        Ok(cx.key::<H>()?.digest())
    }

    #[test]
    fn handlers_say_what_they_miss_and_reuse_what_they_computed() {
        let (raw, times, labels) = data();
        let mut c = inputs();
        // Each missing resource in the order handlers need them.
        assert_eq!(ask::<Ratemap>(&c), Err(Missing::Cut));
        supply::<CutLabels>(&c, labels);
        assert_eq!(ask::<Ratemap>(&c), Err(Missing::Position));
        supply::<RawPosition>(&c, raw.variant(1, 0., 0., 0.));
        assert_eq!(ask::<Ratemap>(&c), Err(Missing::Population));
        supply::<Population>(
            &c,
            Spikes {
                times,
                amplitudes: vec![0; 120],
            },
        );
        let first = ask::<Ratemap>(&c).unwrap();
        // Colours never change the key; a bin width does, but not the speed dwell's.
        let dwell = ask::<SpeedDwell>(&c).unwrap();
        set(&mut c, &[(MaxRate, 9.)]);
        assert_eq!(ask::<Ratemap>(&c), Ok(first));
        set(&mut c, &[(BinCm, 2.)]);
        assert_ne!(ask::<Ratemap>(&c).unwrap(), first);
        assert_eq!(ask::<SpeedDwell>(&c), Ok(dwell));
        // Another trial's position hasn't been read.
        c.pos_file = "other|a.pos".into();
        assert_eq!(ask::<Ratemap>(&c), Err(Missing::Position));
    }

    #[test]
    fn labels_follow_the_edit_history_from_the_nearest_kept_point() {
        let i = Inputs {
            history: "a,b".into(),
            ..inputs()
        };
        let base = vec![1, 1, 2, 2];
        let after_a = vec![1, 3, 2, 2];
        let after_b = vec![1, 3, 3, 2];
        supply::<CutLabels>(&i, base.clone());
        let labels = |history: &str| {
            let mut cx = Request::new(Inputs {
                history: history.into(),
                ..i.clone()
            });
            cx.call::<Labels>().map(|l| (*l).clone())
        };
        assert_eq!(labels(""), Ok(base.clone()));
        // A patch only JavaScript has: it is asked for by id.
        assert_eq!(labels("a,b"), Err(Missing::Patch));
        assert_eq!(MISSING_PATCH.with(|m| m.borrow().clone()), "a".into());
        let patch = |id: &str, before: &[u16], after: &[u16]| {
            let p = crate::processing::diff(before, after).1;
            supply::<Patch>(
                &Inputs {
                    patch: id.into(),
                    ..i.clone()
                },
                p,
            );
        };
        patch("a", &base, &after_a);
        assert_eq!(labels("a,b"), Err(Missing::Patch));
        assert_eq!(MISSING_PATCH.with(|m| m.borrow().clone()), "b".into());
        patch("b", &after_a, &after_b);
        assert_eq!(labels("a,b"), Ok(after_b));
        // Undo is the shorter history; a patch that doesn't fit is an error.
        assert_eq!(labels("a"), Ok(after_a));
        supply::<Patch>(
            &Inputs {
                patch: "bad".into(),
                ..i.clone()
            },
            vec![1, 2, 3],
        );
        assert_eq!(labels("a,bad"), Err(Missing::Invalid));
        // The cell's membership comes from the labels at its history.
        let mut cx = Request::new(Inputs {
            cell: 3,
            ..i.clone()
        });
        let three = cx.key::<CellSpikesKey>().unwrap();
        let mut cx = Request::new(Inputs {
            cell: 3,
            history: "a".into(),
            ..i.clone()
        });
        assert_ne!(cx.key::<CellSpikesKey>().unwrap(), three);
    }
    /// The node of a cell's spikes, without computing them.
    type CellSpikesKey = CellSpikes;

    #[test]
    fn commands_keep_new_labels_under_the_extended_history() {
        let i = Inputs {
            history: "".into(),
            patch: "p1".into(),
            ..inputs()
        };
        supply::<CutLabels>(&i, vec![1, 1, 2, 2]);
        crate::compute::stage(i.clone());
        assert_eq!(crate::commands::command_relabel(1, 2, 1), 0);
        assert_eq!(crate::commands::command_changed(), 4);
        let mut cx = Request::new(Inputs {
            history: "p1".into(),
            ..i.clone()
        });
        assert_eq!(*cx.call::<Labels>().unwrap(), vec![2, 2, 1, 1]);
        // The patch is kept too, so the labels survive being dropped from the memo.
        let mut cx = Request::new(Inputs {
            patch: "p1".into(),
            ..i.clone()
        });
        assert!(cx.call::<Patch>().is_ok());
        // A split needs the source cell's waveforms, from a scan of the file.
        crate::compute::stage(Inputs {
            history: "p1".into(),
            patch: "p2".into(),
            ..i
        });
        assert_eq!(
            crate::commands::command_split(1, 0, 14, 60),
            Missing::Scan as i32
        );
        assert_eq!(crate::commands::command_split(1, 0, 99, 60), -1);
    }

    #[test]
    fn time_labels_come_from_the_log_and_each_mask_from_one_label() {
        let mut i = Inputs {
            recording: "t1".into(),
            log_file: "trial|a.ttl".into(),
            time_rules: "log\toff\n1\ton\t^ttl_4 (\\S+) 1$\n1\toff\t^ttl_4 (\\S+) 0$".into(),
            tb: 1000.,
            duration: 10.,
            ..Default::default()
        };
        let mut cx = Request::new(i.clone());
        assert_eq!(cx.call::<TimeLabels>().err(), Some(Missing::Log));
        supply::<RawLog>(
            &i,
            b"data_startttl_4 2 1\nttl_4 4 0\nttl_4 6 1\ndata_end".to_vec(),
        );
        let labelled = cx.call::<TimeLabels>().unwrap();
        assert_eq!(labelled.names, ["off", "on"]);
        assert_eq!(labelled.matched, [2, 1]);
        assert_eq!(labelled.seconds, [4., 6.]);
        assert_eq!(labelled.counts, [2, 2]);
        let mask = |i: &Inputs| Request::new(i.clone()).call::<TimeMask>().unwrap();
        // No label: the whole trial.
        assert_eq!(mask(&i).intervals, [0., 10.]);
        i.time_label = "on".into();
        assert_eq!(mask(&i).intervals, [2., 4., 6., 10.]);
        assert_eq!(mask(&i).stats, [6., 10.]);
        let missing = Inputs {
            time_label: "nope".into(),
            ..i.clone()
        };
        assert!(mask(&missing).intervals.is_empty());
        // The label is the mask's alone; the rules and log are both's.
        let key = |i: &Inputs, node| match node {
            0 => Request::new(i.clone()).key::<TimeLabels>().unwrap(),
            _ => Request::new(i.clone()).key::<TimeMask>().unwrap(),
        };
        let other = Inputs {
            time_label: "off".into(),
            ..i.clone()
        };
        assert_eq!(key(&i, 0), key(&other, 0));
        assert_ne!(key(&i, 1), key(&other, 1));
        let renamed = Inputs {
            log_file: "trial|b.ttl".into(),
            ..i.clone()
        };
        assert_ne!(key(&i, 0), key(&renamed, 0));
        // Without a log, log rules say so; split and no rules need none.
        let none = Inputs {
            log_file: "".into(),
            ..i.clone()
        };
        let labelled = Request::new(none.clone()).call::<TimeLabels>().unwrap();
        assert!(labelled.error.contains("no log file"));
        assert!(labelled.segments.is_empty());
        let split = Inputs {
            time_rules: "split\t4\n1\n3\n1\n4".into(),
            time_label: "1".into(),
            ..none.clone()
        };
        assert_eq!(mask(&split).intervals, [0., 2.5, 5., 7.5]);
        let times = Inputs {
            time_rules: "times\n0\ta\n3\tb\n12\ta".into(),
            time_label: "b".into(),
            ..split.clone()
        };
        // A time after the end is outside the trial.
        assert_eq!(mask(&times).intervals, [3., 10.]);
        let off = Inputs {
            time_rules: "".into(),
            time_label: "".into(),
            ..none
        };
        assert_eq!(mask(&off).intervals, [0., 10.]);
        // Bad rules are an answer, not a failure.
        let bad = Inputs {
            time_rules: "log\tx\n1\ty\t(".into(),
            ..i
        };
        let labelled = Request::new(bad).call::<TimeLabels>().unwrap();
        assert!(labelled.error.starts_with("Rule 1:"));
    }
}
