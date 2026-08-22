// Single source of truth for the Firebase app instance.
// Other modules import firebaseApp from here so we avoid circular imports
// with app.js.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { firebaseConfig } from "./firebase-config.js?v=2026-08-20a";

export const firebaseApp = initializeApp(firebaseConfig);
