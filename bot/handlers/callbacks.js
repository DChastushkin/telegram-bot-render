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
        const submission = pendingSubmissions.get(
          ctx.callbackQuery.message.message_id
        );

        if (!submission) {
          await ctx.answerCbQuery("Черновик не найден");
          return;
        }

        const originalText = ctx.callbackQuery.message.text;
        const items = Array.isArray(submission.items) ? submission.items : [];

        let firstPosted = null;
        let lastMsgId = null;

        if (items.length) {
          for (const it of items) {
            if (!it?.srcChatId || !it?.srcMsgId) continue;
            try {
              const msg = await ctx.telegram.copyMessage(
                env.CHANNEL_ID,
                it.srcChatId,
                it.srcMsgId,
                lastMsgId ? { reply_to_message_id: lastMsgId } : {}
              );
              if (msg?.message_id) {
                if (!firstPosted) firstPosted = msg;
                lastMsgId = msg.message_id;
              }
            } catch (e) {
              console.error("copyMessage to channel failed:", e);
            }
          }
        }

        if (!firstPosted) {
          firstPosted = await ctx.telegram.sendMessage(
            env.CHANNEL_ID,
            originalText,
            { parse_mode: "HTML", disable_web_page_preview: true }
          );
          lastMsgId = firstPosted.message_id;
        }

        if (firstPosted.message_thread_id) {
          channelToDiscussion.set(firstPosted.message_id, {
            discussionChatId: env.CHANNEL_ID,
            discussionMsgId: firstPosted.message_thread_id,
          });
        }

        const internalId = String(env.CHANNEL_ID).startsWith("-100")
          ? String(env.CHANNEL_ID).slice(4)
          : String(Math.abs(env.CHANNEL_ID));

        const postLink = `https://t.me/c/${internalId}/${firstPosted.message_id}`;
        const anonLink = `https://t.me/${env.BOT_USERNAME}?start=anon_${firstPosted.message_id}`;

        // 🔧 FIX: добавляем anon-link ВНУТРЬ канонического поста, без второго сообщения
        try {
          if (firstPosted.caption !== undefined) {
            const caption = `${firstPosted.caption || ""}\n\n💬 <a href="${anonLink}">Ответить анонимно</a>`;
            await ctx.telegram.editMessageCaption(
              env.CHANNEL_ID,
              firstPosted.message_id,
              undefined,
              caption,
              { parse_mode: "HTML" }
            );
          } else {
            const text = `${firstPosted.text || ""}\n\n💬 <a href="${anonLink}">Ответить анонимно</a>`;
            await ctx.telegram.editMessageText(
              env.CHANNEL_ID,
              firstPosted.message_id,
              undefined,
              text,
              { parse_mode: "HTML", disable_web_page_preview: true }
            );
          }
        } catch (e) {
          console.error("failed to attach anon link:", e);
        }

        await ctx.telegram.sendMessage(
          submission.authorId,
          `✅ Ваша тема опубликована!\n\n🔗 ${postLink}`
        );

        pendingSubmissions.delete(ctx.callbackQuery.message.message_id);

        try {
          if (ctx.callbackQuery?.message) {
            await ctx.telegram.editMessageReplyMarkup(
              ctx.callbackQuery.message.chat.id,
              ctx.callbackQuery.message.message_id,
              undefined,
              { inline_keyboard: [] }
            );
          }
        } catch (e) {
          console.error("editMessageReplyMarkup failed:", e);
        }

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
          pendingRejectionsByAdmin.set(userId, submission);

          const prompt = await ctx.telegram.sendMessage(
            ctx.callbackQuery.message.chat.id,
            "✏️ Напишите причину отклонения ответом на это сообщение.",
            {
              reply_to_message_id: ctx.callbackQuery.message.message_id,
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
