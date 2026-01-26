import {
  newUserMenu,
  memberMenu,
  composeKeyboard,
  showNonMemberHint
} from "../ui.js";
import { isMember, handleRejectionReason } from "../utils.js";
import { submitDraftToModeration } from "../submit.js";
import {
  awaitingTopic,
  pendingDrafts,
  pendingRejections,
  pendingRejectionsByAdmin,
  awaitingIntent
} from "../state.js";

function detectContentMeta(msg) {
  if ("text" in msg)
    return { kind: "text", supportsCaption: false };
  if (msg.photo)
    return { kind: "photo", supportsCaption: true };
  if (msg.video)
    return { kind: "video", supportsCaption: true };
  if (msg.animation)
    return { kind: "animation", supportsCaption: true };
  if (msg.document)
    return { kind: "document", supportsCaption: true };
  if (msg.audio)
    return { kind: "audio", supportsCaption: true };
  if (msg.voice)
    return { kind: "voice", supportsCaption: true };
  return { kind: "other", supportsCaption: false };
}

export function registerModerationHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID } = env;

  bot.hears("📝 Предложить тему/вопрос", async (ctx) => {
    if (!(await isMember(ctx, CHANNEL_ID))) {
      await showNonMemberHint(ctx);
      return;
    }
    awaitingTopic.add(ctx.from.id);
    await ctx.reply("Напишите вашу тему одним сообщением.");
  });

  bot.command("cancel", async (ctx) => {
    awaitingTopic.delete(ctx.from.id);
    pendingDrafts.delete(ctx.from.id);
    awaitingIntent.delete(ctx.from.id);
    await ctx.reply(
      "Отменено.",
      (await isMember(ctx, CHANNEL_ID)) ? memberMenu() : newUserMenu()
    );
  });

  bot.on("message", async (ctx, next) => {
    try {
      // ответы админа при отклонении
      if (String(ctx.chat?.id) === String(ADMIN_CHAT_ID)) {
        const replyTo = ctx.message?.reply_to_message;
        if (replyTo) {
          const entry = pendingRejections.get(replyTo.message_id);
          if (entry) {
            await handleRejectionReason(ctx, entry, { ADMIN_CHAT_ID });
            return;
          }
        }
        const planB = pendingRejectionsByAdmin.get(ctx.from.id);
        if (planB) {
          await handleRejectionReason(ctx, planB, { ADMIN_CHAT_ID });
          return;
        }
      }

      const uid = ctx.from.id;

      // начало создания темы
      if (awaitingTopic.has(uid)) {
        if (!(await isMember(ctx, CHANNEL_ID))) {
          awaitingTopic.delete(uid);
          await showNonMemberHint(ctx);
          return;
        }

        awaitingTopic.delete(uid);

        pendingDrafts.set(uid, {
          items: [{ srcChatId: ctx.chat.id, srcMsgId: ctx.message.message_id }]
        });

        await ctx.reply(
          "Принято. Можете добавить ещё текст или медиа.\nКогда закончите — нажмите «✅ Готово».",
          composeKeyboard()
        );
        return;
      }

      // добавление сообщений в draft
      if (pendingDrafts.has(uid) && !awaitingIntent.has(uid)) {
        const session = pendingDrafts.get(uid);
        session.items.push({
          srcChatId: ctx.chat.id,
          srcMsgId: ctx.message.message_id
        });
        await ctx.reply("Добавлено. Нажмите «✅ Готово», когда закончите.", composeKeyboard());
        return;
      }

      // выбор типа публикации
      if (pendingDrafts.has(uid) && awaitingIntent.has(uid) && "text" in ctx.message) {
        const t = (ctx.message.text || "").trim();
        if (t === "1" || t === "2") {
          const session = pendingDrafts.get(uid);
          const intent = t === "1" ? "advice" : "express";

          const result = await submitDraftToModeration(
            { telegram: ctx.telegram, ADMIN_CHAT_ID },
            { user: ctx.from, draft: session, intent }
          );

          if (result?.channelMessageId) {
            const channelLink = `https://t.me/c/${String(CHANNEL_ID).replace("-100", "")}/${result.channelMessageId}`;
            await ctx.reply(`✅ Тема опубликована:\n${channelLink}`, memberMenu());
          } else {
            await ctx.reply("✅ Тема опубликована.", memberMenu());
          }

          pendingDrafts.delete(uid);
          awaitingIntent.delete(uid);
          return;
        }

        await ctx.reply("Пожалуйста, выберите вариант выше.");
        return;
      }

      return next();
    } catch (e) {
      console.error("moderation error:", e);
      return next();
    }
  });
}
