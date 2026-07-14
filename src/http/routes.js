// src/http/routes.js
import express from "express";
import fetch, { Blob, FormData } from "node-fetch";
import multer from "multer";

import {
  verifyFirebaseToken,
  deleteFirebaseUser,
} from "../auth/firebase.js";
import { OPENAI_API_KEY } from "../config/env.js";
import { getDb } from "../db/db.js";

const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
]);

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (!file?.mimetype) {
      callback(new Error("Uploaded audio file has no MIME type."));
      return;
    }

    if (!ALLOWED_AUDIO_TYPES.has(file.mimetype)) {
      callback(
        new Error(`Unsupported audio file type: ${file.mimetype}`)
      );
      return;
    }

    callback(null, true);
  },
});

function getBearerToken(req) {
  const auth = req.headers.authorization || "";

  return auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : null;
}

async function requireAuthenticatedUser(req, res) {
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({
      error: "Missing Bearer token",
    });

    return null;
  }

  try {
    return await verifyFirebaseToken(token);
  } catch (error) {
    console.error("[requireAuthenticatedUser]", error);

    res.status(401).json({
      error: "Invalid or expired token",
    });

    return null;
  }
}

function handleAudioUpload(req, res, next) {
  uploadAudio.single("file")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "Audio recording is too large. Maximum size is 25 MB.",
        });
        return;
      }

      res.status(400).json({
        error: error.message || "Audio upload failed.",
      });
      return;
    }

    res.status(400).json({
      error: error?.message || "Invalid audio upload.",
    });
  });
}

export function attachRoutes(app) {
  app.use(
    express.json({
      limit: "2mb",
    })
  );

  // --------------------
  // Health
  // --------------------
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "mobilesearcherbackend",
      ts: Date.now(),
    });
  });

  // --------------------
  // Auth test
  // --------------------
  app.get("/me", async (req, res) => {
    const decoded = await requireAuthenticatedUser(req, res);

    if (!decoded) {
      return;
    }

    return res.json({
      uid: decoded.uid,
      email: decoded.email || null,
    });
  });

  // --------------------
  // Create or update user profile
  // POST /api/users
  // Body: { username: string }
  // --------------------
  app.post("/api/users", async (req, res) => {
    try {
      const decoded = await requireAuthenticatedUser(req, res);

      if (!decoded) {
        return;
      }

      const uid = decoded.uid;

      const username =
        typeof req.body?.username === "string"
          ? req.body.username.trim()
          : "";

      if (!username) {
        return res.status(400).json({
          error: "username is required",
        });
      }

      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({
          error: "username must be 2-20 chars",
        });
      }

      const db = await getDb();

      await db.run(
        `INSERT INTO users (
          uid,
          username,
          created_at,
          updated_at
        )
        VALUES (
          ?,
          ?,
          strftime('%s', 'now'),
          strftime('%s', 'now')
        )
        ON CONFLICT(uid) DO UPDATE SET
          username = excluded.username,
          updated_at = strftime('%s', 'now')`,
        [uid, username]
      );

      return res.json({
        ok: true,
        uid,
        username,
      });
    } catch (error) {
      console.error("[POST /api/users]", error);

      return res.status(500).json({
        error: error?.message || "Failed to save user",
      });
    }
  });

  // --------------------
  // Get authenticated user's profile
  // GET /api/users/:uid
  // --------------------
  app.get("/api/users/:uid", async (req, res) => {
    try {
      const decoded = await requireAuthenticatedUser(req, res);

      if (!decoded) {
        return;
      }

      const requestedUid = String(req.params.uid || "").trim();

      if (!requestedUid) {
        return res.status(400).json({
          error: "uid is required",
        });
      }

      if (requestedUid !== decoded.uid) {
        return res.status(403).json({
          error: "Forbidden",
        });
      }

      const db = await getDb();

      const row = await db.get(
        `SELECT uid, username
         FROM users
         WHERE uid = ?`,
        [requestedUid]
      );

      if (!row) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      return res.json({
        ok: true,
        uid: row.uid,
        username: row.username,
      });
    } catch (error) {
      console.error("[GET /api/users/:uid]", error);

      return res.status(500).json({
        error: error?.message || "Failed to load user",
      });
    }
  });

  // --------------------
  // Permanently delete authenticated user's account
  // DELETE /api/users/:uid
  // --------------------
  app.delete("/api/users/:uid", async (req, res) => {
    let db;

    try {
      const decoded = await requireAuthenticatedUser(req, res);

      if (!decoded) {
        return;
      }

      const authenticatedUid = decoded.uid;
      const requestedUid = String(req.params.uid || "").trim();

      if (!requestedUid) {
        return res.status(400).json({
          error: "uid is required",
        });
      }

      if (requestedUid !== authenticatedUid) {
        return res.status(403).json({
          error: "Forbidden",
        });
      }

      db = await getDb();

      await db.exec("BEGIN TRANSACTION");

      try {
        await db.run(
          `DELETE FROM users
           WHERE uid = ?`,
          [authenticatedUid]
        );

        // Add future server-side user data deletions here:
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
    } catch (error) {
      console.error("[DELETE /api/users/:uid]", error);

      if (error?.code === "auth/user-not-found") {
        return res.status(404).json({
          error: "Firebase user not found",
        });
      }

      if (
        typeof error?.code === "string" &&
        error.code.startsWith("auth/id-token")
      ) {
        return res.status(401).json({
          error: "Invalid or expired token",
        });
      }

      return res.status(500).json({
        error: error?.message || "Failed to delete account",
      });
    }
  });

  // --------------------
  // Transcribe recorded audio
  // POST /api/transcriptions
  //
  // Authorization:
  //   Bearer <Firebase ID token>
  //
  // multipart/form-data:
  //   file: audio recording
  // --------------------
  app.post(
    "/api/transcriptions",
    handleAudioUpload,
    async (req, res) => {
      try {
        const decoded = await requireAuthenticatedUser(req, res);

        if (!decoded) {
          return;
        }

        const uploadedFile = req.file;

        if (!uploadedFile) {
          return res.status(400).json({
            error: "No audio file was uploaded.",
          });
        }

        if (!uploadedFile.buffer?.length) {
          return res.status(400).json({
            error: "Uploaded audio file is empty.",
          });
        }

        const formData = new FormData();

        const audioBlob = new Blob(
          [uploadedFile.buffer],
          {
            type:
              uploadedFile.mimetype ||
              "audio/m4a",
          }
        );

        formData.append(
          "file",
          audioBlob,
          uploadedFile.originalname ||
            "recording.m4a"
        );

        formData.append(
          "model",
          "gpt-4o-mini-transcribe"
        );

        const openAIResponse = await fetch(
          "https://api.openai.com/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: formData,
          }
        );

        const responseText =
          await openAIResponse.text();

        let data;

        try {
          data = JSON.parse(responseText);
        } catch {
          data = {
            error: {
              message:
                responseText ||
                "OpenAI returned an invalid response.",
            },
          };
        }

        if (!openAIResponse.ok) {
          console.error(
            "[POST /api/transcriptions] OpenAI error:",
            {
              status: openAIResponse.status,
              body: data,
              uid: decoded.uid,
            }
          );

          return res
            .status(openAIResponse.status)
            .json({
              error:
                data?.error?.message ||
                "The transcription service failed.",
            });
        }

        const transcript =
          typeof data?.text === "string"
            ? data.text.trim()
            : "";

        if (!transcript) {
          return res.status(422).json({
            error:
              "No speech was detected in the recording.",
          });
        }

        return res.json({
          ok: true,
          text: transcript,
        });
      } catch (error) {
        console.error(
          "[POST /api/transcriptions]",
          error
        );

        return res.status(500).json({
          error:
            error?.message ||
            "Unable to transcribe the recording.",
        });
      }
    }
  );

  // --------------------
  // Summarize chat history
  // --------------------
  app.post("/summarize", async (req, res) => {
    try {
      const decoded = await requireAuthenticatedUser(
        req,
        res
      );

      if (!decoded) {
        return;
      }

      const {
        messages,
        language = "en",
      } = req.body;

      if (
        !Array.isArray(messages) ||
        messages.length === 0
      ) {
        return res.status(400).json({
          error:
            "messages must be a non-empty array",
        });
      }

      const openAIResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
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
                  "Summarize the following chat for memory retention. " +
                  "Focus only on fridge and shopping-list state. " +
                  `Reply in ${language}.`,
              },
              ...messages,
            ],
            temperature: 0.2,
          }),
        }
      );

      const responseText =
        await openAIResponse.text();

      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        data = null;
      }

      if (!openAIResponse.ok) {
        console.error(
          "[POST /summarize] OpenAI error:",
          {
            status: openAIResponse.status,
            body: data || responseText,
            uid: decoded.uid,
          }
        );

        return res
          .status(openAIResponse.status)
          .json({
            error:
              data?.error?.message ||
              responseText ||
              "Failed to summarize",
          });
      }

      const summary =
        data?.choices?.[0]?.message?.content ?? "";

      return res.json({
        summary,
      });
    } catch (error) {
      console.error("[POST /summarize]", error);

      return res.status(500).json({
        error: "Failed to summarize",
      });
    }
  });
}