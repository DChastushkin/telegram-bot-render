// bot/submit.js
import { pendingSubmissions } from "./state.js";

export const intentLabel = (intent) =>
  intent === "advice" ? "нужен совет" : "хочу высказаться";

const ADVICE_HEADER  = "Новое обращение от подписчика - требуется обратная связь";
const EXPRESS_HEADER = "Новая тема от подписчика";

// сместить entities на shift символов
function shiftEntities(entities = [], shift = 0) {
  if (!Array.isArray(entities) || shift === 0) return entities;
  return entities.map(e => ({ ...e, offset: e.offset + shift }));
}

// склеить несколько текстовых сегментов с сохранением entities
function joinTextWithEntities(segments, sep = "\n\n") {
  const parts = [];
  const outEntities = [];
  let base = 0;
  for (let i = 0; i < segments.length; i++) {
    const t = segments[i].text || "";
    const ents = Array.isArray(segments[i].entities) ? segments[i].entities : [];
    if (t.length > 0) {
      parts.push(t);
      for (const e of ents) outEntities.push({ ...e, offset: e.offset + base });
      base += t.length;
      if (i !== segments.length - 1) base += sep.length;
    }
  }
  return { text: parts.join(sep), entities: outEntities };
}

/**
 * Отправляет ПРЕВЬЮ в админ-чат (как будет в канале) и карточку модерации.
 * - Если есть медиа с подписью — делаем ОДНО сообщение: та медиа + caption = "шапка\n\nтексты".
 * - Иначе, если есть только текст — ОДНО текстовое сообщение: "шапка\n\nтексты".
 * - Иначе (только стикер/кружок и т.п.) — ДВА сообщения: (1) шапка, (2) сам контент.
 * В pendingSubmissions сохраняем adminPreviewMsgIds, чтобы «Отклонить» принимал реплай на превью.
 */
export async function submitDraftToModeration({ telegram, ADMIN_CHAT_ID }, { user, draft, intent }) {
  const header = intent === "advice" ? ADVICE_HEADER : EXPRESS_HEADER;
  const info =
    `👤 От: @${user.username || "—"}\n` +
    `ID: ${user.id}\n` +
    `Имя: ${[user.first_name, user.last_name].filter(Boolean).join(" ") || "—"}\n` +
    `Тип обращения: ${intentLabel(intent)}`;

  // 0) Сервиска про автора
  await telegram.sendMessage(ADMIN_CHAT_ID, info);

  // 1) Собираем тексты из элементов черновика
  const items = draft.items || [];
  const textSegments = items
    .map(it => ({ text: it.text || "", entities: it.entities || [] }))
    .filter(s => s.text && s.text.trim().length > 0);

  // 2) Выбираем «основной» элемент, чтобы превью было одним сообщением
  let primary = null;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].supportsCaption) { primary = items[i]; break; }
  }
  const onlyText = !primary && textSegments.length > 0;

  const adminPreviewMsgIds = [];

  if (primary) {
    // ОДНО сообщение: копируем МЕДИА + новая подпись с форматированием
    const { text: body, entities } = joinTextWithEntities(textSegments);
    const caption = body ? `${header}\n\n${body}` : header;
    const caption_entities = shiftEntities(entities, body ? header.length + 2 : 0);

    const copied = await telegram.copyMessage(
      ADMIN_CHAT_ID,
      primary.srcChatId,
      primary.srcMsgId,
      { caption, caption_entities }
    );
    adminPreviewMsgIds.push(copied.message_id);

  } else if (onlyText) {
    // ОДНО сообщение: чистый текст + entities
    const { text: body, entities } = joinTextWithEntities(textSegments);
    const combined = body ? `${header}\n\n${body}` : header;
    const finalEntities = shiftEntities(entities, body ? header.length + 2 : 0);

    const sent = await telegram.sendMessage(ADMIN_CHAT_ID, combined, { entities: finalEntities });
    adminPreviewMsgIds.push(sent.message_id);

  } else {
    // ДВА сообщения: (1) шапка, (2) первый элемент (например, стикер/кружок)
    const s1 = await telegram.sendMessage(ADMIN_CHAT_ID, header);
    adminPreviewMsgIds.push(s1.message_id);

    const first = items[0];
    const s2 = await telegram.copyMessage(ADMIN_CHAT_ID, first.srcChatId, first.srcMsgId);
    adminPreviewMsgIds.push(s2.message_id);
  }

  // 3) Карточка модерации
  const cb = (t) => JSON.stringify({ t, uid: user.id });
  const control = await telegram.sendMessage(
    ADMIN_CHAT_ID,
    "📝 Предпросмотр публикации (см. сообщение выше).",
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "📣 Опубликовать", callback_data: cb("publish") },
          { text: "🚫 Отклонить",   callback_data: cb("reject")  }
        ]]
      }
    }
  );

  // 4) Сохраняем заявку (для публикации берём исходные items, а для отклонения — превью id)
  pendingSubmissions.set(control.message_id, {
    authorId: user.id,
    intent,
    items,                // исходники — чтобы при публикации собрать точно такой же пост
    adminPreviewMsgIds    // id превью-сообщений в админ-чате (1 или 2)
  });
}
