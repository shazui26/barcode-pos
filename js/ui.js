/* ==========================================================================
   Presentation helpers shared by every page: currency formatting, toasts,
   the app shell (header + nav + sign-out), and the setup notice shown before
   Firebase has been configured.
   ========================================================================== */

import { isConfigured } from "./firebase.js";

let currentCurrency = "USD";

/** Set the currency used by every money() call (driven by Firestore settings). */
export function setCurrency(code) {
  if (code) currentCurrency = code;
}

/** Format a number as currency, e.g. money(12.5) -> "$12.50". */
export function money(value) {
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currentCurrency
    }).format(n);
  } catch {
    // Unknown currency code in settings — fall back rather than crash the page.
    return n.toFixed(2);
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

/* ------------------------------------------------------------ toast --- */

let toastTimer = null;

export function toast(message, type = "success") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.className = `toast ${type}`;
  el.textContent = message;
  // Force a reflow so the transition replays on rapid successive calls.
  void el.offsetWidth;
  el.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/** Show an inline status strip (the .search-result element on each page). */
export function showStatus(el, message, type = "info") {
  if (!el) return;
  el.textContent = message;
  el.className = `search-result visible ${type}`;
}

export function clearStatus(el) {
  if (!el) return;
  el.className = "search-result";
  el.textContent = "";
}

/* ------------------------------------------------------------ shell --- */

/* `icon` is a plain text glyph, shown only in the mobile bottom tab bar; the
   desktop nav hides it and is otherwise unchanged. */
const PAGES = [
  { href: "index.html", label: "Point of Sale", icon: "▣" },
  { href: "stocks.html", label: "Stocks", icon: "▤" },
  { href: "sales.html", label: "Sales", icon: "▦" }
];

/**
 * Fill in the app header: brand, nav tabs, signed-in user and sign-out button.
 * `active` is the href of the current page.
 */
export function renderShell({ active, user, settings, onSignOut }) {
  const brandName = document.getElementById("brandName");
  if (brandName) brandName.textContent = settings?.storeName || "POS Terminal";

  const nav = document.getElementById("nav");
  if (nav) {
    nav.innerHTML = PAGES.map(
      (p) =>
        `<a href="${p.href}"${p.href === active ? ' class="active"' : ""}>` +
        `<span class="nav-icon" aria-hidden="true">${p.icon}</span>` +
        `<span class="nav-label">${p.label}</span></a>`
    ).join("");
  }

  const status = document.getElementById("userStatus");
  if (status) {
    status.textContent = user?.email || "signed in";
    status.title = user?.email || "";
  }

  const signOutBtn = document.getElementById("signOutBtn");
  if (signOutBtn) signOutBtn.onclick = onSignOut;
}

/* ---------------------------------------------------- setup notice --- */

/**
 * Replace a page's contents with setup instructions. Used when
 * js/firebase-config.js still holds the PASTE_ placeholders, which is a much
 * friendlier failure than a blank screen and a console error.
 */
export function renderSetupNotice(root) {
  if (!root) return;
  document.body.innerHTML = `
    <div class="center-note">
      <div class="setup-card">
        <h1>Finish connecting Firebase</h1>
        <p>This app is deployed, but it does not know which Firebase project to
           use yet. Three short steps and it will come to life.</p>
        <ol>
          <li>In the <strong>Firebase console</strong>, create a project (or open
              an existing one).</li>
          <li>Add a <strong>Web app</strong> to it, then copy the
              <code>firebaseConfig</code> object from
              "SDK setup and configuration".</li>
          <li>Paste those values into <code>js/firebase-config.js</code>,
              replacing every <code>PASTE_...</code> placeholder, and redeploy.</li>
        </ol>
        <p>Also remember to enable <strong>Email/Password</strong> sign-in and
           add at least one user under <em>Authentication &rarr; Users</em>.</p>
        <pre>// js/firebase-config.js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};</pre>
      </div>
    </div>`;
}

/** True once config is present; pages use this to bail out early. */
export function configReady() {
  return isConfigured;
}
