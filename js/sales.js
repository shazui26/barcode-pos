/* ==========================================================================
   Sales history.

   Reads the append-only `sales` collection and summarises it. The summary is
   deliberately a row of stat tiles rather than a chart: each figure answers a
   single "how much?" question, which is a headline number, not a series.
   The table below doubles as the accessible, exact-value view.
   ========================================================================== */

import { mountAuth, signOutUser } from "./auth.js";
import { fetchRecentSales, subscribeSettings } from "./store.js";
import { money, renderShell, setCurrency, showStatus, toast } from "./ui.js";

const el = (id) => document.getElementById(id);

const MAX_SALES = 300;

let user = null;
let allSales = [];
let expanded = new Set();

/* ---------------------------------------------------------- lifecycle --- */

mountAuth({
  appEl: el("app"),
  gateEl: el("gate"),
  onReady: async (signedInUser) => {
    user = signedInUser;

    subscribeSettings(
      (s) => {
        setCurrency(s.currency);
        renderShell({
          active: "sales.html",
          user,
          settings: s,
          onSignOut: async () => {
            await signOutUser();
            toast("Signed out", "info");
          }
        });
        render();
      },
      (err) => console.error("settings", err)
    );

    el("refreshBtn").onclick = load;
    el("range").addEventListener("change", render);

    el("rows").addEventListener("click", (event) => {
      const row = event.target.closest("tr.sale-row");
      if (!row) return;
      const id = row.dataset.id;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
    });

    await load();
  }
});

/* -------------------------------------------------------------- load --- */

async function load() {
  const btn = el("refreshBtn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    allSales = await fetchRecentSales(MAX_SALES);
  } catch (err) {
    console.error(err);
    toast(describeFirestoreError(err), "error");
    allSales = [];
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
    render();
  }
}

function inRange(sale) {
  const range = el("range").value;
  if (range === "all") return true;

  const at = toDate(sale.createdAt);
  if (!at) return false;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (range === "today") return at >= start;

  const days = Number(range);
  const cutoff = new Date(start);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return at >= cutoff;
}

/* ------------------------------------------------------------ render --- */

function render() {
  const sales = allSales.filter(inRange);

  const gross = sales.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
  const tax = sales.reduce((sum, s) => sum + (Number(s.tax) || 0), 0);
  const items = sales.reduce((sum, s) => sum + (Number(s.itemCount) || 0), 0);
  const average = sales.length ? gross / sales.length : 0;

  el("kpis").innerHTML = `
    ${tile("Sales", String(sales.length), `of ${allSales.length} loaded`)}
    ${tile("Gross", money(gross), tax ? `incl. ${money(tax)} tax` : "&nbsp;")}
    ${tile("Items sold", String(items), "&nbsp;")}
    ${tile("Average sale", money(average), "&nbsp;")}`;

  const tbody = el("rows");
  if (!sales.length) {
    tbody.innerHTML = `
      <tr><td colspan="6">
        <div class="empty-state">
          ${allSales.length ? "No sales in this period." : "No sales recorded yet."}
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = sales
    .map((sale) => {
      const at = toDate(sale.createdAt);
      const when = at ? at.toLocaleString() : "—";
      const open = expanded.has(sale.id);

      const main = `
        <tr class="sale-row" data-id="${esc(sale.id)}">
          <td>${esc(when)}</td>
          <td><span class="item-sub">${esc(sale.cashierEmail || "—")}</span></td>
          <td class="num">${Number(sale.itemCount) || 0}</td>
          <td class="num">${money(sale.subtotal)}</td>
          <td class="num">${money(sale.tax)}</td>
          <td class="num"><strong>${money(sale.total)}</strong></td>
        </tr>`;

      if (!open) return main;

      const lines = (sale.items || [])
        .map(
          (i) => `<tr>
            <td colspan="4">${esc(i.name)}</td>
            <td class="num">${i.qty} &times; ${money(i.price)}</td>
            <td class="num">${money((Number(i.price) || 0) * (Number(i.qty) || 0))}</td>
          </tr>`
        )
        .join("");

      return (
        main +
        `<tr class="detail-row"><td colspan="6"><div class="detail-inner">
           <table>
             ${lines || '<tr><td colspan="6">No line items stored on this sale.</td></tr>'}
             ${sale.discount ? `<tr><td colspan="4">Discount</td><td class="num">-${money(sale.discount)}</td><td></td></tr>` : ""}
             <tr>
               <td colspan="4">Tendered / change</td>
               <td class="num">${money(sale.tendered)}</td>
               <td class="num">${money(sale.change)}</td>
             </tr>
           </table>
         </div></td></tr>`
      );
    })
    .join("");
}

function tile(label, value, sub) {
  return `
    <div class="stat-tile">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="sub">${sub}</div>
    </div>`;
}

/* ------------------------------------------------------------- utils --- */

/** Firestore returns `createdAt` as a Timestamp; normalise it to a Date. */
function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

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
