/* ==========================================================================
   Sales history.

   Reads the append-only `sales` collection and summarises it. The summary is
   deliberately a row of stat tiles rather than a chart: each figure answers a
   single "how much?" question, which is a headline number, not a series.
   The table below doubles as the accessible, exact-value view.
   ========================================================================== */

import { mountAuth, signOutUser } from "./auth.js";
import {
  costRecorded,
  fetchRecentSales,
  subscribeProducts,
  subscribeSettings
} from "./store.js";import { money, renderShell, setCurrency, showStatus, toast } from "./ui.js";

const el = (id) => document.getElementById(id);

const MAX_SALES = 300;

let user = null;
let allSales = [];
let products = [];
let expanded = new Set();

/* False until the product list arrives. Profit needs each product's cost, and
   sales recorded before costs existed carry none of their own, so they borrow
   the live one. Before that list lands every such line would read as cost 0,
   which does not merely leave the figure blank - it reports the whole sale as
   pure profit and raises an alarm about missing costs. The card waits instead. */
let productsLoaded = false;

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

    subscribeProducts(
      (list) => {
        products = list;
        productsLoaded = true;
        // The profit tile reads from this list, so it has to follow it.
        render();
      },
      (err) => console.error("products", err)
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

  el("insights").innerHTML = renderInsights(sales);

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

/* ---------------------------------------------------------- insights --- */

/**
 * Product-level figures for the sales in the period.
 *
 * Three of these are "which product?" rather than "how much?", so the sort
 * order has to be total: sales arrive newest-first and two products sitting on
 * the same unit count would otherwise swap places between one render and the
 * next. Name is the final tie-break precisely because it never changes.
 *
 * Zero-sellers are left out of the slow-moving figure on purpose. A product
 * that sold nothing this week may be brand new rather than unpopular, and the
 * tile would name whichever of them happened to sort first.
 */
function analyse(sales) {
  const perProduct = new Map();

  // Only products with a cost actually on file. A product whose Original price
  // is blank must not enter this map with an implied 0 — that would mark its
  // lines as costed and report their whole selling price as profit, which is
  // the one outcome the coverage warning exists to prevent.
  const currentCost = new Map(
    products
      .filter((p) => costRecorded(p.cost))
      .map((p) => [p.barcode, Number(p.cost) || 0])
  );

  let netRevenue = 0;
  let cogs = 0;
  let costedLines = 0;
  let totalLines = 0;

  for (const sale of sales) {
    // Tax is excluded: it is collected on the tax authority's behalf, so
    // counting it would overstate profit by the tax rate on every sale.
    netRevenue += (Number(sale.subtotal) || 0) - (Number(sale.discount) || 0);

    for (const line of sale.items || []) {
      const qty = Number(line.qty) || 0;
      const price = Number(line.price) || 0;

      const entry = perProduct.get(line.barcode) || { name: line.name, units: 0, revenue: 0 };
      entry.units += qty;
      entry.revenue += price * qty;
      if (line.name) entry.name = line.name;
      perProduct.set(line.barcode, entry);

      // A line records the cost it was sold at. Only lines written before that
      // field existed fall back to the product's cost today - and if the
      // product has since been deleted, or its cost was never filled in, there
      // is nothing left to fall back to.
      const fromLine = costRecorded(line.cost);
      const fromProduct = !fromLine && currentCost.has(line.barcode);
      const cost = fromLine ? Number(line.cost) || 0 : currentCost.get(line.barcode) ?? 0;

      totalLines += 1;
      if (fromLine || fromProduct) costedLines += 1;

      cogs += cost * qty;
    }
  }

  const ranked = [...perProduct.values()].filter((e) => e.units > 0);
  const by = (fn, dir) => (a, b) =>
    dir * fn(b) - dir * fn(a) || a.name.localeCompare(b.name);

  return {
    best: [...ranked].sort(by((e) => e.revenue, 1))[0] || null,
    fast: [...ranked].sort(by((e) => e.units, 1))[0] || null,
    slow: [...ranked].sort(by((e) => e.units, -1))[0] || null,
    profit: netRevenue - cogs,
    costedLines,
    totalLines
  };
}

function renderInsights(sales) {
  const a = analyse(sales);

  if (!a.best) {
    const why = sales.length ? "No line items stored" : "No sales in this period";
    return (
      tile("Most selling", "—", why) +
      tile("Fast moving", "—", why) +
      tile("Slow moving", "—", why) +
      profitTile(a)
    );
  }

  return (
    tile("Most selling", esc(a.best.name), `${money(a.best.revenue)} revenue`) +
    tile("Fast moving", esc(a.fast.name), `${a.fast.units} units sold`) +
    tile("Slow moving", esc(a.slow.name), `${a.slow.units} units sold`) +
    profitTile(a)
  );
}

function profitTile(a) {
  if (!productsLoaded) {
    return tile("Net profit", "—", "Loading costs…");
  }
  if (!a.totalLines) {
    return tile("Net profit", money(0), "No line items stored");
  }

  // Lines with no cost anywhere are counted as costing nothing, which flatters
  // the total. Say so rather than reporting a number the data cannot support.
  const missing = a.totalLines - a.costedLines;
  const note = missing
    ? `${missing} of ${a.totalLines} lines have no cost — profit is overstated`
    : `all ${a.totalLines} line items costed`;

  return tile("Net profit", money(a.profit), note, "", missing ? "caution" : "");
}

function tile(label, value, sub, valueClass = "", subClass = "") {
  return `
    <div class="stat-tile">
      <div class="label">${label}</div>
      <div class="value${valueClass ? ` ${valueClass}` : ""}">${value}</div>
      <div class="sub${subClass ? ` ${subClass}` : ""}">${sub}</div>
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
