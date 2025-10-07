// bot/state.js
export const awaitingTopic = new Set();

// userId -> { items: [{ srcChatId, srcMsgId, kind, supportsCaption, text, entities }] }
export const pendingDrafts = new Map();

export const pendingRejections = new Map();        // replyMsgId -> entry
export const pendingRejectionsByAdmin = new Map(); // adminId    -> entry

// controlMsgId -> { authorId, intent, adminCopyMsgIds?, items: [{...}] }
export const pendingSubmissions = new Map();

export const awaitingIntent = new Set();
