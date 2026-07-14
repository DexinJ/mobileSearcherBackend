// src/auth/firebase.js
import admin from "firebase-admin";
import fs from "fs";

let initialized = false;

export function initFirebaseAdmin() {
  if (initialized) return;

  let serviceAccountObj = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccountObj = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const svcPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    serviceAccountObj = JSON.parse(fs.readFileSync(svcPath, "utf8"));
  } else {
    throw new Error(
      "Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH."
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountObj),
  });

  initialized = true;
}

export async function verifyFirebaseToken(idToken) {
  // verifyIdToken validates signature, expiry, etc.
  return admin.auth().verifyIdToken(idToken);
}

export async function deleteFirebaseUser(uid) {
  return admin.auth().deleteUser(uid);
}