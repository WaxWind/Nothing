// 曲库：把导入的歌和分轨原文件保存在 iPad 本地（IndexedDB）
const DB_NAME = 'djmix-library';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('waves')) db.createObjectStore('waves', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
    const s = Array.isArray(store) ? store.map((n) => t.objectStore(n)) : t.objectStore(store);
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
  }));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const lib = {
  available: typeof indexedDB !== 'undefined',
  async allSongs() { const r = await tx('songs', 'readonly', (s) => s.getAll()); return (r || []).sort((a, b) => b.addedAt - a.addedAt); },
  getSong(id) { return tx('songs', 'readonly', (s) => s.get(id)); },
  putSong(song) { return tx('songs', 'readwrite', (s) => s.put(song)); },
  getFile(id) { return tx('files', 'readonly', (s) => s.get(id)); },
  putFile(rec) { return tx('files', 'readwrite', (s) => s.put(rec)); },
  getWave(id) { return tx('waves', 'readonly', (s) => s.get(id)); },
  putWave(rec) { return tx('waves', 'readwrite', (s) => s.put(rec)); },
  async deleteSong(song) {
    await tx(['songs', 'files', 'waves'], 'readwrite', ([songs, files, waves]) => {
      songs.delete(song.id); waves.delete(song.id);
      for (const st of song.stems) files.delete(st.fileId);
    });
  },
  async estimate() {
    try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) {}
    return null;
  },
  async persist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
    return false;
  },
};
