import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { DateTime } from 'luxon';
import { runPending } from '../actions.js';
import type { Agent, AgentReply } from '../agent/agent.js';
import { signState } from '../lib/crypto.js';
import { errMsg } from '../lib/log.js';
import { classifyImport } from '../modules/importer.js';
import { buildEveningReport, buildMorningReport } from '../modules/reports.js';
import { toOggOpus, plainForSpeech } from '../integrations/tts.js';
import { esc, type Services } from '../services.js';
import type { PendingAction } from '../store/pending.js';

const TG_LIMIT = 4000;
const VOICE_MAX_CHARS = 900;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TEXT_FILE = /\.(txt|md|csv|json|log|html?)$/i;

/** Splits on paragraph boundaries so HTML tags of one section stay together. */
export function chunk(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    if (para.length > limit) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < para.length; i += limit) out.push(para.slice(i, i + limit));
      continue;
    }
    if ((cur + '\n\n' + para).length > limit && cur) {
      out.push(cur);
      cur = para;
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}

export function confirmKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text('✅ Підтвердити', `pend:ok:${id}`).text('❌ Скасувати', `pend:no:${id}`);
}

function importKeyboard(id: string, projects: string[], withConfirm: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (withConfirm) kb.text('✅ Підтвердити', `pend:ok:${id}`).text('❌ Скасувати', `pend:no:${id}`).row().text('🔁 Інший проєкт', `pend:pick:${id}`);
  else {
    projects.forEach((p, i) => {
      kb.text(p, `pend:set:${id}:${i}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text('❌ Скасувати', `pend:no:${id}`);
  }
  return kb;
}

export function createBot(s: Services, agent: Agent): Bot {
  const { cfg } = s;
  const bot = new Bot(cfg.TELEGRAM_BOT_TOKEN);
  const ownerId = cfg.OWNER_TELEGRAM_ID;

  s.downloadFile = async (fileId) => {
    const f = await bot.api.getFile(fileId);
    if (!f.file_path) throw new Error('Telegram не повернув file_path');
    const res = await fetch(`https://api.telegram.org/file/bot${cfg.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
    if (!res.ok) throw new Error(`Telegram file HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  s.notify = async (html) => {
    for (const part of chunk(html)) await bot.api.sendMessage(ownerId, part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  };

  // Private bot: ignore everyone except the owner (the only authentication there is).
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== ownerId) {
      s.log.warn('rejected_non_owner', { fromId: ctx.from?.id });
      return;
    }
    await next();
  });

  // ---------- rendering ----------

  async function sendCard(chatId: number, p: PendingAction): Promise<void> {
    const projects = (await s.settings.get()).projects;
    const needsProject = p.kind === 'note.save' && !p.payload.project && projects.length > 0;
    const kb = p.kind === 'note.save' ? importKeyboard(p.id, projects, !needsProject) : confirmKeyboard(p.id);
    const header = needsProject ? '📝 Оберіть проєкт для матеріалу' : '📝 Підтвердіть дію';
    const msg = await bot.api.sendMessage(chatId, `${header}:\n${esc(p.summary)}`, { parse_mode: 'HTML', reply_markup: kb });
    await s.pending.setMessage(p.id, msg.message_id);
  }

  async function sendVoice(chatId: number, text: string): Promise<boolean> {
    if (!s.tts) return false;
    try {
      const mp3 = await s.tts.speak(plainForSpeech(text));
      const ogg = await toOggOpus(mp3);
      if (ogg) await bot.api.sendVoice(chatId, new InputFile(ogg, 'reply.ogg'));
      else await bot.api.sendAudio(chatId, new InputFile(Buffer.from(mp3), 'reply.mp3'));
      return true;
    } catch (e) {
      s.log.warn('tts_failed', { error: errMsg(e).slice(0, 200) });
      return false;
    }
  }

  async function deliver(chatId: number, reply: AgentReply, viaVoice: boolean): Promise<void> {
    const { voiceReplies } = await s.settings.get();
    const wantVoice = voiceReplies === 'always' || (voiceReplies === 'mirror' && viaVoice);
    const hasCards = reply.proposals.length > 0;
    if (reply.text) {
      const spoken = wantVoice && !hasCards && reply.text.length <= VOICE_MAX_CHARS && (await sendVoice(chatId, reply.text));
      if (!spoken) for (const part of chunk(reply.text)) await bot.api.sendMessage(chatId, part, { link_preview_options: { is_disabled: true } });
    }
    for (const p of reply.proposals) await sendCard(chatId, p);
  }

  async function ask(chatId: number, text: string, viaVoice: boolean): Promise<void> {
    await bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    const reply = await agent.handle(chatId, text);
    await deliver(chatId, reply, viaVoice);
  }

  // ---------- import (ChatGPT / Dot / files) ----------

  async function startImport(chatId: number, input: { text: string; hint?: string; file?: { fileId: string; name: string; mime: string } }): Promise<void> {
    const settings = await s.settings.get();
    const guess = await classifyImport(s.llm, settings.projects, input.text, input.hint);
    const payload = {
      title: guess.title,
      project: guess.project,
      source: guess.source,
      text: input.text,
      ...(input.file ? { file: input.file } : {}),
    };
    const preview = input.text.replace(/\s+/g, ' ').slice(0, 120);
    const p = await s.pending.create('note.save', payload, `«${guess.title}»${guess.project ? ` → ${guess.project}` : ''} (${guess.source})${input.file ? `\n📎 ${input.file.name}` : ''}\n${preview}${input.text.length > 120 ? '…' : ''}`, chatId);
    await sendCard(chatId, p);
  }

  // ---------- commands ----------

  bot.command('start', (ctx) =>
    ctx.reply(
      'Привіт! Я ваш персональний асистент. Пишіть або надсилайте голосові: задачі, календар, фінанси, звіти.\n\n' +
        '/connect — підключити Google та Instagram\n/status — стан підключень\n/morning, /evening — звіти зараз\n/plan — план дня\n/metrics — Instagram і YouTube\n/events — підбірка подій\n/voice — режим голосових відповідей\n\n' +
        'Перешліть сюди відповідь ChatGPT/Dot або файл — розкладу за проєктами.',
    ),
  );
  bot.command('help', (ctx) => ctx.reply('Просто напишіть, що потрібно, голосом або текстом. Команди: /connect /status /morning /evening /plan /metrics /events /voice'));

  bot.command('connect', async (ctx) => {
    const kb = new InlineKeyboard();
    const base = cfg.PUBLIC_URL;
    if (!base) return void (await ctx.reply('PUBLIC_URL не задано — OAuth недоступний.'));
    const state = (slot: string) => signState({ slot, owner: String(ownerId) }, cfg.APP_SECRET);
    if (s.googleAuth) {
      kb.url('Google Calendar (робочий)', s.googleAuth.authUrl('google:work', state('google:work'))).row();
      kb.url('Google Calendar (особистий)', s.googleAuth.authUrl('google:personal', state('google:personal'))).row();
      kb.url('YouTube', s.googleAuth.authUrl('google:youtube', state('google:youtube'))).row();
    }
    if (s.instagram) kb.url('Instagram', s.instagram.authUrl(state('instagram'))).row();
    await ctx.reply('Оберіть, що підключити (посилання діє 15 хв). Google може показати «непідтверджений застосунок» — натисніть «Додатково → Перейти».', { reply_markup: kb });
  });

  bot.command('status', async (ctx) => {
    const st = await s.settings.get();
    const slots = new Set(await s.tokens.connected());
    const ig = await s.tokens.get('instagram');
    const mark = (ok: boolean) => (ok ? '✅' : '—');
    const lines = [
      `${mark(Boolean(st.notion))} Notion${st.notion ? '' : ' (виконайте npm run setup:notion)'}`,
      `${mark(slots.has('google:work'))} Google Calendar (робочий)`,
      `${mark(slots.has('google:personal'))} Google Calendar (особистий)`,
      `${mark(slots.has('google:youtube'))} YouTube`,
      `${mark(slots.has('instagram'))} Instagram${ig?.expiresAt ? ` (токен до ${DateTime.fromJSDate(ig.expiresAt).toISODate()})` : ''}`,
      `${mark(Boolean(s.tts))} Голос (ElevenLabs)`,
      '',
      `Звіти: ${st.morningTime} / ${st.eveningTime} (${st.timezone})`,
      `Голосові відповіді: ${st.voiceReplies}`,
      `Проєктів: ${st.projects.length}, події: ${st.eventsTopics.length ? st.eventsTopics.join(', ') : 'теми не задано'}`,
    ];
    await ctx.reply(lines.join('\n'));
  });

  bot.command('morning', async (ctx) => void (await s.notify(await buildMorningReport(s))));
  bot.command('evening', async (ctx) => void (await s.notify(await buildEveningReport(s))));
  bot.command('plan', (ctx) => ask(ctx.chat.id, 'Склади план мого дня на сьогодні за вільним часом.', false));
  bot.command('metrics', (ctx) => ask(ctx.chat.id, 'Покажи метрики Instagram і YouTube.', false));
  bot.command('events', (ctx) => ask(ctx.chat.id, 'Знайди події за моїми темами.', false));
  bot.command('voice', async (ctx) => {
    const arg = ctx.match.trim();
    const map: Record<string, 'mirror' | 'always' | 'never'> = { on: 'always', mirror: 'mirror', off: 'never' };
    if (!map[arg]) {
      const cur = (await s.settings.get()).voiceReplies;
      return void (await ctx.reply(`Зараз: ${cur}.\n/voice on — завжди голосом\n/voice mirror — голосом на голосові\n/voice off — лише текст`));
    }
    await s.settings.update({ voiceReplies: map[arg] });
    await ctx.reply(`Голосові відповіді: ${map[arg]}.`);
  });

  // ---------- messages ----------

  bot.on('message:voice', async (ctx) => {
    const v = ctx.message.voice;
    if (v.file_size && v.file_size > MAX_FILE_BYTES) return void (await ctx.reply('Голосове задовге.'));
    await ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
    const audio = await s.downloadFile!(v.file_id);
    const text = await s.llm.transcribe(audio, 'voice.ogg', v.mime_type ?? 'audio/ogg', (await s.settings.get()).language);
    if (!text) return void (await ctx.reply('Не вдалося розпізнати голос. Спробуйте ще раз.'));
    await ctx.reply(`🎙 ${text}`);
    await ask(ctx.chat.id, text, true);
  });

  bot.on('message:document', async (ctx) => {
    const d = ctx.message.document;
    if (d.file_size && d.file_size > MAX_FILE_BYTES) return void (await ctx.reply('Файл більший за 20 МБ — Telegram не дає його завантажити боту.'));
    const name = d.file_name ?? 'file';
    let text = ctx.message.caption ?? '';
    if (TEXT_FILE.test(name) && (d.file_size ?? 0) <= 300_000) {
      const data = await s.downloadFile!(d.file_id);
      text = `${text}\n${new TextDecoder().decode(data)}`.trim().slice(0, 60_000);
    }
    await startImport(ctx.chat.id, { text: text || `Файл ${name}`, hint: name, file: { fileId: d.file_id, name, mime: d.mime_type ?? 'application/octet-stream' } });
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    // forwarded message, or an explicit "gpt:" / "dot:" / "збережи" prefix, is material to file away
    if (ctx.message.forward_origin || /^(gpt|chatgpt|dot)\s*[:\-]/i.test(text)) {
      const body = text.replace(/^(gpt|chatgpt|dot)\s*[:\-]\s*/i, '');
      return void (await startImport(ctx.chat.id, { text: body }));
    }
    await ask(ctx.chat.id, text, false);
  });

  // ---------- confirm buttons ----------

  bot.on('callback_query:data', async (ctx) => {
    const [ns, action, id, arg] = ctx.callbackQuery.data.split(':');
    if (ns !== 'pend' || !id) return void (await ctx.answerCallbackQuery());
    const msg = ctx.callbackQuery.message;
    const edit = (text: string) => (msg ? ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(() => {}) : Promise.resolve());

    if (action === 'ok') {
      await ctx.answerCallbackQuery({ text: 'Виконую…' });
      await edit(`⏳ Виконую…`);
      const r = await runPending(s, id);
      await edit(`${r.ok ? '✅' : '⚠️'} ${esc(r.text)}`);
      await s.messages.add(ctx.chat?.id ?? ownerId, 'assistant', `${r.ok ? 'Підтверджено і виконано' : 'Помилка виконання'}: ${r.text}`);
      return;
    }
    if (action === 'no') {
      const cancelled = await s.pending.cancel(id);
      await ctx.answerCallbackQuery({ text: cancelled ? 'Скасовано' : 'Вже оброблено' });
      if (cancelled) {
        await edit('❌ Скасовано');
        await s.messages.add(ctx.chat?.id ?? ownerId, 'assistant', 'Користувач скасував підготовлену дію.');
      }
      return;
    }
    const p = await s.pending.get(id);
    if (!p || p.status !== 'pending') return void (await ctx.answerCallbackQuery({ text: 'Вже оброблено' }));
    const projects = (await s.settings.get()).projects;
    if (action === 'pick') {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: importKeyboard(id, projects, false) }).catch(() => {});
      return;
    }
    if (action === 'set') {
      const project = projects[Number(arg)];
      if (!project) return void (await ctx.answerCallbackQuery({ text: 'Невідомий проєкт' }));
      const payload = { ...p.payload, project };
      const summary = p.summary.replace(/→ [^(]+/, '').replace(/^«([^»]*)»/, `«$1» → ${project}`);
      await s.pending.updatePayload(id, payload, summary);
      await ctx.answerCallbackQuery({ text: project });
      await ctx.editMessageText(`📝 Підтвердіть дію:\n${esc(summary)}`, { parse_mode: 'HTML', reply_markup: importKeyboard(id, projects, true) }).catch(() => {});
    }
  });

  bot.catch(async (err) => {
    s.log.error('bot_error', { error: errMsg(err.error).slice(0, 300) });
    const chatId = err.ctx.chat?.id;
    if (chatId) await bot.api.sendMessage(chatId, `⚠️ Сталася помилка: ${errMsg(err.error).slice(0, 200)}`).catch(() => {});
  });

  return bot;
}

export type { Context };
