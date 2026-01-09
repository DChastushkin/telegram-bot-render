import { Markup } from "telegraf";
import { newUserMenu, memberMenu, showMenuByStatus } from "../ui.js";
import { safeSendMessage } from "../utils.js";

export function registerAccessHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID } = env;

  // /id — удобный способ узнать chat.id
  bot.command("id", async (ctx) => ctx.reply(`chat.id = ${ctx.chat.id}`));

  // /start — показать «умное» меню
  bot.start(async (ctx) => {
    await ctx.reply("Привет! Я бот канала.");
    await showMenuByStatus(ctx, CHANNEL_ID);
  });

  // «Запросить доступ»
  bot.hears("🔓 Запросить доступ в канал", async (ctx) => {
    try {
      const m = await ctx.telegram.getChatMember(CHANNEL_ID, ctx.from.id).catch(() => null);

      if (m?.status === "kicked") {
        await ctx.reply("❌ Вы заблокированы. Напишите администратору, чтобы вас разблокировали.");

        await safeSendMessage(
          ctx.telegram,
          ADMIN_CHAT_ID,
          `🛑 Запрос доступа от заблокированного пользователя @${ctx.from.username || ctx.from.id} (id: ${ctx.from.id})`,
          {
            reply_markup: {
              inline_keyboard: [[
                {
                  text: "🔓 Разблокировать",
                  callback_data: JSON.stringify({ t: "unban", uid: ctx.from.id })
                }
              ]]
            }
          }
        );
        return;
      }

      if (["member", "administrator", "creator"].includes(m?.status)) {
        await ctx.reply("✅ Вы уже участник. Можете предлагать темы.", memberMenu());
        return;
      }

      const link = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
        creates_join_request: true,
        name: `req_${ctx.from.id}_${Date.now()}`
      });

      await ctx.reply(
        "Нажмите, чтобы подать заявку в канал:",
        Markup.inlineKeyboard([
          [Markup.button.url("Подать заявку →", link.invite_link)]
        ])
      );

      await safeSendMessage(
        ctx.telegram,
        ADMIN_CHAT_ID,
        `🔔 Новый запрос доступа от @${ctx.from.username || ctx.from.id} (id: ${ctx.from.id}).`
      );

    } catch (e) {
      console.error("createChatInviteLink error:", e);
      await ctx.reply("Ошибка при создании ссылки. Проверьте, что бот — админ канала.");
    }
  });

  // Событие заявок (приходит от канала)
  bot.on("chat_join_request", async (ctx) => {
    const req = ctx.update.chat_join_request;
    const u = req.from;

    const approve = JSON.stringify({ t: "approve", cid: req.chat.id, uid: u.id });
    const decline = JSON.stringify({ t: "decline", cid: req.chat.id, uid: u.id });

    await safeSendMessage(
      ctx.telegram,
      ADMIN_CHAT_ID,
      `📩 Заявка в канал от @${u.username || u.id} (id: ${u.id})`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Одобрить", callback_data: approve },
            { text: "❌ Отклонить", callback_data: decline }
          ]]
        }
      }
    );
  });
}
