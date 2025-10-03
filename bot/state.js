// bot/state.js
export const awaitingTopic = new Set();             // кто пишет тему (ожидаем 1-е сообщение)
export const pendingDrafts = new Map();             // userId -> { srcChatId, srcMsgId }

export const pendingRejections = new Map();         // replyMsgId -> { authorId, modMsgId, modText }
export const pendingRejectionsByAdmin = new Map();  // adminId   -> { authorId, modMsgId, modText }

export const pendingSubmissions = new Map();        // controlMsgId -> { srcChatId, srcMsgId, authorId, adminCopyMsgId, intent }
