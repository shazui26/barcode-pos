/* ==========================================================================
   Shared camera scanner wrapper around html5-qrcode.

   The important details here are carried over from the original working
   scanner and are what actually make a webcam read real retail barcodes:
     * the full 1D format list, because html5-qrcode defaults to QR-only
     * useBarCodeDetectorIfSupported, to use the browser's fast native
       detector when it exists
     * a wide, short qrbox, which suits 1D barcodes far better than a square

   html5-qrcode is loaded as a classic <script> tag (it is not published as an
   ES module), so it is reached through window.Html5Qrcode rather than
   imported. Classic scripts run before deferred modules, so it is always
   defined by the time this module executes.
   ========================================================================== */

/** One physical label held under the camera fires dozens of callbacks per
 *  second. Ignore repeats of the same code for this long so a single scan
 *  adds one line item, not twenty. */
const DUPLICATE_COOLDOWN_MS = 1600;

/**
 * The barcode formats to enable. Built lazily rather than at module scope: if
 * the html5-qrcode CDN script is blocked or offline, touching
 * window.Html5QrcodeSupportedFormats at import time would throw and take the
 * whole module graph down with it. Returning undefined here just means "let
 * html5-qrcode use its own defaults".
 */
function supportedFormats() {
  const F = window.Html5QrcodeSupportedFormats;
  if (!F) return undefined;

  return [
    F.QR_CODE,
    F.EAN_13,
    F.EAN_8,
    F.UPC_A,
    F.UPC_E,
    F.CODE_128,
    F.CODE_39,
    F.CODE_93,
    F.ITF,
    F.CODABAR
  ].filter((format) => format !== undefined);
}

/** Wide and short, sized to the video width — the shape of a 1D barcode. */
function qrboxFunction(viewfinderWidth, viewfinderHeight) {
  const width = Math.floor(Math.min(viewfinderWidth, 400) * 0.9);
  const height = Math.floor(Math.min(viewfinderHeight * 0.7, width * 0.5));
  return { width, height };
}

/**
 * Create a scanner bound to an element id.
 * @param {{elementId: string, onScan: (text: string, format?: string) => void,
 *          onError?: (message: string) => void}} options
 */
export function createScanner({ elementId, onScan, onError = () => {} }) {
  let scanner = null;
  let running = false;
  let lastCode = null;
  let lastCodeAt = 0;

  function handleDecoded(decodedText, decodedResult) {
    const code = String(decodedText).trim();
    const now = Date.now();

    // Suppress the same code re-firing while it sits in front of the lens.
    if (code === lastCode && now - lastCodeAt < DUPLICATE_COOLDOWN_MS) return;
    lastCode = code;
    lastCodeAt = now;

    if (navigator.vibrate) navigator.vibrate(60);
    onScan(code, decodedResult?.result?.format?.formatName);
  }

  async function start() {
    if (running) return;

    if (typeof window.Html5Qrcode === "undefined") {
      onError("Scanner library failed to load. Check your connection and reload.");
      return;
    }

    const formats = supportedFormats();
    const options = {
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
    if (formats) options.formatsToSupport = formats;

    scanner = new Html5Qrcode(elementId, options);

    try {
      await scanner.start(
        { facingMode: "environment" },
        { fps: 15, qrbox: qrboxFunction },
        handleDecoded,
        () => {} // per-frame decode misses are normal; stay quiet
      );
      running = true;
    } catch (err) {
      scanner = null;
      onError(describeCameraError(err));
    }
  }

  async function stop() {
    if (!scanner || !running) return;
    try {
      await scanner.stop();
      scanner.clear();
    } catch {
      // Already stopped or unmounted — nothing useful to do.
    }
    scanner = null;
    running = false;
    lastCode = null;
  }

  return { start, stop, isRunning: () => running };
}

/** Camera failures are common and confusing; say what actually went wrong. */
function describeCameraError(err) {
  const name = err?.name || "";
  const text = String(err?.message || err);

  if (name === "NotAllowedError" || /permission/i.test(text)) {
    return "Camera permission was blocked. Allow camera access for this site and try again.";
  }
  if (name === "NotFoundError" || /no.*camera|requested device not found/i.test(text)) {
    return "No camera found on this device.";
  }
  if (name === "NotReadableError" || /in use|not readable/i.test(text)) {
    return "The camera is in use by another app.";
  }
  if (/secure context|https/i.test(text)) {
    return "Camera access needs HTTPS. Use the deployed site or localhost.";
  }
  return `Could not start the camera: ${text}`;
}
