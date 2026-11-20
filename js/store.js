// IndexedDB persistence: projects (JSON) + model files (ArrayBuffer). Works offline.
const DB_NAME = 'sitear';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const store = {
  putProject: (p) => run('projects', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(p)))),
  getProject: (id) => run('projects', 'readonly', (s) => s.get(id)),
  listProjects: () => run('projects', 'readonly', (s) => s.getAll()),
  deleteProject: (id) => run('projects', 'readwrite', (s) => s.delete(id)),
  putFile: (f) => run('files', 'readwrite', (s) => s.put(f)),
  getFile: (id) => run('files', 'readonly', (s) => s.get(id)),
  deleteFile: (id) => run('files', 'readwrite', (s) => s.delete(id)),
  async persist() {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
  }
};
