const DB_NAME = 'midi_sorter_soundfont_db_v1';
const STORE_NAME = 'soundfonts';
const ACTIVE_KEY = 'active_sf2';

export interface StoredSoundFont {
  name: string;
  sizeBytes: number;
  savedAt: number;
  buffer: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB nicht verfügbar.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB konnte nicht geöffnet werden.'));
  });
}

export async function saveActiveSoundFontToDb(
  name: string,
  buffer: ArrayBuffer
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredSoundFont = {
        name,
        sizeBytes: buffer.byteLength,
        savedAt: Date.now(),
        buffer,
      };
      store.put(record, ACTIVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-fatal if browser blocks storage quota
  }
}

export async function loadActiveSoundFontFromDb(): Promise<StoredSoundFont | null> {
  try {
    const db = await openDb();
    const record = await new Promise<StoredSoundFont | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(ACTIVE_KEY);
      req.onsuccess = () => resolve((req.result as StoredSoundFont | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (record && record.buffer instanceof ArrayBuffer && record.buffer.byteLength > 64) {
      return record;
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearActiveSoundFontFromDb(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(ACTIVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore errors
  }
}
