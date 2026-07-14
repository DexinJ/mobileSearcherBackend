// src/usage/trialBudget.js
import { TRIAL_MAX_COMPLETION_TOKENS, TRIAL_TOKENS_PER_DAY } from "../config/policy.js";

/**
 * Rough heuristic: ~4 chars per token (pre-check only)
 */
export function estimateTokensFromMessages(messages) {
  let chars = 0;
  for (const m of messages) chars += String(m?.content ?? "").length;
  return Math.ceil(chars / 4);
}

/**
 * Decide max_tokens for trial request given remaining daily tokens.
 */
export function computeTrialMaxTokens({ remainingTokens, messages }) {
  const estPromptTokens = estimateTokensFromMessages(messages);

  if (remainingTokens <= 0) {
    return { ok: false, reason: "Trial limit reached. Please sign in to continue." };
  }

  if (estPromptTokens >= remainingTokens) {
    return {
      ok: false,
      reason: "Trial: message too long for remaining token budget. Please sign in.",
    };
  }

  const maxCompletionTokens = Math.max(
    1,
    Math.min(TRIAL_MAX_COMPLETION_TOKENS, remainingTokens - estPromptTokens)
  );

  return { ok: true, estPromptTokens, maxCompletionTokens };
}

export function remainingTrialTokens(tokensUsed) {
  return TRIAL_TOKENS_PER_DAY - tokensUsed;
}
