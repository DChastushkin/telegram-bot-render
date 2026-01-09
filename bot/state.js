// bot/state.js

// ===== Existing state =====

// ожидание начала темы (старый флоу)
export const awaitingTopic = new Set();

// userId -> { items: [{ srcChatId, srcMsgId, kind, supportsCaption, text, entities }] }
export const pendingDrafts = new Map();

// replyMsgId -> entry
export const pendingRejections = new Map();

// adminId -> entry
export const pendingRejectionsByAdmin = new Map();

// controlMsgId -> { authorId, intent, adminCopyMsgIds?, items: [{...}] }
export const pendingSubmissions = new Map();

// userId, ожидаем выбор intent
export const awaitingIntent = new Set();

// ===== NEW: anonymous replies =====

// userId -> {
//   channelMsgId: number,   // id сообщения в канале, под которым нажали "Ответить анонимно"
//   createdAt: number
// }
export const pendingAnonReplies = new Map();

// channelMsgId -> {
//   discussionChatId: number,
//   discussionMsgId: number
// }
//
// Заполняется в момент публикации поста в канал,
// чтобы потом знать, куда отвечать в обсуждениях.
export const channelToDiscussion = new Map();
export default {
  awaitingTopic,
  pendingDrafts,
  pendingRejections,
  pendingRejectionsByAdmin,
  pendingSubmissions,
  awaitingIntent,
  pendingAnonReplies,
  channelToDiscussion,
};
