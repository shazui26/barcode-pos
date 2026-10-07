/* ==========================================================================
   Point of Sale screen.

   Scanning (camera or a USB keyboard-wedge scanner, which types the code and
   presses Enter) looks the barcode up in Firestore and drops it in the cart.
   Stock is a hard ceiling: a scan that would take the sale past what is on the
   shelf is refused rather than added, and checkout re-checks before writing.
   Completing a sale writes the sale record and decrements stock atomically.
   ========================================================================== */

import { mountAuth, signOutUser } from "./auth.js";
import {
  createScanner,
  cameraPermissionState,
  CAMERA_BLOCKED_HELP
} from "./scanner.js";
import {
  costRecorded,
  getProduct,
  recordSale,
  subscribeProducts,
  subscribeSettings
} from "./store.js";
import { money, renderShell, setCurrency, showStatus, clearStatus, toast } from "./ui.js";

const el = (id) => document.getElementById(id);

let user = null;
let products = [];
let settings = { taxRate: 0.08, discountMinItems: 3, discountRate: 0.05, currency: "USD" };
let cart = [];
let lastSale = null;

/* False until the live product list arrives. Stock is unknowable before then,
   and a cart restored from localStorage would otherwise look oversold for the
   first moment the page is up. */
let productsLoaded = false;

// Assigned by wireSummarySheet, so completeSale can close the mobile sheet
// without needing to know anything about the DOM.
let collapseSummary = () => {};

const LOW_STOCK = 5;
const CART_KEY = () => `pos_cart_${user?.uid || "anon"}`;

/* ---------------------------------------------------------- lifecycle --- */

mountAuth({
  appEl: el("app"),
  gateEl: el("gate"),
  onReady: async (signedInUser) => {
    user = signedInUser;

    subscribeSettings(
      (s) => {
        settings = s;
        setCurrency(s.currency);
        renderShell({
          active: "index.html",
          user,
          settings,
          onSignOut: async () => {
            await signOutUser();
            toast("Signed out", "info");
          }
        });
        renderSummary();
      },
      (err) => console.error("settings", err)
    );

    subscribeProducts(
      (list) => {
        products = list;
        productsLoaded = true;
        // Refreshes the cart too: its stock warnings and the quick-item tiles
        // both read from this list, so they follow it as it changes.
        renderCart();
      },
      (err) => {
        console.error("products", err);
        showStatus(el("scanStatus"), describeFirestoreError(err), "error");
      }
    );

    loadCart();
    renderCart();
    el("barcodeInput").focus();
    wireEvents();
  }
});

/* ------------------------------------------------------------- events --- */

let wired = false;

function wireEvents() {
  if (wired) return;
  wired = true;

  el("addItemBtn").onclick = () => addByBarcodeInput();

  // USB barcode scanners behave as keyboards and send Enter after the code.
  el("barcodeInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addByBarcodeInput();
    }
  });

  el("clearCartBtn").onclick = () => {
    if (!cart.length) return;
    if (!confirm("Clear the current sale?")) return;
    cart = [];
    saveCart();
    renderCart();
    clearStatus(el("scanStatus"));
  };

  el("cancelBtn").onclick = () => el("clearCartBtn").click();

  el("payBtn").onclick = completeSale;

  el("tendered").addEventListener("input", renderSummary);

  document.querySelectorAll("[data-tender]").forEach((btn) => {
    btn.onclick = () => {
      const kind = btn.dataset.tender;
      el("tendered").value =
        kind === "exact" ? totals().total.toFixed(2) : Number(kind).toFixed(2);
      renderSummary();
    };
  });

  el("cartItems").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const { action, barcode } = btn.dataset;
    if (action === "increase") changeQty(barcode, 1);
    if (action === "decrease") changeQty(barcode, -1);
    if (action === "remove") removeLine(barcode);
  });

  wireCamera();
  wireSummarySheet();
  measureBottomBar();
}

/* ------------------------------------------------- summary bottom sheet --- */

/**
 * On a phone the Order Summary is a fixed bottom bar: Total and Complete sale
 * stay reachable without scrolling past the cart, and the rest of the card
 * (subtotal, tax, discount, tendered, change) unfolds above them. Tapping the
 * backdrop or completing a sale closes it again.
 *
 * The markup is the real summary card, not a copy - so #totalValue and #payBtn
 * remain the single source of truth and renderSummary() needs no changes.
 * On desktop .expanded is inert and the toggle is hidden by CSS.
 */
function wireSummarySheet() {
  const card = document.querySelector(".summary-card");
  const toggle = document.querySelector(".summary-toggle");
  const backdrop = el("sheetBackdrop");
  if (!card || !toggle) return;

  const setOpen = (open) => {
    card.classList.toggle("expanded", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Hide order details" : "Show order details");
    if (backdrop) backdrop.classList.toggle("show", open);
  };

  toggle.onclick = () => setOpen(!card.classList.contains("expanded"));
  if (backdrop) backdrop.onclick = () => setOpen(false);

  collapseSummary = () => setOpen(false);
}

/**
 * Keep the page's bottom padding equal to how tall the summary bar actually is.
 *
 * The stylesheet reserves a fixed guess (--bottombar-h) for that bar, but the
 * bar is exactly as tall as its contents - and it grows when the stock warning
 * appears. A guess that is too small does not merely look untidy: it parks the
 * last line of the cart underneath the bar, where no amount of scrolling will
 * bring it back. Measuring is the only way to stay correct.
 *
 * Only --bottombar-h is written. --tabbar-h sizes the tabs themselves, so
 * feeding a measured height back into it would be a loop.
 */
function measureBottomBar() {
  const panel = document.querySelector(".summary-panel");
  if (!panel) return;

  const apply = () =>
    document.documentElement.style.setProperty("--bottombar-h", `${panel.offsetHeight}px`);

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(apply).observe(panel);
  } else {
    window.addEventListener("resize", apply);
  }
  apply();
}

/* ------------------------------------------------------------ camera --- */

function wireCamera() {
  const cameraBtn = el("cameraBtn");
  let starting = false;

  const scanner = createScanner({
    elementId: "reader",
    onScan: (code) => {
      el("barcodeInput").value = code;
      addByBarcodeInput(code);
    },
    onError: (message) => showStatus(el("scanStatus"), message, "error")
  });

  // A blocked camera is sticky: the browser will not prompt again, so letting
  // the user press the button to discover that just wastes their time. Say so
  // as soon as the page is ready instead.
  cameraPermissionState().then((state) => {
    if (state === "denied") {
      showStatus(el("scanStatus"), CAMERA_BLOCKED_HELP, "error");
    }
  });

  cameraBtn.onclick = async () => {
    if (starting) return;

    if (scanner.isRunning()) {
      await scanner.stop();
      cameraBtn.textContent = "Use camera";
      cameraBtn.classList.add("secondary-btn");
      return;
    }

    starting = true;
    cameraBtn.textContent = "Starting…";
    await scanner.start();
    starting = false;

    if (scanner.isRunning()) {
      cameraBtn.textContent = "Stop camera";
      showStatus(el("scanStatus"), "Camera running — point it at a barcode.", "info");
    } else {
      cameraBtn.textContent = "Use camera";
    }
  };
}

/* -------------------------------------------------------------- cart --- */

function totals() {
  const subtotal = round2(cart.reduce((sum, i) => sum + i.price * i.qty, 0));
  const itemCount = cart.reduce((n, i) => n + i.qty, 0);

  const discount =
    settings.discountMinItems > 0 && itemCount >= settings.discountMinItems
      ? round2(subtotal * settings.discountRate)
      : 0;

  const taxable = subtotal - discount;
  const tax = round2(taxable * settings.taxRate);
  const total = round2(taxable + tax);
  const tendered = Number(el("tendered").value) || total;
  const change = round2(tendered - total);

  return { subtotal, itemCount, discount, tax, total, tendered, change };
}

function addItemByProduct(product) {
  const existing = cart.find((i) => i.barcode === product.barcode);
  if (existing) {
    existing.qty += 1;
  } else {
    const line = {
      barcode: product.barcode,
      name: product.name,
      price: Number(product.price) || 0,
      qty: 1
    };

    // Snapshotted, like the price, so the profit on a sale is fixed by what the
    // item cost when it was rung up. Only written when the product actually has
    // a cost on file: a blank Original price means unknown, and recording 0
    // would read back as a genuine cost of nothing, inflating profit silently.
    if (costRecorded(product.cost)) line.cost = Number(product.cost) || 0;

    cart.push(line);
  }
  saveCart();
  renderCart();
}

/* ------------------------------------------------------- stock checks --- */

/**
 * Units on hand. Missing, non-numeric and negative counts all read as 0 — the
 * same rule the Stocks page uses for its "Out" badge, so a product that looks
 * unsellable there is unsellable here.
 */
function stockOf(product) {
  return Math.max(0, Number(product?.stock) || 0);
}

function qtyInCart(barcode) {
  return cart.find((i) => i.barcode === barcode)?.qty || 0;
}

/**
 * How many more units of `product` this sale may take. Stock is the ceiling and
 * whatever is already in the cart has spent part of it.
 */
function roomFor(product) {
  return stockOf(product) - qtyInCart(product.barcode);
}

/**
 * Why a unit could not be added. "Nothing on the shelf" and "everything on the
 * shelf is already in the sale" call for different actions, so they get
 * different sentences rather than one vague refusal.
 */
function refuseMessage(product) {
  const onHand = stockOf(product);

  if (onHand <= 0) {
    return `${product.name} is out of stock and cannot be sold. Restock it on the Stocks page.`;
  }
  return `Only ${onHand} of ${product.name} in stock, and all ${onHand} are already in this sale.`;
}

/**
 * Put one unit in the cart, or refuse and say why.
 *
 * Every route into the cart goes through here — a scan, the Add Item button, a
 * quick-item tile and the + stepper — because one unguarded route is a route
 * that oversells.
 */
function addOne(product, statusEl) {
  if (roomFor(product) <= 0) {
    showStatus(statusEl, refuseMessage(product), "error");
    return false;
  }

  addItemByProduct(product);
  showStatus(statusEl, `${product.name} added.`, "success");
  return true;
}

/**
 * The first cart line that cannot be sold as it stands, or null.
 *
 * The cart outlives the tab — it is restored from localStorage — and stock
 * moves while it sits there, so a line that was fine when it was scanned may
 * not be fine by the time the cashier rings it up. Checkout runs this against
 * the live product list rather than trusting what was true at scan time.
 */
function oversoldLine() {
  if (!productsLoaded) return null;

  for (const item of cart) {
    const product = products.find((p) => p.barcode === item.barcode);
    if (!product || item.qty > stockOf(product)) {
      return {
        item,
        onHand: product ? stockOf(product) : 0,
        stocked: Boolean(product)
      };
    }
  }
  return null;
}

function blockedMessage({ item, onHand, stocked }) {
  if (!stocked) {
    return `${item.name} is no longer in the stock list — remove it to continue.`;
  }
  if (onHand <= 0) {
    return `${item.name} is out of stock — remove it or restock it to continue.`;
  }
  return `${item.name}: only ${onHand} in stock but ${item.qty} in this sale — reduce it to continue.`;
}

async function addByBarcodeInput(presetCode) {
  // Only a string is a barcode. The Add Item handler used to be this function
  // itself, so the click event arrived here as `presetCode` and was looked up
  // as one - and because an event object is truthy, the input box was never
  // read. The handler now wraps the call; this check keeps a repeat of that
  // mistake from silently returning to the same bug.
  const preset = typeof presetCode === "string" ? presetCode.trim() : "";
  const code = preset || el("barcodeInput").value.trim();
  if (!code) {
    showStatus(el("scanStatus"), "Scan or type a barcode first.", "error");
    return;
  }

  // The live subscription usually already holds the product, so look there
  // first and spare the hot path a network round-trip — a busy till would
  // otherwise bill one read per scan. A miss falls back to a direct read, which
  // costs nothing on the common path and still covers two real cases: the
  // moment before the first snapshot arrives (the list is still empty), and a
  // product added on another device a beat ago, before its snapshot reaches
  // this one.
  let product = products.find((p) => p.barcode === code) || null;

  if (!product) {
    try {
      product = await getProduct(code);
    } catch (err) {
      showStatus(el("scanStatus"), describeFirestoreError(err), "error");
      return;
    }
  }

  if (!product) {
    showStatus(
      el("scanStatus"),
      `Barcode "${code}" is not a known product. Add it on the Stocks page first.`,
      "error"
    );
    return;
  }

  addOne(product, el("scanStatus"));

  // Cleared either way: the code has been dealt with, and a refused item left
  // sitting in the box only invites a second Enter that fails the same way.
  el("barcodeInput").value = "";
  el("barcodeInput").focus();
}

function changeQty(barcode, delta) {
  const item = cart.find((i) => i.barcode === barcode);
  if (!item) return;

  // The + button is already disabled once the line has taken everything on the
  // shelf, so this only catches the routes that do not render such a button.
  if (delta > 0) {
    const product = products.find((p) => p.barcode === barcode);
    if (!product) {
      showStatus(el("scanStatus"), `${item.name} is no longer in the stock list.`, "error");
      return;
    }
    if (roomFor(product) <= 0) {
      showStatus(el("scanStatus"), refuseMessage(product), "error");
      return;
    }
  }

  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter((i) => i.barcode !== barcode);
  saveCart();
  renderCart();
}

function removeLine(barcode) {
  cart = cart.filter((i) => i.barcode !== barcode);
  saveCart();
  renderCart();
}

/* ------------------------------------------------------------ render --- */

/** One cart row, flagged when the line cannot be sold as it stands. */
function renderLine(item) {
  const product = products.find((p) => p.barcode === item.barcode);
  const onHand = product ? stockOf(product) : 0;

  // Before the first snapshot there is nothing to compare against, so say
  // nothing rather than flash a warning that is not yet true.
  const gone = productsLoaded && !product;
  const out = productsLoaded && product && onHand <= 0;
  const short = productsLoaded && product && onHand > 0 && item.qty > onHand;
  const unsellable = gone || out || short;

  // The line has taken the whole shelf, so the + says so before it is tapped
  // rather than refusing afterwards.
  const full = productsLoaded && !unsellable && item.qty >= onHand;

  let note = "";
  if (gone) note = "No longer in the stock list";
  else if (out) note = "Out of stock";
  else if (short) note = `Only ${onHand} in stock`;

  return `
      <tr${unsellable ? ' class="unsellable"' : ""}>
        <td>
          <div class="item-name">${esc(item.name)}</div>
          <div class="item-sub">#${esc(item.barcode)}</div>
          ${note ? `<div class="item-warn">${esc(note)}</div>` : ""}
        </td>
        <td class="num" data-label="Price">${money(item.price)}</td>
        <td data-label="Qty">
          <div class="qty-box">
            <button type="button" data-action="decrease" data-barcode="${esc(item.barcode)}"
                    aria-label="Decrease quantity">&minus;</button>
            <span>${item.qty}</span>
            <button type="button" data-action="increase" data-barcode="${esc(item.barcode)}"
                    aria-label="Increase quantity"${full || unsellable ? " disabled" : ""}>+</button>
          </div>
        </td>
        <td class="num" data-label="Total">${money(item.price * item.qty)}</td>
        <td class="num">
          <button class="remove-btn" type="button" data-action="remove"
                  data-barcode="${esc(item.barcode)}">Remove</button>
        </td>
      </tr>`;
}

function renderCart() {
  const tbody = el("cartItems");

  tbody.innerHTML = cart.length
    ? cart.map(renderLine).join("")
    : `
      <tr><td colspan="5">
        <div class="empty-state">No items yet. Scan a barcode to begin.</div>
      </td></tr>`;

  renderSummary();
  // Tiles share the cart's ceiling, so they grey out as the sale fills up.
  renderQuickItems();
}

function renderSummary() {
  const t = totals();

  el("subtotalValue").textContent = money(t.subtotal);
  el("taxValue").textContent = `${money(t.tax)} (${(settings.taxRate * 100).toFixed(1)}%)`;
  el("discountValue").textContent = t.discount
    ? `${money(t.discount)} (${(settings.discountRate * 100).toFixed(0)}%)`
    : money(0);
  el("totalValue").textContent = money(t.total);
  el("itemCount").textContent = `${t.itemCount} item${t.itemCount === 1 ? "" : "s"}`;

  const change = el("changeValue");
  change.textContent = money(Math.max(t.change, 0));
  change.style.color = t.change < 0 ? "var(--danger)" : "var(--text)";

  // A disabled pay button with no reason next to it is a stuck till. On a phone
  // the collapsed summary bar is the only part of this card on screen, so the
  // explanation has to live there rather than only in the cart.
  const blocked = oversoldLine();
  const warn = el("summaryWarn");
  if (warn) {
    warn.hidden = !blocked;
    warn.textContent = blocked ? blockedMessage(blocked) : "";
  }

  el("payBtn").disabled = !cart.length || t.change < 0 || Boolean(blocked);
}

function renderQuickItems() {
  const container = el("quickItems");
  if (!container) return;

  // An empty grid beats a "no products yet" that flashes on every page load
  // before the first snapshot lands.
  if (!productsLoaded) {
    container.innerHTML = "";
    return;
  }

  // Prefer items that are actually in stock; fall back to the first few.
  const inStock = products.filter((p) => stockOf(p) > 0);
  const featured = (inStock.length ? inStock : products).slice(0, 8);

  if (!featured.length) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        No products yet.
        <a href="stocks.html" style="color:var(--primary);font-weight:600;">Add some</a>.
      </div>`;
    return;
  }

  container.innerHTML = featured
    .map(
      (p) => `
      <button type="button" class="quick-item${roomFor(p) <= 0 ? " out" : ""}"
              data-barcode="${esc(p.barcode)}">
        <h4>${esc(p.name)}</h4>
        <span>${money(p.price)}</span>
      </button>`
    )
    .join("");

  container.querySelectorAll(".quick-item").forEach((btn) => {
    btn.onclick = () => {
      const product = products.find((p) => p.barcode === btn.dataset.barcode);
      if (!product) return;
      addOne(product, el("scanStatus"));
    };
  });
}

/* ---------------------------------------------------------- checkout --- */

async function completeSale() {
  const t = totals();
  if (!cart.length) return;

  if (t.change < 0) {
    toast("Cash tendered is less than the total", "error");
    return;
  }

  // Last line of defence. Stock moves between the scan and the payment —
  // another till, or an edit on the Stocks page — and this is the only check
  // that runs against what is true right now rather than at scan time.
  const blocked = oversoldLine();
  if (blocked) {
    const reason = blockedMessage(blocked);
    collapseSummary(); // the sheet covers the cart on a phone
    showStatus(el("scanStatus"), reason, "error");
    toast(reason, "error");
    return;
  }

  const payBtn = el("payBtn");
  payBtn.disabled = true;
  payBtn.textContent = "Saving…";

  try {
    await recordSale(
      {
        items: cart.map((i) => {
          const line = {
            barcode: i.barcode,
            name: i.name,
            price: i.price,
            qty: i.qty
          };

          // A cart restored from localStorage may have been saved before costs
          // existed, so `i.cost` can be undefined. Firestore rejects a document
          // containing undefined outright, which would fail the whole sale at
          // the till. Writing 0 instead would be worse than failing: it reads
          // back as a real cost of nothing and inflates the profit figure
          // without raising the "no cost" warning. Omitting the key leaves the
          // line honestly costless, and the Sales page falls back to the
          // product's current cost for it.
          if (costRecorded(i.cost)) line.cost = Number(i.cost) || 0;

          return line;
        }),
        subtotal: t.subtotal,
        taxRate: settings.taxRate,
        tax: t.tax,
        discountRate: settings.discountRate,
        discount: t.discount,
        total: t.total,
        tendered: t.tendered,
        change: Math.max(t.change, 0),
        itemCount: t.itemCount
      },
      user
    );

    lastSale = { ...t, items: [...cart], at: new Date() };
    renderReceipt(lastSale);

    cart = [];
    saveCart();
    el("tendered").value = "";
    renderCart();
    collapseSummary();
    clearStatus(el("scanStatus"));
    toast(`Sale complete — change ${money(Math.max(t.change, 0))}`);
    el("barcodeInput").focus();
  } catch (err) {
    console.error(err);
    toast(describeFirestoreError(err), "error");
  } finally {
    payBtn.textContent = "Complete sale";
    renderSummary();
  }
}

function renderReceipt(sale) {
  const box = el("receipt");
  box.classList.add("show");
  box.innerHTML = `
    <div class="card">
      <div class="section-header" style="margin-top:0;">
        <div class="section-title">Sale recorded</div>
        <div style="color:var(--muted);font-size:0.9rem;">
          ${sale.at.toLocaleString()}
        </div>
      </div>
      <table>
        <tbody>
          ${sale.items
            .map(
              (i) => `<tr>
                <td>${esc(i.name)} <span class="item-sub">x${i.qty}</span></td>
                <td class="num">${money(i.price * i.qty)}</td>
              </tr>`
            )
            .join("")}
          <tr><td>Subtotal</td><td class="num">${money(sale.subtotal)}</td></tr>
          <tr><td>Tax</td><td class="num">${money(sale.tax)}</td></tr>
          ${sale.discount ? `<tr><td>Discount</td><td class="num">-${money(sale.discount)}</td></tr>` : ""}
          <tr><td><strong>Total</strong></td><td class="num"><strong>${money(sale.total)}</strong></td></tr>
          <tr><td>Tendered</td><td class="num">${money(sale.tendered)}</td></tr>
          <tr><td><strong>Change</strong></td><td class="num"><strong>${money(Math.max(sale.change, 0))}</strong></td></tr>
        </tbody>
      </table>
      <div class="row" style="margin-top:14px;">
        <button class="secondary-btn" type="button" onclick="window.print()">Print receipt</button>
        <button class="ghost-btn" type="button" id="closeReceiptBtn">Done</button>
      </div>
    </div>`;

  el("closeReceiptBtn").onclick = () => {
    box.classList.remove("show");
    box.innerHTML = "";
  };

  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* -------------------------------------------------------- persistence --- */

// A sale in progress survives an accidental refresh or a phone locking.
function saveCart() {
  try {
    localStorage.setItem(CART_KEY(), JSON.stringify(cart));
  } catch {
    // Private mode / quota — the cart just won't persist; not worth failing over.
  }
}

function loadCart() {
  try {
    cart = JSON.parse(localStorage.getItem(CART_KEY())) || [];
  } catch {
    cart = [];
  }
}

/* ------------------------------------------------------------- utils --- */

/**
 * Round a money amount to whole cents.
 *
 * Prices, a tax rate and a discount rate multiply out to values like
 * 10.908000000000001, and storing those as-is would put sub-cent noise into
 * every sale record — the Sales page then sums the noise into Gross and Net
 * profit, and the receipt total can disagree with the stored total in the last
 * place. Rounding each monetary result here keeps the till to real cents.
 * (Not a policy for the half-cent case — that is a far rarer question than the
 * representation error this fixes.)
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Local HTML escaper — deliberately not named `escape` so it does not shadow
 *  the deprecated global of the same name. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function describeFirestoreError(err) {
  const code = err?.code || "";
  if (code.includes("permission-denied")) {
    return "Permission denied. Check that the Firestore rules are published and you are signed in.";
  }
  if (code.includes("unavailable")) {
    return "Cannot reach Firestore — check your connection.";
  }
  if (code.includes("failed-precondition")) {
    return "Firestore needs an index for this query. Check the browser console for a creation link.";
  }
  return err?.message || "Something went wrong talking to the database.";
}
