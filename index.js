import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ЯВНО грузим .env из папки проекта и фиксируем кодировку
dotenv.config({ path: join(__dirname, '.env'), encoding: 'utf8' });

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;


if (!BOT_TOKEN || !CHANNEL_ID || !ADMIN_CHAT_ID) {
  console.error('❌ Проверьте .env: BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID должны быть заданы');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Главное меню
const mainMenu = () =>
  Markup.keyboard([
    ['🔓 Запросить доступ в канал'],
    ['📝 Предложить тему/вопрос']
  ]).resize();

// /start
bot.start(async (ctx) => {
  await ctx.reply(
    'Привет! Я бот канала.\n\n' +
    '— 🔓 Запросить доступ в канал\n' +
    '— 📝 Предложить тему/вопрос (анонимно через модерацию)',
    mainMenu()
  );
});


// Запросить доступ
bot.hears('🔓 Запросить доступ в канал', async (ctx) => {
  try {
    const link = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
  creates_join_request: true,
  name: `req_${ctx.from.id}_${Date.now()}`,
  // ВАЖНО: без member_limit при creates_join_request
  expire_date: Math.floor(Date.now() / 1000) + 3600 // можно оставить срок действия
});


    await ctx.reply(
      'Нажмите, чтобы подать заявку в канал:',
      Markup.inlineKeyboard([
        [Markup.button.url('Подать заявку →', link.invite_link)]
      ])
    );

    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 Новый запрос доступа от @${ctx.from.username || ctx.from.id} (id: ${ctx.from.id}).`
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка при создании ссылки. Убедитесь, что бот админ канала.');
  }
});

// Обработка join-заявок
bot.on('chat_join_request', async (ctx) => {
  const req = ctx.update.chat_join_request;
  const user = req.from;

  const dataApprove = JSON.stringify({ t: 'approve', cid: req.chat.id, uid: user.id });
  const dataDecline = JSON.stringify({ t: 'decline', cid: req.chat.id, uid: user.id });

  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `📩 Заявка в канал от @${user.username || user.id} (id: ${user.id})`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Одобрить', callback_data: dataApprove },
          { text: '❌ Отклонить', callback_data: dataDecline }
        ]]
      }
    }
  );
});

// Callback-кнопки
bot.on('callback_query', async (ctx) => {
  try {
    const payload = JSON.parse(ctx.update.callback_query.data);

    // Одобрение/отклонение заявок в канал
    if (payload.t === 'approve') {
      await ctx.telegram.approveChatJoinRequest(payload.cid, payload.uid);
      await ctx.answerCbQuery('Одобрено');
      // убираем кнопки у админ-сообщения
      await ctx.editMessageReplyMarkup();
      // уведомляем пользователя (если он писал боту)
      try { await ctx.telegram.sendMessage(payload.uid, '✅ Вам одобрен доступ в канал.'); } catch {}
      return;
    }
    if (payload.t === 'decline') {
      await ctx.telegram.declineChatJoinRequest(payload.cid, payload.uid);
      await ctx.answerCbQuery('Отклонено');
      await ctx.editMessageReplyMarkup();
      try { await ctx.telegram.sendMessage(payload.uid, '❌ Доступ в канал отклонён.'); } catch {}
      return;
    }

    // Публикация/отклонение предложенной темы
    if (payload.t === 'publish') {
      const adminMsg = ctx.update.callback_query.message; // сообщение с текстом темы в админ-чате
      // Копируем его в канал (анонимно, от имени канала)
      await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
      await ctx.answerCbQuery('Опубликовано');
      await ctx.editMessageReplyMarkup();
      try { await ctx.telegram.sendMessage(payload.uid, '✅ Ваша тема опубликована.'); } catch {}
      return;
    }
if (payload.t === 'reject') {
  // просим у админа причину отклонения ответом на сообщение
  const modMsg = ctx.update.callback_query.message; // карточка темы в админ-чате
  const prompt = await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    '✍️ Напишите причину отклонения ответом на ЭТО сообщение (только текст).',
    { reply_parameters: { message_id: modMsg.message_id }, reply_markup: { force_reply: true } }
  );
  // запоминаем ожидание: к какому сообщению придёт ответ и чей автор
  pendingRejections.set(prompt.message_id, { authorId: payload.uid, modMsgId: modMsg.message_id });
  await ctx.answerCbQuery('Жду причину в ответном сообщении');
  return;
}


    // На всякий случай
    await ctx.answerCbQuery('Неизвестное действие');
  } catch (e) {
    console.error(e);
    try { await ctx.answerCbQuery('Ошибка'); } catch {}
  }
});



// Отправка темы
const awaiting = new Set();
const pendingRejections = new Map(); // key: replyMessageId, value: { authorId, modMsgId }

bot.hears('📝 Предложить тему/вопрос', async (ctx) => {
  awaiting.add(ctx.from.id);
  await ctx.reply('Напишите вашу тему одним сообщением (или /cancel для отмены).');
});

bot.command('cancel', async (ctx) => {
  awaiting.delete(ctx.from.id);
  await ctx.reply('Отменено.', mainMenu());
});

// обработка причины отклонения (админ отвечает на подсказку)
bot.on('message', async (ctx, next) => {
  try {
    // нас интересуют только сообщения в админ-чате, которые являются ответом
    if (String(ctx.chat?.id) !== String(ADMIN_CHAT_ID)) return next();
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) return next();
    const key = replyTo.message_id;
    if (!pendingRejections.has(key)) return next();
    if (!('text' in ctx.message)) {
      await ctx.reply('Нужен текст. Напишите причину одним сообщением.', { reply_parameters: { message_id: replyTo.message_id } });
      return;
    }

    const { authorId, modMsgId } = pendingRejections.get(key);
    pendingRejections.delete(key);

    const reason = ctx.message.text.trim();

    // уведомляем автора
    try {
      await ctx.telegram.sendMessage(authorId, `❌ Ваша тема отклонена.\nПричина: ${reason}`);
    } catch {}

    // снимаем кнопки и помечаем в админ-карточке
    try {
      await ctx.telegram.editMessageReplyMarkup(ADMIN_CHAT_ID, modMsgId, undefined, { inline_keyboard: [] });
      await ctx.telegram.editMessageText(
        ADMIN_CHAT_ID,
        modMsgId,
        undefined,
        (await ctx.telegram.getMessage(ADMIN_CHAT_ID, modMsgId))?.text
          ? (await ctx.telegram.getMessage(ADMIN_CHAT_ID, modMsgId)).text + `\n\n🚫 Отклонено. Причина: ${reason}`
          : `🚫 Отклонено. Причина: ${reason}`
      );
    } catch {}

    await ctx.reply('✅ Причина отправлена автору. Отклонение зафиксировано.');
  } catch (e) {
    console.error(e);
    // не ломаем остальные хэндлеры
    return next();
  }
});


bot.on('message', async (ctx) => {
  if (!awaiting.has(ctx.from.id)) return;
  if (!('text' in ctx.message)) return;

  awaiting.delete(ctx.from.id);
  const text = ctx.message.text;

  // короткие callback_data, только действие + id автора
  const cbPublish = JSON.stringify({ t: 'publish', uid: ctx.from.id });
  const cbReject  = JSON.stringify({ t: 'reject',  uid: ctx.from.id });

  // 1) Сначала отправляем админам карточку с данными автора (БЕЗ кнопок)
  const userInfo =
    `👤 От: @${ctx.from.username || '—'}\n` +
    `ID: ${ctx.from.id}\n` +
    `Имя: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`;
  await ctx.telegram.sendMessage(ADMIN_CHAT_ID, userInfo);

  // 2) Затем — само сообщение ТОЛЬКО с текстом темы (С КНОПКАМИ)
  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `📝 Новая предложенная тема:\n\n${text}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '📣 Опубликовать', callback_data: cbPublish },
          { text: '🚫 Отклонить',   callback_data: cbReject }
        ]]
      }
    }
  );

  await ctx.reply('Тема отправлена на модерацию.');
});


// Запуск
bot.launch().then(() => console.log('🤖 Бот запущен (long polling)'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
