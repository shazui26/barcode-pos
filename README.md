# Barcode POS

A point-of-sale and inventory app for a small shop. Scan a barcode, sell it,
and keep stock and sales in Firebase so every device sees the same data.

It is a **static site**: plain HTML, CSS and JavaScript with no build step, no
`npm install`, and no server to run. Firebase is reached directly from the
browser, and GitHub Pages hosts the files.

Three screens:

| Page | What it does |
|---|---|
| `index.html` | **Point of Sale** — scan items into a cart, take cash, complete the sale |
| `stocks.html` | **Stocks** — add/edit/delete products and change store settings |
| `sales.html` | **Sales** — takings for today / 7 / 30 days, and the full sales ledger |

---

## One-time setup

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and **Add project**.
2. Once it is created, open **Build → Firestore Database → Create database**.
   Choose **Production mode** (the rules below lock it down properly).
   Pick a region close to you.
3. Open **Build → Authentication → Get started**.
4. On the **Sign-in method** tab, enable **Email/Password**. Leave
   "Email link (passwordless sign-in)" off.
5. Go to the **Users** tab and **Add user** for each staff member.

> **There is deliberately no sign-up screen.** Accounts only exist if you
> create them here. That is what makes it safe to publish this app at a public
> web address — a stranger has no account, so the rules below give them
> nothing. Do not add a sign-up form.

### 2. Get your config and paste it in

1. In the console, **Project settings** (gear icon) → **Your apps**.
2. Click the **Web** icon (`</>`) to register an app, give it any nickname.
3. Copy the `firebaseConfig` object it shows you.
4. Paste those values into [`js/firebase-config.js`](js/firebase-config.js),
   replacing every `PASTE_...` placeholder.

These values are **public identifiers, not secrets**. It is normal for them to
sit in a public repo — they only say *which* project to talk to. Real access
control is the rules file in the next step.

### 3. Publish the security rules

1. In the console, **Firestore Database → Rules** tab.
2. Replace everything in the editor with the contents of
   [`firestore.rules`](firestore.rules).
3. Click **Publish**.

Until you do this, the database is in locked/production mode and the app will
show "Permission denied".

---

## Deploying

This machine has no `git`, so deployment goes through the GitHub API instead.

### 1. Create a token

Go to <https://github.com/settings/tokens/new?scopes=repo> and create a
**classic** token with the **`repo`** scope. Copy it — you will not see it
again.

*(Fine-grained tokens also work but are fussier about creating new
repositories. Classic with `repo` is the simplest thing that works.)*

### 2. Run the deploy script

```powershell
cd C:\Users\yourfolder\barcode-scanner

# If PowerShell refuses to run the script, allow it for this window only:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

.\deploy.ps1 -Repo barcode-pos
```

It will ask you to paste the token (input is hidden). Then it:

1. verifies your token and finds your username
2. creates the repository (or reuses it if it already exists)
3. uploads every site file
4. makes **one** commit containing all of them
5. turns on GitHub Pages and waits for the first build

When it finishes it prints your live URL:

```
https://<your-username>.github.io/barcode-pos/
```

Sign in there with a user you created in step 1.5. Open the same URL on a
phone and the stock list is shared between them.

**To publish changes later, just run the script again.** Each run makes a new
commit.

### Options

```powershell
.\deploy.ps1 -Repo barcode-pos -CommitMessage "Add beer to stock"
.\deploy.ps1 -Repo barcode-pos -Owner my-org      # deploy under an organisation
.\deploy.ps1 -Repo barcode-pos -SkipPages         # commit without touching Pages
```

> **Private keys are never uploaded.** `cert.pem` and `key.pem` (created by
> `serve.py` for local HTTPS) are excluded, along with any `*.pem` / `*.key`
> file. Keep it that way — a private key in a public repo must be considered
> compromised.

---

## Daily use

**Stocks page** — scan a product's barcode, type a name, price and stock
level, then **Save product**. The barcode *is* the product's identity, so
saving a barcode that already exists updates that product instead of creating
a duplicate. Set **Store settings** once (currency, tax rate, volume
discount).

**POS page** — scan or type a barcode. Known products drop straight into the
cart; unknown ones are refused with a pointer to the Stocks page. Adjust
quantities with the `+` / `−` steppers, enter the cash tendered (or hit
**Exact**), and press **Complete sale**. That writes the sale and decrements
stock in a single atomic operation, then offers a printable receipt.

### Stock is a hard limit

An item the shop does not have cannot be sold. The POS enforces that at four
points, because a till that can oversell is worse than one that refuses:

* **Scanning** an item with no stock left is refused — nothing goes in the
  cart, and the reason is shown in red under the scan box.
* **The `+` stepper** stops at the number on the shelf and greys out there.
* **Quick item tiles** grey out once their whole stock is already in the sale.
* **Complete sale** re-checks every line against live stock before writing.
  Stock moves while a sale sits in the cart — another till, or an edit on the
  Stocks page — so a line that was fine when it was scanned may not be by the
  time it is rung up. When that happens the sale is blocked, the line is
  flagged in the cart, and the reason appears next to the total.

A product with no stock field at all counts as 0 — the same rule as the red
**Out** badge on the Stocks page.

**Sales page** — takings and the ledger. Click any sale to see its line items.

### Scanning

Three ways in, all on the same input box:

* **USB barcode scanner** — these behave like keyboards and press Enter after
  the code, so they just work. This is the fastest and most reliable option.
* **Phone or webcam** — press **Use camera**. Works on the deployed HTTPS URL
  (browsers only allow camera access over HTTPS or localhost).
* **Typing** — type the code and press Enter.

The camera reads real retail 1D barcodes (EAN-13, EAN-8, UPC-A, UPC-E,
Code 128, Code 39, Code 93, ITF, Codabar) as well as QR codes. A single
physical scan is deduplicated for ~1.6s so one label cannot add twenty items.

---

## Local development

`serve.py` runs the folder over HTTPS on your LAN so a phone can reach it and
use its camera:

```powershell
python serve.py
```

It prints a `https://<your-lan-ip>:8443/` URL. The certificate is self-signed,
so the browser warns once — accept it. `localhost` is also accepted by Firefox
and Chrome without a warning.

---

## Security model

Worth understanding, because the site is publicly reachable.

* **Sign-in required.** Every Firestore rule demands `request.auth != null`.
* **No self-signup.** Accounts are created only in the console. This is the
  load-bearing detail — an app with open signup plus "any signed-in user may
  write" rules is effectively open to the world.
* **Sales are append-only.** There is no `update` or `delete` rule on the
  `sales` collection, so a completed sale cannot be silently altered.
* **`robots.txt` asks crawlers to stay out.** That is a politeness signal, not
  a security control — anyone can ignore it. The rules above are the real
  protection.

What this does *not* do: any signed-in staff member can read and write all
data. There are no roles (cashier vs manager). For a small trusted team that
is usually the right trade-off; if you need per-role limits, the rules are the
place to add them.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Finish connecting Firebase" screen | `js/firebase-config.js` still has placeholders. Do setup step 2 and redeploy. |
| "Permission denied" | `firestore.rules` not published, or you are signed out. |
| "Cannot sign in" with an error | Email/Password provider not enabled, or wrong email/password. |
| Email/password rejected as invalid | The user was never created under Authentication → Users. |
| Blank page | Fixed in this version — you should always see a status message. If you see nothing, check the browser console for a module load error. |
| Camera will not start | You must be on HTTPS (the GitHub Pages URL or localhost), and must grant camera permission. |
| "Firestore needs an index" | Follow the link Firebase prints in the browser console; it creates the index for you. |
| Pages shows 404 for a while | The first build takes a minute or two. Check the repo's Actions tab. |

---

## File map

```
index.html            POS terminal
stocks.html           Product stock and store settings
sales.html            Sales history
css/styles.css        All styling (shared design tokens)
js/firebase-config.js <-- PASTE YOUR CONFIG HERE
js/firebase.js        Firebase app / Firestore / Auth bootstrap
js/auth.js            Sign-in gate, email+password only
js/store.js           Every Firestore read and write (schema lives here)
js/scanner.js         Camera scanning wrapper
js/ui.js              Currency, toasts, header/nav, setup notice
js/pos.js             POS screen logic
js/stocks.js          Stocks screen logic
js/sales.js           Sales screen logic
firestore.rules       Security rules - paste into the Firebase console
deploy.ps1            Deploys to GitHub Pages via the GitHub API
serve.py              Local HTTPS dev server for phone testing
```

`Main` is the original static POS mockup this was built from. It is superseded
and deliberately excluded from deployment; you can delete it.

## Upgrading the Firebase SDK

The SDK version is pinned in **import URLs** — there is no central constant,
because JavaScript import specifiers must be static strings that no variable
can fill in. To upgrade, replace every `12.19.0` across three files:

```powershell
Select-String -Path js\*.js -Pattern '12\.19\.0'
```

[`js/firebase.js`](js/firebase.js) has three (App, Firestore, Auth),
[`js/store.js`](js/store.js) has the Firestore functions, and
[`js/auth.js`](js/auth.js) has the Auth functions. Keep them all identical —
mixing versions in one page can produce two copies of the SDK.
