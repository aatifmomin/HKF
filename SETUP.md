# Hasnain Karimain Foundation — web app

This is the browser version of the Android app. Same Firebase project, same
data, same auth. Anyone with a browser (laptop, iPhone, any Android, tablet)
can open the URL, sign in with their Google account, and use the app.

## What you do once, before the web app works

### 1. Add a "Web app" to your Firebase project

This is a one-time setup that gives the website a key for talking to Firebase.

1. Open **Firebase Console** → your project (`hasnain-karimain-foundat-18957`)
2. Click the **gear icon** (top-left, next to "Project Overview") → **Project settings**
3. Scroll down to **Your apps** section
4. Click the **`</>` icon** (Web app)
5. Register the app:
   - **App nickname**: `HKF Web`
   - **Set up Firebase Hosting**: leave unchecked for now (we'll do this
     in session 5)
   - Click **Register app**
6. You'll see a code snippet with a `firebaseConfig` object. **Copy it.**
   It looks like:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "hasnain-karimain-foundat-18957.firebaseapp.com",
     databaseURL: "https://hasnain-karimain-foundat-18957-default-rtdb.firebaseio.com",
     projectId: "hasnain-karimain-foundat-18957",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "1:..."
   };
   ```
7. Click **Continue to console**.

### 2. Paste it into `firebase-config.js`

Open `web/firebase-config.js` in any text editor and paste the values from
step 6. The placeholder shows you what fields to fill.

### 3. Authorize the domain you'll use

Web Google Sign-In only works from domains Firebase trusts.

1. Firebase Console → **Authentication** → **Settings** tab → **Authorized
   domains**
2. By default `localhost` is already there (so opening the file via a local
   server works for testing).
3. When you later host on Firebase Hosting, that domain will be added
   automatically.

### 4. Open the app

For testing on your laptop:

- **Easiest**: install Python (likely already installed). In a terminal:
  ```
  cd web
  python -m http.server 8080
  ```
  Then open http://localhost:8080 in any browser.

- **Alternative**: VS Code "Live Server" extension, or any tool that serves
  static files. **You cannot open `index.html` by double-clicking** —
  Firebase auth needs a real http(s) origin.

For testing on your phone in the same Wi-Fi:

- Find your laptop's IP (usually `192.168.x.x`)
- On your phone, browse to `http://192.168.x.x:8080`
- This domain isn't in Firebase's authorized list yet, so Google Sign-In may
  reject it. Add `192.168.x.x` (your laptop's IP) to Authentication →
  Settings → Authorized domains.

When we deploy to Firebase Hosting (session 5), you'll get a real URL like
`hasnain-karimain-foundat-18957.web.app` that anyone can use.

## What's in this folder

```
web/
  index.html          — page shell, loads everything else
  styles.css          — Android-matching theme (gold, black, cream)
  firebase-config.js  — your firebase keys (paste here, see step 2)
  app.js              — top-level routing, role detection
  auth.js             — sign-in / sign-out / auth state
  home.js             — Home screen: stats grid + monthly charts
  SETUP.md            — this file
```

Future sessions will add `members.js`, `discussion.js`, `handover.js`,
`payments.js`.
