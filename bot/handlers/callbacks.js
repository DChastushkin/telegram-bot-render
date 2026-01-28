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

        const intent = data.v;

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

        await ctx.editMessageText(
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

        await ctx.editMessageText(
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
        await ctx.editMessageText("❌ Отменено.");
        return;
      }

      // =========================
      // ПУБЛИКАЦИЯ (АДМИН)
      // =========================
      if (type === "publish") {
        const adminMsg = ctx.callbackQuery.message;
        const submission = pendingSubmissions.get(adminMsg.message_id);

        if (!submission) {
          await ctx.answerCbQuery("Черновик не найден");
          return;
        }

        const items = Array.isArray(submission.items) ? submission.items : [];

        let firstPostedId = null;

        // 1️⃣ Публикуем пост (медиа или текст)
        if (items.length) {
          for (const it of items) {
            if (!it?.srcChatId || !it?.srcMsgId) continue;

            const res = await ctx.telegram.copyMessage(
              env.CHANNEL_ID,
              it.srcChatId,
              it.srcMsgId
            );

            if (!firstPostedId && res?.message_id) {
              firstPostedId = res.message_id;
            }
          }
        }

        if (!firstPostedId) {
          const sent = await ctx.telegram.sendMessage(
            env.CHANNEL_ID,
            adminMsg.text || "",
            { parse_mode: "HTML", disable_web_page_preview: true }
          );
          firstPostedId = sent.message_id;
        }

        // 2️⃣ 🔥 КЛЮЧЕВОЙ ФИКС: регистрируем discussion СРАЗУ
        try {
          const channelChat = await ctx.telegram.getChat(env.CHANNEL_ID);
          if (channelChat?.linked_chat_id) {
            channelToDiscussion.set(firstPostedId, {
              discussionChatId: channelChat.linked_chat_id,
              discussionMsgId: firstPostedId,
            });
          }
        } catch (e) {
          console.error("Failed to register discussion:", e);
        }

        // 3️⃣ Кнопка анонимного ответа
        const internalId = String(env.CHANNEL_ID).startsWith("-100")
          ? String(env.CHANNEL_ID).slice(4)
          : String(Math.abs(env.CHANNEL_ID));

        const anonLink = `https://t.me/${env.BOT_USERNAME}?start=anon_${firstPostedId}`;

        await ctx.telegram.editMessageReplyMarkup(
          env.CHANNEL_ID,
          firstPostedId,
          undefined,
          {
            inline_keyboard: [
              [{ text: "💬 Ответить анонимно", url: anonLink }],
            ],
          }
        );

        // 4️⃣ Уведомляем автора
        const postLink = `https://t.me/c/${internalId}/${firstPostedId}`;
        await ctx.telegram.sendMessage(
          submission.authorId,
          `✅ Ваша тема опубликована!\n\n🔗 ${postLink}`
        );

        pendingSubmissions.delete(adminMsg.message_id);

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
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
          pendingRejections.set(
            ctx.callbackQuery.message.message_id,
            submission
          );
          pendingRejectionsByAdmin.set(userId, submission);

          const prompt = await ctx.telegram.sendMessage(
            ctx.callbackQuery.message.chat.id,
            "✏️ Напишите причину отклонения ответом на это сообщение.",
            {
              reply_to_message_id:
                ctx.callbackQuery.message.message_id,
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
