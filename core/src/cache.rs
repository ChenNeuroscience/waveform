//! The worker's cache of derived data, for the whole session (as long as the page is open).
//!
//! Every value is keyed by a node of the dependency tree below, and by default its key
//! covers every input beneath that node: a new trial, file, edit or setting is a new key,
//! so nothing is ever invalidated by hand. The code that computes and stores a value (see
//! analysis.rs) can narrow its key only by explicitly ignoring part of the tree that it
//! knows the value doesn't depend on, and sets how many values its node keeps.
//!
//! JavaScript writes the current inputs (`cache_numbers`, `cache_set_text`), then asks
//! analysis.rs for a position or a cell's analyses. Values live here; JavaScript only
//! copies them out.
use std::{
    any::Any,
    cell::RefCell,
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    rc::Rc,
};

/// The tree's leaves: what a cached value can depend on.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub(crate) enum Leaf {
    /// The position file: its trial and file identity.
    PosFile,
    /// Edited pixels_per_metre (NaN: the file's).
    Ppm,
    /// ms added to position times (the in-memory sync_offset_ms header).
    Sync,
    /// The recording asset.
    Recording,
    /// A cell's spike set: its membership hash, or its cut, revision and number.
    Cell,
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
/// The numeric leaves, in the order JavaScript writes them (see `cache_input_name`).
pub(crate) const NUMBERS: [(Leaf, &str); 16] = [
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
];

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Node {
    /// A position file as read, with its calibration.
    PosRaw,
    SettingsPosition,
    /// A processed position.
    Position,
    /// The trajectory plot's path.
    Path,
    /// A cell's spikes.
    Spikes,
    /// A cell's spike count, refractory violations and rate.
    CellStats,
    /// The position sample of each of a cell's spikes.
    SpikeSamples,
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
        PosRaw => &[L(PosFile), L(Ppm)],
        SettingsPosition => &[L(Leds), L(MaxSpeed), L(PosSmooth)],
        Position => &[N(PosRaw), N(SettingsPosition), L(Sync)],
        Path => &[N(Position)],
        Spikes => &[L(Recording), L(Cell)],
        CellStats => &[N(Spikes)],
        SpikeSamples => &[N(Position), N(Spikes)],
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
    node: Node,
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

/// The current inputs, written by JavaScript before each request.
#[derive(Clone)]
pub(crate) struct Inputs {
    pub(crate) numbers: [f64; NUMBERS.len()],
    pub(crate) pos_file: Rc<str>,
    pub(crate) recording: Rc<str>,
    /// Set for a recording whose spikes are named by cut and revision rather than hashed.
    pub(crate) cell_prefix: Rc<str>,
}
impl Default for Inputs {
    fn default() -> Self {
        Self {
            numbers: [f64::NAN; NUMBERS.len()],
            pos_file: "".into(),
            recording: "".into(),
            cell_prefix: "".into(),
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
                    Cell => Value::Text(cell.into()),
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

/// One node's values, least recently used first out beyond the limit its writer set.
#[derive(Default)]
struct Store {
    limit: usize,
    entries: HashMap<Key, (u64, Rc<dyn Any>)>,
}

/// Values of any type, by key. Shared: a value dropped from the cache is freed once
/// nothing else holds it.
#[derive(Default)]
pub(crate) struct Cache {
    pub(crate) inputs: Inputs,
    nodes: HashMap<Node, Store>,
    tick: u64,
}
impl Cache {
    pub(crate) fn get<T: 'static>(&mut self, key: &Key) -> Option<Rc<T>> {
        self.tick += 1;
        let tick = self.tick;
        let (used, value) = self.nodes.get_mut(&key.node)?.entries.get_mut(key)?;
        *used = tick;
        value.clone().downcast().ok()
    }
    /// Stores `value`, keeping at most `limit` values for its node.
    pub(crate) fn put<T: 'static>(&mut self, key: Key, value: T, limit: usize) -> Rc<T> {
        self.tick += 1;
        let value = Rc::new(value);
        let store = self.nodes.entry(key.node).or_default();
        store.limit = limit;
        store.entries.insert(key, (self.tick, value.clone()));
        while store.entries.len() > store.limit {
            let oldest = store
                .entries
                .iter()
                .min_by_key(|(_, (used, _))| *used)
                .map(|(k, _)| k.clone())
                .unwrap();
            store.entries.remove(&oldest);
        }
        value
    }
    /// The value for `key`, or `make`'s, stored with `limit`.
    pub(crate) fn get_or<T: 'static>(
        &mut self,
        key: Key,
        limit: usize,
        make: impl FnOnce(&mut Self) -> Option<T>,
    ) -> Option<Rc<T>> {
        if let Some(value) = self.get(&key) {
            return Some(value);
        }
        let value = make(self)?;
        Some(self.put(key, value, limit))
    }
}

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache::default());
}
/// The session's cache.
pub(crate) fn with<T>(f: impl FnOnce(&mut Cache) -> T) -> T {
    CACHE.with(|c| f(&mut c.borrow_mut()))
}

/// Where JavaScript writes the numeric inputs, in `NUMBERS` order.
#[no_mangle]
pub extern "C" fn cache_numbers() -> *mut f64 {
    with(|c| c.inputs.numbers.as_mut_ptr())
}
#[no_mangle]
pub extern "C" fn cache_input_count() -> usize {
    NUMBERS.len()
}
/// The `i`th numeric input's name, so JavaScript can check it writes them in this order.
#[no_mangle]
pub extern "C" fn cache_input_name(i: usize) -> *const u8 {
    NUMBERS[i].1.as_ptr()
}
#[no_mangle]
pub extern "C" fn cache_input_name_len(i: usize) -> usize {
    NUMBERS[i].1.len()
}
/// Sets a text input from UTF-8: 0 the position file, 1 the recording, 2 the cell prefix.
#[no_mangle]
pub unsafe extern "C" fn cache_set_text(field: u32, text: *const u8, len: usize) {
    let text: Rc<str> = String::from_utf8_lossy(std::slice::from_raw_parts(text, len)).into();
    with(|c| match field {
        0 => c.inputs.pos_file = text,
        1 => c.inputs.recording = text,
        _ => c.inputs.cell_prefix = text,
    })
}

#[cfg(test)]
mod tests {
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
    fn set(i: &Inputs, leaf: Leaf, value: f64) -> Inputs {
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

    #[test]
    fn each_node_drops_its_least_recently_used_beyond_the_limit_its_writer_set() {
        let i = inputs();
        let key = |n: f64| set(&i, Leds, n).key(Node::Position, "", &[]);
        let other = |n: f64| set(&i, Leds, n).key(Node::Path, "", &[]);
        let mut cache = Cache::default();
        cache.put(key(1.), 1, 2);
        cache.put(key(2.), 2, 2);
        cache.put(other(1.), "path", 1);
        assert_eq!(cache.get::<i32>(&key(1.)).as_deref(), Some(&1));
        cache.put(key(3.), 3, 2);
        assert!(cache.get::<i32>(&key(2.)).is_none());
        assert!(cache.get::<i32>(&key(1.)).is_some() && cache.get::<i32>(&key(3.)).is_some());
        // Other nodes keep their own limits, and a value is only found as its own type.
        assert_eq!(cache.get::<&str>(&other(1.)).as_deref(), Some(&"path"));
        assert!(cache.get::<i32>(&other(1.)).is_none());
    }
}
