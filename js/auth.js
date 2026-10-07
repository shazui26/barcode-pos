/* ==========================================================================
   Authentication gate.

   Email + password sign-in ONLY. There is deliberately no sign-up form:
   this app is served from a public GitHub Pages URL, so if anyone could
   create an account, anyone could write to your database. Accounts are
   created by hand in the Firebase console
   (Authentication -> Users -> Add user).

   The Firestore rules then simply require `request.auth != null`, which is
   safe precisely because account creation is not self-service.
   ========================================================================== */

import { auth, isConfigured } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { escapeHtml, renderSetupNotice, toast } from "./ui.js";

/** How long to wait for the auth backend before telling the user something. */
const AUTH_TIMEOUT_MS = 10000;

/**
 * Watch auth state and gate the page on it.
 *   - Not configured -> renders setup instructions.
 *   - Signed out    -> renders the login form.
 *   - Signed in     -> reveals #app and calls onReady(user).
 *
 * The gate is shown with a placeholder *before* the first callback fires. The
 * SDK gives no guarantee about when (or whether) that callback arrives — a
 * blocked network or a wrong project id can stall it indefinitely — and
 * without this the page would just be blank.
 */
export function mountAuth({ appEl, gateEl, onReady }) {
  if (!isConfigured) {
    renderSetupNotice(document.body);
    return;
  }

  appEl.hidden = true;
  renderGateMessage(gateEl, "Checking sign-in…");

  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    renderGateError(
      gateEl,
      "Still waiting for the sign-in service. This usually means the device is " +
        "offline, the network is blocking Firebase, or the values in " +
        "js/firebase-config.js do not match a real project."
    );
  }, AUTH_TIMEOUT_MS);

  const finish = () => {
    settled = true;
    clearTimeout(timer);
  };

  onAuthStateChanged(
    auth,
    (user) => {
      finish();
      if (user) {
        gateEl.hidden = true;
        gateEl.innerHTML = "";
        appEl.hidden = false;
        onReady(user);
      } else {
        appEl.hidden = true;
        renderLoginForm(gateEl);
      }
    },
    (err) => {
      finish();
      renderGateError(
        gateEl,
        `Could not reach the sign-in service. ${err?.message || ""}`
      );
    }
  );
}

/** A quiet placeholder card shown while we wait for the first auth callback. */
function renderGateMessage(gateEl, message) {
  gateEl.hidden = false;
  gateEl.className = "login-screen";
  gateEl.innerHTML = `
    <div class="login-card">
      <div class="brand">
        <div class="brand-badge">&#9635;</div>
        <div>POS Terminal</div>
      </div>
      <p class="sub" style="margin-top:18px;">${message}</p>
    </div>`;
}

/** Terminal auth failure, with a way out for the user. */
function renderGateError(gateEl, message) {
  gateEl.hidden = false;
  gateEl.className = "login-screen";
  gateEl.innerHTML = `
    <div class="login-card">
      <div class="brand">
        <div class="brand-badge">&#9635;</div>
        <div>POS Terminal</div>
      </div>
      <h1>Cannot sign in</h1>
      <div class="search-result visible error" style="text-align:left;">${escapeHtml(message)}</div>
      <button class="primary-btn" type="button" id="retryBtn"
              style="width:100%;margin-top:16px;">Try again</button>
    </div>`;

  gateEl.querySelector("#retryBtn").onclick = () => location.reload();
}

function renderLoginForm(gateEl) {
  gateEl.hidden = false;
  gateEl.className = "login-screen";
  gateEl.innerHTML = `
    <form class="login-card" id="loginForm" novalidate>
      <div class="brand">
        <div class="brand-badge">&#9635;</div>
        <div>POS Terminal</div>
      </div>
      <h1>Staff sign in</h1>
      <p class="sub">Contact admin for access</p>

      <div class="field">
        <label for="loginEmail">Email</label>
        <input id="loginEmail" type="email" autocomplete="username"
               placeholder="you@example.com" required />
      </div>

      <div class="field">
        <label for="loginPassword">Password</label>
        <input id="loginPassword" type="password" autocomplete="current-password"
               placeholder="••••••••" required />
      </div>

      <div id="loginError" class="search-result error" role="alert"></div>

      <button class="primary-btn" type="submit" id="loginBtn">Sign in</button>
      <p class="hint" style="text-align:center;">
        ask the owner to add your account.
      </p>
    </form>`;

  const form = gateEl.querySelector("#loginForm");
  const emailEl = gateEl.querySelector("#loginEmail");
  const passwordEl = gateEl.querySelector("#loginPassword");
  const btn = gateEl.querySelector("#loginBtn");
  const errorEl = gateEl.querySelector("#loginError");

  emailEl.focus();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.className = "search-result error";

    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) {
      errorEl.textContent = "Enter both your email and password.";
      errorEl.className = "search-result visible error";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged takes it from here.
      toast("Signed in");
    } catch (err) {
      errorEl.textContent = describeAuthError(err);
      errorEl.className = "search-result visible error";
      btn.disabled = false;
      btn.textContent = "Sign in";
      passwordEl.select();
    }
  });
}

/** Turn Firebase's terse error codes into something a cashier can act on. */
function describeAuthError(err) {
  switch (err?.code) {
    case "auth/invalid-email":
      return "That email address is not valid.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Email or password is incorrect.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Wait a minute and try again.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/network-request-failed":
      return "Network problem — check your connection.";
    case "auth/operation-not-allowed":
      return "Email/Password sign-in is not enabled in the Firebase console.";
    case "auth/invalid-api-key":
      return "The API key in js/firebase-config.js is wrong.";
    default:
      return err?.message || "Could not sign in.";
  }
}

export async function signOutUser() {
  await signOut(auth);
}

export { isConfigured };
