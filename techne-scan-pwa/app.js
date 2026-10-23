const S = {
  user: null,
  route: "dashboard",
  modal: null,
  query: "",
  authMode: "login",
  data: blank(),
  banner: "",
  answer: "",
  recon: null,
  demo: null,
  online: navigator.onLine,
  outbox: 0,
};
let cameraStream = null;
let cameraTimer = null;
let countTimer = null;

function blank() {
  return { branches: [], employees: [], assets: [], products: [], stocktakes: [], schedules: [], devices: [], imports: [], events: [], audits: [], notifications: [], company: null };
}
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const allow = (cap) => Boolean(S.user?.caps?.includes(cap));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: S.user?.timezone || "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fmt = (value) => value ? new Date(value).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: String(value).includes("T") ? "short" : undefined }) : "—";
const branchName = (id) => S.data.branches.find((branch) => branch.id === id)?.name || "—";
const employeeName = (id) => S.data.employees.find((person) => person.id === id)?.name || "Unassigned";
const unread = () => S.data.notifications.filter((item) => !item.readAt).length;
const btn = (label, act, cls = "light") => `<button class="btn ${cls}" data-act="${act}" type="button">${label}</button>`;
const empty = (title, sub) => `<div class="empty"><strong>${esc(title)}</strong><div>${esc(sub)}</div></div>`;
const field = (name, label, type = "text", value = "", extra = "") => `<div class="field"><label for="f_${name}">${label}</label><input id="f_${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
const select = (name, label, options, value = "") => `<div class="field"><label for="f_${name}">${label}</label><select id="f_${name}" name="${name}">${options.map((option) => `<option value="${esc(option.value)}" ${option.value === value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>`;
const status = (value) => `<span class="pill ${value === "available" || value === "approved" ? "green" : value === "out" || value === "active" || value === "completed" ? "orange" : value === "overdue" ? "red" : ""}">${esc(({ available: "Available", out: "Checked out", active: "In progress", completed: "Submitted", approved: "Approved" })[value] || value)}</span>`;

function header(label, title, sub, actions = "") {
  return `<div class="headline"><div><div class="eyebrow">${label}</div><h1>${title}</h1><p class="sub">${sub}</p></div><div class="actions">${actions}</div></div>${S.banner ? `<div class="warn">${esc(S.banner)}</div>` : ""}`;
}
function branchOptions(selected = S.user?.branchId) {
  return select("branchId", "Branch", S.data.branches.filter((branch) => branch.active).map((branch) => ({ value: branch.id, label: branch.name })), selected);
}
function peopleOptions(branchId, includeBlank = true) {
  const people = S.data.employees.filter((person) => person.active && (!branchId || person.branchId === branchId));
  const options = people.map((person) => ({ value: person.id, label: `${person.name} · ${person.role}` }));
  if (includeBlank) options.unshift({ value: "", label: "Unassigned" });
  return options;
}

const NAV = [
  ["dashboard", "Overview", "work"],
  ["assets", "Assets", "work"],
  ["stocktakes", "Counts", "work"],
  ["schedules", "Schedules", "work"],
  ["inventory", "Inventory", "work"],
  ["scanner", "Scanner", "ops"],
  ["activity", "Activity", "ops"],
  ["intelligence", "Intelligence", "ops"],
  ["alerts", "Alerts", "ops"],
  ["devices", "Devices", "admin"],
  ["branches", "Branches", "admin"],
  ["team", "Team", "admin"],
];
function visibleNav() {
  return NAV.filter((item) => item[0] !== "branches" && item[0] !== "team" || (item[0] === "branches" && allow("branches")) || (item[0] === "team" && allow("employees")));
}
function navButton(item) {
  const badge = item[0] === "alerts" && unread() ? `<span class="badge" id="alertcount">${unread()}</span>` : "";
  return `<button class="${S.route === item[0] ? "active" : ""}" data-nav="${item[0]}"><span class="ico">•</span>${item[1]}${badge}</button>`;
}
function syncLabel() {
  if (!S.online) return `Offline · ${S.outbox} waiting`;
  if (S.outbox) return `Syncing · ${S.outbox} waiting`;
  return "Synced";
}

function shell() {
  const items = visibleNav();
  document.getElementById("app").innerHTML = `<div class="layout"><aside class="side"><div class="brand"><div class="brand-mark">T</div><div><strong>TECHNE SCAN</strong><small>${esc(S.user.companyName || "INTELLIGENCE")}</small></div></div><div class="nav-title">WORKSPACE</div><div class="nav">${items.filter((item) => item[2] === "work").map(navButton).join("")}</div><div class="nav-title">OPERATIONS</div><div class="nav">${items.filter((item) => item[2] !== "work").map(navButton).join("")}</div><div class="sidefoot"><span id="syncstate">${esc(syncLabel())}</span><small>${esc(S.user.name)} · ${esc(S.user.role)}. Records sync to your company database and stay in this browser while offline.</small></div></aside><div class="main"><header class="topbar"><div class="crumb">${esc(S.user.companyName)} / <strong>${esc(items.find((item) => item[0] === S.route)?.[1] || "More")}</strong></div><div class="topright"><span class="syncdot" id="syncstate-top">${esc(syncLabel())}</span><button class="avatar" data-act="account" type="button">${esc(S.user.name.slice(0, 2).toUpperCase())}</button></div></header><main class="content" id="page"></main></div></div><nav class="bottomnav">${[["dashboard", "Home"], ["assets", "Assets"], ["stocktakes", "Counts"], ["alerts", "Alerts"], ["more", "More"]].map((item) => `<button data-nav="${item[0]}" class="${S.route === item[0] ? "active" : ""}"><span>•</span>${item[1]}</button>`).join("")}</nav><div id="overlay"></div>`;
  render();
}
function render() {
  if (!document.querySelector(".layout")) return shell();
  document.getElementById("page").innerHTML = pages[S.route] ? pages[S.route]() : morePage();
  const label = syncLabel();
  const side = document.getElementById("syncstate");
  const top = document.getElementById("syncstate-top");
  if (side) side.textContent = label;
  if (top) top.textContent = label;
  const badge = document.getElementById("alertcount");
  if (badge) badge.textContent = unread() || "";
  renderModal();
}
function renderModal() {
  const overlay = document.getElementById("overlay");
  if (!overlay) return;
  overlay.innerHTML = S.modal ? modalHtml() : "";
  if (S.modal === "scan-qr" && !cameraStream) startCamera();
  if (S.modal !== "scan-qr") stopCamera();
  if (S.modal?.startsWith("stocktake:")) {
    const id = S.modal.slice(10);
    const item = S.data.stocktakes.find((row) => row.id === id);
    if (item && item.status !== "active" && S.recon?.stocktakeId !== id && !S.reconLoading && navigator.onLine) {
      S.reconLoading = id;
      TechneAPI.send("GET", `/api/stocktakes/${id}/reconciliation`).then((data) => {
        S.recon = data;
        S.reconLoading = null;
        render();
      }).catch((error) => {
        S.reconLoading = null;
        S.banner = error.message;
      });
    }
  }
}

function dashboard() {
  const out = S.data.assets.filter((asset) => asset.status === "out");
  const overdue = out.filter((asset) => asset.due && asset.due < today());
  const open = S.data.stocktakes.filter((item) => item.status === "active");
  const mine = open.filter((item) => item.assignedEmployeeId === S.user.id);
  return header("Operations hub", `Good day, ${esc(S.user.companyName)}`, "Assets, counts, and schedules for your branch.", (allow("assets") ? btn("+ Check out", "new-checkout", "green") : "") + (allow("stocktakes") ? btn("+ Start count", "new-stocktake") : "")) +
    `<div class="stats">${[["Assets", S.data.assets.length, "Tracked"], ["Checked out", out.length, "With staff"], ["Open counts", open.length, "In progress"], ["Overdue", overdue.length, "Need a return"]].map((item) => `<div class="stat"><div class="k">${item[0]}</div><div class="n">${item[1]}</div><div class="tag">${item[2]}</div></div>`).join("")}</div>` +
    `<div class="panels"><div><section class="panel"><h3>Assigned to you</h3>${mine.map((item) => `<div class="countrow"><div><strong>${esc(item.name)}</strong><div class="muted">${item.lines.length} products</div></div><button class="smallbtn" data-act="stocktake:${item.id}">Open</button></div>`).join("") || empty("Nothing assigned", "Scheduled counts land here when they are assigned to you.")}</section><section class="panel"><h3>Recent custody</h3>${S.data.events.slice(0, 5).map((event) => `<div class="countrow"><div><strong>${esc(S.data.assets.find((asset) => asset.id === event.assetId)?.name || "Asset")}</strong><div class="muted">${esc(event.person)} · ${fmt(event.at)}</div></div>${status(event.kind === "out" ? "out" : "available")}</div>`).join("") || empty("No movements", "Check-outs and returns will appear here.")}</section></div><div><section class="panel"><h3>Overdue returns</h3>${overdue.map((asset) => `<div class="countrow"><div><strong>${esc(asset.name)}</strong><div class="muted">${esc(asset.holder)} · due ${esc(asset.due)}</div></div><span class="pill red">Overdue</span></div>`).join("") || `<div class="notice"><strong>Returns are up to date</strong>${out.length} asset${out.length === 1 ? " is" : "s are"} checked out.</div>`}</section><section class="panel"><h3>Next scheduled counts</h3>${S.data.schedules.slice(0, 4).map((item) => `<div class="countrow"><div><strong>${esc(item.name)}</strong><div class="muted">${esc(item.frequency)} · ${fmt(item.nextRunAt)}</div></div><span class="pill">Automatic</span></div>`).join("") || empty("No schedules", "A daily, weekly, or monthly count runs on its own while the server is up.")}</section></div></div>`;
}
function assets() {
  const q = S.query.toLowerCase();
  const rows = S.data.assets.filter((asset) => `${asset.name} ${asset.publicId} ${asset.holder} ${asset.department}`.toLowerCase().includes(q));
  return header("Custody", "Assets", "Each asset gets a QR label and a Code 128 label the OPN-2001 can read.", (allow("assets") ? btn("+ Register", "new-asset", "green") + btn("Scan QR", "scan-qr") + btn("Check out", "new-checkout") + btn("Check in", "quick-checkin") : "")) +
    `<section class="panel"><div class="toolbar"><input class="search" id="search" placeholder="Search asset, person, or department" value="${esc(S.query)}"><span class="muted">${rows.length} assets</span></div><div class="tablewrap"><table><thead><tr><th>Asset</th><th>ID</th><th>Branch</th><th>Custodian</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((asset) => `<tr><td><strong>${esc(asset.name)}</strong><div class="smalls">${esc(asset.serial)}</div></td><td><span class="barcode">${esc(asset.publicId || "Pending sync")}</span></td><td>${esc(branchName(asset.branchId))}</td><td>${esc(asset.holder || "Unassigned")}</td><td>${asset.status === "out" && asset.due && asset.due < today() ? status("overdue") : status(asset.status)}</td><td><button class="smallbtn" data-act="asset:${asset.id}">Open</button></td></tr>`).join("")}</tbody></table></div></section>`;
}
function inventory() {
  const q = S.query.toLowerCase();
  const rows = S.data.products.filter((product) => `${product.name} ${product.sku} ${product.aisle}`.toLowerCase().includes(q));
  return header("Catalogue", "Inventory", "Quantities change through the stock ledger when a count is approved.", (allow("products") ? btn("+ Add product", "new-product", "green") : "") + btn("Export CSV", "export-inventory")) +
    `<section class="panel"><div class="toolbar"><input class="search" id="search" placeholder="Find a product or SKU" value="${esc(S.query)}"></div><div class="tablewrap"><table><thead><tr><th>Product</th><th>SKU</th><th>Branch</th><th>Aisle</th><th>On hand</th><th></th></tr></thead><tbody>${rows.map((product) => `<tr><td><strong>${esc(product.name)}</strong></td><td><span class="barcode">${esc(product.sku)}</span></td><td>${esc(branchName(product.branchId))}</td><td>${esc(product.aisle)}</td><td><strong>${product.qty}</strong></td><td><button class="smallbtn" data-act="product:${product.id}">Label</button></td></tr>`).join("")}</tbody></table></div></section>`;
}
function stocktakes() {
  return header("Cycle counts", "Stocktakes", "Expected quantities stay hidden until the count is submitted. Approval posts only the residual variance.", allow("stocktakes") ? btn("+ New count", "new-stocktake", "green") : "") +
    `<section class="panel"><div class="tablewrap"><table><thead><tr><th>Session</th><th>Scope</th><th>Branch</th><th>Assigned</th><th>Status</th><th></th></tr></thead><tbody>${S.data.stocktakes.map((item) => `<tr><td><strong>${esc(item.name)}</strong><div class="smalls">${item.lines.length} products</div></td><td>${esc(item.scope === "full" ? "Full inventory" : `${item.scope}: ${item.scopeValue}`)}</td><td>${esc(branchName(item.branchId))}</td><td>${esc(employeeName(item.assignedEmployeeId))}</td><td>${status(item.status)}</td><td><button class="smallbtn" data-act="stocktake:${item.id}">${item.status === "active" ? "Continue" : "Review"}</button></td></tr>`).join("")}</tbody></table>${S.data.stocktakes.length ? "" : empty("No counts yet", "Start one, or wait for a schedule to open it.")}</div></section>`;
}
function schedules() {
  return header("Automation", "Count schedules", "The server opens these counts at the chosen time in the company timezone.", allow("schedules") ? btn("+ New schedule", "new-schedule", "green") : "") +
    `<section class="panel"><div class="tablewrap"><table><thead><tr><th>Schedule</th><th>Repeat</th><th>Next run</th><th>Assigned</th><th></th></tr></thead><tbody>${S.data.schedules.map((item) => `<tr><td><strong>${esc(item.name)}</strong><div class="smalls">${esc(item.scope)} ${esc(item.scopeValue)}</div></td><td>${esc(item.frequency)} · ${esc(item.timeOfDay)}</td><td>${fmt(item.nextRunAt)}</td><td>${esc(employeeName(item.assignedEmployeeId))}</td><td>${allow("schedules") ? `<button class="smallbtn" data-act="run-schedule:${item.id}">Run now</button> <button class="smallbtn" data-act="remove-schedule:${item.id}">Delete</button>` : ""}</td></tr>`).join("")}</tbody></table>${S.data.schedules.length ? "" : empty("No schedules", "Create a daily, weekly, or monthly template.")}</div></section><div class="notice">Schedules run while the Techne Scan server is running. A count is not opened twice for the same due time.</div>`;
}
function scanner() {
  return header("Devices", "Scanner imports", "Upload the OPN-2001 Companion CSV, then apply the rows to an open count.", allow("imports") ? btn("Import CSV", "import-csv", "green") + btn("Sample CSV", "sample-csv") : "") +
    `<div class="panels"><section class="panel"><h3>How a batch gets into a count</h3><div class="countrow"><strong>1. Scan on the device</strong><span class="pill">On device</span></div><div class="countrow"><strong>2. Export barcode, quantity CSV</strong><span class="pill">Companion app</span></div><div class="countrow"><strong>3. Import and apply to an open count</strong><span class="pill green">Available</span></div><p class="muted">Direct USB still needs the Opticon SDK on Windows. This screen records the device and applies the file.</p></section><section class="panel"><h3>Recent imports</h3>${S.data.imports.map((item) => `<div class="countrow"><div><strong>${esc(item.name)}</strong><div class="muted">${fmt(item.createdAt)} · ${item.lineCount} rows${item.appliedStocktakeId ? " · applied" : ""}</div></div>${item.appliedStocktakeId ? `<span class="pill green">Applied</span>` : `<button class="smallbtn" data-act="apply:${item.id}">Apply</button>`}</div>`).join("") || empty("No imports", "Upload a scanner CSV to begin.")}</section></div>`;
}
function activity() {
  const audits = S.data.audits.filter((item) => item.action === "stocktake.approve" || item.action === "import.apply");
  return header("Accountability", "Activity", "Custody events and count approvals for this company.", btn("Export CSV", "export-events")) +
    `<section class="panel"><div class="tablewrap"><table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${S.data.events.map((event) => `<tr><td>${fmt(event.at)}</td><td>${status(event.kind === "out" ? "out" : "available")}</td><td>${esc(S.data.assets.find((asset) => asset.id === event.assetId)?.name || "Asset")} · ${esc(event.person)} · ${esc(event.location || event.notes || "")}</td></tr>`).join("")}${audits.map((item) => `<tr><td>${fmt(item.at)}</td><td>${esc(item.action)}</td><td>${esc(item.detail?.name || item.entity)}</td></tr>`).join("")}</tbody></table></div></section>`;
}
function alerts() {
  return header("Notifications", "Alerts", "Assignments, overdue returns, and counts waiting for approval.", unread() ? btn("Mark all read", "read-all") : "") +
    `<section class="panel">${S.data.notifications.map((item) => `<div class="countrow"><div><strong>${esc(item.title)}</strong><div class="muted">${esc(item.body)} · ${fmt(item.createdAt)}</div></div><button class="smallbtn" data-act="open-note:${item.id}">${item.readAt ? "Open" : "Read"}</button></div>`).join("") || empty("No alerts", "Overdue assets and scheduled counts will notify you here.")}</section>`;
}
function devices() {
  return header("Hardware", "Devices", "Register each scanner before importing its file.", allow("devices") ? btn("+ Register device", "new-device", "green") : "") +
    `<section class="panel"><div class="tablewrap"><table><thead><tr><th>Device</th><th>Type</th><th>Branch</th><th>Last import</th><th>Status</th></tr></thead><tbody>${S.data.devices.map((device) => `<tr><td><strong>${esc(device.name)}</strong><div class="smalls">${esc(device.serial)}</div></td><td>${esc(device.kind)}</td><td>${esc(branchName(device.branchId))}</td><td>${fmt(device.lastSeenAt)}</td><td>${status(device.status === "active" ? "available" : "completed")}</td></tr>`).join("")}</tbody></table>${S.data.devices.length ? "" : empty("No devices", "Register the OPN-2001 that will send CSV files.")}</div></section>`;
}
function branches() {
  return header("Company", "Branches", `${esc(S.data.company?.name || S.user.companyName)} · ${esc(S.user.timezone)}`, btn("Company settings", "company") + btn("+ Branch", "new-branch", "green")) +
    `<section class="panel"><div class="tablewrap"><table><thead><tr><th>Branch</th><th>Code</th><th>Address</th><th>Status</th></tr></thead><tbody>${S.data.branches.map((branch) => `<tr><td><strong>${esc(branch.name)}</strong></td><td>${esc(branch.code)}</td><td>${esc(branch.address || "—")}</td><td>${branch.active ? status("available") : status("completed")}</td></tr>`).join("")}</tbody></table></div></section>`;
}
function team() {
  return header("Access", "Team", "Owners and admins see every branch. Everyone else is limited to their own branch.", btn("+ Employee", "new-employee", "green")) +
    `<section class="panel"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Branch</th><th>Status</th></tr></thead><tbody>${S.data.employees.map((person) => `<tr><td><strong>${esc(person.name)}</strong></td><td>${esc(person.email || "—")}</td><td>${esc(person.role)}</td><td>${esc(branchName(person.branchId))}</td><td>${person.active ? status("available") : status("completed")}</td></tr>`).join("")}</tbody></table></div></section>`;
}
function intelligence() {
  const intel = S.intel;
  return header("Techne Intelligence", "Recommendations", "Answers come from the stock ledger, count snapshots, and custody dates.", btn("Refresh", "refresh-intel", "green")) +
    (intel ? `<p class="muted">${esc(intel.method)}</p><div class="intel-grid"><div><section class="panel"><h3>What to do next</h3>${intel.recommendations.map((item) => `<div class="countrow"><div><strong>${esc(item.title)}</strong><div class="muted">${esc(item.detail)}</div></div><span class="pill ${item.severity === "high" ? "red" : item.severity === "medium" ? "orange" : ""}">${esc(item.severity)}</span></div>`).join("") || empty("No recommendations", "The books look quiet.")}</section><section class="panel"><h3>Discrepancy investigations</h3>${intel.discrepancies.map((item) => `<div class="countrow"><div><strong>${esc(item.name)}</strong><div class="muted">${esc(item.narrative)}</div></div><span class="pill ${item.variance ? "orange" : ""}">${item.variance > 0 ? "+" : ""}${esc(item.variance)}</span></div>`).join("") || empty("No discrepancies", "Approved counts with a residual variance show up here.")}</section></div><div><section class="panel"><h3>Demand cover</h3><div class="tablewrap"><table><thead><tr><th>SKU</th><th>Daily use</th><th>Days cover</th></tr></thead><tbody>${intel.forecast.map((item) => `<tr><td><strong>${esc(item.sku)}</strong><div class="smalls">${esc(item.note)}</div></td><td>${item.dailyUse ?? "—"}</td><td>${item.daysOfCover ?? "—"}</td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h3>Ask</h3><form id="askform"><div class="field"><label for="question">Question</label><input id="question" name="question" placeholder="Which assets are overdue?" required></div><button class="btn green" type="submit">Ask</button></form>${S.answer ? `<div class="answer">${esc(S.answer)}</div>` : ""}</section></div></div>` : `<section class="panel"><p class="muted">Open this page online once to cache the latest recommendations for offline reading.</p>${btn("Load recommendations", "refresh-intel", "green")}</section>`);
}
function morePage() {
  const items = visibleNav().filter((item) => !["dashboard", "assets", "stocktakes", "alerts"].includes(item[0]));
  return header("Menu", "More", "The rest of the workspace.") + `<section class="panel"><div class="shortcuts">${items.map((item) => `<button class="shortcut" data-nav="${item[0]}"><strong>${esc(item[1])}</strong></button>`).join("")}</div></section>`;
}
const pages = { dashboard, assets, inventory, stocktakes, schedules, scanner, activity, alerts, devices, branches, team, intelligence, more: morePage };

function formModal(title, sub, body, submit = "Save") {
  return `<div class="modalshade"><div class="modal"><h2>${title}</h2><p class="sub">${sub}</p><form id="actionform"><div class="formgrid">${body}</div><div class="modalactions"><button type="button" class="btn light" data-act="close">Cancel</button><button class="btn green" type="submit">${submit}</button></div></form></div></div>`;
}
function scopeFields() {
  return select("scope", "Scope", ["full", "aisle", "department", "category", "range"].map((value) => ({ value, label: value === "full" ? "Full inventory" : value === "range" ? "SKU prefix" : value }))) + field("scopeValue", "Scope value", "text", "", 'placeholder="Aisle 1"');
}
function qr(value) {
  try {
    const encoder = new QREncoder(0, 1);
    encoder.addData(value);
    encoder.make();
    const count = encoder.getModuleCount();
    const cell = 4;
    const quiet = 4;
    let marks = "";
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (encoder.isDark(row, col)) marks += `<rect x="${(col + quiet) * cell}" y="${(row + quiet) * cell}" width="${cell}" height="${cell}"/>`;
    const size = (count + quiet * 2) * cell;
    return `<svg aria-label="QR code for ${esc(value)}" role="img" width="150" height="150" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#101d31">${marks}</g></svg>`;
  } catch (error) {
    return `<strong>${esc(error.message)}</strong>`;
  }
}
function labelBlock(code) {
  if (!code) return `<div class="warn">Sync this record before printing its permanent label.</div>`;
  return `<div class="print-label"><div class="qrframe">${qr(code)}</div><div class="qrframe">${code128Svg(code)}</div><h3>${esc(code)}</h3><p>QR for phones. Code 128 for the OPN-2001.</p></div>`;
}
function modalHtml() {
  if (S.modal === "new-asset") return formModal("Register an asset", "A permanent id is assigned when this reaches the server.", branchOptions() + field("name", "Asset name", "text", "", "required") + field("serial", "Serial number") + select("category", "Category", ["IT Equipment", "Tools", "AV Equipment", "Vehicles", "Furniture", "Other"].map((value) => ({ value, label: value }))) + field("department", "Department", "text", "IT", "required") + field("location", "Current location", "text", "Head Office", "required") + select("condition", "Condition", ["Good", "Fair", "Needs attention"].map((value) => ({ value, label: value }))), "Create asset");
  if (S.modal === "new-product") return formModal("Add product", "The opening quantity is the first ledger entry.", branchOptions() + field("name", "Product name", "text", "", "required") + field("sku", "Barcode / SKU", "text", "", "required") + field("department", "Department", "text", "Retail", "required") + field("category", "Category", "text", "General", "required") + field("aisle", "Aisle", "text", "Aisle 1", "required") + field("qty", "Opening quantity", "number", "0", 'min="0" required'), "Add product");
  if (S.modal === "new-checkout" || S.modal === "quick-checkin") {
    const checkin = S.modal === "quick-checkin";
    const list = S.data.assets.filter((asset) => asset.status === (checkin ? "out" : "available"));
    return formModal(checkin ? "Check in" : "Check out", checkin ? "Record who received it, its condition, and where it is now." : "Record who has the asset and when it is due.", select("asset", "Asset", list.map((asset) => ({ value: asset.id, label: `${asset.publicId} · ${asset.name}` }))) + field("person", checkin ? "Received by" : "Issued to", "text", "", "required") + (checkin ? select("condition", "Condition", ["Good", "Fair", "Damaged"].map((value) => ({ value, label: value }))) + field("location", "Return location", "text", "", "required") : field("due", "Expected return", "date", today(), "required")) + field("notes", "Notes"), checkin ? "Confirm check-in" : "Confirm check-out");
  }
  if (S.modal === "new-stocktake" || S.modal === "new-schedule") {
    const schedule = S.modal === "new-schedule";
    return formModal(schedule ? "Schedule a count" : "Start a count", schedule ? "This will open itself at the next matching time." : "The snapshot is taken when the server accepts the count.", branchOptions() + field("name", "Name", "text", schedule ? "Weekly aisle count" : "New stocktake", "required") + scopeFields() + (schedule ? select("frequency", "Frequency", ["daily", "weekly", "monthly"].map((value) => ({ value, label: value }))) + field("timeOfDay", "Time", "time", "08:00", "required") + select("weekday", "Weekday", ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, value) => ({ value: String(value), label }))) + field("dayOfMonth", "Day of month", "number", "1", 'min="1" max="28"') : "") + (allow("assign") || schedule ? select("assignedEmployeeId", "Assign to", peopleOptions(S.user.branchId)) : ""), schedule ? "Save schedule" : "Start count");
  }
  if (S.modal === "new-branch") return formModal("New branch", "Branch codes are unique inside the company.", field("name", "Branch name", "text", "", "required") + field("code", "Code", "text", "", "required") + field("address", "Address"), "Create branch");
  if (S.modal === "new-employee") return formModal("New employee", "They will sign in with this email and password.", field("name", "Name", "text", "", "required") + field("email", "Email", "email", "", "required") + select("role", "Role", ["admin", "manager", "supervisor", "clerk", "viewer"].filter((role) => S.user.role === "owner" || role !== "admin").concat(S.user.role === "owner" ? ["owner"] : []).filter((role, index, list) => list.indexOf(role) === index).map((value) => ({ value, label: value }))) + branchOptions() + field("password", "Temporary password", "password", "", "required minlength=\"10\""), "Create login");
  if (S.modal === "new-device") return formModal("Register a device", "Tie later CSV imports to this scanner.", branchOptions() + field("name", "Device name", "text", "", "required") + select("kind", "Type", ["OPN-2001", "Phone", "Other"].map((value) => ({ value, label: value }))) + field("serial", "Serial"), "Save device");
  if (S.modal === "import-csv") return formModal("Import scan CSV", "Rows are stored first. Apply them to an open count from the import list.", branchOptions() + select("deviceId", "Device", [{ value: "", label: "No device" }, ...S.data.devices.map((device) => ({ value: device.id, label: device.name }))]) + `<div class="field"><label for="f_file">CSV file</label><input id="f_file" name="file" type="file" accept=".csv,text/csv" required></div>`, "Import");
  if (S.modal === "company") return formModal("Company settings", "Schedules use this timezone.", field("name", "Company name", "text", S.data.company?.name || S.user.companyName, "required") + field("timezone", "Timezone", "text", S.user.timezone, "required"), "Save");
  if (S.modal === "account") return `<div class="modalshade"><div class="modal"><h2>Your account</h2><p class="sub">${esc(S.user.email)} · ${esc(S.user.role)} · ${esc(branchName(S.user.branchId))}</p><form id="actionform"><div class="formgrid">${field("current", "Current password", "password")}${field("next", "New password", "password", "", 'minlength="10"')}</div><div class="modalactions"><button type="button" class="btn light" data-act="close">Close</button><button type="button" class="btn light" data-act="sign-out">Sign out</button><button class="btn green" type="submit">Change password</button></div></form></div></div>`;
  if (S.modal?.startsWith("asset:")) {
    const asset = S.data.assets.find((item) => item.id === S.modal.slice(6));
    if (!asset) return "";
    return `<div class="modalshade"><div class="modal"><h2>${esc(asset.name)}</h2><p class="sub">${esc(asset.publicId || "Pending sync")} · ${esc(asset.serial || "No serial")}</p><div class="split" style="margin-top:18px">${labelBlock(asset.publicId)}<div><p><strong>Status:</strong> ${status(asset.status)}</p><p><strong>Branch:</strong> ${esc(branchName(asset.branchId))}</p><p><strong>Location:</strong> ${esc(asset.location)}</p><p><strong>Custodian:</strong> ${esc(asset.holder || "Unassigned")}</p><p><strong>Due:</strong> ${esc(asset.due || "—")}</p><p><strong>Condition:</strong> ${esc(asset.condition)}</p></div></div><div class="modalactions noprint">${btn("Print label", "print")}${btn("Close", "close")}</div></div></div>`;
  }
  if (S.modal?.startsWith("product:")) {
    const product = S.data.products.find((item) => item.id === S.modal.slice(8));
    if (!product) return "";
    return `<div class="modalshade"><div class="modal"><h2>${esc(product.name)}</h2><p class="sub">${esc(product.sku)} · ${product.qty} on hand</p>${labelBlock(product.sku)}<div class="modalactions noprint">${btn("Print label", "print")}${btn("Close", "close")}</div></div></div>`;
  }
  if (S.modal?.startsWith("apply:")) {
    const item = S.data.imports.find((row) => row.id === S.modal.slice(6));
    const open = S.data.stocktakes.filter((row) => row.status === "active" && row.branchId === item?.branchId);
    if (!item) return "";
    return formModal("Apply scan rows", `${item.lineCount} rows from ${esc(item.name)}. Matching is case-insensitive and adds to the current count.`, select("stocktakeId", "Open count", open.map((row) => ({ value: row.id, label: row.name }))), "Apply to count");
  }
  if (S.modal?.startsWith("stocktake:")) {
    const item = S.data.stocktakes.find((row) => row.id === S.modal.slice(10));
    if (!item) return "";
    const counted = item.lines.filter((line) => line.counted !== null).length;
    const recon = S.recon?.stocktakeId === item.id ? S.recon.items : [];
    return `<div class="modalshade"><div class="modal"><h2>${esc(item.name)}</h2><p class="sub">${item.lines.length} products · ${counted} counted · ${esc(item.status)} · ${esc(employeeName(item.assignedEmployeeId))}</p><div class="progress" style="margin:16px 0"><div style="width:${item.lines.length ? 100 * counted / item.lines.length : 0}%"></div></div><form id="countform">${item.status === "active" ? `<div class="toolbar"><input name="barcode" class="search" placeholder="SKU or barcode" aria-label="Product barcode"><button class="btn light" type="button" data-act="lookup:${item.id}">Add scan</button></div><div id="scanmessage" class="muted">A matching SKU adds 1 to that line.</div>` : ""}${item.lines.map((line) => {
      const product = S.data.products.find((row) => row.id === line.productId);
      const explained = recon.find((row) => row.productId === line.productId);
      return `<div class="countrow"><div><strong>${esc(line.name || product?.name || "Product")}</strong><div class="muted">${esc(line.sku || product?.sku || "")}${item.status === "active" ? "" : ` · Snapshot ${line.expected}`}</div>${explained ? `<div class="smalls">${esc(explained.narrative)}</div>` : item.status === "approved" && line.variance !== null ? `<div class="smalls">Variance posted: ${line.variance}</div>` : ""}</div><div class="stepper">${item.status === "active" ? `<button type="button" data-act="minus:${item.id}:${line.productId}">−</button><input type="number" min="0" data-count="${item.id}:${line.productId}" value="${line.counted ?? ""}" placeholder="—"><button type="button" data-act="plus:${item.id}:${line.productId}">+</button>` : `<strong>${line.counted ?? "—"}</strong>`}</div></div>`;
    }).join("")}<div class="modalactions"><button type="button" class="btn light" data-act="close">Close</button>${item.status === "active" ? `<button type="button" class="btn green" data-act="submit-count:${item.id}" ${item.lines.length && counted === item.lines.length ? "" : "disabled"}>Submit for review</button>` : ""}${item.status === "completed" && allow("approve") ? `<button type="button" class="btn green" data-act="approve-count:${item.id}">Approve adjustments</button>` : ""}</div></form>${item.status === "completed" ? `<div class="warn">Approval posts the residual after movements during the count. ${S.user.role === "owner" ? "Owners can approve a count they submitted." : "Someone other than the person who submitted it must approve."}</div>` : ""}</div></div>`;
  }
  if (S.modal === "scan-qr") return `<div class="modalshade"><div class="modal"><h2>Scan asset QR</h2><p class="sub">Use the phone camera or type the asset id.</p><video id="scanvideo" autoplay playsinline muted style="width:100%;max-height:240px;background:#101d31;border-radius:12px"></video><p class="muted" id="camstatus">Camera starts on supported browsers over HTTPS or localhost.</p><form id="manualasset"><div class="field"><label>Asset ID</label><input name="id" placeholder="TT-AST-001" required></div><div class="modalactions"><button type="button" class="btn light" data-act="close">Close</button><button class="btn green" type="submit">Open asset</button></div></form></div></div>`;
  return "";
}

function stopCamera() {
  if (cameraTimer) clearInterval(cameraTimer);
  cameraTimer = null;
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
}
async function startCamera() {
  const statusNode = document.getElementById("camstatus");
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    if (statusNode) statusNode.textContent = "Camera QR detection is not supported here. Enter the asset id.";
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = document.getElementById("scanvideo");
    if (!video || S.modal !== "scan-qr") return stopCamera();
    video.srcObject = cameraStream;
    await video.play();
    if (statusNode) statusNode.textContent = "Point the camera at an asset QR label.";
    let busy = false;
    cameraTimer = setInterval(async () => {
      if (busy || !video.videoWidth) return;
      busy = true;
      try {
        const codes = await detector.detect(video);
        if (codes.length) openAssetCode(codes[0].rawValue);
      } catch { /* keep scanning */ } finally { busy = false; }
    }, 400);
  } catch {
    if (statusNode) statusNode.textContent = "Camera unavailable. Enter the asset id.";
    stopCamera();
  }
}
function openAssetCode(code) {
  const asset = S.data.assets.find((item) => item.publicId === code || item.id === code);
  if (!asset) {
    const statusNode = document.getElementById("camstatus");
    if (statusNode) statusNode.textContent = "That code is not one of your assets.";
    return;
  }
  stopCamera();
  S.modal = `asset:${asset.id}`;
  render();
}

async function refresh() {
  const data = await TechneAPI.send("GET", "/api/sync/pull");
  const pending = await TechneIDB.outbox();
  const blocked = new Set(pending.map((item) => item.bucket));
  for (const key of ["branches", "employees", "assets", "products", "stocktakes", "schedules", "devices", "imports", "events", "audits", "notifications"]) {
    if (!blocked.has(key)) S.data[key] = data[key] || [];
  }
  S.data.company = data.company;
  if (S.user && data.company) {
    S.user.companyName = data.company.name;
    S.user.timezone = data.company.timezone;
  }
  S.outbox = pending.length;
  await TechneIDB.set("snapshot", S.data);
  await TechneIDB.set("user", S.user);
}
async function run(method, path, body, bucket, applyLocal) {
  if (applyLocal) applyLocal();
  await TechneIDB.set("snapshot", S.data);
  try {
    if (!navigator.onLine) {
      const error = new Error("offline");
      error.offline = true;
      throw error;
    }
    await TechneAPI.send(method, path, body);
    await refresh();
    S.banner = "";
  } catch (error) {
    if (error.offline) {
      await TechneIDB.enqueue({ id: crypto.randomUUID(), method, path, body, bucket });
      S.outbox = (await TechneIDB.outbox()).length;
      S.banner = "Saved on this device. It will sync when the connection returns.";
    } else if (error.unauthorized) {
      await TechneIDB.clear();
      S.user = null;
      return showLogin();
    } else {
      S.banner = error.message;
      try { await refresh(); } catch { /* keep the message */ }
    }
  }
  render();
}
async function flush() {
  if (!navigator.onLine || !S.user) return;
  const operations = await TechneIDB.outbox();
  if (!operations.length) return;
  try {
    const result = await TechneAPI.send("POST", "/api/sync/push", { operations });
    for (const row of result.results) {
      if (row.ok || row.status < 500) await TechneIDB.drop(row.opId);
      else break;
    }
    const failed = result.results.find((row) => !row.ok && row.status < 500);
    if (failed) S.banner = failed.error;
    await refresh();
    render();
  } catch (error) {
    if (!error.offline) S.banner = error.message;
  }
}
function setCount(stocktakeId, productId, value) {
  const stocktake = S.data.stocktakes.find((item) => item.id === stocktakeId);
  const line = stocktake?.lines.find((item) => item.productId === productId);
  if (!line || stocktake.status !== "active") return;
  line.counted = value;
  clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    run("PUT", `/api/stocktakes/${stocktakeId}/counts`, { counts: [{ productId, count: value }] }, "stocktakes");
  }, 350);
  const submit = document.querySelector(`[data-act="submit-count:${stocktakeId}"]`);
  if (submit) submit.disabled = stocktake.lines.some((item) => item.counted === null);
}

function loginHtml() {
  const setup = S.authMode === "setup";
  return `<div class="login-wrap"><form class="login-card" id="${setup ? "setupform" : "loginform"}"><div class="eyebrow">TECHNE SCAN</div><h1>${setup ? "Create a company" : "Sign in"}</h1><p class="sub">${setup ? "This creates a separate company, its first branch, and an owner login." : "Your records belong to one company and sync from this browser."}</p>${S.demo && !setup ? `<div class="demo-box"><strong>Local demo</strong><div>Owner ${esc(S.demo.email)} · ${esc(S.demo.password)}</div><div>Clerk thabo@techne.local uses the same password and cannot approve counts.</div></div>` : ""}${S.banner ? `<div class="warn">${esc(S.banner)}</div>` : ""}<div class="formgrid">${setup ? field("companyName", "Company name", "text", "", "required") + field("timezone", "Timezone", "text", "Africa/Johannesburg", "required") + field("branchName", "First branch", "text", "Head Office", "required") + field("adminName", "Your name", "text", "", "required") : ""}${field("email", "Email", "email", "", "required")}${field("password", "Password", "password", "", setup ? 'required minlength="10"' : "required")}</div><div class="modalactions"><button class="btn green" type="submit">${setup ? "Create company" : "Sign in"}</button><button class="btn light" type="button" data-act="${setup ? "show-login" : "show-setup"}">${setup ? "I have a login" : "Create a company"}</button></div></form></div>`;
}
function showLogin() {
  stopCamera();
  document.getElementById("app").innerHTML = loginHtml();
}
async function enter(user) {
  S.user = user;
  S.banner = "";
  await refresh();
  S.route = "dashboard";
  shell();
  loadIntel();
  flush();
}
async function loadIntel() {
  if (!S.user) return;
  if (!navigator.onLine) {
    S.intel = await TechneIDB.get("intel");
    if (S.route === "intelligence") render();
    return;
  }
  try {
    S.intel = await TechneAPI.send("GET", "/api/intelligence/summary");
    await TechneIDB.set("intel", S.intel);
    if (S.route === "intelligence") render();
  } catch (error) {
    if (!error.offline) S.banner = error.message;
  }
}

function dataOf(form) {
  return Object.fromEntries(new FormData(form).entries());
}
async function onSubmit(event) {
  const form = event.target;
  if (form.id === "loginform" || form.id === "setupform" || form.id === "actionform" || form.id === "manualasset" || form.id === "askform" || form.id === "countform") event.preventDefault();
  try {
    if (form.id === "loginform") {
      const body = dataOf(form);
      const result = await TechneAPI.send("POST", "/api/login", body);
      return enter(result.user);
    }
    if (form.id === "setupform") {
      const result = await TechneAPI.send("POST", "/api/setup", dataOf(form));
      return enter(result.user);
    }
    if (form.id === "manualasset") return openAssetCode(String(new FormData(form).get("id") || "").trim());
    if (form.id === "askform") {
      const result = await TechneAPI.send("POST", "/api/intelligence/ask", { question: new FormData(form).get("question") });
      S.answer = result.answer;
      return render();
    }
    if (form.id !== "actionform") return;
    const body = dataOf(form);
    const modal = S.modal;
    if (modal === "account") {
      if (!body.current && !body.next) return;
      await TechneAPI.send("POST", "/api/me/password", body);
      S.banner = "Password changed.";
      S.modal = null;
      return render();
    }
    if (modal === "company") {
      const result = await TechneAPI.send("PATCH", "/api/company", body);
      S.user = result;
      S.modal = null;
      await refresh();
      return shell();
    }
    if (modal === "import-csv") {
      const file = form.file.files[0];
      body.csv = await file.text();
      body.name = file.name;
      delete body.file;
      S.modal = null;
      return run("POST", "/api/imports", body, "imports");
    }
    if (modal?.startsWith("apply:")) {
      const id = modal.slice(6);
      S.modal = null;
      return run("POST", `/api/imports/${id}/apply`, body, "stocktakes");
    }
    const clientId = crypto.randomUUID();
    if (modal === "new-asset") S.data.assets.unshift({ id: clientId, branchId: body.branchId, publicId: "", name: body.name, category: body.category, department: body.department, location: body.location, serial: body.serial || "", status: "available", holder: "", due: "", condition: body.condition || "Good", version: 1 });
    if (modal === "new-product") S.data.products.unshift({ id: clientId, branchId: body.branchId, sku: body.sku, name: body.name, department: body.department, aisle: body.aisle, category: body.category, qty: Number(body.qty) || 0, version: 1 });
    if (modal === "new-checkout") {
      const asset = S.data.assets.find((item) => item.id === body.asset);
      if (asset) Object.assign(asset, { status: "out", holder: body.person, due: body.due });
    }
    if (modal === "quick-checkin") {
      const asset = S.data.assets.find((item) => item.id === body.asset);
      if (asset) Object.assign(asset, { status: "available", holder: "", due: "", condition: body.condition, location: body.location });
    }
    const routes = {
      "new-asset": ["POST", "/api/assets", "assets", { ...body, id: clientId }],
      "new-product": ["POST", "/api/products", "products", { ...body, id: clientId, qty: Number(body.qty) }],
      "new-checkout": ["POST", `/api/assets/${body.asset}/checkout`, "assets", body],
      "quick-checkin": ["POST", `/api/assets/${body.asset}/checkin`, "assets", body],
      "new-stocktake": ["POST", "/api/stocktakes", "stocktakes", { ...body, id: clientId, assignedEmployeeId: body.assignedEmployeeId || null }],
      "new-schedule": ["POST", "/api/schedules", "schedules", { ...body, id: clientId, weekday: Number(body.weekday), dayOfMonth: Number(body.dayOfMonth), assignedEmployeeId: body.assignedEmployeeId || null }],
      "new-branch": ["POST", "/api/branches", "branches", body],
      "new-employee": ["POST", "/api/employees", "employees", body],
      "new-device": ["POST", "/api/devices", "devices", { ...body, id: clientId }],
    };
    const chosen = routes[modal];
    if (!chosen) return;
    S.modal = null;
    await run(chosen[0], chosen[1], chosen[3], chosen[2]);
    if (modal === "new-stocktake") {
      const created = S.data.stocktakes.find((item) => item.id === clientId);
      if (created) S.modal = `stocktake:${created.id}`;
      render();
    }
  } catch (error) {
    S.banner = error.message;
    if (S.user) render();
    else showLogin();
  }
}
function download(name, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function action(name) {
  if (["new-asset", "new-product", "new-checkout", "quick-checkin", "new-stocktake", "new-schedule", "new-branch", "new-employee", "new-device", "import-csv", "scan-qr", "account", "company"].includes(name) || name.startsWith("asset:") || name.startsWith("product:") || name.startsWith("apply:")) {
    S.modal = name;
    S.recon = null;
    render();
    if (name.startsWith("stocktake:")) return;
    return;
  }
  if (name.startsWith("stocktake:")) {
    S.modal = name;
    S.recon = null;
    render();
    const id = name.slice(10);
    const item = S.data.stocktakes.find((row) => row.id === id);
    if (item && item.status !== "active" && navigator.onLine) {
      try { S.recon = await TechneAPI.send("GET", `/api/stocktakes/${id}/reconciliation`); render(); } catch (error) { S.banner = error.message; render(); }
    }
    return;
  }
  if (name === "sign-out") {
    try { await TechneAPI.send("POST", "/api/logout", {}); } catch { /* local sign-out still proceeds */ }
    await TechneIDB.clear();
    S.user = null;
    S.data = blank();
    S.intel = null;
    S.modal = null;
    S.banner = "";
    return showLogin();
  }
  if (name === "close") { S.modal = null; return render(); }
  if (name === "print") return window.print();
  if (name === "show-login") { S.authMode = "login"; S.banner = ""; return showLogin(); }
  if (name === "show-setup") { S.authMode = "setup"; S.banner = ""; return showLogin(); }
  if (name === "sample-csv") return download("scanner-sample.csv", [["barcode", "quantity"], ["BVG-001", 2], ["CLN-001", 1]]);
  if (name === "export-inventory") return download("inventory.csv", [["sku", "name", "branch", "aisle", "qty"], ...S.data.products.map((product) => [product.sku, product.name, branchName(product.branchId), product.aisle, product.qty])]);
  if (name === "export-events") return download("custody.csv", [["time", "kind", "asset", "person", "location", "notes"], ...S.data.events.map((event) => [event.at, event.kind, event.assetId, event.person, event.location, event.notes])]);
  if (name === "refresh-intel") return loadIntel();
  if (name === "read-all") return run("POST", "/api/notifications/read-all", {}, "notifications");
  if (name.startsWith("open-note:")) {
    const id = name.slice(10);
    const item = S.data.notifications.find((row) => row.id === id);
    if (item && !item.readAt) await run("POST", `/api/notifications/${id}/read`, {}, "notifications");
    if (item?.href?.startsWith("stocktake:")) { S.route = "stocktakes"; S.modal = item.href; shell(); }
    else if (item?.href?.startsWith("asset:")) { S.route = "assets"; S.modal = item.href; shell(); }
    return;
  }
  if (name.startsWith("remove-schedule:")) {
    if (confirm("Delete this schedule? It will stop opening counts.")) return run("DELETE", `/api/schedules/${name.split(":")[1]}`, {}, "schedules");
    return;
  }
  if (name.startsWith("run-schedule:")) return run("POST", `/api/schedules/${name.split(":")[1]}/run`, {}, "stocktakes");
  if (name.startsWith("plus:") || name.startsWith("minus:")) {
    const [op, stocktakeId, productId] = name.split(":");
    const stocktake = S.data.stocktakes.find((item) => item.id === stocktakeId);
    const line = stocktake?.lines.find((item) => item.productId === productId);
    if (!line) return;
    setCount(stocktakeId, productId, Math.max(0, (line.counted ?? 0) + (op === "plus" ? 1 : -1)));
    return render();
  }
  if (name.startsWith("lookup:")) {
    const stocktake = S.data.stocktakes.find((item) => item.id === name.slice(7));
    const code = document.querySelector("#countform [name=barcode]")?.value.trim().toLowerCase();
    const line = stocktake?.lines.find((item) => item.sku.toLowerCase() === code || item.productId === code || S.data.products.find((product) => product.id === item.productId && product.sku.toLowerCase() === code));
    const message = document.getElementById("scanmessage");
    if (!line) { if (message) message.textContent = "Unknown or out-of-scope barcode. No count changed."; return; }
    setCount(stocktake.id, line.productId, (line.counted ?? 0) + 1);
    render();
    document.querySelector("#countform [name=barcode]")?.focus();
    return;
  }
  if (name.startsWith("submit-count:")) return run("POST", `/api/stocktakes/${name.slice(13)}/submit`, {}, "stocktakes");
  if (name.startsWith("approve-count:")) {
    if (!navigator.onLine) { S.banner = "Reconnect to approve. The server reconciles movements that happened during the count."; return render(); }
    if (!confirm("Approve this count and post the residual quantities?")) return;
    S.modal = null;
    return run("POST", `/api/stocktakes/${name.slice(14)}/approve`, {}, "stocktakes");
  }
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-nav],[data-act]");
  if (!target) return;
  if (target.dataset.nav) {
    stopCamera();
    S.route = target.dataset.nav;
    S.query = "";
    S.modal = null;
    if (S.route === "intelligence") loadIntel();
    shell();
  } else action(target.dataset.act);
});
document.addEventListener("submit", onSubmit);
document.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    S.query = event.target.value;
    const pos = event.target.selectionStart;
    render();
    const input = document.getElementById("search");
    input?.focus();
    input?.setSelectionRange(pos, pos);
  }
  if (event.target.dataset.count) {
    const [stocktakeId, productId] = event.target.dataset.count.split(":");
    const raw = event.target.value;
    setCount(stocktakeId, productId, raw === "" ? null : Math.max(0, Math.floor(Number(raw) || 0)));
  }
});
window.addEventListener("online", () => { S.online = true; flush(); });
window.addEventListener("offline", () => { S.online = false; S.banner = "Offline. Changes stay on this device until the connection returns."; render(); });
setInterval(() => { if (S.user && navigator.onLine) flush(); }, 20000);

async function boot() {
  await TechneIDB.open();
  const snapshot = await TechneIDB.get("snapshot");
  const cachedUser = await TechneIDB.get("user");
  if (snapshot) S.data = { ...blank(), ...snapshot };
  try {
    const status = await TechneAPI.send("GET", "/api/setup/status");
    S.demo = status.demoLogin;
  } catch { /* login still works without the hint */ }
  try {
    const me = await TechneAPI.send("GET", "/api/me");
    await enter(me.user);
  } catch (error) {
    if (cachedUser && (error.offline || !navigator.onLine)) {
      S.user = cachedUser;
      S.banner = "Offline. Showing the last synced copy.";
      shell();
    } else showLogin();
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}
boot();
