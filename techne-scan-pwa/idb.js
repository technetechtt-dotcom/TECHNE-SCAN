const TechneIDB = (() => {
  const name = "techne-scan";
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("ops")) {
          const ops = db.createObjectStore("ops", { keyPath: "id" });
          const kv = request.transaction.objectStore("kv");
          const existing = kv.get("outbox");
          existing.onsuccess = () => {
            for (const item of existing.result || []) {
              ops.put({ status: "pending", seq: Date.now(), ...item });
            }
            kv.delete("outbox");
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbp;
  }
  function done(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function finish(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    open,
    async get(key) {
      const db = await open();
      return done(db.transaction("kv").objectStore("kv").get(key));
    },
    async set(key, value) {
      const db = await open();
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      return finish(tx);
    },
    async outbox() {
      const db = await open();
      const rows = (await done(db.transaction("ops").objectStore("ops").getAll())) || [];
      return rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    },
    async enqueue(operation) {
      const items = await this.outbox();
      const next = mergeOutbox(items, { status: "pending", seq: Date.now(), ...operation });
      const db = await open();
      const tx = db.transaction("ops", "readwrite");
      const store = tx.objectStore("ops");
      for (const item of next) {
        if (!items.some((old) => old.id === item.id && JSON.stringify(old) === JSON.stringify(item))) store.put(item);
      }
      return finish(tx);
    },
    async mark(id, patch) {
      const db = await open();
      const current = await done(db.transaction("ops").objectStore("ops").get(id));
      if (!current) return;
      const tx = db.transaction("ops", "readwrite");
      tx.objectStore("ops").put({ ...current, ...patch });
      return finish(tx);
    },
    async logSync(entry) {
      const log = (await this.get("synclog")) || [];
      log.unshift({ ...entry, at: new Date().toISOString() });
      await this.set("synclog", log.slice(0, 40));
    },
    async drop(id) {
      const db = await open();
      const tx = db.transaction("ops", "readwrite");
      tx.objectStore("ops").delete(id);
      return finish(tx);
    },
    async clear() {
      const db = await open();
      const tx = db.transaction(["kv", "ops"], "readwrite");
      tx.objectStore("kv").clear();
      tx.objectStore("ops").clear();
      return finish(tx);
    },
  };
})();
