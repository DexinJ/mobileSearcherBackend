// src/utils/json.js
export function safeJsonParse(str) {
    try {
      return { ok: true, value: JSON.parse(str) };
    } catch {
      return { ok: false, value: null };
    }
  }
  