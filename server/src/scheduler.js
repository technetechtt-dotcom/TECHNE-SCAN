import { housekeeping, log } from "./guard.js";
import { overdueNotices, runDueSchedules } from "./store.js";

export function startScheduler() {
  const tick = () => {
    runDueSchedules().catch((error) => log("error", "Scheduler failed.", { detail: error.message }));
    overdueNotices().catch((error) => log("error", "Overdue notices failed.", { detail: error.message }));
    housekeeping().catch((error) => log("error", "Housekeeping failed.", { detail: error.message }));
  };
  const timer = setInterval(tick, 30_000);
  timer.unref?.();
  setTimeout(tick, 1500).unref?.();
}
