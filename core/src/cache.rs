//! The memo behind `Request::call` in compute.rs: an implementation detail of the compute
//! graph. It stores each handler's values by key, keeping at most the number its handler
//! sets per node, and within a memory budget overall, least recently used out.
use crate::compute::{Key, Node};
use std::{any::Any, cell::RefCell, collections::HashMap, rc::Rc};

/// The memory budget for kept values that report their size (populations, labels and the
/// like); about what the worker used to keep resident.
const BUDGET: usize = 512 * 1024 * 1024;

struct Entry {
    used: u64,
    bytes: usize,
    value: Rc<dyn Any>,
}
/// One node's values, least recently used first out beyond the limit its writer set.
#[derive(Default)]
struct Store {
    limit: usize,
    entries: HashMap<Key, Entry>,
}

/// Values of any type, by key. Shared: a value dropped from the memo is freed once nothing
/// else holds it, so a request still using one keeps it.
struct Cache {
    nodes: HashMap<Node, Store>,
    tick: u64,
    bytes: usize,
    budget: usize,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            nodes: HashMap::new(),
            tick: 0,
            bytes: 0,
            budget: BUDGET,
        }
    }
}
impl Cache {
    fn get<T: 'static>(&mut self, key: &Key) -> Option<Rc<T>> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.nodes.get_mut(&key.node)?.entries.get_mut(key)?;
        entry.used = tick;
        entry.value.clone().downcast().ok()
    }
    /// Stores `value`, keeping at most `limit` values for its node and the total size within
    /// the budget.
    fn put<T: 'static>(&mut self, key: Key, value: T, limit: usize, bytes: usize) -> Rc<T> {
        self.tick += 1;
        let value = Rc::new(value);
        let store = self.nodes.entry(key.node).or_default();
        store.limit = limit;
        let entry = Entry {
            used: self.tick,
            bytes,
            value: value.clone(),
        };
        if let Some(old) = store.entries.insert(key.clone(), entry) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        while store.entries.len() > store.limit {
            let oldest = store
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
                .unwrap();
            self.bytes -= store.entries.remove(&oldest).unwrap().bytes;
        }
        // Over budget: drop the least recently used sized values anywhere but this one.
        while self.bytes > self.budget {
            let oldest = self
                .nodes
                .values()
                .flat_map(|s| s.entries.iter())
                .filter(|(k, e)| e.bytes > 0 && **k != key)
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            let Some(oldest) = oldest else { break };
            let store = self.nodes.get_mut(&oldest.node).unwrap();
            self.bytes -= store.entries.remove(&oldest).unwrap().bytes;
        }
        value
    }
}

thread_local! {
    /// The memo for the session (as long as the page is open).
    static MEMO: RefCell<Cache> = RefCell::new(Cache::default());
}
/// How much the kept values that report their size hold.
pub(crate) fn bytes() -> usize {
    MEMO.with(|m| m.borrow().bytes)
}
/// The kept value for `key`. The memo is borrowed only for this, never while a handler runs,
/// so handlers can call handlers.
pub(crate) fn get<T: 'static>(key: &Key) -> Option<Rc<T>> {
    MEMO.with(|m| m.borrow_mut().get(key))
}
/// Keeps `value`, with at most `limit` values for its node, counting `bytes(&value)`
/// against the budget.
pub(crate) fn put<T: 'static>(key: Key, value: T, limit: usize, bytes: fn(&T) -> usize) -> Rc<T> {
    let size = bytes(&value);
    MEMO.with(|m| m.borrow_mut().put(key, value, limit, size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::tests::{inputs, set};
    use crate::compute::Leaf::*;

    #[test]
    fn each_node_drops_its_least_recently_used_beyond_the_limit_its_writer_set() {
        let i = inputs();
        let key = |n: f64| set(&i, Leds, n).key(Node::Position, "", &[]);
        let other = |n: f64| set(&i, Leds, n).key(Node::Path, "", &[]);
        let mut cache = Cache::default();
        cache.put(key(1.), 1, 2, 0);
        cache.put(key(2.), 2, 2, 0);
        cache.put(other(1.), "path", 1, 0);
        assert_eq!(cache.get::<i32>(&key(1.)).as_deref(), Some(&1));
        cache.put(key(3.), 3, 2, 0);
        assert!(cache.get::<i32>(&key(2.)).is_none());
        assert!(cache.get::<i32>(&key(1.)).is_some() && cache.get::<i32>(&key(3.)).is_some());
        // Other nodes keep their own limits, and a value is only found as its own type.
        assert_eq!(cache.get::<&str>(&other(1.)).as_deref(), Some(&"path"));
        assert!(cache.get::<i32>(&other(1.)).is_none());
    }

    #[test]
    fn sized_values_stay_within_the_budget_least_recently_used_out() {
        let i = inputs();
        // A population's key is its recording's.
        let key = |n: f64| {
            let mut r = i.clone();
            r.recording = format!("r{n}").into();
            r.key(Node::Population, "", &[])
        };
        let small = set(&i, Leds, 9.).key(Node::Path, "", &[]);
        let mut cache = Cache {
            budget: 100,
            ..Default::default()
        };
        cache.put(key(1.), 1, 10, 40);
        cache.put(small.clone(), 0, 10, 0);
        cache.put(key(2.), 2, 10, 40);
        cache.get::<i32>(&key(1.));
        cache.put(key(3.), 3, 10, 40);
        // 2 was least recently used; unsized values never count.
        assert!(cache.get::<i32>(&key(2.)).is_none());
        assert!(cache.get::<i32>(&key(1.)).is_some() && cache.get::<i32>(&key(3.)).is_some());
        assert!(cache.get::<i32>(&small).is_some());
        assert_eq!(cache.bytes, 80);
        // A value bigger than the budget is still kept, alone.
        cache.put(key(4.), 4, 10, 200);
        assert!(cache.get::<i32>(&key(4.)).is_some());
        assert_eq!(cache.bytes, 200);
    }
}
