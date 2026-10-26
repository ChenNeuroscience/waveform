// IndexedDB adapter only. Patch generation and application are Rust operations.
export async function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("waveform-v2", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("data");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function put(
  db: IDBDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("data", "readwrite");
    tx.objectStore("data").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error("Storage transaction aborted."));
  });
}
export async function get<T>(
  db: IDBDatabase,
  key: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const r = db.transaction("data").objectStore("data").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
