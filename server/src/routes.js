import { bad } from "./errors.js";
import { ask, summary } from "./intelligence.js";
import {
  applyImport,
  approveStocktake,
  assignStocktake,
  changePassword,
  checkinAsset,
  checkoutAsset,
  createAsset,
  createBranch,
  createDevice,
  createEmployee,
  createImport,
  createProduct,
  createSchedule,
  createStocktake,
  deleteSchedule,
  listAssets,
  listAudits,
  listBranches,
  listDevices,
  listEmployees,
  listEvents,
  listImports,
  listNotifications,
  listProducts,
  listSchedules,
  listStocktakes,
  markAllNotifications,
  markNotification,
  pull,
  reconciliation,
  runSchedule,
  setCounts,
  submitStocktake,
  updateBranch,
  updateCompany,
  updateDevice,
  updateEmployee,
  updateProduct,
} from "./store.js";

const routes = [
  ["GET", /^\/api\/sync\/pull$/, (user) => pull(user)],
  ["POST", /^\/api\/me\/password$/, (user, body) => changePassword(user, body)],
  ["PATCH", /^\/api\/company$/, (user, body) => updateCompany(user, body)],
  ["GET", /^\/api\/branches$/, (user) => listBranches(user)],
  ["POST", /^\/api\/branches$/, (user, body) => createBranch(user, body)],
  ["PATCH", /^\/api\/branches\/([^/]+)$/, (user, body, id) => updateBranch(user, id, body)],
  ["GET", /^\/api\/employees$/, (user) => listEmployees(user)],
  ["POST", /^\/api\/employees$/, (user, body) => createEmployee(user, body)],
  ["PATCH", /^\/api\/employees\/([^/]+)$/, (user, body, id) => updateEmployee(user, id, body)],
  ["GET", /^\/api\/assets$/, (user) => listAssets(user)],
  ["POST", /^\/api\/assets$/, (user, body) => createAsset(user, body)],
  ["POST", /^\/api\/assets\/([^/]+)\/checkout$/, (user, body, id) => checkoutAsset(user, id, body)],
  ["POST", /^\/api\/assets\/([^/]+)\/checkin$/, (user, body, id) => checkinAsset(user, id, body)],
  ["GET", /^\/api\/products$/, (user) => listProducts(user)],
  ["POST", /^\/api\/products$/, (user, body) => createProduct(user, body)],
  ["PATCH", /^\/api\/products\/([^/]+)$/, (user, body, id) => updateProduct(user, id, body)],
  ["GET", /^\/api\/stocktakes$/, (user) => listStocktakes(user)],
  ["POST", /^\/api\/stocktakes$/, (user, body) => createStocktake(user, body)],
  ["PUT", /^\/api\/stocktakes\/([^/]+)\/counts$/, (user, body, id) => setCounts(user, id, body)],
  ["POST", /^\/api\/stocktakes\/([^/]+)\/submit$/, (user, _body, id) => submitStocktake(user, id)],
  ["GET", /^\/api\/stocktakes\/([^/]+)\/reconciliation$/, (user, _body, id) => reconciliation(user, id)],
  ["POST", /^\/api\/stocktakes\/([^/]+)\/approve$/, (user, _body, id) => approveStocktake(user, id)],
  ["POST", /^\/api\/stocktakes\/([^/]+)\/assign$/, (user, body, id) => assignStocktake(user, id, body)],
  ["GET", /^\/api\/schedules$/, (user) => listSchedules(user)],
  ["POST", /^\/api\/schedules$/, (user, body) => createSchedule(user, body)],
  ["POST", /^\/api\/schedules\/([^/]+)\/run$/, (user, _body, id) => runSchedule(user, id)],
  ["DELETE", /^\/api\/schedules\/([^/]+)$/, (user, _body, id) => deleteSchedule(user, id)],
  ["GET", /^\/api\/devices$/, (user) => listDevices(user)],
  ["POST", /^\/api\/devices$/, (user, body) => createDevice(user, body)],
  ["PATCH", /^\/api\/devices\/([^/]+)$/, (user, body, id) => updateDevice(user, id, body)],
  ["GET", /^\/api\/imports$/, (user) => listImports(user)],
  ["POST", /^\/api\/imports$/, (user, body) => createImport(user, body)],
  ["POST", /^\/api\/imports\/([^/]+)\/apply$/, (user, body, id) => applyImport(user, id, body)],
  ["GET", /^\/api\/notifications$/, (user) => listNotifications(user)],
  ["POST", /^\/api\/notifications\/read-all$/, (user) => markAllNotifications(user)],
  ["POST", /^\/api\/notifications\/([^/]+)\/read$/, (user, _body, id) => markNotification(user, id)],
  ["GET", /^\/api\/activity$/, async (user) => ({ events: await listEvents(user), audits: await listAudits(user) })],
  ["GET", /^\/api\/intelligence\/summary$/, (user) => summary(user)],
  ["POST", /^\/api\/intelligence\/ask$/, (user, body) => ask(user, body.question)],
];

export async function handleProtected(user, method, path, body) {
  for (const [routeMethod, pattern, handle] of routes) {
    if (routeMethod !== method) continue;
    const match = path.match(pattern);
    if (!match) continue;
    return handle(user, body || {}, ...match.slice(1));
  }
  throw bad(404, "That endpoint does not exist.");
}

export async function pushOps(user, operations) {
  if (!Array.isArray(operations) || operations.length > 100) throw bad(400, "Sync batch is not valid.");
  const results = [];
  for (const operation of operations) {
    if (!operation?.path || operation.path.startsWith("/api/sync/")) {
      results.push({ opId: operation?.id, ok: false, status: 400, error: "That sync operation is not valid." });
      break;
    }
    try {
      const value = await handleProtected(user, operation.method, operation.path, operation.body || {});
      results.push({ opId: operation.id, ok: true, status: 200, body: value });
    } catch (error) {
      results.push({ opId: operation.id, ok: false, status: error.status || 500, error: error.message || "Sync failed." });
      break;
    }
  }
  return { results };
}

routes.unshift(["POST", /^\/api\/sync\/push$/, (user, body) => pushOps(user, body.operations || [])]);
