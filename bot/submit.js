// bot/submit.js
import { pendingSubmissions } from "./state.js";

export const intentLabel = (intent) =>
  intent === "advice" ? "нужен совет" : "хочу высказаться";

/**
 * draft: { items: [{ srcChatId, srcMsgId, kind, supportsCaption, text }, ...] }
 */
export async function submitDraftToModeration({ telegram, ADMIN_CHAT_ID }, { user, draft, intent }) {
  const info =
    `👤 От: @${user.username || "—"}\n` +
    `ID: ${user.id}\n` +
    `Имя: ${[user.first_name, user.last_name].filter(Boolean).join(" ") || "—"}\n` +
    `Тип обращения: ${intentLabel(intent)}`;

  await telegram.sendMessage(ADMIN_CHAT_ID, info);

  const adminCopyMsgIds = [];
  for (const it of draft.items) {
    const copied = await telegram.copyMessage(ADMIN_CHAT_ID, it.srcChatId, it.srcMsgId);
    adminCopyMsgIds.push(copied.message_id);
  }

  const cb = (t) => JSON.stringify({ t, uid: user.id });
  const control = await telegram.sendMessage(
    ADMIN_CHAT_ID,
    "📝 Новая предложенная тема (см. сообщения выше).",
    { reply_markup: { inline_keyboard: [[
      { text: "📣 Опубликовать", callback_data: cb("publish") },
      { text: "🚫 Отклонить",   callback_data: cb("reject")  }
    ]] } }
  );

  pendingSubmissions.set(control.message_id, {
    authorId: user.id,
    intent,
    adminCopyMsgIds,
    items: draft.items // пригодится для публикации
  });
}
