/* ==========================================================================
   Firebase bootstrap: one app instance, shared by every page.

   ---------------------------------------------------------------------------
   DO NOT paste the snippet from the Firebase console into this file.
   The console shows a version written for BUNDLED projects, which starts with:

       import { initializeApp } from "firebase/app";

   That bare specifier ("firebase/app") only resolves through a bundler or an
   import map. This project has no build step, so the browser rejects it with
   "Failed to resolve module specifier" and the whole module graph dies -
   every page renders blank. The full CDN URLs below are the equivalent for a
   build-free page, and they are why this file looks different.

   Your config values belong in js/firebase-config.js, not here.
   ---------------------------------------------------------------------------

   Import specifiers must be static string literals, so the SDK version is
   pinned in the URLs below. To upgrade, change the version in all three URLs
   here and in the import URLs in store.js and auth.js.
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import { firebaseConfig, isConfigured } from "./firebase-config.js";

export { isConfigured };

// Only initialise when real credentials are present, so an unconfigured
// checkout renders a setup notice instead of throwing on every call.
let app = null;
let db = null;
let auth = null;

if (isConfigured) {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
}

export { app, db, auth };
