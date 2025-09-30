// index.js — Render (webhook) + локально (polling), ESM ("type": "module" в package.json)

import express from "express";
import { Telegraf, Markup } from "telegraf";

// ===== ENV =====
const {
  BOT_TOKEN,
  CHANNEL_ID,     // -100xxxxxxxxxx или @username
  ADMIN_CHAT_ID,  // chat_id админ-чата или личный ID (число/строка)
  APP_URL,        // https://<service>.onrender.com (Render -> Environment)
  PORT            // Render проставляет сам
} = process.env;

if (!BOT_TOKEN || !CHANNEL_ID || !ADMIN_CHAT_ID) {
  console.error("❌ Нужны переменные окружения: BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID");
  process.exit(1);
}

// ===== INIT =====
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Healthcheck
app.get("/", (_, res) => res.send("OK — bot is alive"));

// ===== UI =====
const mainMenu = () =>
  Markup.keyboard([["🔓 Запросить доступ в канал"], ["📝 Предложить тему/вопрос"]]).resize();

// /start
bot.start(async (ctx) => {
  await ctx.reply(
    "Привет! Я бот канала.\n\n— 🔓 Запросить доступ в канал\n— 📝 Предложить тему/вопрос (анонимно через модерацию)",
    mainMenu()
  );
});

// ===== STATE =====
// 1) кто сейчас пишет тему
const awaitingTopic = new Set();
// 2) ожидание причины отклонения: replyPromptMsgId -> { authorId, modMsgId, modText }
const pendingRejections = new Map();
// 3) связь «карточка модерации» -> оригинал сообщения пользователя
// controlMsgId -> { srcChatId, srcMsgId, authorId, adminCopyMsgId }
const pendingSubmissions = new Map();

// ===== ACCESS REQUEST (запрос доступа в канал) =====
bot.hears("🔓 Запросить доступ в канал", async (ctx) => {
  try {
    const link = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
      creates_join_request: true,
      name: `req_${ctx.from.id}_${Date.now()}`,
      expire_date: Math.floor(Date.now() / 1000) + 3600 // 1 час
    });

    await ctx.reply(
      "Нажмите, чтобы подать заявку в канал:",
      Markup.inlineKeyboard([[Markup.button.url("Подать заявку →", link.invite_link)]])
    );

    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 Новый запрос доступа от @${ctx.from.username || ctx.from.id} (id: ${ctx.from.id}).`
    );
  } catch (e) {
    console.error("createChatInviteLink error:", e);
    await ctx.reply("Ошибка при создании ссылки. Проверьте, что бот — админ канала.");
  }
});

// ===== JOIN REQUESTS (когда заявка приходит в канал) =====
bot.on("chat_join_request", async (ctx) => {
  const req = ctx.update.chat_join_request;
  const user = req.from;

  const dataApprove = JSON.stringify({ t: "approve", cid: req.chat.id, uid: user.id });
  const dataDecline = JSON.stringify({ t: "decline", cid: req.chat.id, uid: user.id });

  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `📩 Заявка в канал от @${user.username || user.id} (id: ${user.id})`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Одобрить", callback_data: dataApprove },
          { text: "❌ Отклонить", callback_data: dataDecline }
        ]]
      }
    }
  );
});

// ===== HELPERS =====
const isOldQueryError = (e) =>
  e?.description?.includes("query is too old") ||
  e?.description?.includes("query ID is invalid") ||
  e?.description?.includes("response timeout expired");

// ===== CALLBACKS =====
bot.on("callback_query", async (ctx) => {
  try {
    // быстро отвечаем, чтобы не протухал callback_query_id
    await ctx.answerCbQuery().catch(() => {});
    const payload = JSON.parse(ctx.update.callback_query.data || "{}");

    // --- Одобрить/Отклонить заявку в канал ---
    if (payload.t === "approve") {
      await ctx.telegram.approveChatJoinRequest(payload.cid, payload.uid);
      await ctx.editMessageReplyMarkup(); // убрать кнопки
      try { await ctx.telegram.sendMessage(payload.uid, "✅ Вам одобрен доступ в канал."); } catch {}
      return;
    }
    if (payload.t === "decline") {
      await ctx.telegram.declineChatJoinRequest(payload.cid, payload.uid);
      await ctx.editMessageReplyMarkup();
      try { await ctx.telegram.sendMessage(payload.uid, "❌ Доступ в канал отклонён."); } catch {}
      return;
    }

    // --- Публикация темы (копируем оригинал пользователя) ---
    if (payload.t === "publish") {
      const controlMsg = ctx.update.callback_query.message; // карточка в админ-чате
      const binding = pendingSubmissions.get(controlMsg.message_id);

      if (binding) {
        const { srcChatId, srcMsgId, authorId } = binding;
        await ctx.telegram.copyMessage(CHANNEL_ID, srcChatId, srcMsgId); // любой тип сообщения
        await ctx.editMessageReplyMarkup(); // убрать кнопки
        try { await ctx.telegram.sendMessage(authorId, "✅ Ваша тема опубликована."); } catch {}
        pendingSubmissions.delete(controlMsg.message_id);
        return;
      }

      // fallback (на случай старых карточек): публикуем саму карточку
      const adminMsg = ctx.update.callback_query.message;
      await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
      await ctx.editMessageReplyMarkup();
      try { await ctx.telegram.sendMessage(payload.uid, "✅ Ваша тема опубликована."); } catch {}
      return;
    }

    // --- Отклонение темы (с запросом причины) ---
    if (payload.t === "reject") {
      const modMsg = ctx.update.callback_query.message; // карточка
      const prompt = await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        "✍️ Напишите причину отклонения ответом на ЭТО сообщение (только текст).",
        { reply_to_message_id: modMsg.message_id }
      );
      pendingRejections.set(prompt.message_id, {
        authorId: payload.uid,
        modMsgId: modMsg.message_id,
        modText: modMsg.text || ""
      });
      return;
    }

    // --- fallback ---
    await ctx.answerCbQuery("Неизвестное действие").catch(() => {});
  } catch (e) {
    if (!isOldQueryError(e)) {
      console.error("callback_query error:", e);
    }
    try { await ctx.answerCbQuery("Ошибка").catch(() => {}); } catch {}
  }
});

// ===== Написать тему =====
bot.hears("📝 Предложить тему/вопрос", async (ctx) => {
  awaitingTopic.add(ctx.from.id);
  await ctx.reply("Напишите вашу тему одним сообщением (или /cancel для отмены).");
});

bot.command("cancel", async (ctx) => {
  awaitingTopic.delete(ctx.from.id);
  await ctx.reply("Отменено.", mainMenu());
});

// ===== Обработка входящих сообщений =====
// 1) ответ модератора с причиной (в админ-чате, reply на подсказку)
// 2) сообщение пользователя как тема (ЛЮБОЙ тип сообщения)
bot.on("message", async (ctx, next) => {
  try {
    // --- 1) Ответ модератора с причиной ---
    if (String(ctx.chat?.id) === String(ADMIN_CHAT_ID)) {
      const replyTo = ctx.message?.reply_to_message;
      if (replyTo) {
        const key = replyTo.message_id;
        if (pendingRejections.has(key)) {
          if (!("text" in ctx.message)) {
            await ctx.reply("Нужен текст. Напишите причину одним сообщением.", {
              reply_to_message_id: replyTo.message_id
            });
            return;
          }
          const { authorId, modMsgId, modText } = pendingRejections.get(key);
          pendingRejections.delete(key);

          const reason = ctx.message.text.trim();

          // уведомляем автора
          try {
            await ctx.telegram.sendMessage(
              authorId,
              `❌ Ваша тема отклонена.\nПричина: ${reason}`
            );
          } catch {}

          // убираем кнопки и помечаем карточку
          try {
            await ctx.telegram.editMessageReplyMarkup(ADMIN_CHAT_ID, modMsgId, undefined, {
              inline_keyboard: []
            });
            const updatedText =
              (modText || "📝 Тема") + `\n\n🚫 Отклонено. Причина: ${reason}`;
            await ctx.telegram.editMessageText(
              ADMIN_CHAT_ID,
              modMsgId,
              undefined,
              updatedText
            );
          } catch (e) {
            console.error("edit reject card error:", e);
          }

          // чистим связь «карточка -> исходник», если была
          pendingSubmissions.delete(modMsgId);

          await ctx.reply("✅ Причина отправлена автору. Отклонение зафиксировано.");
          return;
        }
      }
    }

    // --- 2) Пользователь прислал сообщение как тему (любой тип) ---
    if (awaitingTopic.has(ctx.from.id)) {
      awaitingTopic.delete(ctx.from.id);

      const srcChatId = ctx.chat.id;
      const srcMsgId = ctx.message.message_id;

      // инфо об авторе
      const userInfo =
        `👤 От: @${ctx.from.username || "—"}\n` +
        `ID: ${ctx.from.id}\n` +
        `Имя: ${[ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "—"}`;
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID, userInfo);

      // копируем ОРИГИНАЛ (любой тип) в админ-чат,
      // чтобы модератор видел именно то, что пойдёт в канал
      const copied = await ctx.telegram.copyMessage(ADMIN_CHAT_ID, srcChatId, srcMsgId);

      // карточка с кнопками под копией
      const cbData = (t) => JSON.stringify({ t, uid: ctx.from.id });
      const control = await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        "📝 Новая предложенная тема (см. сообщение выше).",
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "📣 Опубликовать", callback_data: cbData("publish") },
              { text: "🚫 Отклонить",   callback_data: cbData("reject")  }
            ]]
          }
        }
      );

      // связь карточки с исходником
      pendingSubmissions.set(control.message_id, {
        srcChatId,
        srcMsgId,
        authorId: ctx.from.id,
        adminCopyMsgId: copied.message_id
      });

      await ctx.reply("Тема отправлена на модерацию.");
      return;
    }

    // не наш кейс — дальше по цепочке
    return next();
  } catch (e) {
    console.error("message handler error:", e);
    return next();
  }
});

// ===== STARTUP: webhook (prod) / polling (local) =====
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => {
  console.log(`HTTP server listening on ${listenPort}`);
});

(async () => {
  try {
    if (APP_URL) {
      // PROD: WEBHOOK
      const secretPath = `/webhook/${BOT_TOKEN.slice(0, 10)}`;
      app.use(express.json());
      app.use(secretPath, bot.webhookCallback(secretPath));

      await bot.telegram.setWebhook(`${APP_URL}${secretPath}`, {
        drop_pending_updates: true
      });
      console.log("Webhook set to:", `${APP_URL}${secretPath}`);
    } else {
      // LOCAL: POLLING
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.launch({ dropPendingUpdates: true });
      console.log("Bot launched in polling mode");
    }
  } catch (err) {
    console.error("Bot start error:", err);
  }
})();

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
