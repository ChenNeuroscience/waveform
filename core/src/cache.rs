//! The memo behind `Context::call` in compute.rs: an implementation detail of the compute
//! graph. It stores each handler's values by key, keeping at most the number its handler
//! sets per node, least recently used out.
use crate::compute::{Key, Node};
use std::{any::Any, collections::HashMap, rc::Rc};

/// One node's values, least recently used first out beyond the limit its writer set.
#[derive(Default)]
struct Store {
    limit: usize,
    entries: HashMap<Key, (u64, Rc<dyn Any>)>,
}

/// Values of any type, by key. Shared: a value dropped from the memo is freed once nothing
/// else holds it.
#[derive(Default)]
pub(crate) struct Cache {
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
