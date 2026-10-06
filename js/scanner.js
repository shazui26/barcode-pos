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
 * Shown when the browser has the camera permission set to "blocked".
 *
 * This is worth spelling out because a block is sticky: Chrome records it per
 * origin and will not prompt again, so pressing the button repeatedly can
 * never recover. The user has to reset it in site settings first.
 */
export const CAMERA_BLOCKED_HELP =
  "Camera is blocked for this site, and the browser will not ask again until " +
  "you reset it: click the icon at the left of the address bar, set Camera to " +
  "Allow, then reload the page.";

/**
 * Best-effort camera permission state: "granted" | "denied" | "prompt", or
 * "unknown" where the browser does not support querying it (Firefox and
 * Safari do not expose "camera" to permissions.query). Used to warn about a
 * sticky block before the user wastes time pressing the button.
 */
export async function cameraPermissionState() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return "unknown";
    const status = await navigator.permissions.query({ name: "camera" });
    return status.state;
  } catch {
    return "unknown";
  }
}

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

  // html5-qrcode renders its video into this element and sizes the scan region
  // from what it measures there. If the element is display:none at that moment
  // it measures 0x0, the qrbox collapses to 0x0 along with it, and the
  // viewfinder stays invisible even once real frames arrive. So the container
  // has to be laid out BEFORE start() runs, not revealed afterwards - hence
  // the .active class, added below rather than left to the CSS alone.
  const container = document.getElementById(elementId);

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
    if (!container) {
      onError("Camera area not found on this page.");
      return;
    }

    const formats = supportedFormats();
    const options = {
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
    if (formats) options.formatsToSupport = formats;

    // Shown first, so the library measures a laid-out element rather than a
    // hidden one. Removed again if anything below fails.
    container.classList.add("active");

    try {
      scanner = new Html5Qrcode(elementId, options);
      await scanner.start(
        { facingMode: "environment" },
        { fps: 15, qrbox: qrboxFunction },
        handleDecoded,
        () => {} // per-frame decode misses are normal; stay quiet
      );
      running = true;
    } catch (err) {
      container.classList.remove("active");
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
    if (container) container.classList.remove("active");
  }

  return { start, stop, isRunning: () => running };
}

/** Camera failures are common and confusing; say what actually went wrong. */
function describeCameraError(err) {
  const name = err?.name || "";
  const text = String(err?.message || err);

  if (name === "NotAllowedError" || /permission/i.test(text)) {
    return CAMERA_BLOCKED_HELP;
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
