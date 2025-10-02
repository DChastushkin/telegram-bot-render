// bot.js — логика бота: админ-чат, умное меню, модерация, публикация любых медиа
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
  // replyMsgId -> { authorId, modMsgId, modText }
  const pendingRejections = new Map();
  // controlMsgId -> { srcChatId, srcMsgId, authorId, adminCopyMsgId }
  const pendingSubmissions = new Map();

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
      // если бот не может проверить (нет прав в канале) — считаем не участником
      return false;
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

  // ===== Служебные команды =====
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
      // Проверим статус заранее
      const member = await ctx.telegram.getChatMember(CHANNEL_ID, ctx.from.id).catch(() => null);

      if (member?.status === "kicked") {
        await ctx.reply("❌ Вы в списке заблокированных. Напишите администратору, чтобы вас разблокировали.");
        // кнопка для модераторов «Разблокировать»
        await ctx.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🛑 Запрос доступа от заблокированного пользователя @${ctx.from.username || ctx.from.id} (id: ${ctx.from.id})`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "🔓 Разблокировать", callback_data: JSON.stringify({ t: "unban", uid: ctx.from.id }) }
              ]]
            }
          }
        );
        return;
      }

      if (["member", "administrator", "creator"].includes(member?.status)) {
        await ctx.reply("✅ Вы уже участник канала. Можете предлагать темы.", memberMenu());
        return;
      }

      // Создаём инвайт-ссылку без срока жизни (создаёт join request)
      const link = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
        creates_join_request: true,
        name: `req_${ctx.from.id}_${Date.now()}`
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

      // --- Unban (разблокировать пользователя) ---
      if (payload.t === "unban") {
        try {
          await ctx.telegram.unbanChatMember(CHANNEL_ID, payload.uid);
          await ctx.editMessageReplyMarkup(); // убрать кнопку
          try {
            await ctx.telegram.sendMessage(payload.uid, "✅ Вы разблокированы. Нажмите «Запросить доступ» ещё раз.");
          } catch {}
        } catch (e) {
          console.error("unban error:", e);
        }
        return;
      }

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

        // fallback: на случай очень старых карточек
        const adminMsg = ctx.update.callback_query.message;
        await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
        await ctx.editMessageReplyMarkup();
        try { await ctx.telegram.sendMessage(payload.uid, "✅ Ваша тема опубликована."); } catch {}
        return;
      }

      // --- Отклонение темы с причиной (устойчивые ответы) ---
      if (payload.t === "reject") {
        const controlMsg = ctx.update.callback_query.message; // карточка с кнопками

        // Подсказка «напишите причину» с reply на карточку
        const prompt = await ctx.telegram.sendMessage(
          ADMIN_CHAT_ID,
          "✍️ Напишите причину отклонения ответом на ЭТО сообщение (только текст).",
          { reply_to_message_id: controlMsg.message_id }
        );

        // Базовые данные для отклонения
        const entry = {
          authorId: payload.uid,
          modMsgId: controlMsg.message_id,
          modText: controlMsg.text || ""
        };

        // Примем ответ, если модератор ответит на:
        // 1) подсказку,
        pendingRejections.set(prompt.message_id, entry);
        // 2) карточку с кнопками,
        pendingRejections.set(controlMsg.message_id, entry);
        // 3) скопированный оригинал автора (если есть привязка)
        const binding = pendingSubmissions.get(controlMsg.message_id);
        if (binding?.adminCopyMsgId) {
          pendingRejections.set(binding.adminCopyMsgId, entry);
        }

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
          const entry = pendingRejections.get(key);
          if (entry) {
            if (!("text" in ctx.message)) {
              await ctx.reply("Нужен текст. Напишите причину одним сообщением.", {
                reply_to_message_id: replyTo.message_id
              });
              return;
            }

            const { authorId, modMsgId, modText } = entry;
            const reason = ctx.message.text.trim();

            // 1) уведомляем автора
            let sentToAuthor = true;
            try {
              await ctx.telegram.sendMessage(
                authorId,
                `❌ Ваша тема отклонена.\nПричина: ${reason}`
              );
            } catch (e) {
              sentToAuthor = false;
              await ctx.reply("⚠️ Не удалось отправить причину автору (возможно, закрыты ЛС боту).");
            }

            // 2) снимаем кнопки и помечаем карточку
            try {
              await ctx.telegram.editMessageReplyMarkup(ADMIN_CHAT_ID, modMsgId, undefined, { inline_keyboard: [] });
              const updatedText = (modText || "📝 Тема") + `\n\n🚫 Отклонено. Причина: ${reason}`;
              await ctx.telegram.editMessageText(ADMIN_CHAT_ID, modMsgId, undefined, updatedText);
            } catch {
              // если карточка была не текстовой — добавим отдельным сообщением
              await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `🚫 Отклонено. Причина: ${reason}`, {
                reply_to_message_id: modMsgId
              });
            }

            // 3) подчистим все ключи, связанные с этой карточкой
            for (const [k, v] of pendingRejections.entries()) {
              if (v.modMsgId === modMsgId) pendingRejections.delete(k);
            }
            pendingSubmissions.delete(modMsgId);

            await ctx.reply(`✅ Отклонение зафиксировано.${sentToAuthor ? "" : " (Автору не доставлено)"}`);
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

        // карточка модерации (любой модератор может нажать)
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
