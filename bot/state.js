// bot/state.js
export const awaitingTopic = new Set();             // кто пишет тему (ожидаем 1-е сообщение)

// сохраняем черновик вместе с метаданными контента
// userId -> { srcChatId, srcMsgId, kind, supportsCaption, text }
export const pendingDrafts = new Map();

export const pendingRejections = new Map();         // replyMsgId -> { authorId, modMsgId, modText }
export const pendingRejectionsByAdmin = new Map();  // adminId   -> { authorId, modMsgId, modText }

// controlMsgId -> {..., intent, kind, supportsCaption, text}
export const pendingSubmissions = new Map();
