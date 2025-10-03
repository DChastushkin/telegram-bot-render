// bot/submit.js
import { pendingSubmissions } from "./state.js";

export const intentLabel = (intent) =>
  intent === "advice" ? "нужен совет" : "хочу высказаться";

/**
 * Отправляет черновик (любой тип сообщения) в админ-чат:
 * 1) инфо об авторе
 * 2) копию исходного сообщения
 * 3) карточку модерации (publish/reject)
 * И сохраняет связь в pendingSubmissions (включая intent и метаданные контента).
 */
export async function submitDraftToModeration({ telegram, ADMIN_CHAT_ID }, { user, draft, intent }) {
  const userInfo =
    `👤 От: @${user.username || "—"}\n` +
    `ID: ${user.id}\n` +
    `Имя: ${[user.first_name, user.last_name].filter(Boolean).join(" ") || "—"}\n` +
    `Тип обращения: ${intentLabel(intent)}`;

  await telegram.sendMessage(ADMIN_CHAT_ID, userInfo);

  const copied = await telegram.copyMessage(ADMIN_CHAT_ID, draft.srcChatId, draft.srcMsgId);

  const cb = (t) => JSON.stringify({ t, uid: user.id });
  const control = await telegram.sendMessage(
    ADMIN_CHAT_ID,
    "📝 Новая предложенная тема (см. сообщение выше).",
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "📣 Опубликовать", callback_data: cb("publish") },
          { text: "🚫 Отклонить",   callback_data: cb("reject")  }
        ]]
      }
    }
  );

  pendingSubmissions.set(control.message_id, {
    srcChatId: draft.srcChatId,
    srcMsgId: draft.srcMsgId,
    authorId: user.id,
    adminCopyMsgId: copied.message_id,
    intent,
    kind: draft.kind,
    supportsCaption: draft.supportsCaption,
    text: draft.text || ""
  });
}
