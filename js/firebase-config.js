/* ==========================================================================
   Firebase web app config.

   These values came from:
   Firebase console -> Project settings (gear) -> "Your apps" -> Web app
   -> "SDK setup and configuration" -> Config

   NOTE ON SECRECY: these are PUBLIC identifiers, not secrets. It is normal
   and safe for them to sit in a public GitHub Pages repo. They only tell the
   browser *which* project to talk to. Actual access control is enforced by
   firestore.rules on the server, which is why those rules matter so much.

   NOTE ON FORMAT: this file is imported directly by the browser as an ES
   module. It must keep `export const` and must not import anything itself.
   ========================================================================== */

export const firebaseConfig = {
  apiKey: "AIzaSyDNOVvkQW5daedc-N_h3X0pAbyzn6z-GCw",
  authDomain: "test-pos-7ff35.firebaseapp.com",
  projectId: "test-pos-7ff35",
  storageBucket: "test-pos-7ff35.firebasestorage.app",
  messagingSenderId: "342705745003",
  appId: "1:342705745003:web:5ad0a0a7a39e908521552e"
};

/** True once the placeholders above have been replaced with real values. */
export const isConfigured = !JSON.stringify(firebaseConfig).includes("PASTE_");
