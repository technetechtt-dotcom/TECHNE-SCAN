/* Code 128 patterns match code128.js (JsBarcode, MIT). EAN-13 patterns follow the GS1 specification. */
(function (root) {
  const BARS = [
    11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
    10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
    11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
    10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
    11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
    11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
    11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
    10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
    11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
    10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
    11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
    11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
    11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
    10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
    10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
    11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
    10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
    10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
    11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
    10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
    10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
    11010011100, 1100011101011,
  ].map(String);
  const INDEX = new Map(BARS.map((pattern, value) => [pattern, value]));
  const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
  const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
  const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

  function eanCheck(twelve) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
  }

  function ean13Bits(digits) {
    const text = String(digits || "");
    if (!/^\d{12,13}$/.test(text)) return "";
    const body = text.slice(0, 12);
    const check = eanCheck(body);
    if (text.length === 13 && Number(text[12]) !== check) return "";
    const parity = PARITY[Number(body[0])];
    let bits = "101";
    for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === "L" ? L : G)[Number(body[i])];
    bits += "01010";
    for (let i = 7; i <= 11; i++) bits += R[Number(body[i])];
    bits += R[check] + "101";
    return bits;
  }

  function decodeEan(bits) {
    if (bits.length !== 95 || !bits.startsWith("101") || !bits.endsWith("101") || bits.slice(45, 50) !== "01010") return "";
    let parity = "";
    let left = "";
    for (let i = 0; i < 6; i++) {
      const chunk = bits.slice(3 + i * 7, 10 + i * 7);
      const l = L.indexOf(chunk);
      const g = G.indexOf(chunk);
      if (l >= 0) { parity += "L"; left += String(l); }
      else if (g >= 0) { parity += "G"; left += String(g); }
      else return "";
    }
    const first = PARITY.indexOf(parity);
    if (first < 0) return "";
    let right = "";
    for (let i = 0; i < 6; i++) {
      const digit = R.indexOf(bits.slice(50 + i * 7, 57 + i * 7));
      if (digit < 0) return "";
      right += String(digit);
    }
    const twelve = String(first) + left + right.slice(0, 5);
    if (eanCheck(twelve) !== Number(right[5])) return "";
    return twelve + right[5];
  }

  function code128Bits(text) {
    const codes = [104];
    for (const char of String(text || "")) {
      const code = char.charCodeAt(0) - 32;
      if (code < 0 || code > 94) return "";
      codes.push(code);
    }
    if (codes.length < 2) return "";
    let sum = codes[0];
    for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103, 106);
    return codes.map((code) => BARS[code]).join("");
  }

  function decode128(bits) {
    const stop = BARS[106];
    if (![103, 104, 105].some((start) => bits.startsWith(BARS[start]))) return "";
    const symbols = [];
    let i = 0;
    while (i < bits.length && !bits.startsWith(stop, i)) {
      const chunk = bits.slice(i, i + 11);
      if (!INDEX.has(chunk)) return "";
      symbols.push(INDEX.get(chunk));
      i += 11;
    }
    if (!bits.startsWith(stop, i) || symbols.length < 3 || symbols[0] !== 104) return "";
    const data = symbols.slice(1, -1);
    const check = symbols[symbols.length - 1];
    let sum = symbols[0];
    data.forEach((value, index) => { sum += value * (index + 1); });
    if (sum % 103 !== check) return "";
    return data.map((value) => String.fromCharCode(value + 32)).join("");
  }

  function normalize(raw) {
    const start = raw.indexOf("1");
    const end = raw.lastIndexOf("1");
    if (start < 0 || end - start < 20) return "";
    const body = raw.slice(start, end + 1);
    const runs = [];
    let i = 0;
    while (i < body.length) {
      let j = i + 1;
      while (j < body.length && body[j] === body[i]) j++;
      runs.push([body[i], j - i]);
      i = j;
    }
    const min = Math.min(...runs.map((run) => run[1]));
    let bits = "";
    for (const [bit, len] of runs) bits += bit.repeat(Math.max(1, Math.round(len / min)));
    return bits;
  }

  function rowBits(data, width, y) {
    let sum = 0;
    const values = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      values[x] = (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11) | 0;
      sum += values[x];
    }
    const threshold = sum / width;
    let bits = "";
    for (let x = 0; x < width; x++) bits += values[x] < threshold ? "1" : "0";
    return normalize(bits);
  }

  function readImage(data, width, height) {
    if (root.jsQR) {
      try {
        const qr = root.jsQR(data, width, height);
        if (qr?.data) return qr.data;
      } catch { /* fall through to the 1D decoder */ }
    }
    const votes = new Map();
    for (const step of [0.35, 0.45, 0.5, 0.55, 0.65]) {
      const y = Math.min(height - 1, Math.max(0, Math.floor(height * step)));
      const bits = rowBits(data, width, y);
      const value = decodeEan(bits) || decode128(bits);
      if (value) votes.set(value, (votes.get(value) || 0) + 1);
    }
    let best = "";
    let count = 0;
    for (const [value, seen] of votes) if (seen > count) { best = value; count = seen; }
    return best;
  }

  root.TechneSymbology = { ean13Bits, code128Bits, decodeEan, decode128, readImage };
})(globalThis);
