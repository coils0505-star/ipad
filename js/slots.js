// セーブスロット（IndexedDB に学習状況のコピーを保存）
const DB_NAME = 'anikan';
const STORE = 'slots';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req ? req.result : undefined);
    };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

/** @returns {Promise<Array<{id, savedAt, summary, data, note?}>>} */
export function list() {
  return run('readonly', (st) => st.getAll());
}

export function get(id) {
  return run('readonly', (st) => st.get(id));
}

export function put(record) {
  return run('readwrite', (st) => st.put(record));
}

export function remove(id) {
  return run('readwrite', (st) => st.delete(id));
}
