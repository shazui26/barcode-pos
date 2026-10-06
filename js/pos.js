/* ==========================================================================
   Point of Sale screen.

   Scanning (camera or a USB keyboard-wedge scanner, which types the code and
   presses Enter) looks the barcode up in Firestore and drops it in the cart.
   Completing a sale writes the sale record and decrements stock atomically.
   ========================================================================== */

import { mountAuth, signOutUser } from "./auth.js";
import {
  createScanner,
  cameraPermissionState,
  CAMERA_BLOCKED_HELP
} from "./scanner.js";
import {
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
        renderQuickItems();
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

  el("addItemBtn").onclick = addByBarcodeInput;

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
  const subtotal = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
  const itemCount = cart.reduce((n, i) => n + i.qty, 0);

  const discount =
    settings.discountMinItems > 0 && itemCount >= settings.discountMinItems
      ? subtotal * settings.discountRate
      : 0;

  const taxable = subtotal - discount;
  const tax = taxable * settings.taxRate;
  const total = taxable + tax;
  const tendered = Number(el("tendered").value) || total;
  const change = tendered - total;

  return { subtotal, itemCount, discount, tax, total, tendered, change };
}

function addItemByProduct(product) {
  const existing = cart.find((i) => i.barcode === product.barcode);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({
      barcode: product.barcode,
      name: product.name,
      price: Number(product.price) || 0,
      qty: 1
    });
  }
  saveCart();
  renderCart();
}

async function addByBarcodeInput(presetCode) {
  const code = String(presetCode ?? el("barcodeInput").value).trim();
  if (!code) {
    showStatus(el("scanStatus"), "Scan or type a barcode first.", "error");
    return;
  }

  let product;
  try {
    product = await getProduct(code);
  } catch (err) {
    showStatus(el("scanStatus"), describeFirestoreError(err), "error");
    return;
  }

  if (!product) {
    showStatus(
      el("scanStatus"),
      `Barcode "${code}" is not in the catalog. Add it on the Catalog page first.`,
      "error"
    );
    return;
  }

  addItemByProduct(product);
  el("barcodeInput").value = "";
  el("barcodeInput").focus();

  const remaining = (Number(product.stock) || 0) - qtyInCart(product.barcode);
  if (remaining < 0) {
    showStatus(
      el("scanStatus"),
      `${product.name} added — but stock says ${product.stock ?? 0}, so this oversells.`,
      "error"
    );
  } else {
    showStatus(el("scanStatus"), `${product.name} added.`, "success");
  }
}

function qtyInCart(barcode) {
  return cart.find((i) => i.barcode === barcode)?.qty || 0;
}

function changeQty(barcode, delta) {
  const item = cart.find((i) => i.barcode === barcode);
  if (!item) return;
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

function renderCart() {
  const tbody = el("cartItems");

  if (!cart.length) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="empty-state">No items yet. Scan a barcode to begin.</div>
      </td></tr>`;
    renderSummary();
    return;
  }

  tbody.innerHTML = cart
    .map(
      (item) => `
      <tr>
        <td>
          <div class="item-name">${esc(item.name)}</div>
          <div class="item-sub">#${esc(item.barcode)}</div>
        </td>
        <td class="num">${money(item.price)}</td>
        <td>
          <div class="qty-box">
            <button type="button" data-action="decrease" data-barcode="${esc(item.barcode)}"
                    aria-label="Decrease quantity">&minus;</button>
            <span>${item.qty}</span>
            <button type="button" data-action="increase" data-barcode="${esc(item.barcode)}"
                    aria-label="Increase quantity">+</button>
          </div>
        </td>
        <td class="num">${money(item.price * item.qty)}</td>
        <td class="num">
          <button class="remove-btn" type="button" data-action="remove"
                  data-barcode="${esc(item.barcode)}">Remove</button>
        </td>
      </tr>`
    )
    .join("");

  renderSummary();
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

  el("payBtn").disabled = !cart.length || t.change < 0;
}

function renderQuickItems() {
  const container = el("quickItems");
  if (!container) return;

  // Prefer items that are actually in stock; fall back to the first few.
  const inStock = products.filter((p) => (Number(p.stock) || 0) > 0);
  const featured = (inStock.length ? inStock : products).slice(0, 8);

  if (!featured.length) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        No products in the catalog yet.
        <a href="catalog.html" style="color:var(--primary);font-weight:600;">Add some</a>.
      </div>`;
    return;
  }

  container.innerHTML = featured
    .map(
      (p) => `
      <button type="button" class="quick-item" data-barcode="${esc(p.barcode)}">
        <h4>${esc(p.name)}</h4>
        <span>${money(p.price)}</span>
      </button>`
    )
    .join("");

  container.querySelectorAll(".quick-item").forEach((btn) => {
    btn.onclick = async () => {
      const product = products.find((p) => p.barcode === btn.dataset.barcode);
      if (!product) return;
      addItemByProduct(product);
      showStatus(el("scanStatus"), `${product.name} added.`, "success");
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

  const payBtn = el("payBtn");
  payBtn.disabled = true;
  payBtn.textContent = "Saving…";

  try {
    await recordSale(
      {
        items: cart.map((i) => ({
          barcode: i.barcode,
          name: i.name,
          price: i.price,
          qty: i.qty
        })),
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
  box.style.display = "block";
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
    box.style.display = "none";
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
