// bot/handlers/callbacks.js

import {
  pendingDrafts,
  pendingSubmissions,
  pendingRejections,
  pendingRejectionsByAdmin,
  awaitingIntent,
  channelToDiscussion,
} from "../state.js";

import { submitDraftToModeration } from "../submit.js";

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

      // =========================
      // ВЫБОР ТИПА ТЕМЫ
      // =========================
      if (type === "choose") {
        awaitingIntent.delete(ctx.from.id);
        pendingDrafts.set(ctx.from.id, { items: [] });

        await ctx.editMessageText(
          "✏️ Напишите тему. Можно отправить несколько сообщений.\nКогда закончите — нажмите «Готово»."
        );
        return;
      }

      // =========================
      // ГОТОВО → МОДЕРАЦИЯ
      // =========================
      if (type === "compose_done") {
        const draft = pendingDrafts.get(ctx.from.id);

        if (!draft || !draft.items.length) {
          await ctx.answerCbQuery("Черновик пуст");
          return;
        }

        await submitDraftToModeration(
          { telegram: ctx.telegram, ADMIN_CHAT_ID: env.ADMIN_CHAT_ID },
          {
            user: ctx.from,
            draft,
          }
        );

        pendingDrafts.delete(ctx.from.id);

        await ctx.editMessageText(
          "✅ Тема отправлена на модерацию.\nМы уведомим вас после проверки."
        );
        return;
      }

      // =========================
      // ПУБЛИКАЦИЯ (АДМИН)
      // =========================
      if (type === "publish") {
        const submission = pendingSubmissions.get(
          ctx.callbackQuery.message.message_id
        );

        if (!submission) {
          await ctx.answerCbQuery("Черновик не найден");
          return;
        }

        const posted = await ctx.telegram.copyMessage(
          env.CHANNEL_ID,
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id
        );

        // сохраняем связку канал → обсуждение
        if (posted.message_thread_id) {
          channelToDiscussion.set(posted.message_id, {
            discussionChatId: env.CHANNEL_ID,
            discussionMsgId: posted.message_thread_id,
          });
        }

        // ссылка на пост в приватном канале
        const internalId = String(env.CHANNEL_ID).startsWith("-100")
          ? String(env.CHANNEL_ID).slice(4)
          : String(Math.abs(env.CHANNEL_ID));

        const link = `https://t.me/c/${internalId}/${posted.message_id}`;

        await ctx.telegram.sendMessage(
          submission.authorId,
          `✅ Ваша тема опубликована!\n\n🔗 ${link}`
        );

        pendingSubmissions.delete(ctx.callbackQuery.message.message_id);

        await ctx.editMessageReplyMarkup();
        await ctx.answerCbQuery("Опубликовано");
        return;
      }

      // =========================
      // ОТКЛОНЕНИЕ
      // =========================
      if (type === "reject") {
        const submission = pendingSubmissions.get(
          ctx.callbackQuery.message.message_id
        );

        if (submission) {
          pendingRejections.set(ctx.callbackQuery.message.message_id, submission);
          pendingRejectionsByAdmin.set(ctx.from.id, submission);

          await ctx.telegram.sendMessage(
            ctx.from.id,
            "✏️ Напишите причину отклонения."
          );
        }

        await ctx.answerCbQuery("Введите причину");
      }
    } catch (e) {
      console.error("Callback error:", e);
    }
  });
}
