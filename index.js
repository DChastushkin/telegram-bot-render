// index.js — версия для Render (webhook) + локальная (polling)
// ESM: "type": "module" в package.json

import express from "express";
import { Telegraf, Markup } from "telegraf";

// === ENV ===
// На Render переменные задаются в настройках сервиса.
// Локально можно использовать .env (через `dotenv/config`), но это опционально.
// Если хочешь .env локально — раскомментируй следующую строку и добавь пакет dotenv.
// import 'dotenv/config';

const {
  BOT_TOKEN,
  CHANNEL_ID,     // ДОЛЖЕН быть вида -100xxxxxxxxxx или @username
  ADMIN_CHAT_ID,  // ваш личный chat id (число)
  APP_URL,        // https://<service>.onrender.com  (задаётся на Render)
  PORT            // Render проставляет автоматически
} = process.env;

if (!BOT_TOKEN || !CHANNEL_ID || !ADMIN_CHAT_ID) {
  console.error("❌ Нужны переменные окружения: BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID");
  process.exit(1);
}

// === BOT & WEB ===
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Простой healthcheck
app.get("/", (_, res) => res.send("OK — bot is alive"));

// === UI ===
const mainMenu = () =>
  Markup.keyboard([["🔓 Запросить доступ в канал"], ["📝 Предложить тему/вопрос"]]).resize();

bot.start(async (ctx) => {
  await ctx.reply(
    "Привет! Я бот канала.\n\n— 🔓 Запросить доступ в канал\n— 📝 Предложить тему/вопрос (анонимно через модерацию)",
    mainMenu()
  );
});

// === STATE ===
const awaitingTopic = new Set();                           // кто сейчас пишет тему
const pendingRejections = new Map(); // replyPromptMsgId -> { authorId, modMsgId, modText }

// === ACCESS REQUEST ===
bot.hears("🔓 Запросить доступ в канал", async (ctx) => {
  try {
    // Создаём инвайт-ссылку с заявкой на присоединение (без member_limit)
    const link = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
      creates_join_request: true,
      name: `req_${ctx.from.id}_${Date.now()}`,
      expire_date: Math.floor(Date.now() / 1000) + 3600
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
    await ctx.reply("Ошибка при создании ссылки. Убедитесь, что бот — админ канала.");
  }
});

// === JOIN REQUESTS (когда заявка приходит в канал) ===
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

// === CALLBACKS ===
const isOldQueryError = (e) =>
  e?.description?.includes("query is too old") ||
  e?.description?.includes("query ID is invalid") ||
  e?.description?.includes("response timeout expired");

bot.on("callback_query", async (ctx) => {
  try {
    // моментально отвечаем, чтобы не протухал callback_query_id
    await ctx.answerCbQuery().catch(() => {});
    const payload = JSON.parse(ctx.update.callback_query.data || "{}");

    // Одобрение/отклонение заявок в канал
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

    // ПУБЛИКАЦИЯ предложенной темы
    if (payload.t === "publish") {
      const adminMsg = ctx.update.callback_query.message; // карточка темы в админ-чате
      await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
      await ctx.editMessageReplyMarkup(); // убрать кнопки
      try { await ctx.telegram.sendMessage(payload.uid, "✅ Ваша тема опубликована."); } catch {}
      return;
    }

    // ОТКЛОНЕНИЕ С ПРИЧИНОЙ
    if (payload.t === "reject") {
      const modMsg = ctx.update.callback_query.message; // карточка темы (с кнопками)
      const prompt = await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        "✍️ Напишите причину отклонения ответом на ЭТО сообщение (только текст).",
        { reply_to_message_id: modMsg.message_id }
      );
      // сохраним, к какой карточке относится ответ
      pendingRejections.set(prompt.message_id, {
        authorId: payload.uid,
        modMsgId: modMsg.message_id,
        modText: modMsg.text || "" // сохраним исходный текст карточки
      });
      return;
    }

    // fallback
    await ctx.answerCbQuery("Неизвестное действие").catch(() => {});
  } catch (e) {
    if (!isOldQueryError(e)) {
      console.error("callback_query error:", e);
    }
    try { await ctx.answerCbQuery("Ошибка").catch(() => {}); } catch {}
  }
});

// === Ввод темы пользователем ===
bot.hears("📝 Предложить тему/вопрос", async (ctx) => {
  awaitingTopic.add(ctx.from.id);
  await ctx.reply("Напишите вашу тему одним сообщением (или /cancel для отмены).");
});

bot.command("cancel", async (ctx) => {
  awaitingTopic.delete(ctx.from.id);
  await ctx.reply("Отменено.", mainMenu());
});

// === Обработка сообщений (две ветки: 1) ответ модератором с причиной, 2) текст темы от пользователя) ===
bot.on("message", async (ctx, next) => {
  try {
    // 1) Ответ модератора с причиной (должен быть в админ-чате и ответом на подсказку)
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

          // снимаем кнопки и правим текст карточки
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

          await ctx.reply("✅ Причина отправлена автору. Отклонение зафиксировано.");
          return;
        }
      }
    }

    // 2) Пользователь прислал текст темы
    if (awaitingTopic.has(ctx.from.id) && "text" in ctx.message) {
      awaitingTopic.delete(ctx.from.id);
      const text = ctx.message.text;

      // короткие callback_data: только тип и id автора
      const cbPublish = JSON.stringify({ t: "publish", uid: ctx.from.id });
      const cbReject  = JSON.stringify({ t: "reject",  uid: ctx.from.id });

      // сначала отправим карточку с данными автора (без кнопок)
      const userInfo =
        `👤 От: @${ctx.from.username || "—"}\n` +
        `ID: ${ctx.from.id}\n` +
        `Имя: ${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID, userInfo);

      // затем — сам текст темы с кнопками
      const posted = await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📝 Новая предложенная тема:\n\n${text}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "📣 Опубликовать", callback_data: cbPublish },
              { text: "🚫 Отклонить",   callback_data: cbReject }
            ]]
          }
        }
      );

      await ctx.reply("Тема отправлена на модерацию.");
      return;
    }

    // если это не наш случай — пропускаем дальше
    return next();
  } catch (e) {
    console.error("message handler error:", e);
    return next();
  }
});

// === STARTUP: webhook в проде, polling локально ===

// слушаем порт ВСЕГДА, чтобы Render видел, что сервис «живой»
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => {
  console.log(`HTTP server listening on ${listenPort}`);
});

(async () => {
  try {
    if (APP_URL) {
      // === PROD: WEBHOOK ===
      const secretPath = `/webhook/${BOT_TOKEN.slice(0, 10)}`;
      app.use(express.json());
      app.use(secretPath, bot.webhookCallback(secretPath));

      // сбрасываем старые апдейты на всякий
      await bot.telegram.setWebhook(`${APP_URL}${secretPath}`, {
        drop_pending_updates: true
      });
      console.log("Webhook set to:", `${APP_URL}${secretPath}`);
    } else {
      // === LOCAL: POLLING ===
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
