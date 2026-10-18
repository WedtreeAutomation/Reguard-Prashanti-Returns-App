import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, browserLocalPersistence, setPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
  measurementId: import.meta.env.VITE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Staff sessions: the backend issues a Firebase custom token on login and the
// browser signs in with it. Firestore security rules and the API both rely on
// this signed-in user (see functions/security.py and firestore.rules).
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {
  /* falls back to default persistence */
});
