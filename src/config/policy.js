// src/config/policy.js

// Full access models (signed-in users)
export const ALLOWED_MODELS_AUTHED = new Set([
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4o-mini",
  ]);
  
  // Trial models (cheap + predictable)
  export const ALLOWED_MODELS_TRIAL = new Set([
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4o-mini",
  ]);
  
  // Tools allowed during trial
  export const TRIAL_ALLOWED_TOOLS = new Set([
    "webSearch",
    "webFetch",
    "addFridgeItem",
    "addShoppingItem",
    "removeFridgeItem",
    "removeShoppingItem",
    "findInFridge",
    "findInShoppingList",
    "getFridgeContents",
    "getShoppingListContents",
    "proposeAddAllToFridge",
    "streamlineLists", // ✅ NEW (replaces listItemsAndUpdateTags)
  ]);
  
  // Trial token budgets (SQLite-backed daily quota)
  export const TRIAL_TOKENS_PER_DAY = 20_000;      // adjust to your product
  export const TRIAL_MAX_COMPLETION_TOKENS = 600;  // per request cap
  
  // WS rate limits (per minute)
  export const START_LIMIT_AUTHED = { windowMs: 60_000, max: 12 };
  export const START_LIMIT_TRIAL = { windowMs: 60_000, max: 5 };
  