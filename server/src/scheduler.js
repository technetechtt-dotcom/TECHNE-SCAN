import { overdueNotices, runDueSchedules } from "./store.js";

export function startScheduler() {
  const tick = () => {
    runDueSchedules().catch((error) => console.error("Scheduler failed.", error));
    overdueNotices().catch((error) => console.error("Overdue notices failed.", error));
  };
  const timer = setInterval(tick, 30_000);
  timer.unref?.();
  setTimeout(tick, 1500).unref?.();
}
