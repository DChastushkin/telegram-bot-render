// bot/state.js
export const awaitingTopic = new Set(); // кто начинает ввод темы

// userId -> { items: [{ srcChatId, srcMsgId, kind, supportsCaption, text }] }
export const pendingDrafts = new Map();

// для отклонений
export const pendingRejections = new Map();        // replyMsgId -> entry
export const pendingRejectionsByAdmin = new Map(); // adminId   -> entry

// controlMsgId -> { items, authorId, intent, adminCopyMsgIds, ... }
export const pendingSubmissions = new Map();

// userIds, у кого попросили выбрать тип (1/2 или кнопки)
export const awaitingIntent = new Set();
