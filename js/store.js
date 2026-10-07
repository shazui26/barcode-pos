/* ==========================================================================
   Data layer — every Firestore read/write in the app goes through here, so
   the POS and the stock list stay consistent and there is one place to change
   the schema.

   Schema
   ------
   products/{barcode}          doc id IS the barcode, so scanning is a direct
                               document read (no query) and duplicate barcodes
                               are impossible by construction.
     { barcode, name, price, cost, stock, updatedAt, updatedBy }

                               `price` is what the customer pays, `cost` is what
                               the shop paid. An absent `cost` means the cost is
                               *unknown*, which is not the same as 0 — see
                               costRecorded() below. (An absent `stock` does mean
                               0, because "we have none" is the safe reading.)

   sales/{autoId}              append-only ledger (never updated or deleted)
     { items: [{barcode, name, price, cost, qty}], subtotal, taxRate, tax,
       discount, total, tendered, change, itemCount, cashierUid,
       cashierEmail, createdAt }

                               Each line carries the `cost` as it stood when the
                               sale was rung up, not a pointer to the product, so
                               changing a product's cost later cannot rewrite the
                               profit of sales already made. Lines written before
                               that field existed have no `cost`; the Sales page
                               falls back to the product's current one.

   settings/config             single document of store-wide settings
     { storeName, currency, taxRate, discountMinItems, discountRate }
   ========================================================================== */

import { db } from "./firebase.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

export const DEFAULT_SETTINGS = {
  storeName: "POS Terminal",
  currency: "USD",
  taxRate: 0.08,
  discountMinItems: 3,
  discountRate: 0.05
};

/* --------------------------------------------------------- products --- */

/**
 * Whether a cost price has actually been recorded.
 *
 * An absent cost is *unknown*, not zero, and keeping those apart is what makes
 * the profit figure honest. A missing cost treated as 0 would report the entire
 * selling price as profit and would never raise the warning the profit tile
 * shows for lines it could not cost.
 *
 * `undefined`, `null` and `""` all mean the same thing: nobody typed an
 * original price in. A real 0 — a giveaway, a donation — is a recorded cost of
 * zero, and is treated as known.
 */
export function costRecorded(cost) {
  return cost !== undefined && cost !== null && cost !== "";
}

/** Live-updating list of products, sorted by name. Returns an unsubscribe fn. */
export function subscribeProducts(onChange, onError) {
  const q = query(collection(db, "products"), orderBy("name"));
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

/** Look up a single product by its barcode. Returns null when not stocked. */
export async function getProduct(barcode) {
  const snap = await getDoc(doc(db, "products", String(barcode).trim()));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Create or overwrite a product, keyed by barcode. */
export async function upsertProduct({ barcode, name, price, cost, stock }, user) {
  const id = String(barcode).trim();

  const record = {
    barcode: id,
    name: String(name).trim(),
    price: Number(price) || 0,
    stock: Number(stock) || 0,
    updatedAt: serverTimestamp(),
    updatedBy: user?.email || "unknown"
  };

  // Only written when a cost was actually entered. This is a non-merge setDoc,
  // so leaving the key out also clears a cost that used to be on file - and a
  // blank Original price means exactly that, the cost is unknown. Writing 0
  // instead would read back as a *recorded* cost of nothing (see
  // costRecorded), which reports the whole selling price as profit and never
  // raises the "no cost" warning that figure depends on.
  if (costRecorded(cost)) record.cost = Number(cost) || 0;

  await setDoc(doc(db, "products", id), record);
  return id;
}

export async function deleteProduct(barcode) {
  await deleteDoc(doc(db, "products", String(barcode).trim()));
}

/* --------------------------------------------------------- settings --- */

/** Live-updating settings document, falling back to defaults when unset. */
export function subscribeSettings(onChange, onError) {
  return onSnapshot(
    doc(db, "settings", "config"),
    (snap) => onChange({ ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}) }),
    onError
  );
}

export async function saveSettings(settings) {
  const { storeName, currency, taxRate, discountMinItems, discountRate } = settings;
  await setDoc(
    doc(db, "settings", "config"),
    {
      storeName,
      currency,
      taxRate: Number(taxRate) || 0,
      discountMinItems: Number(discountMinItems) || 0,
      discountRate: Number(discountRate) || 0,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

/* ------------------------------------------------------------ sales --- */

/**
 * Commit a sale: append the sale record AND decrement stock for every line
 * item, so a sale can never be recorded without its stock movement.
 *
 * A transaction rather than a batch, because a batch is only all-or-nothing -
 * it re-checks nothing. Two tills ringing the last unit at the same moment
 * would each have passed the POS's own stock check and both decremented,
 * leaving the shelf at -1. Reading every product inside the transaction makes
 * the check part of the write: the second till's read sees the first till's
 * committed decrement and is refused instead of overselling.
 *
 * All reads are gathered before any write is issued, which the SDK requires.
 * A product that no longer exists is skipped rather than created - `set` with
 * a merge would otherwise leave a nameless ghost product with negative stock
 * for the Stocks page to list.
 */
export async function recordSale(sale, user) {
  const lines = sale.items.map((item) => ({
    ...item,
    ref: doc(db, "products", String(item.barcode))
  }));

  await runTransaction(db, async (tx) => {
    const snaps = [];
    for (const line of lines) snaps.push(await tx.get(line.ref));

    lines.forEach((line, i) => {
      if (!snaps[i].exists()) return;

      const onHand = Number(snaps[i].data().stock) || 0;
      if (onHand < line.qty) {
        throw new Error(
          `${line.name}: only ${onHand} in stock but ${line.qty} in this sale — reduce it to continue.`
        );
      }

      tx.update(line.ref, { stock: increment(-line.qty) });
    });

    tx.set(doc(collection(db, "sales")), {
      items: sale.items,
      subtotal: sale.subtotal,
      taxRate: sale.taxRate,
      tax: sale.tax,
      discountRate: sale.discountRate,
      discount: sale.discount,
      total: sale.total,
      tendered: sale.tendered,
      change: sale.change,
      itemCount: sale.itemCount,
      cashierUid: user?.uid || null,
      cashierEmail: user?.email || "unknown",
      createdAt: serverTimestamp()
    });
  });
}

/** Most recent sales, newest first. */
export async function fetchRecentSales(max = 100) {
  const q = query(collection(db, "sales"), orderBy("createdAt", "desc"), limit(max));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
