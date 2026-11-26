// 题库缓存（IndexedDB）：刷新页面不用重新拉
(function () {
  const DB_NAME = 'hbmu_drill';
  const STORE = 'courses';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try {
        result = fn(store);
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const HBMUCache = {
    async get(cid) {
      const db = await open();
      return new Promise((resolve) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(String(cid));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    },

    async put(course) {
      if (!course || !course.id) return;
      // 只存精简字段，避免体积过大
      const slim = {
        id: course.id,
        name: course.name,
        chapters: course.chapters,
        groups: course.groups,
        questions: course.questions,
        savedAt: Date.now(),
      };
      try {
        await tx('readwrite', (store) => store.put(slim));
      } catch (e) {
        // 空间满了：清掉再试一次
        try {
          await tx('readwrite', (store) => { store.clear(); store.put(slim); });
        } catch (e2) {}
      }
    },

    async list() {
      const db = await open();
      return new Promise((resolve) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    },

    async remove(cid) {
      await tx('readwrite', (store) => store.delete(String(cid)));
    },

    async clear() {
      await tx('readwrite', (store) => store.clear());
    },
  };

  window.HBMUCache = HBMUCache;
})();
