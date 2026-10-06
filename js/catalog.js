/* ==========================================================================
   Catalog screen — add, edit and delete products, plus store settings.

   Products are keyed by barcode in Firestore, so saving an existing barcode
   updates that product rather than creating a duplicate.
   ========================================================================== */

import { mountAuth, signOutUser } from "./auth.js";
import {
  createScanner,
  cameraPermissionState,
  CAMERA_BLOCKED_HELP
} from "./scanner.js";
import {
  deleteProduct,
  saveSettings,
  subscribeProducts,
  subscribeSettings,
  upsertProduct
} from "./store.js";
import { money, renderShell, setCurrency, showStatus, toast } from "./ui.js";

const el = (id) => document.getElementById(id);

const LOW_STOCK = 5;

let user = null;
let products = [];
let settings = {};
let settingsLoaded = false;
let editingBarcode = null;

/* ---------------------------------------------------------- lifecycle --- */

mountAuth({
  appEl: el("app"),
  gateEl: el("gate"),
  onReady: (signedInUser) => {
    user = signedInUser;

    subscribeSettings(
      (s) => {
        settings = s;
        setCurrency(s.currency);
        renderShell({
          active: "catalog.html",
          user,
          settings,
          onSignOut: async () => {
            await signOutUser();
            toast("Signed out", "info");
          }
        });
        // Populate the form only once, so a live update cannot clobber
        // whatever the user is currently typing.
        if (!settingsLoaded) {
          fillSettingsForm(s);
          settingsLoaded = true;
        }
        renderRows();
      },
      (err) => console.error("settings", err)
    );

    subscribeProducts(
      (list) => {
        products = list;
        renderRows();
      },
      (err) => showStatus(el("scanStatus"), describeFirestoreError(err), "error")
    );

    wireEvents();
    el("barcode").focus();
  }
});

/* ------------------------------------------------------------- events --- */

function wireEvents() {
  el("saveBtn").onclick = saveProduct;
  el("resetBtn").onclick = resetForm;
  el("saveSettingsBtn").onclick = persistSettings;
  el("exportBtn").onclick = exportCsv;
  el("filter").addEventListener("input", renderRows);

  // Enter moves through the form instead of submitting it.
  el("barcode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); el("name").focus(); }
  });
  el("name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); el("price").focus(); }
  });
  el("price").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); el("stock").focus(); }
  });
  el("stock").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveProduct(); }
  });

  el("rows").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const { action, barcode } = btn.dataset;
    if (action === "edit") startEdit(barcode);
    if (action === "delete") removeProduct(barcode);
  });

  wireCamera();
}

function wireCamera() {
  const cameraBtn = el("cameraBtn");
  let starting = false;

  const scanner = createScanner({
    elementId: "reader",
    onScan: (code) => {
      el("barcode").value = code;
      // A freshly scanned barcode is usually a new product, so jump to the
      // name field — but prefill from the catalog if we already stock it.
      const existing = products.find((p) => p.barcode === code);
      if (existing) {
        startEdit(code);
        showStatus(el("scanStatus"), `${existing.name} loaded for editing.`, "info");
      } else {
        el("name").focus();
        showStatus(el("scanStatus"), `Scanned ${code} — enter the details.`, "info");
      }
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

/* ------------------------------------------------------------- save ----- */

async function saveProduct() {
  const barcode = el("barcode").value.trim();
  const name = el("name").value.trim();
  const price = Number(el("price").value) || 0;
  const stock = Number(el("stock").value) || 0;

  if (!barcode) {
    showStatus(el("scanStatus"), "A barcode is required — scan one or type it.", "error");
    el("barcode").focus();
    return;
  }
  if (!name) {
    showStatus(el("scanStatus"), "A product name is required.", "error");
    el("name").focus();
    return;
  }

  const btn = el("saveBtn");
  btn.disabled = true;
  try {
    await upsertProduct({ barcode, name, price, stock }, user);
    toast(editingBarcode ? "Product updated" : "Product saved");
    resetForm();
  } catch (err) {
    console.error(err);
    showStatus(el("scanStatus"), describeFirestoreError(err), "error");
  } finally {
    btn.disabled = false;
  }
}

function startEdit(barcode) {
  const product = products.find((p) => p.barcode === barcode);
  if (!product) return;

  editingBarcode = barcode;
  el("barcode").value = product.barcode;
  el("barcode").readOnly = true;
  el("name").value = product.name || "";
  el("price").value = product.price ?? "";
  el("stock").value = product.stock ?? 0;
  el("formTitle").textContent = `Editing “${product.name}”`;
  el("saveBtn").textContent = "Update product";
  el("name").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  editingBarcode = null;
  el("barcode").value = "";
  el("barcode").readOnly = false;
  el("name").value = "";
  el("price").value = "";
  el("stock").value = "";
  el("formTitle").textContent = "Add a product";
  el("saveBtn").textContent = "Save product";
  el("scanStatus").className = "search-result";
  el("barcode").focus();
}

async function removeProduct(barcode) {
  const product = products.find((p) => p.barcode === barcode);
  if (!confirm(`Delete “${product?.name || barcode}” from the catalog?`)) return;

  try {
    await deleteProduct(barcode);
    if (editingBarcode === barcode) resetForm();
    toast("Product deleted");
  } catch (err) {
    console.error(err);
    showStatus(el("scanStatus"), describeFirestoreError(err), "error");
  }
}

/* ------------------------------------------------------------ render --- */

function renderRows() {
  const tbody = el("rows");
  if (!tbody) return;

  const filter = el("filter").value.trim().toLowerCase();
  const visible = filter
    ? products.filter(
        (p) =>
          String(p.name || "").toLowerCase().includes(filter) ||
          String(p.barcode || "").toLowerCase().includes(filter)
      )
    : products;

  el("count").textContent = products.length;

  if (!visible.length) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="empty-state">
          ${products.length ? "No products match that filter." : "No products yet. Add your first one above."}
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = visible
    .map((p) => {
      const stock = Number(p.stock) || 0;
      const level = stock <= 0 ? "out" : stock <= LOW_STOCK ? "low" : "ok";
      const label = stock <= 0 ? "Out" : stock <= LOW_STOCK ? `Low · ${stock}` : stock;

      return `
        <tr>
          <td><div class="item-name">${esc(p.name)}</div></td>
          <td><span class="item-sub">${esc(p.barcode)}</span></td>
          <td class="num">${money(p.price)}</td>
          <td class="num"><span class="badge ${level}">${esc(label)}</span></td>
          <td class="num" style="white-space:nowrap;">
            <button class="secondary-btn" type="button" data-action="edit"
                    data-barcode="${esc(p.barcode)}"
                    style="height:34px;padding:0 12px;font-size:0.85rem;">Edit</button>
            <button class="remove-btn" type="button" data-action="delete"
                    data-barcode="${esc(p.barcode)}"
                    style="margin-left:10px;">Delete</button>
          </td>
        </tr>`;
    })
    .join("");
}

/* ---------------------------------------------------------- settings --- */

function fillSettingsForm(s) {
  el("storeName").value = s.storeName || "";
  el("currency").value = s.currency || "USD";
  el("taxRate").value = ((s.taxRate ?? 0) * 100).toFixed(2).replace(/\.00$/, "");
  el("discountMinItems").value = s.discountMinItems ?? 0;
  el("discountRate").value = ((s.discountRate ?? 0) * 100).toFixed(2).replace(/\.00$/, "");
}

async function persistSettings() {
  const btn = el("saveSettingsBtn");
  btn.disabled = true;
  try {
    await saveSettings({
      storeName: el("storeName").value.trim() || "POS Terminal",
      currency: el("currency").value,
      // Stored as a fraction (0.08); shown to the user as a percentage (8).
      taxRate: (Number(el("taxRate").value) || 0) / 100,
      discountMinItems: Number(el("discountMinItems").value) || 0,
      discountRate: (Number(el("discountRate").value) || 0) / 100
    });
    toast("Settings saved");
  } catch (err) {
    console.error(err);
    toast(describeFirestoreError(err), "error");
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ export --- */

function exportCsv() {
  if (!products.length) {
    toast("Nothing to export", "info");
    return;
  }

  const header = ["Barcode", "Name", "Price", "Stock", "Stock Value"];
  const rows = products.map((p) => [
    p.barcode,
    p.name,
    Number(p.price || 0).toFixed(2),
    Number(p.stock || 0),
    (Number(p.price || 0) * Number(p.stock || 0)).toFixed(2)
  ]);

  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `catalog-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV exported");
}

/* ------------------------------------------------------------- utils --- */

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
