// bot.js — логика бота: умное меню, админ-чат, модерация, публикация любых медиа
import { Telegraf, Markup } from "telegraf";

export function createBot(env) {
  const { BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID } = env;
  const bot = new Telegraf(BOT_TOKEN);

  // ===== UI (две разные клавиатуры) =====
  const newUserMenu = () =>
    Markup.keyboard([["🔓 Запросить доступ в канал"]]).resize();
  const memberMenu = () =>
    Markup.keyboard([["📝 Предложить тему/вопрос"]]).resize();

  // ===== STATE =====
  const awaitingTopic = new Set();        // кто сейчас пишет тему
  const pendingRejections = new Map();    // replyPromptMsgId -> { authorId, modMsgId, modText }
  const pendingSubmissions = new Map();   // controlMsgId -> { srcChatId, srcMsgId, authorId, adminCopyMsgId }

  // ===== Helpers =====
  const isOldQueryError = (e) =>
    e?.description?.includes("query is too old") ||
    e?.description?.includes("query ID is invalid") ||
    e?.description?.includes("response timeout expired");

  async function isMember(ctx, userId) {
    try {
      const uid = userId ?? ctx.from?.id;
      const m = await ctx.telegram.getChatMember(CHANNEL_ID, uid);
      return ["member", "administrator", "creator"].includes(m.status);
    } catch {
      return false; // если бот не может проверить (нет прав в канале) — считаем не участником
    }
  }

  async function showMenuByStatus(ctx) {
    const member = await isMember(ctx);
    if (member) {
      await ctx.reply("Вы участник канала. Можете предложить тему.", memberMenu());
    } else {
      await ctx.reply("Чтобы предлагать темы, запросите доступ в канал.", newUserMenu());
    }
  }

  // ===== Служебные команды (помогают настроить админ-чат) =====
  // /id — вернёт chat.id (удобно, чтобы выставить ADMIN_CHAT_ID)
  bot.command("id", async (ctx) => {
    await ctx.reply(`chat.id = ${ctx.chat.id}`);
  });

  // ===== /start =====
  bot.start(async (ctx) => {
    await ctx.reply("Привет! Я бот канала.");
    await showMenuByStatus(ctx);
  });

  // ===== Запрос доступа =====
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

  // ===== Входящие заявки в канал (событие из канала) =====
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

  // ===== Кнопки модерации (только из админ-чата!) =====
  bot.on("callback_query", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      // защита: принимать клики только из админ-чата
      if (String(ctx.chat?.id) !== String(ADMIN_CHAT_ID)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }

      const payload = JSON.parse(ctx.update.callback_query.data || "{}");

      // --- Одобрить/Отклонить заявку в канал ---
      if (payload.t === "approve") {
        await ctx.telegram.approveChatJoinRequest(payload.cid, payload.uid);
        await ctx.editMessageReplyMarkup();
        try {
          await ctx.telegram.sendMessage(payload.uid, "✅ Вам одобрен доступ в канал.");
          // Показать меню участника
          await ctx.telegram.sendMessage(
            payload.uid,
            "Добро пожаловать! Теперь вы можете предложить тему.",
            { reply_markup: memberMenu().reply_markup }
          );
        } catch {}
        return;
      }
      if (payload.t === "decline") {
        await ctx.telegram.declineChatJoinRequest(payload.cid, payload.uid);
        await ctx.editMessageReplyMarkup();
        try { await ctx.telegram.sendMessage(payload.uid, "❌ Доступ в канал отклонён."); } catch {}
        return;
      }

      // --- Публикация темы (копируем ОРИГИНАЛ пользователя в канал) ---
      if (payload.t === "publish") {
        const controlMsg = ctx.update.callback_query.message;
        const binding = pendingSubmissions.get(controlMsg.message_id);

        if (binding) {
          const { srcChatId, srcMsgId, authorId } = binding;
          await ctx.telegram.copyMessage(CHANNEL_ID, srcChatId, srcMsgId);
          await ctx.editMessageReplyMarkup(); // убрать кнопки
          try { await ctx.telegram.sendMessage(authorId, "✅ Ваша тема опубликована."); } catch {}
          pendingSubmissions.delete(controlMsg.message_id);
          return;
        }

        // fallback: на случай старых карточек
        const adminMsg = ctx.update.callback_query.message;
        await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
        await ctx.editMessageReplyMarkup();
        try { await ctx.telegram.sendMessage(payload.uid, "✅ Ваша тема опубликована."); } catch {}
        return;
      }

      // --- Отклонение темы с причиной ---
      if (payload.t === "reject") {
        const modMsg = ctx.update.callback_query.message;
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

      await ctx.answerCbQuery("Неизвестное действие").catch(() => {});
    } catch (e) {
      if (!isOldQueryError(e)) console.error("callback_query error:", e);
      try { await ctx.answerCbQuery("Ошибка").catch(() => {}); } catch {}
    }
  });

  // ===== Кнопка «Предложить тему» (только для участников канала) =====
  bot.hears("📝 Предложить тему/вопрос", async (ctx) => {
    const member = await isMember(ctx);
    if (!member) {
      await ctx.reply("❌ Вы ещё не участник канала. Сначала запросите доступ.", newUserMenu());
      return;
    }
    awaitingTopic.add(ctx.from.id);
    await ctx.reply("Напишите вашу тему одним сообщением (или /cancel для отмены).");
  });

  bot.command("cancel", async (ctx) => {
    awaitingTopic.delete(ctx.from.id);
    await showMenuByStatus(ctx);
  });

  // ===== Обработка сообщений =====
  // 1) ответ модератора с причиной (reply в админ-чате)
  // 2) сообщение пользователя как тема (ЛЮБОЙ тип; только для участников)
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

            // снимаем кнопки и помечаем карточку
            try {
              await ctx.telegram.editMessageReplyMarkup(ADMIN_CHAT_ID, modMsgId, undefined, {
                inline_keyboard: []
              });
              const updatedText = (modText || "📝 Тема") + `\n\n🚫 Отклонено. Причина: ${reason}`;
              await ctx.telegram.editMessageText(ADMIN_CHAT_ID, modMsgId, undefined, updatedText);
            } catch (e) {
              console.error("edit reject card error:", e);
            }

            // если была связь с исходником — чистим
            pendingSubmissions.delete(modMsgId);

            await ctx.reply("✅ Причина отправлена автору. Отклонение зафиксировано.");
            return;
          }
        }
      }

      // --- 2) Пользователь прислал тему (любой тип), если в процессе ввода ---
      if (awaitingTopic.has(ctx.from.id)) {
        // доп. защита: проверим членство ещё раз
        const member = await isMember(ctx);
        if (!member) {
          awaitingTopic.delete(ctx.from.id);
          await ctx.reply("❌ Вы больше не участник канала. Сначала запросите доступ.", newUserMenu());
          return;
        }

        awaitingTopic.delete(ctx.from.id);

        const srcChatId = ctx.chat.id;
        const srcMsgId = ctx.message.message_id;

        // информация об авторе (в админ-чат)
        const userInfo =
          `👤 От: @${ctx.from.username || "—"}\n` +
          `ID: ${ctx.from.id}\n` +
          `Имя: ${[ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "—"}`;
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, userInfo);

        // копируем ОРИГИНАЛ (любой тип) в админ-чат
        const copied = await ctx.telegram.copyMessage(ADMIN_CHAT_ID, srcChatId, srcMsgId);

        // карточка модерации (видна всем в админ-чате; любой может нажать)
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

        await ctx.reply("Тема отправлена на модерацию.", memberMenu());
        return;
      }

      // не наш кейс — передаём дальше
      return next();
    } catch (e) {
      console.error("message handler error:", e);
      return next();
    }
  });

  return bot;
}
