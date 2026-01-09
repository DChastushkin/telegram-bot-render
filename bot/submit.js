// bot/submit.js
import state from "./state.js";

const {
  pendingAnonReplies,
  channelToDiscussion
} = state;

/**
 * ===============================
 * 🕶 АНОНИМНЫЙ КОММЕНТАРИЙ
 * ===============================
 * Возвращает true, если сообщение обработано
 */
export async function tryHandleAnonReply(ctx) {
  if (!ctx?.from || !ctx.message?.text) return false;

  const uid = ctx.from.id;
  const pending = pendingAnonReplies.get(uid);
  if (!pending) return false;

  const { channelMsgId } = pending;
  const link = channelToDiscussion.get(channelMsgId);

  if (!link) {
    await ctx.reply(
      "⚠️ Обсуждение к этой теме пока не найдено.\nПопробуйте чуть позже."
    );
    return true;
  }

  const { discussionChatId, discussionMsgId } = link;

  try {
    await ctx.telegram.sendMessage(
      discussionChatId,
      ctx.message.text,
      { reply_to_message_id: discussionMsgId }
    );

    await ctx.reply("✅ Анонимный комментарий опубликован.");
  } catch (e) {
    console.error("Anon reply error:", e);
    await ctx.reply("❌ Не удалось опубликовать комментарий.");
  } finally {
    pendingAnonReplies.delete(uid);
  }

  return true;
}
