globalThis.TechneOps = {
  modal() {
    const S = Techne.S;
    if (S.modal === "privacy") {
      return `<div class="modalshade"><div class="modal"><h2>Privacy</h2><p class="sub">Techne Scan keeps company records so your organisation can run custody and stocktaking. You can export your profile or ask for this login to be removed. Stock and audit history stay with the company.</p><div class="modalactions">${Techne.btn("Export my data", "ops-export")}${Techne.btn("Remove this login", "ops-erase")}${Techne.btn("Close", "close")}</div></div></div>`;
    }
    if (S.modal === "mfa") {
      return `<div class="modalshade"><div class="modal"><h2>Authenticator</h2><p class="sub">${S.mfaUri ? `Add this secret to an authenticator app, then enter the 6-digit code. Secret: ${Techne.esc(S.mfaSecret)}` : "Turn on a time-based code for this login. SMS is not used."}</p><form id="opsform" data-op="mfa"><div class="formgrid">${S.mfaUri ? Techne.field("code", "Code", "text", "", "required") : ""}</div><div class="modalactions"><button type="button" class="btn light" data-act="close">Close</button><button class="btn green" type="submit">${S.mfaUri ? "Confirm" : "Start setup"}</button></div></form>${S.backupCodes ? `<div class="warn">Save these backup codes: ${Techne.esc(S.backupCodes.join(" "))}</div>` : ""}</div></div>`;
    }
    return "";
  },
  page() {
    const S = Techne.S;
    const hits = S.searchHits;
    const search = hits ? `<section class="panel"><h3>Search</h3>${["assets", "products", "stocktakes"].map((key) => (hits[key] || []).map((item) => `<div class="countrow"><strong>${Techne.esc(item.label)}</strong><span class="pill">${Techne.esc(item.status || item.qty || "")}</span></div>`).join("")).join("") || Techne.empty("No matches", "Try a name, SKU, or asset id.")}</section>` : "";
    const log = (S.syncLog || []).slice(0, 5).map((item) => `<div class="countrow"><span>${item.ok ? "Synced" : "Held"}</span><span class="muted">${Techne.esc(item.error || item.status || "")}</span></div>`).join("");
    return Techne.header("Controls", "Operations", "Reservations, stock documents, count controls, and sync history.") +
      search +
      `<div class="panels"><section class="panel"><h3>Quick actions</h3><div class="modalactions">${Techne.btn("Scope preview", "ops-preview")}${Techne.btn("Coverage", "ops-coverage")}${Techne.btn("Valuation CSV", "ops-report:valuation")}${Techne.btn("Overdue assets", "ops-report:overdue-assets")}${Techne.btn("Movements", "ops-report:movements")}</div><div id="opsresult" class="muted"></div></section><section class="panel"><h3>Sync history</h3>${log || Techne.empty("No sync events yet", "Offline changes appear here after they are sent.")}</section></div>` +
      `<section class="panel"><h3>Receive stock</h3><form id="opsform" data-op="receive"><div class="formgrid">${Techne.field("supplier", "Supplier", "text", "", "required")}${Techne.field("sku", "SKU", "text", "", "required")}${Techne.field("qty", "Quantity", "number", "1", 'min="1" required')}</div><button class="btn green" type="submit">Post goods receipt</button></form></section>`;
  },
};

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-act]");
  if (!target || !Techne?.S?.user) return;
  const name = target.dataset.act;
  if (name === "ops-export") {
    const data = await TechneAPI.send("GET", "/api/privacy");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "techne-privacy.json";
    link.click();
  }
  if (name === "ops-erase") {
    const password = prompt("Type your password to remove this login. Stock history stays with the company.");
    if (!password) return;
    await TechneAPI.send("POST", "/api/privacy/erase", { password });
    await TechneIDB.clear();
    location.reload();
  }
  if (name === "ops-preview") {
    const scope = prompt("Scope: full, aisle, department, category, shelf, rack, bin, abc, list", "aisle") || "aisle";
    const scopeValue = scope === "full" ? "" : (prompt("Scope value", "Aisle 1") || "");
    const data = await TechneAPI.send("POST", "/api/stocktakes/preview", { scope, scopeValue, branchId: Techne.S.user.branchId });
    const box = document.getElementById("opsresult");
    if (box) box.textContent = `${data.count} products: ${data.products.map((item) => item.sku).join(", ")}`;
  }
  if (name === "ops-coverage") {
    const data = await TechneAPI.send("GET", "/api/stocktakes/coverage");
    const box = document.getElementById("opsresult");
    if (box) box.textContent = `${data.coverage}% of products have been in a count. Shrinkage units ${data.shrinkageUnits}.`;
  }
  if (name.startsWith("ops-report:")) {
    const data = await TechneAPI.send("GET", `/api/reports/${name.slice(11)}`);
    const blob = new Blob([data.csv], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = data.filename;
    link.click();
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id !== "opsform") return;
  event.preventDefault();
  event.stopPropagation();
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.op === "mfa" && !Techne.S.mfaSecret) {
      const started = await TechneAPI.send("POST", "/api/mfa/setup", {});
      Techne.S.mfaSecret = started.secret;
      Techne.S.mfaUri = started.uri;
      return render();
    }
    if (form.dataset.op === "mfa") {
      const confirmed = await TechneAPI.send("POST", "/api/mfa/confirm", { code: body.code });
      Techne.S.backupCodes = confirmed.backupCodes;
      Techne.S.banner = "Authenticator is on for the next sign-in.";
      return render();
    }
    if (form.dataset.op === "receive") {
      const product = Techne.S.data.products.find((item) => item.sku.toLowerCase() === body.sku.toLowerCase());
      if (!product) throw new Error("That SKU is not in the synced catalogue.");
      await TechneAPI.send("POST", "/api/goods-receipts", { supplier: body.supplier, lines: [{ productId: product.id, qty: Number(body.qty) }] }, crypto.randomUUID());
      Techne.S.banner = "Goods receipt posted.";
      await refresh();
      render();
    }
  } catch (error) {
    Techne.S.banner = error.message;
    render();
  }
});
