// bot/state.js

// =======================
// ОСНОВНОЙ ФЛОУ ТЕМ
// =======================

// userId -> true
// Ожидание, что пользователь начнёт ввод темы
export const awaitingTopic = new Set();

// userId -> {
//   items: [
//     {
//       kind: "text" | "photo" | "video" | "document",
//       text?: string,
//       caption?: string,
//       entities?: any[]
//     }
//   ]
// }
// Черновик темы (внутренний, пользователь о нём не знает)
export const pendingDrafts = new Map();

// controlMsgId -> submission
// Активные заявки на модерации (сообщения в админ-чате)
export const pendingSubmissions = new Map();

// replyMsgId -> submission
// Для отклонений (ответ админа на конкретное сообщение)
export const pendingRejections = new Map();

// adminId -> submission
export const pendingRejectionsByAdmin = new Map();

// userId -> true
// Ожидание выбора типа обращения (нужен совет / хочу высказаться)
export const awaitingIntent = new Map();


// =======================
// АНОНИМНЫЕ ОТВЕТЫ
// =======================

// userId -> {
//   channelMsgId: number,
//   createdAt: number
// }
export const pendingAnonReplies = new Map();

// channelMsgId -> {
//   discussionChatId: number,
//   discussionMsgId: number
// }
export const channelToDiscussion = new Map();


// =======================
// EXPORT
// =======================

export default {
  awaitingTopic,
  pendingDrafts,
  pendingSubmissions,
  pendingRejections,
  pendingRejectionsByAdmin,
  awaitingIntent,
  pendingAnonReplies,
  channelToDiscussion,
};
