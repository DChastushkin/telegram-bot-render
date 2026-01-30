import {
  pendingDrafts,
  pendingSubmissions,
  pendingRejections,
  pendingRejectionsByAdmin,
  awaitingIntent,
  channelToDiscussion,
} from "../state.js";

import { submitDraftToModeration } from "../submit.js";
import { choiceKeyboard } from "../ui.js";

/**
 * Безопасное редактирование callback-сообщения.
 */
async function safeEditMessageText(ctx, text, extra) {
  if (ctx.callbackQuery?.message) {
    return ctx.editMessageText(text, extra);
  }
  return ctx.answerCbQuery();
}

async function safeClearReplyMarkup(ctx) {
  if (ctx.callbackQuery?.message) {
    return ctx.editMessageReplyMarkup();
  }
  return ctx.answerCbQuery();
}

export function registerCallbackHandlers(bot, env) {
  bot.on("callback_query", async (ctx) => {
    try {
      const raw = ctx.callbackQuery?.data;
      if (!raw) return;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      const type = data.t;
      const userId = ctx.from.id;

      // =========================
      // ВЫБОР ТИПА (после "Готово")
      // =========================
      if (type === "choose") {
        const draft = pendingDrafts.get(userId);

        if (!draft || !draft.items?.length) {
          await ctx.answerCbQuery("Черновик не найден");
          return;
        }

        const intent = data.v; // "advice" | "express"

        await submitDraftToModeration(
          {
            telegram: ctx.telegram,
            ADMIN_CHAT_ID: env.ADMIN_CHAT_ID,
            CHANNEL_ID: env.CHANNEL_ID,
            BOT_USERNAME: env.BOT_USERNAME,
          },
          {
            user: ctx.from,
            draft,
            intent,
          }
        );

        pendingDrafts.delete(userId);
        awaitingIntent.delete(userId);

        await safeEditMessageText(
          ctx,
          "✅ Тема отправлена на модерацию.\nМы уведомим вас после проверки."
        );
        return;
      }

      // =========================
      // ГОТОВО → ПОКАЗАТЬ ВЫБОР
      // =========================
      if (type === "compose_done") {
        const draft = pendingDrafts.get(userId);

        if (!draft || !draft.items?.length) {
          await ctx.answerCbQuery("Черновик пуст");
          return;
        }

        awaitingIntent.set(userId, "pending");

        await safeEditMessageText(
          ctx,
          "Выберите, что это:\n\n🧭 Нужен совет\n💬 Хочу высказаться",
          choiceKeyboard()
        );
        return;
      }

      // =========================
      // ОТМЕНА
      // =========================
      if (type === "compose_cancel") {
        pendingDrafts.delete(userId);
        awaitingIntent.delete(userId);
        await safeEditMessageText(ctx, "❌ Отменено.");
        return;
      }

      // =========================
      // ПУБЛИКАЦИЯ (АДМИН) — ВАРИАНТ A (по спецификации)
      // =========================
      if (type === "publish") {
        const msg = ctx.callbackQuery.message;
        if (!msg) {
          await ctx.answerCbQuery("Сообщение устарело");
          return;
        }

        const submission = pendingSubmissions.get(msg.message_id);
        if (!submission) {
          await ctx.answerCbQuery("Черновик не найден");
          return;
        }

        const SERVICE_HEADER =
          "Новое сообщение от подписчика — требуется обратная связь (или нужен совет)";

        const items = Array.isArray(submission.items) ? submission.items : [];

        const shiftEntities = (entities = [], shift = 0) => {
          if (!Array.isArray(entities) || shift === 0) return entities;
          return entities.map(e => ({ ...e, offset: e.offset + shift }));
        };

        let firstTextPostedId = null;
        let lastTextPostedId = null;

        // Текстовыми считаем ТОЛЬКО kind==="text" (как в твоём ТЗ: фото — отдельно, сервис под текстом)
        const textItems = items.filter(it => it && it.kind === "text" && typeof it.text === "string");
        const hasText = textItems.length > 0;

        for (const it of items) {
          if (!it) continue;

          // ===== ТЕКСТ =====
          if (it.kind === "text" && typeof it.text === "string") {
            const isFirstText = !firstTextPostedId;
            const isLastText = hasText && (it === textItems[textItems.length - 1]);

            const baseText = it.text || "";
            const baseEntities = Array.isArray(it.entities) ? it.entities : [];

            let outText = baseText;
            let outEntities = baseEntities;

            // Первая сервисная строка — ПЕРВОЙ строкой первого текстового сообщения
            if (isFirstText) {
              const prefix = SERVICE_HEADER + "\n\n";
              outText = prefix + outText;
              outEntities = shiftEntities(outEntities, prefix.length);
            }

            // Последний текст — добавляем в конце кликабельную фразу (URL скрыт)
            if (isLastText) {
              const phrase = "💬 Ответить анонимно";
              const suffix = "\n\n" + phrase;
              outText = outText + suffix;

              const sent = await ctx.telegram.sendMessage(
                env.CHANNEL_ID,
                outText,
                { entities: outEntities, disable_web_page_preview: true }
              );

              if (!firstTextPostedId) firstTextPostedId = sent.message_id;
              lastTextPostedId = sent.message_id;

              const finalAnonUrl = `https://t.me/${env.BOT_USERNAME}?start=anon:${sent.message_id}`;
              const phraseOffset = outText.length - phrase.length;

              const finalEntities = (outEntities || []).slice();
              finalEntities.push({
                type: "text_link",
                offset: phraseOffset,
                length: phrase.length,
                url: finalAnonUrl
              });

              try {
                await ctx.telegram.editMessageText(
                  env.CHANNEL_ID,
                  sent.message_id,
                  undefined,
                  outText,
                  { entities: finalEntities, disable_web_page_preview: true }
                );
              } catch (e) {
                console.error("edit last text link failed:", e);
              }

              continue;
            }

            // Обычный текст (не последний)
            const sent = await ctx.telegram.sendMessage(
              env.CHANNEL_ID,
              outText,
              { entities: outEntities, disable_web_page_preview: true }
            );

            if (!firstTextPostedId) firstTextPostedId = sent.message_id;
            lastTextPostedId = sent.message_id;
            continue;
          }

          // ===== МЕДИА (photo/video/document/…) — копируем как отдельный пост =====
          if (it.srcChatId && it.srcMsgId) {
            try {
              await ctx.telegram.copyMessage(
                env.CHANNEL_ID,
                it.srcChatId,
                it.srcMsgId
              );
            } catch (e) {
              console.error("copyMessage to channel failed:", e);
            }
          }
        }

        // CASE: текста нет вообще — создаём отдельное сервисное сообщение из 2 строк
        if (!lastTextPostedId) {
          const phrase = "💬 Ответить анонимно";
          const serviceText = `${SERVICE_HEADER}\n${phrase}`;

          const sent = await ctx.telegram.sendMessage(
            env.CHANNEL_ID,
            serviceText,
            { disable_web_page_preview: true }
          );

          const finalAnonUrl = `https://t.me/${env.BOT_USERNAME}?start=anon:${sent.message_id}`;
          const phraseOffset = serviceText.length - phrase.length;

          try {
            await ctx.telegram.editMessageText(
              env.CHANNEL_ID,
              sent.message_id,
              undefined,
              serviceText,
              {
                entities: [{
                  type: "text_link",
                  offset: phraseOffset,
                  length: phrase.length,
                  url: finalAnonUrl
                }],
                disable_web_page_preview: true
              }
            );
          } catch (e) {
            console.error("edit service link failed:", e);
          }

          lastTextPostedId = sent.message_id;
        }

        // Уведомляем автора ссылкой на ПОСЛЕДНИЙ текстовый/сервисный пост (там обсуждение)
        const internalId = String(env.CHANNEL_ID).startsWith("-100")
          ? String(env.CHANNEL_ID).slice(4)
          : String(Math.abs(env.CHANNEL_ID));
        const postLink = `https://t.me/c/${internalId}/${lastTextPostedId}`;

        try {
          await ctx.telegram.sendMessage(
            submission.authorId,
            `✅ Ваша тема опубликована!\n\n🔗 ${postLink}`
          );
        } catch (e) {
          console.error("notify author failed:", e);
        }

        // NOTE: channelToDiscussion заполняется в index.js автоматически,
        // когда в обсуждении появляется forward_from_message_id для этого channelMsgId.
        pendingSubmissions.delete(msg.message_id);

        await safeClearReplyMarkup(ctx);
        await ctx.answerCbQuery("Опубликовано");
        return;
      }

      // =========================
      // ОТКЛОНЕНИЕ
      // =========================
      if (type === "reject") {
        const msg = ctx.callbackQuery.message;
        if (!msg) {
          await ctx.answerCbQuery("Сообщение устарело");
          return;
        }

        const submission = pendingSubmissions.get(msg.message_id);
        if (submission) {
          pendingRejections.set(msg.message_id, submission);
          pendingRejectionsByAdmin.set(userId, submission);

          const prompt = await ctx.telegram.sendMessage(
            msg.chat.id,
            "✏️ Напишите причину отклонения ответом на это сообщение.",
            {
              reply_to_message_id: msg.message_id,
              reply_markup: { force_reply: true },
            }
          );

          if (prompt?.message_id) {
            pendingRejections.set(prompt.message_id, submission);
          }
        }

        await ctx.answerCbQuery("Введите причину");
        return;
      }
    } catch (e) {
      console.error("Callback error:", e);
    }
  });
}
