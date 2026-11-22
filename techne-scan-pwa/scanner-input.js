(function () {
  let buffer = "";
  let last = 0;
  let fast = false;

  document.addEventListener("keydown", (event) => {
    if (localStorage.getItem("techne-wedge") !== "1") return;
    if (!globalThis.Techne?.S?.user || !Techne.applyBarcode) return;
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (event.key === "Enter") {
      const code = buffer;
      const wasFast = fast;
      buffer = "";
      fast = false;
      if (wasFast && code.length >= 3) {
        event.preventDefault();
        const input = document.activeElement;
        if (input && "value" in input && String(input.value).endsWith(code)) input.value = input.value.slice(0, -code.length);
        Techne.applyBarcode(code);
      }
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (buffer && gap > 40) {
      buffer = "";
      fast = false;
    }
    if (buffer) fast = true;
    buffer += event.key;
  }, true);

  globalThis.TechneHid = async function connectHid() {
    if (!navigator.hid) {
      Techne.S.banner = "This browser cannot open USB HID devices. Use the keyboard wedge, or import a CSV.";
      Techne.render();
      return;
    }
    try {
      const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x065a }, { usagePage: 0x8c }] });
      const device = devices[0];
      if (!device) return;
      if (!device.opened) await device.open();
      let pending = "";
      device.addEventListener("inputreport", (event) => {
        const bytes = new Uint8Array(event.data.buffer);
        for (const byte of bytes) {
          if (byte === 13 || byte === 10 || byte === 0) {
            const code = pending.trim();
            pending = "";
            if (code.length >= 3) Techne.applyBarcode(code);
            continue;
          }
          if (byte >= 32 && byte <= 126) pending += String.fromCharCode(byte);
        }
      });
      Techne.S.banner = `USB HID connected${device.productName ? `: ${device.productName}` : ""}.`;
    } catch (error) {
      Techne.S.banner = error.message || "USB HID permission was not granted.";
    }
    Techne.render();
  };
})();
