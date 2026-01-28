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
      // ПУБЛИКАЦИЯ (АДМИН)
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

        const items = Array.isArray(submission.items) ? submission.items : [];

        // 1) Публикуем в канал: медиа/сообщения пользователя → copyMessage; если нет items → текстом.
        let firstPostedId = null;

        if (items.length) {
          for (const it of items) {
            if (!it?.srcChatId || !it?.srcMsgId) continue;
            try {
              const res = await ctx.telegram.copyMessage(
                env.CHANNEL_ID,
                it.srcChatId,
                it.srcMsgId
              );
              if (!firstPostedId && res?.message_id) {
                firstPostedId = res.message_id;
              }
            } catch (e) {
              console.error("copyMessage to channel failed:", e);
            }
          }
        }

        if (!firstPostedId) {
          const posted = await ctx.telegram.sendMessage(
            env.CHANNEL_ID,
            msg.text || "",
            { parse_mode: "HTML", disable_web_page_preview: true }
          );
          firstPostedId = posted.message_id;
        }

        // 2) ✅ КЛЮЧЕВОЙ ФИКС: получаем реальное сообщение в discussion group через getDiscussionMessage
        // и сохраняем правильную связку для анонимных комментариев.
        try {
          const dmsg = await ctx.telegram.getDiscussionMessage(
            env.CHANNEL_ID,
            firstPostedId
          );

          if (dmsg?.chat?.id && dmsg?.message_id) {
            channelToDiscussion.set(firstPostedId, {
              discussionChatId: dmsg.chat.id,
              discussionMsgId: dmsg.message_id,
            });
            console.error("✅ discussion mapped", {
              channelMsgId: firstPostedId,
              discussionChatId: dmsg.chat.id,
              discussionMsgId: dmsg.message_id,
            });
          } else {
            console.error("⚠️ getDiscussionMessage returned empty", dmsg);
          }
        } catch (e) {
          console.error("❌ getDiscussionMessage failed:", e);
        }

        // 3) Кнопка "Ответить анонимно" под каноническим постом
        const anonLink = `https://t.me/${env.BOT_USERNAME}?start=anon_${firstPostedId}`;

        try {
          await ctx.telegram.editMessageReplyMarkup(
            env.CHANNEL_ID,
            firstPostedId,
            undefined,
            {
              inline_keyboard: [[{ text: "💬 Ответить анонимно", url: anonLink }]],
            }
          );
        } catch (e) {
          console.error("attach anon button failed:", e);
        }

        // 4) Уведомляем автора ссылкой на пост
        const internalId = String(env.CHANNEL_ID).startsWith("-100")
          ? String(env.CHANNEL_ID).slice(4)
          : String(Math.abs(env.CHANNEL_ID));
        const postLink = `https://t.me/c/${internalId}/${firstPostedId}`;

        try {
          await ctx.telegram.sendMessage(
            submission.authorId,
            `✅ Ваша тема опубликована!\n\n🔗 ${postLink}`
          );
        } catch (e) {
          console.error("notify author failed:", e);
        }

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
