// bot/utils.js
import { pendingRejections, pendingRejectionsByAdmin, pendingSubmissions } from "./state.js";

export const isOldQueryError = (e) =>
  e?.description?.includes("query is too old") ||
  e?.description?.includes("query ID is invalid") ||
  e?.description?.includes("response timeout expired");

export async function isMember(ctx, channelId, userId) {
  try {
    const uid = userId ?? ctx.from?.id;
    const m = await ctx.telegram.getChatMember(channelId, uid);
    return ["member", "administrator", "creator"].includes(m.status);
  } catch { return false; }
}

export async function handleRejectionReason(ctx, entry, { ADMIN_CHAT_ID }) {
  if (!("text" in ctx.message)) {
    await ctx.reply("Нужен текст. Напишите причину одним сообщением.", {
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }
  const { authorId, modMsgId, modText } = entry;
  const reason = ctx.message.text.trim();

  // автору
  let sent = true;
  try { await ctx.telegram.sendMessage(authorId, `❌ Ваша тема отклонена.\nПричина: ${reason}`); }
  catch (e) { sent = false; await ctx.reply("⚠️ Не удалось отправить причину автору."); console.error(e); }

  // помечаем карточку
  try {
    await ctx.telegram.editMessageReplyMarkup(ADMIN_CHAT_ID, modMsgId, undefined, { inline_keyboard: [] });
    const updated = (modText || "📝 Тема") + `\n\n🚫 Отклонено. Причина: ${reason}`;
    await ctx.telegram.editMessageText(ADMIN_CHAT_ID, modMsgId, undefined, updated);
  } catch {
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `🚫 Отклонено. Причина: ${reason}`, { reply_to_message_id: modMsgId });
  }

  // чистим состояние
  for (const [k, v] of pendingRejections.entries()) if (v.modMsgId === modMsgId) pendingRejections.delete(k);
  pendingRejectionsByAdmin.delete(ctx.from.id);
  pendingSubmissions.delete(modMsgId);

  await ctx.reply(`✅ Отклонение зафиксировано.${sent ? "" : " (Автору не доставлено)"}`);
}
