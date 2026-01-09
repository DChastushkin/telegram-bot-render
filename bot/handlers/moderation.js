import {
  newUserMenu,
  memberMenu,
  composeKeyboard,
  choiceKeyboard,
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
    return { kind: "text", supportsCaption: false, text: msg.text || "", entities: msg.entities || [] };
  if (msg.photo)
    return { kind: "photo", supportsCaption: true, text: msg.caption || "", entities: msg.caption_entities || [] };
  if (msg.video)
    return { kind: "video", supportsCaption: true, text: msg.caption || "", entities: msg.caption_entities || [] };
  if (msg.animation)
    return { kind: "animation", supportsCaption: true, text: msg.caption || "", entities: msg.caption_entities || [] };
  if (msg.document)
    return { kind: "document", supportsCaption: true, text: msg.caption || "", entities: msg.caption_entities || [] };
  if (msg.audio)
    return { kind: "audio", supportsCaption: true, text: msg.caption || "", entities: msg.caption_entities || [] };
  if (msg.voice)
    return { kind: "voice", supportsCaption: true, text: msg.caption || "", entities: msg.caption_entities || [] };
  if (msg.video_note)
    return { kind: "video_note", supportsCaption: false, text: "", entities: [] };
  if (msg.sticker)
    return { kind: "sticker", supportsCaption: false, text: "", entities: [] };
  return { kind: "other", supportsCaption: false, text: "", entities: [] };
}

export function registerModerationHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID, BOT_USERNAME } = env;

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
      // Админ: причины отклонения
      if (String(ctx.chat?.id) === String(ADMIN_CHAT_ID)) {
        const replyTo = ctx.message?.reply_to_message;
        if (replyTo) {
          const entry = pendingRejections.get(replyTo.message_id);
          if (entry) { await handleRejectionReason(ctx, entry, { ADMIN_CHAT_ID }); return; }
        }
        const planB = pendingRejectionsByAdmin.get(ctx.from.id);
        if (planB) { await handleRejectionReason(ctx, planB, { ADMIN_CHAT_ID }); return; }
      }

      const uid = ctx.from.id;

      // Старт темы
      if (awaitingTopic.has(uid)) {
        if (!(await isMember(ctx, CHANNEL_ID))) {
          awaitingTopic.delete(uid);
          await showNonMemberHint(ctx);
          return;
        }
        awaitingTopic.delete(uid);

        const meta = detectContentMeta(ctx.message);
        pendingDrafts.set(uid, {
          items: [{ srcChatId: ctx.chat.id, srcMsgId: ctx.message.message_id, ...meta }]
        });

        await ctx.reply(
          "Принято. Можете добавить ещё текст/медиа.\nКогда закончите — нажмите «✅ Готово».",
          composeKeyboard()
        );
        return;
      }

      // Накопление черновика
      if (pendingDrafts.has(uid) && !awaitingIntent.has(uid)) {
        const meta = detectContentMeta(ctx.message);
        const session = pendingDrafts.get(uid);
        session.items.push({ srcChatId: ctx.chat.id, srcMsgId: ctx.message.message_id, ...meta });
        await ctx.reply("Добавлено. Нажмите «✅ Готово», когда закончите.", composeKeyboard());
        return;
      }

      // После «Готово»
      if (pendingDrafts.has(uid) && awaitingIntent.has(uid) && "text" in ctx.message) {
        const t = (ctx.message.text || "").trim();
        if (t === "1" || t === "2") {
          const session = pendingDrafts.get(uid);
          const intent = t === "1" ? "advice" : "express";

          const result = await submitDraftToModeration(
            { telegram: ctx.telegram, ADMIN_CHAT_ID },
            { user: ctx.from, draft: session, intent }
          );

          // result.channelMessageId должен вернуться из submitDraftToModeration
          if (result?.channelMessageId && BOT_USERNAME) {
            const anonLink = `https://t.me/${BOT_USERNAME}?start=anon_${result.channelMessageId}`;
            await ctx.telegram.sendMessage(
              CHANNEL_ID,
              `<a href="${anonLink}">💬 Ответить анонимно</a>`,
              { parse_mode: "HTML" }
            );
          }

          pendingDrafts.delete(uid);
          awaitingIntent.delete(uid);

          await ctx.reply("Тема опубликована.", memberMenu());
          return;
        } else {
          await ctx.reply("Пожалуйста, нажмите кнопку выше или отправьте «1» / «2».");
          return;
        }
      }

      return next();
    } catch (e) {
      console.error("message handler error:", e);
      return next();
    }
  });
}
