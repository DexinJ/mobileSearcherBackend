// src/ws/chatGateway.js
import {
  ALLOWED_MODELS_AUTHED,
  ALLOWED_MODELS_TRIAL,
  START_LIMIT_AUTHED,
  START_LIMIT_TRIAL,
  TRIAL_TOKENS_PER_DAY,
} from "../config/policy.js";

import { rateLimitStart } from "../utils/rateLimit.js";
import { newId } from "../utils/ids.js";
import { safeJsonParse } from "../utils/json.js";

import { verifyFirebaseToken } from "../auth/firebase.js";
import { getDb } from "../db/db.js";
import { parseOwner, getUsageRow, addUsage } from "../usage/usageStore.js";
import { computeTrialMaxTokens, remainingTrialTokens } from "../usage/trialBudget.js";

import { streamOpenAIOnce } from "../chat/openaiStream.js";
import { runToolCalls } from "../chat/toolRunner.js"; // ✅ HYBRID: enable server-side tools

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/**
 * Convert client tool_results payload into Chat Completions tool messages.
 * Expected from client:
 *  { type:"tool_results", requestId, results: [{ tool_call_id, name, content }] }
 */
function toolResultsToToolMessages(results) {
  const arr = Array.isArray(results) ? results : [];
  return arr
    .map((r) => {
      const tool_call_id = r?.tool_call_id || r?.id || null;
      const content =
        typeof r?.content === "string"
          ? r.content
          : JSON.stringify(r?.content ?? {});
      if (!tool_call_id) return null;
      return { role: "tool", tool_call_id, content };
    })
    .filter(Boolean);
}

/**
 * For Chat Completions, when the assistant requests tools, you must append:
 *  - an assistant message with tool_calls
 *  - one tool message per tool_call_id with the tool output
 */
function makeAssistantToolCallMsg(toolCalls) {
  return {
    role: "assistant",
    tool_calls: Array.isArray(toolCalls) ? toolCalls : [],
    content: null,
  };
}

// ✅ HYBRID: server-only tools (secrets / internet)
const SERVER_TOOLS = new Set([
  "webSearch",
  // "webFetch", // add if you implement page fetching
]);

function splitToolCalls(toolCalls) {
  const serverCalls = [];
  const clientCalls = [];
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = tc?.function?.name;
    if (name && SERVER_TOOLS.has(name)) serverCalls.push(tc);
    else clientCalls.push(tc);
  }
  return { serverCalls, clientCalls };
}

function withTimeout(promise, ms, msg = "Timed out") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export function attachChatGateway(wss) {
  wss.on("connection", (ws) => {
    const active = new Map();
    const connectionTrialId = newId();

    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    send(ws, { type: "hello", serverTime: Date.now() });

    // ✅ HYBRID: resume when we have ALL tool_call_id results (server + client)
    function maybeResumeAfterTools(requestId) {
      const state = active.get(requestId);
      if (!state) return;

      const allIds = (state.toolCalls || []).map((tc) => tc?.id).filter(Boolean);
      const haveIds = new Set((state.collectedToolMsgs || []).map((m) => m.tool_call_id));

      const missing = allIds.filter((id) => !haveIds.has(id));
      if (missing.length) return; // still waiting

      // stop timeout
      if (state.toolResultsTimeout) {
        clearTimeout(state.toolResultsTimeout);
        state.toolResultsTimeout = null;
      }

      // Append assistant tool_calls + all tool outputs
      const assistantToolCallMsg = makeAssistantToolCallMsg(state.toolCalls);
      state.workingMessages = [
        ...state.workingMessages,
        assistantToolCallMsg,
        ...(state.collectedToolMsgs || []),
      ];

      // clear tool state
      state.awaitingTools = false;
      state.toolCalls = [];
      state.collectedToolMsgs = [];
      state.pendingToolResults = null;

      runOneRound(requestId).catch((e) => {
        send(ws, {
          type: "error",
          requestId,
          message: e?.message || "Failed to continue after tools.",
        });
        active.delete(requestId);
      });
    }

    async function runOneRound(requestId) {
      const state = active.get(requestId);
      if (!state) return;

      const {
        controller,
        model,
        workingMessages,
        maxTokensForThisRequest,
        db,
        ownerType,
        ownerKey,
        isAuthed,
      } = state;

      const one = await streamOpenAIOnce({
        ws,
        send,
        requestId,
        model,
        messages: workingMessages,
        controller,
        maxTokens: maxTokensForThisRequest,
      });

      if (!one.ok) {
        active.delete(requestId);
        return;
      }

      // Usage accounting (trial)
      if (!isAuthed) {
        await addUsage(db, ownerType, ownerKey, 0, 1);

        if (one?.usage?.total_tokens) {
          await addUsage(db, ownerType, ownerKey, one.usage.total_tokens, 0);

          const u2 = await getUsageRow(db, ownerType, ownerKey);
          const remainingNow = Math.max(0, TRIAL_TOKENS_PER_DAY - u2.tokens_used);

          send(ws, {
            type: "trial_budget_update",
            requestId,
            usedTokens: u2.tokens_used,
            remainingTokens: remainingNow,
          });
        }
      }

      // Normal completion
      if (!one.needsTools) {
        send(ws, { type: "done", requestId });
        active.delete(requestId);
        return;
      }

      // Tool calls required
      state.awaitingTools = true;
      state.toolCalls = one.toolCalls || [];
      state.collectedToolMsgs = [];
      state.round = (state.round || 0) + 1;

      const { serverCalls, clientCalls } = splitToolCalls(state.toolCalls);

      // ✅ HYBRID: run server tools immediately (e.g., webSearch)
      if (serverCalls.length) {
        const ctx = {
          requestId,
          isAuthed: state.isAuthed,
          wsSend: (obj) => send(ws, obj),
          userId: state.userId,
          db: state.db,
          ownerType: state.ownerType,
          ownerKey: state.ownerKey,
        };

        try {
          // keep a timeout so Serper fetch doesn't hang
          const serverToolMsgs = await withTimeout(
            runToolCalls(serverCalls, ctx),
            25_000,
            "Server tool execution timed out."
          );
          state.collectedToolMsgs.push(...(Array.isArray(serverToolMsgs) ? serverToolMsgs : []));
        } catch (e) {
          send(ws, {
            type: "error",
            requestId,
            message: e?.message || "Server tool execution failed.",
          });
          active.delete(requestId);
          return;
        }
      }

      // ✅ HYBRID: if there are client tools, request tool_results for ONLY those
      if (clientCalls.length) {
        send(ws, {
          type: "awaiting_tool_results",
          requestId,
          round: state.round,
          toolCalls: clientCalls, // IMPORTANT: client executes ONLY these
        });

        // If tool_results arrived early, consume immediately
        if (state.pendingToolResults) {
          const toolMsgs = toolResultsToToolMessages(state.pendingToolResults);
          state.collectedToolMsgs.push(...toolMsgs);
          state.pendingToolResults = null;
          maybeResumeAfterTools(requestId);
          return;
        }

        // Timeout waiting for client
        if (state.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
        state.toolResultsTimeout = setTimeout(() => {
          const s2 = active.get(requestId);
          if (!s2) return;
          if (s2.awaitingTools) {
            send(ws, {
              type: "error",
              requestId,
              message: "Timed out waiting for tool results from client.",
            });
            active.delete(requestId);
          }
        }, 30_000);

        return; // wait for client tool_results
      }

      // ✅ HYBRID: server-only tool calls -> resume immediately
      maybeResumeAfterTools(requestId);
    }

    ws.on("message", async (raw) => {
      const parsed = safeJsonParse(raw.toString());
      if (!parsed.ok) return send(ws, { type: "error", message: "Invalid JSON" });

      const msg = parsed.value;

      // Cancel
      if (msg.type === "cancel") {
        const requestId = msg.requestId;
        const state = active.get(requestId);
        if (state?.controller) state.controller.abort();
        if (state?.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
        active.delete(requestId);
        send(ws, { type: "done", requestId, cancelled: true });
        return;
      }

      // Tool results from client (RESUME)
      if (msg.type === "tool_results") {
        const requestId = msg.requestId;
        const state = active.get(requestId);

        if (!state) {
          return send(ws, {
            type: "error",
            requestId,
            message: "No active request for tool_results.",
          });
        }

        // EARLY tool_results race: buffer it
        if (!state.awaitingTools) {
          state.pendingToolResults = msg.results || [];
          send(ws, {
            type: "queued_tool_results",
            requestId,
            message: "Received tool_results early; queued until server is ready.",
          });
          return;
        }

        // stop timeout
        if (state.toolResultsTimeout) {
          clearTimeout(state.toolResultsTimeout);
          state.toolResultsTimeout = null;
        }

        const toolMsgs = toolResultsToToolMessages(msg.results || []);
        state.collectedToolMsgs = state.collectedToolMsgs || [];
        state.collectedToolMsgs.push(...toolMsgs);

        // Resume ONLY when we have all tool_call_id outputs (server + client)
        maybeResumeAfterTools(requestId);
        return;
      }

      // Start
      if (msg.type !== "start") {
        return send(ws, { type: "error", message: "Unknown message type" });
      }

      const requestId = msg.requestId || newId();

      // Auth or Trial mode
      let userId;
      let isAuthed = false;

      if (msg.token) {
        try {
          const decoded = await verifyFirebaseToken(msg.token);
          userId = decoded.uid;
          isAuthed = true;
        } catch {
          send(ws, { type: "error", requestId, message: "Invalid token" });
          return;
        }
      } else {
        const trialId =
          typeof msg.trialId === "string" && msg.trialId.length > 0
            ? msg.trialId
            : connectionTrialId;

        userId = `trial:${trialId}`;
        isAuthed = false;
      }

      // Rate limit per mode
      const rlKey = isAuthed ? `user:${userId}` : userId;
      const rl = rateLimitStart(rlKey, isAuthed ? START_LIMIT_AUTHED : START_LIMIT_TRIAL);

      if (!rl.ok) {
        send(ws, {
          type: "event",
          event: "quota",
          requestId,
          message: `Rate limited. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
        });
        return;
      }

      // Model policy per mode
      const model = msg.model || (isAuthed ? "gpt-5" : "gpt-4o-mini");
      const allowedModels = isAuthed ? ALLOWED_MODELS_AUTHED : ALLOWED_MODELS_TRIAL;

      if (!allowedModels.has(model)) {
        send(ws, {
          type: "error",
          requestId,
          message: isAuthed ? "Model not allowed" : "Trial: model not available. Please sign in.",
        });
        return;
      }

      const language = msg.language || "en";
      const messages = Array.isArray(msg.messages) ? msg.messages : null;

      if (!messages) {
        return send(ws, { type: "error", requestId, message: "messages must be an array" });
      }

      // SQLite-backed token budget enforcement (trial)
      const db = await getDb();
      const { ownerType, ownerKey } = parseOwner(userId, isAuthed);

      let maxTokensForThisRequest = undefined;

      if (!isAuthed) {
        const usage = await getUsageRow(db, ownerType, ownerKey);
        const remaining = remainingTrialTokens(usage.tokens_used);

        if (remaining <= 0) {
          send(ws, {
            type: "error",
            requestId,
            message: "Trial limit reached. Please sign in to continue.",
          });
          return;
        }

        const budget = computeTrialMaxTokens({ remainingTokens: remaining, messages });
        if (!budget.ok) {
          send(ws, { type: "error", requestId, message: budget.reason });
          return;
        }

        maxTokensForThisRequest = budget.maxCompletionTokens;

        send(ws, {
          type: "trial_budget",
          requestId,
          remainingTokens: remaining,
          dailyLimit: TRIAL_TOKENS_PER_DAY,
          estPromptTokens: budget.estPromptTokens,
          maxCompletionTokens: maxTokensForThisRequest,
        });
      }

      const controller = new AbortController();

      // Store full state for hybrid tool execution
      active.set(requestId, {
        controller,
        workingMessages: [
          { role: "system", content: `Reply in ${language}.` },
          ...messages,
        ],
        model,
        language,
        isAuthed,
        userId,
        db,
        ownerType,
        ownerKey,
        maxTokensForThisRequest,
        round: 0,

        awaitingTools: false,
        toolCalls: [],
        collectedToolMsgs: [],
        toolResultsTimeout: null,
        pendingToolResults: null,
      });

      send(ws, { type: "started", requestId, isAuthed });

      runOneRound(requestId).catch((err) => {
        const isAbort = err && err.name === "AbortError";
        send(
          ws,
          isAbort
            ? { type: "done", requestId, cancelled: true }
            : { type: "error", requestId, message: err?.message || "Stream error" }
        );
        const st = active.get(requestId);
        if (st?.toolResultsTimeout) clearTimeout(st.toolResultsTimeout);
        active.delete(requestId);
      });
    });

    ws.on("close", () => {
      for (const state of active.values()) {
        state.controller?.abort?.();
        if (state.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
      }
      active.clear();
    });
  });

  // Heartbeat loop
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on("close", () => clearInterval(interval));
}
