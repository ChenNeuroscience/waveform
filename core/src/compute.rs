//! The compute graph: positions and cell analyses as a lazy graph of handlers.
//!
//! Every value is computed by a `Handler` (see compute_handlers.rs): a plain function of the inputs
//! that gets what it needs by calling other handlers through `Request::call`. That call
//! memoises (cache.rs, an implementation detail): it looks the value up by key and runs the
//! handler only when it isn't there. Without it the handlers would still be correct, just
//! slower; they never see keys or the memo.
//!
//! A value's key is its handler's node of the dependency tree below, and by default covers
//! every input beneath that node: a new trial, file, edit or setting is a new key, so
//! nothing is invalidated by hand. A handler can narrow its key only by explicitly ignoring
//! inputs it doesn't depend on, and sets how many of its values to keep.
//!
//! JavaScript writes the current inputs (`compute_inputs`, `compute_set_text`) and asks for
//! a handler by name (`compute_request`). The answer is a table of named buffers to copy
//! out, or what is missing for JavaScript to supply (a recording's spikes, or a position
//! file).
use crate::cache;
use std::{
    any::Any,
    cell::RefCell,
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    rc::Rc,
};

/// The tree's leaves: what a computed value can depend on.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub(crate) enum Leaf {
    /// The position file: its trial and file identity.
    PosFile,
    /// Edited pixels_per_metre (NaN: the file's).
    Ppm,
    /// ms added to position times (the in-memory sync_offset_ms header).
    Sync,
    /// The recording: its tetrode file's identity.
    Recording,
    /// Where its labels start: a cut file's identity, or unsorted.
    CutSource,
    /// The patches applied since, in order: the edit history.
    History,
    /// One patch, by id.
    PatchId,
    /// A cell's spike set: its membership hash.
    Cell,
    /// One waveform sample of one channel, for every spike.
    GateChannel,
    GateSample,
    PcaSamples,
    Leds,
    MaxSpeed,
    PosSmooth,
    BinCm,
    Smooth,
    MaxRate,
    RateMapSteps,
    ScMinOverlap,
    DirBin,
    DirSmooth,
    SpeedBin,
    SpeedMax,
    AcWindow,
    AcBinMs,
}
pub(crate) use Leaf::*;
/// The numeric leaves, in the order JavaScript writes them (see `compute_input_name`).
pub(crate) const NUMBERS: [(Leaf, &str); 17] = [
    (Leds, "leds"),
    (MaxSpeed, "maxSpeed"),
    (PosSmooth, "posSmooth"),
    (BinCm, "binCm"),
    (Smooth, "smooth"),
    (MaxRate, "maxRate"),
    (RateMapSteps, "rateMapSteps"),
    (ScMinOverlap, "scMinOverlap"),
    (DirBin, "dirBin"),
    (DirSmooth, "dirSmooth"),
    (SpeedBin, "speedBin"),
    (SpeedMax, "speedMax"),
    (AcWindow, "acWindow"),
    (AcBinMs, "acBinMs"),
    (Ppm, "ppm"),
    (Sync, "sync"),
    (PcaSamples, "pcaSamples"),
];

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Node {
    /// A recording's spike times and amplitudes, read from its file.
    Population,
    /// A cut file's labels, or none (unsorted).
    CutLabels,
    /// One edit, as a patch.
    Patch,
    /// The labels after the edit history.
    Labels,
    Counts,
    /// Each cell's spike indices.
    Groups,
    /// Each cell's membership hash.
    CellHashes,
    /// The resident waveforms' order by cell.
    WaveOrder,
    /// What the page shows of the labels: they, counts, hashes and waveform order.
    View,
    /// Every waveform of a cell's spikes, for a split preview.
    CellWaves,
    /// One sample of one channel for every spike, for a split of a cell too big for
    /// `CellWaves`.
    Gate,
    /// Four principal components of every spike.
    Pca,
    /// A position file as read, with its calibration.
    PosRaw,
    SettingsPosition,
    /// A processed position.
    Position,
    /// The trajectory plot's path.
    Path,
    /// A processed position's arena size and calibration.
    PositionInfo,
    /// A cell's spikes.
    Spikes,
    /// A cell's spike count, refractory violations and rate.
    CellStats,
    /// The position sample of each of a cell's spikes.
    SpikeSamples,
    /// Where each of a cell's spikes was, for the path plot.
    SpikePositions,
    SettingsRatemap,
    SpatialOccupancy,
    Ratemap,
    SettingsSpatialAc,
    SpatialAc,
    SettingsDirection,
    DirectionOccupancy,
    Direction,
    SettingsSpeed,
    /// The speed histogram's time in each bin.
    SpeedDwell,
    Speed,
    SettingsTemporalAc,
    TemporalAc,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Part {
    L(Leaf),
    N(Node),
}
pub(crate) use Part::{L, N};

/// What each node is made from. Settings groups follow the Settings panel's sections.
fn children(node: Node) -> &'static [Part] {
    use Node::*;
    match node {
        Population => &[L(Recording)],
        CutLabels => &[L(Recording), L(CutSource)],
        Patch => &[L(PatchId)],
        Labels => &[L(Recording), L(CutSource), L(History)],
        Counts | Groups | CellHashes | WaveOrder | View => &[N(Labels)],
        CellWaves => &[N(Spikes)],
        Gate => &[L(Recording), L(GateChannel), L(GateSample)],
        Pca => &[L(Recording), L(PcaSamples)],
        PosRaw => &[L(PosFile), L(Ppm)],
        SettingsPosition => &[L(Leds), L(MaxSpeed), L(PosSmooth)],
        Position => &[N(PosRaw), N(SettingsPosition), L(Sync)],
        Path => &[N(Position)],
        PositionInfo => &[N(Position)],
        Spikes => &[L(Recording), L(Cell)],
        CellStats => &[N(Spikes)],
        SpikeSamples => &[N(Position), N(Spikes)],
        SpikePositions => &[N(SpikeSamples)],
        SettingsRatemap => &[L(BinCm), L(Smooth), L(MaxRate), L(RateMapSteps)],
        SpatialOccupancy => &[N(Position), N(SettingsRatemap)],
        Ratemap => &[N(SpikeSamples), N(SpatialOccupancy)],
        SettingsSpatialAc => &[L(ScMinOverlap)],
        SpatialAc => &[N(Ratemap), N(SettingsSpatialAc)],
        SettingsDirection => &[L(DirBin), L(DirSmooth)],
        DirectionOccupancy => &[N(Position), N(SettingsDirection)],
        Direction => &[N(SpikeSamples), N(DirectionOccupancy)],
        SettingsSpeed => &[L(SpeedBin), L(SpeedMax)],
        SpeedDwell => &[N(Position), N(SettingsSpeed)],
        Speed => &[N(SpikeSamples), N(SpeedDwell)],
        SettingsTemporalAc => &[L(AcWindow), L(AcBinMs)],
        TemporalAc => &[N(Spikes), N(SettingsTemporalAc)],
    }
}
fn beneath(part: Part, into: &mut Vec<Part>) {
    if !into.contains(&part) {
        into.push(part);
        if let N(node) = part {
            for &child in children(node) {
                beneath(child, into);
            }
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum Value {
    Number(u64),
    Text(Rc<str>),
}
/// A node and the value of every leaf beneath it that isn't ignored.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Key {
    pub(crate) node: Node,
    values: Vec<(Leaf, Value)>,
}
impl Key {
    /// A stable 64-bit digest, so JavaScript can tell when a value it holds is unchanged.
    pub(crate) fn digest(&self) -> u64 {
        let mut h = DefaultHasher::new();
        self.hash(&mut h);
        h.finish()
    }
}

/// A request's inputs.
#[derive(Clone)]
pub(crate) struct Inputs {
    pub(crate) numbers: [f64; NUMBERS.len()],
    pub(crate) pos_file: Rc<str>,
    pub(crate) recording: Rc<str>,
    pub(crate) cut_source: Rc<str>,
    /// Patch ids, comma-separated.
    pub(crate) history: Rc<str>,
    pub(crate) patch: Rc<str>,
    pub(crate) gate: [f64; 2],
    /// The cell asked about.
    pub(crate) cell: u16,
    /// The cell's membership hash (the `Cell` leaf), worked out when a key first needs it.
    pub(crate) cell_id: Option<Rc<str>>,
    /// The recording's spike count, timebase (ticks per second) and duration (s), from its
    /// header. Not leaves: they are fixed for a recording, which is.
    pub(crate) n: usize,
    pub(crate) tb: f64,
    pub(crate) duration: f64,
}
impl Default for Inputs {
    fn default() -> Self {
        Self {
            numbers: [f64::NAN; NUMBERS.len()],
            pos_file: "".into(),
            recording: "".into(),
            cut_source: "".into(),
            history: "".into(),
            patch: "".into(),
            gate: [f64::NAN; 2],
            cell: 0,
            cell_id: None,
            n: 0,
            tb: f64::NAN,
            duration: 0.,
        }
    }
}
impl Inputs {
    pub(crate) fn number(&self, leaf: Leaf) -> f64 {
        let i = NUMBERS.iter().position(|(l, _)| *l == leaf).unwrap();
        self.numbers[i]
    }
    /// The key for `node`: every leaf beneath it except those beneath `ignore`, which the
    /// caller knows its value doesn't depend on. `cell` is the cell's spike set, for nodes
    /// with one. Ignoring something that isn't beneath `node` is a mistake, so it panics.
    pub(crate) fn key(&self, node: Node, cell: &str, ignore: &[Part]) -> Key {
        let mut all = vec![];
        beneath(N(node), &mut all);
        let mut dropped = vec![];
        for &part in ignore {
            assert!(
                all.contains(&part),
                "{node:?} can't ignore {part:?}: it isn't part of it"
            );
            beneath(part, &mut dropped);
        }
        let mut leaves: Vec<Leaf> = all
            .into_iter()
            .filter(|p| !dropped.contains(p))
            .filter_map(|p| if let L(leaf) = p { Some(leaf) } else { None })
            .collect();
        leaves.sort();
        let values = leaves
            .into_iter()
            .map(|leaf| {
                let value = match leaf {
                    PosFile => Value::Text(self.pos_file.clone()),
                    Recording => Value::Text(self.recording.clone()),
                    CutSource => Value::Text(self.cut_source.clone()),
                    History => Value::Text(self.history.clone()),
                    PatchId => Value::Text(self.patch.clone()),
                    Cell => Value::Text(cell.into()),
                    GateChannel => Value::Number(self.gate[0].to_bits()),
                    GateSample => Value::Number(self.gate[1].to_bits()),
                    // No sync edit and an edit of 0 are the same offset.
                    Sync if !self.number(Sync).is_finite() => Value::Number(0),
                    _ => {
                        let n = self.number(leaf);
                        // -0 is 0, and every NaN (an absent value) the same.
                        Value::Number(if n == 0. {
                            0
                        } else if n.is_nan() {
                            f64::NAN.to_bits()
                        } else {
                            n.to_bits()
                        })
                    }
                };
                (leaf, value)
            })
            .collect();
        Key { node, values }
    }
}

/// What a handler needs that only JavaScript can supply, and what JavaScript does.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Missing {
    /// Stream the tetrode file into a population (`compute_supply_population`).
    Population = 1,
    /// Read the position file (`compute_supply_position`).
    Position = 2,
    /// Stream the cut file into a parser (`compute_supply_cut`).
    Cut = 3,
    /// Fetch the patch named by `missing_text` (`compute_supply_patch`).
    Patch = 4,
    /// Fit PCA with a builder (`compute_supply_pca`).
    Pca = 5,
    /// Stream the tetrode file through the scanner `scan_take` gives (`compute_supply_scan`).
    Scan = 6,
    /// Not missing: what was supplied (a cut or patch) doesn't fit the recording.
    Invalid = 7,
}

/// Computes one node's value from the inputs, calling other handlers for what it needs.
pub(crate) trait Handler: 'static {
    type Value: 'static;
    const NODE: Node;
    /// Inputs beneath `NODE` the value doesn't depend on, so its key leaves them out.
    const IGNORE: &'static [Part] = &[];
    /// How many values of this node to keep.
    const LIMIT: usize;
    fn compute(cx: &mut Request) -> Result<Self::Value, Missing>;
    /// Roughly how much memory a value holds, for large ones (see cache.rs's budget).
    fn bytes(_: &Self::Value) -> usize {
        0
    }
}

/// What handlers are asked to compute for.
pub(crate) struct Request {
    inputs: Inputs,
}
impl Request {
    pub(crate) fn new(inputs: Inputs) -> Self {
        Self { inputs }
    }
    /// `H`'s value: from the memo, or computed by `H` and kept.
    pub(crate) fn call<H: Handler>(&mut self) -> Result<Rc<H::Value>, Missing> {
        let key = self.key::<H>()?;
        if let Some(value) = cache::get(&key) {
            return Ok(value);
        }
        let value = H::compute(self)?;
        Ok(cache::put(key, value, H::LIMIT, H::bytes))
    }
    /// `H`'s value for these inputs changed by `change` (another point of the edit history,
    /// say), leaving these as they were.
    pub(crate) fn call_with<H: Handler>(
        &mut self,
        change: impl FnOnce(&mut Inputs),
    ) -> Result<Rc<H::Value>, Missing> {
        let saved = self.inputs.clone();
        change(&mut self.inputs);
        let result = self.call::<H>();
        self.inputs = saved;
        result
    }
    /// `H`'s value for these inputs changed by `change`, if it is kept; never computed.
    pub(crate) fn peek_with<H: Handler>(
        &mut self,
        change: impl FnOnce(&mut Inputs),
    ) -> Option<Rc<H::Value>> {
        let saved = self.inputs.clone();
        change(&mut self.inputs);
        let key = self.key::<H>();
        self.inputs = saved;
        cache::get(&key.ok()?)
    }
    /// Keeps `value` as `H`'s for these inputs changed by `change`.
    pub(crate) fn keep_with<H: Handler>(
        &mut self,
        value: H::Value,
        change: impl FnOnce(&mut Inputs),
    ) -> Result<Rc<H::Value>, Missing> {
        let saved = self.inputs.clone();
        change(&mut self.inputs);
        let key = self.key::<H>();
        self.inputs = saved;
        Ok(cache::put(key?, value, H::LIMIT, H::bytes))
    }
    /// `H`'s key for these inputs.
    pub(crate) fn key<H: Handler>(&mut self) -> Result<Key, Missing> {
        let mut parts = vec![];
        beneath(N(H::NODE), &mut parts);
        let mut ignored = vec![];
        for &part in H::IGNORE {
            beneath(part, &mut ignored);
        }
        let cell = if parts.contains(&L(Cell)) && !ignored.contains(&L(Cell)) {
            self.cell_id()?
        } else {
            "".into()
        };
        Ok(self.inputs.key(H::NODE, &cell, H::IGNORE))
    }
    /// The cell's membership hash: its spike count and a hash of its spike indices.
    fn cell_id(&mut self) -> Result<Rc<str>, Missing> {
        if let Some(id) = &self.inputs.cell_id {
            return Ok(id.clone());
        }
        use crate::compute_handlers::{CellHashes, Counts};
        let cell = self.inputs.cell as usize;
        let (count, hashes) = (self.call::<Counts>()?[cell], self.call::<CellHashes>()?);
        let id: Rc<str> = format!("{count}:{}:{}", hashes[cell * 2], hashes[cell * 2 + 1]).into();
        self.inputs.cell_id = Some(id.clone());
        Ok(id)
    }
    pub(crate) fn inputs(&self) -> &Inputs {
        &self.inputs
    }
    pub(crate) fn input(&self, leaf: Leaf) -> f64 {
        self.inputs.number(leaf)
    }
    pub(crate) fn cell(&self) -> u16 {
        self.inputs.cell
    }
    pub(crate) fn tb(&self) -> f64 {
        self.inputs.tb
    }
    pub(crate) fn duration(&self) -> f64 {
        self.inputs.duration
    }
}

/// One buffer of an answer: floats borrowed from the answered value, or numbers made for it.
pub(crate) enum Buffer {
    F32(*const f32, usize),
    U8(*const u8, usize),
    U16(*const u16, usize),
    U32(*const u32, usize),
    F64(Vec<f64>),
}
pub(crate) fn f32s(values: &[f32]) -> Buffer {
    Buffer::F32(values.as_ptr(), values.len())
}
pub(crate) fn u8s(values: &[u8]) -> Buffer {
    Buffer::U8(values.as_ptr(), values.len())
}
pub(crate) fn u16s(values: &[u16]) -> Buffer {
    Buffer::U16(values.as_ptr(), values.len())
}
pub(crate) fn u32s(values: &[u32]) -> Buffer {
    Buffer::U32(values.as_ptr(), values.len())
}
/// A value JavaScript can ask for, as named buffers.
pub(crate) trait Answer {
    fn buffers(&self) -> Vec<(&'static str, Buffer)>;
}
/// A handler JavaScript can ask for by name.
pub(crate) type Route = (&'static str, fn(&mut Request) -> Result<Answered, Missing>);
/// The last answer: its key's digest, its buffers, and the value they borrow from.
#[derive(Default)]
pub(crate) struct Answered {
    digest: [u32; 2],
    buffers: Vec<(&'static str, Buffer)>,
    _value: Option<Rc<dyn Any>>,
}
impl Answered {
    /// An answer made from several values (`value` keeps what the buffers borrow alive).
    pub(crate) fn new(
        digest: u64,
        buffers: Vec<(&'static str, Buffer)>,
        value: Option<Rc<dyn Any>>,
    ) -> Self {
        Self {
            digest: [digest as u32, (digest >> 32) as u32],
            buffers,
            _value: value,
        }
    }
}
/// Answers with `H`'s value.
pub(crate) fn answer<H: Handler>(cx: &mut Request) -> Result<Answered, Missing>
where
    H::Value: Answer,
{
    let value = cx.call::<H>()?;
    let digest = cx.key::<H>()?.digest();
    Ok(Answered {
        digest: [digest as u32, (digest >> 32) as u32],
        buffers: value.buffers(),
        _value: Some(value),
    })
}

thread_local! {
    /// The inputs JavaScript is writing for its next request.
    static STAGED: RefCell<Inputs> = RefCell::new(Inputs::default());
    static ANSWER: RefCell<Answered> = RefCell::new(Answered::default());
}
fn staged<T>(f: impl FnOnce(&mut Inputs) -> T) -> T {
    STAGED.with(|i| f(&mut i.borrow_mut()))
}
/// Stages `inputs`, as JavaScript does before a request.
#[cfg(test)]
pub(crate) fn stage(inputs: Inputs) {
    staged(|i| *i = inputs);
}
/// The staged inputs, as a request.
pub(crate) fn staged_request() -> Request {
    Request::new(staged(|i| i.clone()))
}
/// Keeps a value JavaScript supplied for `H` (one `H` can't compute) under the staged inputs.
pub(crate) fn supply<H: Handler>(value: H::Value) {
    if let Ok(key) = staged_request().key::<H>() {
        cache::put(key, value, H::LIMIT, H::bytes);
    }
}
/// Answers a missing resource's status code to JavaScript (0 when nothing is missing).
pub(crate) fn status(result: Result<(), Missing>) -> u32 {
    match result {
        Ok(()) => 0,
        Err(missing) => missing as u32,
    }
}
fn answered<T>(f: impl FnOnce(&Answered) -> T) -> T {
    ANSWER.with(|a| f(&a.borrow()))
}

/// The handlers JavaScript can ask for, in this order (see `compute_handler_name`).
#[no_mangle]
pub extern "C" fn compute_handler_count() -> usize {
    crate::compute_handlers::ROUTES.len()
}
#[no_mangle]
pub extern "C" fn compute_handler_name(i: usize) -> *const u8 {
    crate::compute_handlers::ROUTES[i].0.as_ptr()
}
#[no_mangle]
pub extern "C" fn compute_handler_name_len(i: usize) -> usize {
    crate::compute_handlers::ROUTES[i].0.len()
}
/// Asks handler `handler` for the staged inputs and cell `cell`. 0: answered (see
/// `answer_*`); otherwise what is missing (see `Missing`).
#[no_mangle]
pub extern "C" fn compute_request(handler: usize, cell: u16) -> u32 {
    let route = crate::compute_handlers::ROUTES[handler].1;
    let mut inputs = staged(|i| i.clone());
    inputs.cell = cell;
    status(route(&mut Request::new(inputs)).map(|answer| {
        ANSWER.with(|a| *a.borrow_mut() = answer);
    }))
}
/// How much memory kept values hold.
#[no_mangle]
pub extern "C" fn compute_bytes() -> usize {
    cache::bytes()
}
/// The recording's spike count, timebase and duration, from its header.
#[no_mangle]
pub extern "C" fn compute_set_recording(n: usize, tb: f64, duration: f64) {
    staged(|i| (i.n, i.tb, i.duration) = (n, tb, duration));
}
/// The last answer's key digest, as two u32 halves.
#[no_mangle]
pub extern "C" fn answer_digest() -> *const u32 {
    ANSWER.with(|a| a.borrow().digest.as_ptr())
}
#[no_mangle]
pub extern "C" fn answer_count() -> usize {
    answered(|a| a.buffers.len())
}
#[no_mangle]
pub extern "C" fn answer_name(i: usize) -> *const u8 {
    answered(|a| a.buffers[i].0.as_ptr())
}
#[no_mangle]
pub extern "C" fn answer_name_len(i: usize) -> usize {
    answered(|a| a.buffers[i].0.len())
}
/// 0 f32, 1 f64, 2 u8, 3 u16, 4 u32.
#[no_mangle]
pub extern "C" fn answer_kind(i: usize) -> u32 {
    answered(|a| match &a.buffers[i].1 {
        Buffer::F32(..) => 0,
        Buffer::F64(_) => 1,
        Buffer::U8(..) => 2,
        Buffer::U16(..) => 3,
        Buffer::U32(..) => 4,
    })
}
#[no_mangle]
pub extern "C" fn answer_data(i: usize) -> usize {
    answered(|a| match &a.buffers[i].1 {
        Buffer::F32(p, _) => *p as usize,
        Buffer::U8(p, _) => *p as usize,
        Buffer::U16(p, _) => *p as usize,
        Buffer::U32(p, _) => *p as usize,
        Buffer::F64(v) => v.as_ptr() as usize,
    })
}
/// The buffer's length in elements.
#[no_mangle]
pub extern "C" fn answer_len(i: usize) -> usize {
    answered(|a| match &a.buffers[i].1 {
        Buffer::F32(_, n) | Buffer::U8(_, n) | Buffer::U16(_, n) | Buffer::U32(_, n) => *n,
        Buffer::F64(v) => v.len(),
    })
}

/// Where JavaScript writes the numeric inputs, in `NUMBERS` order.
#[no_mangle]
pub extern "C" fn compute_inputs() -> *mut f64 {
    staged(|i| i.numbers.as_mut_ptr())
}
#[no_mangle]
pub extern "C" fn compute_input_count() -> usize {
    NUMBERS.len()
}
/// The `i`th numeric input's name, so JavaScript can check it writes them in this order.
#[no_mangle]
pub extern "C" fn compute_input_name(i: usize) -> *const u8 {
    NUMBERS[i].1.as_ptr()
}
#[no_mangle]
pub extern "C" fn compute_input_name_len(i: usize) -> usize {
    NUMBERS[i].1.len()
}
/// Sets a text input from UTF-8: 0 the position file, 1 the recording, 2 the cut source,
/// 3 the history (comma-separated patch ids), 4 the id for a command's patch.
#[no_mangle]
pub unsafe extern "C" fn compute_set_text(field: u32, text: *const u8, len: usize) {
    let text: Rc<str> = String::from_utf8_lossy(std::slice::from_raw_parts(text, len)).into();
    staged(|i| match field {
        0 => i.pos_file = text,
        1 => i.recording = text,
        2 => i.cut_source = text,
        3 => i.history = text,
        _ => i.patch = text,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn inputs() -> Inputs {
        let mut i = Inputs {
            pos_file: "trial|a.pos".into(),
            recording: "t1|a.1".into(),
            ..Default::default()
        };
        for (j, (leaf, _)) in NUMBERS.iter().enumerate() {
            i.numbers[j] = match leaf {
                Ppm => f64::NAN,
                Sync => 0.,
                _ => j as f64 + 1.,
            };
        }
        i
    }
    pub(crate) fn set(i: &Inputs, leaf: Leaf, value: f64) -> Inputs {
        let mut i = i.clone();
        let j = NUMBERS.iter().position(|(l, _)| *l == leaf).unwrap();
        i.numbers[j] = value;
        i
    }

    #[test]
    fn a_key_covers_everything_beneath_its_node_and_nothing_else() {
        let i = inputs();
        let ratemap = |i: &Inputs| i.key(Node::Ratemap, "c", &[]);
        let position = |i: &Inputs| i.key(Node::Position, "", &[]);
        for (leaf, _) in NUMBERS {
            let changed = set(&i, leaf, 999.);
            let in_ratemap = matches!(
                leaf,
                Ppm | Sync | Leds | MaxSpeed | PosSmooth | BinCm | Smooth | MaxRate | RateMapSteps
            );
            assert_eq!(ratemap(&i) != ratemap(&changed), in_ratemap, "{leaf:?}");
            let in_position = matches!(leaf, Ppm | Sync | Leds | MaxSpeed | PosSmooth);
            assert_eq!(position(&i) != position(&changed), in_position, "{leaf:?}");
        }
        // The spatial autocorrelogram is made from the rate map, so has its settings too.
        assert_ne!(
            i.key(Node::SpatialAc, "c", &[]),
            set(&i, BinCm, 999.).key(Node::SpatialAc, "c", &[])
        );
        let other_trial = Inputs {
            pos_file: "other|a.pos".into(),
            ..i.clone()
        };
        assert_ne!(position(&i), position(&other_trial));
        assert_ne!(ratemap(&i), i.key(Node::Ratemap, "d", &[]));
    }

    #[test]
    fn ignoring_a_part_drops_its_whole_subtree_and_only_that() {
        let i = inputs();
        let path = |i: &Inputs| i.key(Node::Path, "", &[L(Sync)]);
        assert_eq!(path(&i), path(&set(&i, Sync, 40.)));
        assert_ne!(path(&i), path(&set(&i, Leds, 2.)));
        let without_raw = |i: &Inputs| i.key(Node::Position, "", &[N(Node::PosRaw)]);
        assert_eq!(without_raw(&i), without_raw(&set(&i, Ppm, 500.)));
        assert_ne!(without_raw(&i), without_raw(&set(&i, Sync, 40.)));
    }

    #[test]
    #[should_panic(expected = "isn't part of it")]
    fn ignoring_something_outside_the_node_is_a_mistake() {
        inputs().key(Node::PosRaw, "", &[L(Sync)]);
    }

    #[test]
    fn equal_values_give_equal_keys() {
        let i = inputs();
        let key = |i: &Inputs| i.key(Node::Position, "", &[]);
        // No sync edit, 0 and -0 are one offset; any absent calibration is the file's.
        assert_eq!(key(&i), key(&set(&i, Sync, f64::NAN)));
        assert_eq!(key(&i), key(&set(&i, Sync, -0.)));
        assert_eq!(key(&i), key(&set(&i, Ppm, -f64::NAN)));
        assert_eq!(key(&i).digest(), key(&i.clone()).digest());
    }
}
