const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

export function todayInTz(timeZone, from = new Date()) {
  const p = zonedParts(from, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function weekdayInTz(timeZone, from = new Date()) {
  const p = zonedParts(from, timeZone);
  return WEEKDAYS.indexOf(p.weekday);
}

export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(new Date(utc), timeZone);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    const delta = desired - shown;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

export function nextRunAt({ frequency, timeOfDay, weekday, dayOfMonth, timeZone }, from = new Date()) {
  const [hour, minute] = String(timeOfDay).split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Scheduled time is not valid.");
  }
  const start = zonedParts(from, timeZone);
  let year = +start.year;
  let month = +start.month;
  let day = +start.day;
  for (let i = 0; i < 400; i++) {
    const instant = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
    const parts = zonedParts(instant, timeZone);
    const dow = WEEKDAYS.indexOf(parts.weekday);
    const matches =
      frequency === "daily" ||
      (frequency === "weekly" && dow === Number(weekday)) ||
      (frequency === "monthly" && Number(parts.day) === Number(dayOfMonth));
    if (matches && instant.getTime() > from.getTime() + 500) return instant;
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  throw new Error("Could not calculate the next run.");
}

export function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}
