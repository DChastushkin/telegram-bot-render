// bot/handlers/moderation.js
import { newUserMenu, memberMenu, choiceKeyboard } from "../ui.js";
import { isMember, handleRejectionReason } from "../utils.js";
import { submitDraftToModeration } from "../submit.js";
import {
  awaitingTopic,
  pendingDrafts,
  pendingRejections,
  pendingRejectionsByAdmin
} from "../state.js";

function detectContentMeta(msg) {
  if ("text" in msg) return { kind: "text", supportsCaption: false, text: msg.text || "" };
  if (msg.photo) return { kind: "photo", supportsCaption: true, text: msg.caption || "" };
  if (msg.video) return { kind: "video", supportsCaption: true, text: msg.caption || "" };
  if (msg.animation) return { kind: "animation", supportsCaption: true, text: msg.caption || "" };
  if (msg.document) return { kind: "document", supportsCaption: true, text: msg.caption || "" };
  if (msg.audio) return { kind: "audio", supportsCaption: true, text: msg.caption || "" };
  if (msg.voice) return { kind: "voice", supportsCaption: true, text: msg.caption || "" };
  if (msg.video_note) return { kind: "video_note", supportsCaption: false, text: "" };
  if (msg.sticker) return { kind: "sticker", supportsCaption: false, text: "" };
  return { kind: "other", supportsCaption: false, text: "" };
}

export function registerModerationHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID } = env;

  // «Предложить тему» (только для участников)
  bot.hears("📝 Предложить тему/вопрос", async (ctx) => {
    if (!(await isMember(ctx, CHANNEL_ID))) {
      await ctx.reply("❌ Вы ещё не участник канала. Сначала запросите доступ.", newUserMenu());
      return;
    }
    awaitingTopic.add(ctx.from.id);
    await ctx.reply("Напишите вашу тему одним сообщением.");
  });

  bot.command("cancel", async (ctx) => {
    awaitingTopic.delete(ctx.from.id);
    await ctx.reply("Отменено.", await isMember(ctx, CHANNEL_ID) ? memberMenu() : newUserMenu());
  });

  // Общий обработчик сообщений
  bot.on("message", async (ctx, next) => {
    try {
      // 1) Ответ модератора с причиной (в админ-чате)
      if (String(ctx.chat?.id) === String(ADMIN_CHAT_ID)) {
        const replyTo = ctx.message?.reply_to_message;

        // 1a) Реплай на подсказку/карточку/копию
        if (replyTo) {
          const key = replyTo.message_id;
          const entry = pendingRejections.get(key);
          if (entry) {
            await handleRejectionReason(ctx, entry, { ADMIN_CHAT_ID });
            return;
          }
        }

        // 1b) «План Б»: следующее сообщение без реплая
        const planB = pendingRejectionsByAdmin.get(ctx.from.id);
        if (planB) {
          await handleRejectionReason(ctx, planB, { ADMIN_CHAT_ID });
          return;
        }
      }

      const uid = ctx.from.id;

      // 2) Пользователь прислал тему (любой тип), если ждали
      if (awaitingTopic.has(uid)) {
        if (!(await isMember(ctx, CHANNEL_ID))) {
          awaitingTopic.delete(uid);
          await ctx.reply("❌ Вы больше не участник канала. Сначала запросите доступ.", newUserMenu());
          return;
        }

        awaitingTopic.delete(uid);

        // сохраняем черновик + метаданные контента
        const meta = detectContentMeta(ctx.message);
        pendingDrafts.set(uid, {
          srcChatId: ctx.chat.id,
          srcMsgId: ctx.message.message_id,
          kind: meta.kind,
          supportsCaption: meta.supportsCaption,
          text: meta.text
        });

        // просим выбрать тип обращения (и даём fallback 1/2)
        await ctx.reply(
          "Выберите формат обращения (или отправьте цифру: 1 — нужен совет, 2 — хочу высказаться):",
          choiceKeyboard()
        );
        return;
      }

      // 3) Fallback: «1»/«2» вместо кнопок
      if (pendingDrafts.has(uid) && "text" in ctx.message) {
        const t = (ctx.message.text || "").trim();
        if (t === "1" || t === "2") {
          const draft = pendingDrafts.get(uid);
          const intent = t === "1" ? "advice" : "express";

          await submitDraftToModeration(
            { telegram: ctx.telegram, ADMIN_CHAT_ID },
            { user: ctx.from, draft, intent }
          );
          pendingDrafts.delete(uid);

          await ctx.reply("Тема отправлена на модерацию.", memberMenu());
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
