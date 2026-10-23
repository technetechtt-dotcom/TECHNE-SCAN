const TechneIDB = (() => {
  const name = "techne-scan";
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbp;
  }
  async function done(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
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
      return done(db.transaction("kv", "readwrite").objectStore("kv").put(value, key));
    },
    async outbox() {
      return (await this.get("outbox")) || [];
    },
    async enqueue(operation) {
      const items = await this.outbox();
      const index = items.findIndex((item) => item.method === operation.method && item.path === operation.path);
      if (index >= 0) items[index] = { ...items[index], body: operation.body, bucket: operation.bucket };
      else items.push(operation);
      await this.set("outbox", items);
    },
    async drop(id) {
      await this.set("outbox", (await this.outbox()).filter((item) => item.id !== id));
    },
    async clear() {
      const db = await open();
      return done(db.transaction("kv", "readwrite").objectStore("kv").clear());
    },
  };
})();
