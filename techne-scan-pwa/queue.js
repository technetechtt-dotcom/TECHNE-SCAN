globalThis.mergeOutbox = function mergeOutbox(items, operation) {
  const next = items.slice();
  const idempotencyKey = operation.idempotencyKey || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `k-${next.length}-${Date.now()}`);
  if (operation.method === "PUT" && /\/counts$/.test(operation.path || "")) {
    const index = next.findIndex((item) => item.method === "PUT" && item.path === operation.path);
    if (index >= 0) {
      const previous = Array.isArray(next[index].body?.counts) ? next[index].body.counts : [];
      const incoming = Array.isArray(operation.body?.counts) ? operation.body.counts : [];
      const merged = new Map(previous.map((row) => [row.productId, { ...row }]));
      for (const row of incoming) merged.set(row.productId, { ...merged.get(row.productId), ...row });
      const conflicted = next[index].status === "conflict";
      next[index] = {
        ...next[index],
        body: { ...next[index].body, counts: [...merged.values()] },
        bucket: operation.bucket || next[index].bucket,
        status: conflicted ? "pending" : next[index].status,
        idempotencyKey: conflicted ? idempotencyKey : next[index].idempotencyKey,
        error: conflicted ? "" : next[index].error,
      };
      return next;
    }
  }
  next.push({ ...operation, idempotencyKey, id: operation.id || idempotencyKey });
  return next;
};
