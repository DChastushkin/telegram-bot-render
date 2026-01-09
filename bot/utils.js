import {
  pendingRejections,
  pendingRejectionsByAdmin,
  pendingSubmissions
} from "./state.js";
import { memberMenu } from "./ui.js";

/* =======================
   Helpers
======================= */

export const isOldQueryError = (e) =>
  e?.description?.includes("query is too old") ||
  e?.description?.includes("query ID is invalid") ||
  e?.description?.includes("response timeout expired");

export async function isMember(ctx, channelId, userId) {
  try {
    const uid = userId ?? ctx.from?.id;
    const m = await ctx.telegram.getChatMember(channelId, uid);
    return ["member", "administrator", "creator"].includes(m.status);
  } catch {
    return false;
  }
}

/* =======================
   SAFETY RAILS
======================= */

function getAllowedChatIds(env = process.env) {
  return new Set(
    [env.CHANNEL_ID, env.ADMIN_CHAT_ID]
      .filter(Boolean)
      .map((x) => String(x))
  );
}

function blockLog(action, chatId, env = process.env) {
  const mode = env.BOT_MODE || "prod";
  console.error(
    `❌ BLOCKED ${action}: chatId=${chatId} mode=${mode} allowed=[${[
      env.CHANNEL_ID,
      env.ADMIN_CHAT_ID
    ].filter(Boolean).join(", ")}]`
  );
}

export async function safeSendMessage(
  telegram,
  chatId,
  text,
  extra = {},
  env = process.env
) {
  const allowed = getAllowedChatIds(env);
  if (!allowed.has(String(chatId))) {
    blockLog("sendMessage", chatId, env);
    return null;
  }
  return telegram.sendMessage(chatId, text, extra);
}

export async function safeCopyMessage(
  telegram,
  targetChatId,
  fromChatId,
  messageId,
  extra = {},
  env = process.env
) {
  const allowed = getAllowedChatIds(env);
  if (!allowed.has(String(targetChatId))) {
    blockLog("copyMessage", targetChatId, env);
    return null;
  }
  return telegram.copyMessage(targetChatId, fromChatId, messageId, extra);
}

/* =======================
   Rejection flow
======================= */

export async function handleRejectionReason(ctx, entry, { ADMIN_CHAT_ID }) {
  if (!("text" in ctx.message)) {
    await ctx.reply("Нужен текст. Напишите причину одним сообщением.", {
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }

  const { authorId, modMsgId, modText } = entry;
  const reason = ctx.message.text.trim();

  // уведомляем автора
  let delivered = true;
  try {
    await ctx.telegram.sendMessage(
      authorId,
      `❌ Ваша тема отклонена.\nПричина: ${reason}`,
      { reply_markup: memberMenu().reply_markup }
    );
  } catch (e) {
    delivered = false;
    await ctx.reply("⚠️ Не удалось отправить причину автору.");
    console.error(e);
  }

  // обновляем карточку модерации
  try {
    await ctx.telegram.editMessageReplyMarkup(
      ADMIN_CHAT_ID,
      modMsgId,
      undefined,
      { inline_keyboard: [] }
    );

    const updated =
      (modText || "📝 Тема") +
      `\n\n🚫 Отклонено. Причина: ${reason}`;

    await ctx.telegram.editMessageText(
      ADMIN_CHAT_ID,
      modMsgId,
      undefined,
      updated
    );
  } catch {
    await safeSendMessage(
      ctx.telegram,
      ADMIN_CHAT_ID,
      `🚫 Отклонено. Причина: ${reason}`,
      { reply_to_message_id: modMsgId }
    );
  }

  // чистим состояния
  for (const [k, v] of pendingRejections.entries()) {
    if (v.modMsgId === modMsgId) pendingRejections.delete(k);
  }
  pendingRejectionsByAdmin.delete(ctx.from.id);
  pendingSubmissions.delete(modMsgId);

  await ctx.reply(
    `✅ Отклонение зафиксировано.${delivered ? "" : " (Автору не доставлено)"}`
  );
}
