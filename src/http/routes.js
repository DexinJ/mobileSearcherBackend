// src/http/routes.js
import express from "express";
import fetch from "node-fetch";
import {
  verifyFirebaseToken,
  deleteFirebaseUser,
} from "../auth/firebase.js";
import { OPENAI_API_KEY } from "../config/env.js";
import { getDb } from "../db/db.js"; // ✅ add this

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

export function attachRoutes(app) {
  app.use(express.json());

  // --------------------
  // Health
  // --------------------
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "mobilesearcherbackend", ts: Date.now() });
  });

  // --------------------
  // Auth test
  // --------------------
  app.get("/me", async (req, res) => {
    try {
      const token = getBearerToken(req);
      if (!token) return res.status(401).json({ error: "Missing Bearer token" });

      const decoded = await verifyFirebaseToken(token);
      return res.json({ uid: decoded.uid, email: decoded.email || null });
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  });

  // --------------------
  // ✅ Create / update user profile (store username)
  // Auth required; uid is derived from Firebase token.
  // POST /api/users  body: { username: string }
  // --------------------
  app.post("/api/users", async (req, res) => {
    try {
      const token = getBearerToken(req);
      if (!token) return res.status(401).json({ error: "Missing Bearer token" });

      const decoded = await verifyFirebaseToken(token);
      const uid = decoded.uid;

      const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
      if (!username) return res.status(400).json({ error: "username is required" });
      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: "username must be 2-20 chars" });
      }

      const db = await getDb();

      // Make sure you have this table:
      // CREATE TABLE IF NOT EXISTS users (
      //   uid TEXT PRIMARY KEY,
      //   username TEXT NOT NULL,
      //   created_at INTEGER NOT NULL,
      //   updated_at INTEGER NOT NULL
      // );
      await db.run(
        `INSERT INTO users (uid, username, created_at, updated_at)
         VALUES (?, ?, strftime('%s','now'), strftime('%s','now'))
         ON CONFLICT(uid) DO UPDATE SET
           username=excluded.username,
           updated_at=strftime('%s','now')`,
        [uid, username]
      );

      return res.json({ ok: true, uid, username });
    } catch (err) {
      console.error("[POST /api/users]", err);
      return res.status(500).json({ error: err?.message || "Failed to save user" });
    }
  });

  // --------------------
  // ✅ Get username by uid (some id)
  // GET /api/users/:uid  -> { ok, uid, username }
  // (Auth required here. If you want public, remove token check.)
  // --------------------
  app.get("/api/users/:uid", async (req, res) => {
    console.log("get user");
    try {
      const token = getBearerToken(req);
      if (!token) return res.status(401).json({ error: "Missing Bearer token" });
      const decoded = await verifyFirebaseToken(token); // auth gate (not restricting which uid is requested)
      if (req.params.uid !== decoded.uid) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const uid = String(req.params.uid || "").trim();
      if (!uid) return res.status(400).json({ error: "uid is required" });

      const db = await getDb();
      const row = await db.get(`SELECT uid, username FROM users WHERE uid = ?`, [uid]);

      if (!row) return res.status(404).json({ error: "User not found" });
      return res.json({ ok: true, uid: row.uid, username: row.username });
    } catch (err) {
      console.error("[GET /api/users/:uid]", err);
      return res.status(500).json({ error: err?.message || "Failed to load user" });
    }
  });

    // --------------------
  // ✅ Permanently delete the authenticated user's account
  // DELETE /api/users/:uid
  //
  // Auth required.
  // The requested uid must match the uid in the Firebase token.
  // Deletes:
  //   1. User data stored in the local database
  //   2. Firebase Authentication account
  // --------------------
  app.delete("/api/users/:uid", async (req, res) => {
    let db;

    try {
      const token = getBearerToken(req);

      if (!token) {
        return res.status(401).json({
          error: "Missing Bearer token",
        });
      }

      const decoded = await verifyFirebaseToken(token);
      const authenticatedUid = decoded.uid;
      const requestedUid = String(req.params.uid || "").trim();

      if (!requestedUid) {
        return res.status(400).json({
          error: "uid is required",
        });
      }

      // A user may only delete their own account.
      if (requestedUid !== authenticatedUid) {
        return res.status(403).json({
          error: "Forbidden",
        });
      }

      db = await getDb();

      /*
       * Delete all local database data belonging to this user.
       *
       * Add additional DELETE statements here if you later store
       * fridge items, shopping-list items, messages, or other user data
       * in separate tables.
       */
      await db.exec("BEGIN TRANSACTION");

      try {
        await db.run(
          `DELETE FROM users
           WHERE uid = ?`,
          [authenticatedUid]
        );

        // Examples for future server-side tables:
        //
        // await db.run(
        //   `DELETE FROM fridge_items WHERE uid = ?`,
        //   [authenticatedUid]
        // );
        //
        // await db.run(
        //   `DELETE FROM shopping_items WHERE uid = ?`,
        //   [authenticatedUid]
        // );
        //
        // await db.run(
        //   `DELETE FROM chat_messages WHERE uid = ?`,
        //   [authenticatedUid]
        // );

        /*
         * Delete Firebase Auth before committing the database deletion.
         *
         * If Firebase deletion fails, the database transaction is rolled
         * back so the user can retry instead of being left with a partially
         * deleted account.
         */
        await deleteFirebaseUser(authenticatedUid);

        await db.exec("COMMIT");
      } catch (deleteError) {
        await db.exec("ROLLBACK");
        throw deleteError;
      }

      return res.json({
        ok: true,
        uid: authenticatedUid,
        message: "Account permanently deleted",
      });
    } catch (err) {
      console.error("[DELETE /api/users/:uid]", err);

      // The Firebase user might have already been deleted.
      if (err?.code === "auth/user-not-found") {
        return res.status(404).json({
          error: "Firebase user not found",
        });
      }

      // Token verification errors should return 401 instead of 500.
      if (
        typeof err?.code === "string" &&
        err.code.startsWith("auth/id-token")
      ) {
        return res.status(401).json({
          error: "Invalid or expired token",
        });
      }

      return res.status(500).json({
        error: err?.message || "Failed to delete account",
      });
    }
  });
  
  // --------------------
  // 🔥 Summarize chat history
  // --------------------
  app.post("/summarize", async (req, res) => {
    try {
      const { messages, language = "en" } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages must be a non-empty array" });
      }

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                `Summarize the following chat for memory retention. ` +
                `Focus ONLY on fridge and shopping list state. ` +
                `Reply in ${language}.`,
            },
            ...messages,
          ],
          temperature: 0.2,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return res.status(500).json({ error: text });
      }

      const data = await resp.json();
      const summary = data?.choices?.[0]?.message?.content ?? "";
      return res.json({ summary });
    } catch (err) {
      console.error("[summarize]", err);
      return res.status(500).json({ error: "Failed to summarize" });
    }
  });
}
