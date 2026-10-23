import { bad } from "./errors.js";

export function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseScanCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) throw bad(400, "The CSV file is empty.");
  if (raw.length > 1_000_000) throw bad(400, "The CSV file is too large.");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const header = splitCsvLine(lines.shift()).map((cell) => cell.trim().toLowerCase());
  const barcodeAt = header.indexOf("barcode");
  const quantityAt = header.indexOf("quantity");
  if (barcodeAt < 0 || quantityAt < 0) throw bad(400, "CSV needs barcode and quantity columns.");
  const records = [];
  for (const line of lines) {
    const cells = splitCsvLine(line);
    const barcode = String(cells[barcodeAt] || "").trim();
    const quantity = Number(String(cells[quantityAt] || "").trim());
    if (!barcode || !Number.isFinite(quantity) || quantity < 0) continue;
    records.push({ barcode: barcode.slice(0, 80), quantity: Math.floor(quantity) });
  }
  if (!records.length) throw bad(400, "No usable barcode rows were found.");
  if (records.length > 5000) throw bad(400, "CSV is limited to 5000 rows.");
  return records;
}
