import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { DateTime } from 'luxon';
import { runPending } from '../actions.js';
import type { Agent, AgentReply } from '../agent/agent.js';
import { webUrl } from '../config.js';
import { signState } from '../lib/crypto.js';
import { isPhantomTranscript, transcriptionHint } from '../lib/wake.js';
import { mdToTelegramHtml, stripMd } from '../lib/tg-html.js';
import { createLoginToken } from '../web/auth.js';
import { errMsg } from '../lib/log.js';
import { classifyImport } from '../modules/importer.js';
import { buildEveningReport, buildMorningReport } from '../modules/reports.js';
import { toOggOpus, plainForSpeech } from '../integrations/tts.js';
import { esc, type Services } from '../services.js';
import { createProject } from '../agent/project-tools.js';
import { UnsupportedFile } from '../files/extract.js';
import { findNotionLinks } from '../notion/reader.js';
import { activeProject, projectsOf } from '../projects/index.js';
import { fileToText } from '../projects/sync.js';
import type { PendingAction } from '../store/pending.js';
import { TelegramAccess } from '../store/telegram-access.js';

const TG_LIMIT = 4000;
const VOICE_MAX_CHARS = 900;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** confirm cards and transcript echoes stay well under Telegram's 4096 characters */
const CARD_MAX_CHARS = 3500;
const ECHO_MAX_CHARS = 700;

/** cuts on a word boundary and never inside a surrogate pair (emoji) */
export function preview(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max).join('');
  const cut = head.lastIndexOf(' ');
  return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd()}… (ще ${chars.length - max} символів)`;
}
/** a file's text goes into the turn up to this size (the whole of it stays in the project materials) */
const INLINE_FILES_CHARS = 24_000;
/** a pasted message this long is kept as a project material */
const LONG_MESSAGE = 1200;
/** files sent together (an album) arrive one by one: wait this long for the rest */
const ALBUM_WAIT_MS = 1500;

interface IncomingFile {
  fileId: string;
  uniqueId: string;
  name: string;
  mime?: string;
  size?: number;
}

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

/** Who wrote a forwarded message, as Telegram tells it. */
function forwardName(o: any): string {
  if (!o) return '';
  if (o.type === 'user') return [o.sender_user?.first_name, o.sender_user?.last_name].filter(Boolean).join(' ');
  if (o.type === 'hidden_user') return o.sender_user_name ?? '';
  if (o.type === 'chat' || o.type === 'channel') return o.sender_chat?.title ?? o.chat?.title ?? '';
  return '';
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

  const access = new TelegramAccess(s.db, ownerId);

  const sendHtml = async (chatId: number, html: string) => {
    for (const part of chunk(html)) await bot.api.sendMessage(chatId, part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  };

  // reports and alerts: the owner plus the people the owner allowed to receive them
  s.notify = async (html) => {
    for (const chatId of await access.recipients()) {
      try {
        await sendHtml(chatId, html);
      } catch (e) {
        if (chatId === ownerId) throw e;
        s.log.warn('notify_failed', { chatId, error: errMsg(e).slice(0, 200) });
      }
    }
  };

  // Private bot: only the owner and the people she allowed in the cabinet (Опції → Підключення → Telegram).
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (await access.isAllowed(from?.id)) return next();
    s.log.warn('rejected_non_owner', { fromId: from?.id });
    // private chats only: say once how to get access, never in groups
    if (from && ctx.chat?.type === 'private') {
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
      if (await access.request({ id: from.id, name, username: from.username }, s.clock())) {
        await ctx
          .reply(`Цей асистент приватний. Ваш Telegram ID: ${from.id}.\nВласник може надати доступ у веб-кабінеті: Опції → Підключення → Telegram.`)
          .catch(() => {});
      }
    }
  });

  // Updates arrive through handleUpdate (webhook), where bot.catch does not apply: never fail silently.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      s.log.error('bot_error', { error: errMsg(e).slice(0, 300) });
      if (ctx.chat?.id) await bot.api.sendMessage(ctx.chat.id, `⚠️ Не вдалося відповісти: ${errMsg(e).slice(0, 200)}\nСпробуй ще раз або напиши коротше.`).catch(() => {});
    }
  });

  /** Telegram shows «друкує…» for 5 s: repeat it while a long answer or a long recording is being processed. */
  function keepTyping(chatId: number): () => void {
    const ping = () => void bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    ping();
    const t = setInterval(ping, 4500);
    return () => clearInterval(t);
  }

  // ---------- rendering ----------

  async function sendCard(chatId: number, p: PendingAction): Promise<void> {
    const projects = (await s.settings.get()).projects;
    const needsProject = p.kind === 'note.save' && !p.payload.project && projects.length > 0;
    const kb = p.kind === 'note.save' ? importKeyboard(p.id, projects, !needsProject) : confirmKeyboard(p.id);
    const header = needsProject ? '📝 Оберіть проєкт для матеріалу' : '📝 Підтвердіть дію';
    const summary = p.summary.length > CARD_MAX_CHARS ? `${p.summary.slice(0, CARD_MAX_CHARS)}…` : p.summary;
    const msg = await bot.api.sendMessage(chatId, `${header}:\n${esc(summary)}`, { parse_mode: 'HTML', reply_markup: kb });
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

  /** the model's Markdown as Telegram HTML; plain text if Telegram rejects the markup */
  async function sendRich(chatId: number, md: string): Promise<void> {
    try {
      await bot.api.sendMessage(chatId, mdToTelegramHtml(md), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (e) {
      s.log.warn('rich_text_rejected', { error: errMsg(e).slice(0, 200) });
      await bot.api.sendMessage(chatId, stripMd(md), { link_preview_options: { is_disabled: true } });
    }
  }

  // background work (project reading, long jobs) reports through these
  s.deliver = {
    text: async (chatId, md) => {
      for (const part of chunk(md)) await sendRich(chatId, part);
    },
    card: (chatId, p) => sendCard(chatId, p),
  };

  async function deliver(chatId: number, reply: AgentReply, viaVoice: boolean): Promise<void> {
    const { voiceReplies } = await s.settings.get();
    // an explicit request ("say it by voice") wins over the mode; cards then follow the voice message
    const asked = reply.voice === true;
    const wantVoice = asked || voiceReplies === 'always' || (voiceReplies === 'mirror' && viaVoice);
    const hasCards = reply.proposals.length > 0;
    if (reply.text) {
      const spoken = wantVoice && (asked || !hasCards) && reply.text.length <= VOICE_MAX_CHARS && (await sendVoice(chatId, reply.text));
      if (!spoken) for (const part of chunk(reply.text)) await sendRich(chatId, part);
    }
    for (const p of reply.proposals) await sendCard(chatId, p);
  }

  async function ask(chatId: number, text: string, viaVoice: boolean, historyText?: string): Promise<void> {
    const stop = keepTyping(chatId);
    try {
      const reply = await agent.handle(chatId, text, undefined, historyText ? { historyText } : {});
      await deliver(chatId, reply, viaVoice);
    } finally {
      stop();
    }
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
        '/project — проєкти: перемкнути чи додати новий за посиланням Notion\n/connect — підключити Google та Instagram\n/web — увійти у веб-кабінет\n/status — стан підключень\n/morning, /evening — звіти зараз\n/plan — план дня\n/metrics — Instagram і YouTube\n/events — підбірка подій\n/voice — режим голосових відповідей\n\n' +
        'Перешліть сюди відповідь ChatGPT/Dot або файл — розкладу за проєктами.',
    ),
  );
  bot.command('help', (ctx) => ctx.reply('Просто напишіть, що потрібно, голосом або текстом. Файли (PDF, Word, Excel, PowerPoint, фото) і посилання можна надсилати прямо в чат. Команди: /project /web /connect /status /morning /evening /plan /metrics /events /voice'));

  bot.command('connect', async (ctx) => {
    const kb = new InlineKeyboard();
    const state = (slot: string) => signState({ slot, owner: String(ownerId) }, cfg.APP_SECRET);
    if (s.googleAuth) {
      kb.url('Google Calendar (робочий)', s.googleAuth.authUrl('google:work', state('google:work'))).row();
      kb.url('Google Calendar (особистий)', s.googleAuth.authUrl('google:personal', state('google:personal'))).row();
      kb.url('YouTube', s.googleAuth.authUrl('google:youtube', state('google:youtube'))).row();
    }
    if (s.instagram) kb.url('Instagram', s.instagram.authUrl(state('instagram'))).row();
    await ctx.reply('Оберіть, що підключити (посилання діє 15 хв). Google може показати «непідтверджений застосунок» — натисніть «Додатково → Перейти».', { reply_markup: kb });
  });

  bot.command('web', async (ctx) => {
    const token = await createLoginToken(s.db);
    // token in the URL fragment: never sent to the server or to Telegram's link previewer
    const url = `${webUrl(cfg)}/#/login?token=${token}`;
    await ctx.reply(`Вхід у веб-кабінет (одноразове посилання, 10 хв):\n${url}`, { link_preview_options: { is_disabled: true } });
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

  bot.command('morning', async (ctx) => sendHtml(ctx.chat.id, await buildMorningReport(s)));
  bot.command('evening', async (ctx) => sendHtml(ctx.chat.id, await buildEveningReport(s)));
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

  /** voice note, audio file or round video: transcribe, then answer like a typed message (by voice in mirror mode) */
  async function hearAndAnswer(chatId: number, file: { file_id: string; file_size?: number; mime_type?: string }, name: string): Promise<void> {
    if (file.file_size && file.file_size > MAX_FILE_BYTES) return void (await bot.api.sendMessage(chatId, 'Запис задовгий (Telegram дає боту файли до 20 МБ).'));
    const stop = keepTyping(chatId);
    let text: string;
    try {
      const audio = await s.downloadFile!(file.file_id);
      const st = await s.settings.get();
      const heard = await s.llm.transcribe(audio, name, file.mime_type ?? 'audio/ogg', st.language, transcriptionHint(st.assistantName));
      text = isPhantomTranscript(heard, st.assistantName) ? '' : heard;
    } finally {
      stop();
    }
    if (!text) return void (await bot.api.sendMessage(chatId, 'Не вдалося розпізнати. Спробуй ще раз, ближче до мікрофона.'));
    // a long recording is echoed as a preview: the whole transcript can exceed Telegram's 4096 characters
    await bot.api.sendMessage(chatId, `🎙 ${preview(text, ECHO_MAX_CHARS)}`);
    await ask(chatId, text, true);
  }

  bot.on('message:voice', (ctx) => hearAndAnswer(ctx.chat.id, ctx.message.voice, 'voice.ogg'));
  bot.on('message:video_note', (ctx) => hearAndAnswer(ctx.chat.id, { ...ctx.message.video_note, mime_type: 'video/mp4' }, 'note.mp4'));
  bot.on('message:audio', (ctx) => {
    const a = ctx.message.audio;
    const ext = (a.file_name?.split('.').pop() ?? a.mime_type?.split('/')[1] ?? 'mp3').toLowerCase();
    return hearAndAnswer(ctx.chat.id, a, `audio.${ext}`);
  });

  // ---------- files and photos: read, keep in the project, hand to the assistant ----------

  /** Reads the files, saves each as a material of the active project, then asks the assistant with their text. */
  async function receiveFiles(chatId: number, files: IncomingFile[], caption: string): Promise<void> {
    const stop = keepTyping(chatId);
    try {
      const project = await activeProject(s);
      const parts: string[] = [];
      const short: string[] = [];
      const budget = Math.floor(INLINE_FILES_CHARS / files.length);
      for (const f of files) {
        if (f.size && f.size > MAX_FILE_BYTES) {
          parts.push(`[Файл «${f.name}» більший за 20 МБ — Telegram не дає боту його завантажити. Попроси надіслати менший файл або посилання.]`);
          continue;
        }
        try {
          const data = await s.downloadFile!(f.fileId);
          const { text, links } = await fileToText(s, data, f.name, f.mime);
          if (!text.trim()) {
            parts.push(`[Файл «${f.name}»: тексту в ньому не знайдено]`);
            continue;
          }
          const { material } = await projectsOf(s).addMaterial({
            projectId: project?.id,
            kind: 'file',
            title: f.name,
            source: `tg:${f.uniqueId}`,
            text,
            meta: { links: links.slice(0, 100), mime: f.mime },
          });
          const where = `збережено в матеріали${project ? ` проєкту «${project.name}»` : ''} як #${material.id}, ${text.length} знаків`;
          const body = text.length <= budget ? text : `${text.slice(0, budget)}\n…(далі ще ${text.length - budget} знаків — material_read(${material.id}, part=2))`;
          const linkLine = links.length ? `\nПосилання у файлі (${links.length}): ${links.slice(0, 40).join(' ')}` : '';
          parts.push(`[Файл «${f.name}» — ${where}]\n${body}${linkLine}`);
          short.push(`[Файл «${f.name}» — матеріал #${material.id}, ${text.length} знаків]\n${text.slice(0, 800)}${text.length > 800 ? '…' : ''}`);
        } catch (e) {
          parts.push(`[Файл «${f.name}»: ${e instanceof UnsupportedFile ? e.message : `не вдалося прочитати (${errMsg(e).slice(0, 150)})`}]`);
        }
      }
      const head = caption.trim() || (files.length > 1 ? 'Надсилаю файли.' : 'Надсилаю файл.');
      const reply = await agent.handle(chatId, [head, ...parts].join('\n\n'), undefined, { historyText: [head, ...(short.length ? short : parts)].join('\n\n') });
      await deliver(chatId, reply, false);
    } finally {
      stop();
    }
  }

  // an album arrives as separate messages with one media_group_id: answer once for all of them
  const albums = new Map<string, { chatId: number; files: IncomingFile[]; caption: string; timer: ReturnType<typeof setTimeout> }>();
  function queueFile(chatId: number, file: IncomingFile, caption: string | undefined, group: string | undefined): void {
    if (!group) return void receiveFiles(chatId, [file], caption ?? '').catch((e) => s.log.error('files_failed', { error: errMsg(e).slice(0, 200) }));
    const a = albums.get(group) ?? { chatId, files: [], caption: '', timer: setTimeout(() => {}, 0) };
    clearTimeout(a.timer);
    a.files.push(file);
    if (caption) a.caption = a.caption ? `${a.caption}\n${caption}` : caption;
    a.timer = setTimeout(() => {
      albums.delete(group);
      void receiveFiles(a.chatId, a.files, a.caption).catch((e) => s.log.error('files_failed', { error: errMsg(e).slice(0, 200) }));
    }, ALBUM_WAIT_MS);
    albums.set(group, a);
  }

  bot.on('message:document', (ctx) => {
    const d = ctx.message.document;
    queueFile(ctx.chat.id, { fileId: d.file_id, uniqueId: d.file_unique_id, name: d.file_name ?? 'file', mime: d.mime_type, size: d.file_size }, ctx.message.caption, ctx.message.media_group_id);
  });

  bot.on('message:photo', (ctx) => {
    const ph = ctx.message.photo.at(-1)!; // the largest size
    queueFile(ctx.chat.id, { fileId: ph.file_id, uniqueId: ph.file_unique_id, name: `фото-${ph.file_unique_id.slice(-6)}.jpg`, mime: 'image/jpeg', size: ph.file_size }, ctx.message.caption, ctx.message.media_group_id);
  });

  // ---------- projects ----------

  /** chats where «➕ Новий проєкт» was pressed: the next message is the project's Notion link */
  const awaitingProject = new Set<number>();

  async function projectsKeyboard(): Promise<{ text: string; kb: InlineKeyboard }> {
    const list = await projectsOf(s).list();
    const active = (await s.settings.get()).activeProjectId;
    const kb = new InlineKeyboard();
    list.forEach((p, i) => {
      kb.text(`${p.id === active ? '● ' : ''}${p.name}`.slice(0, 60), `proj:on:${p.id}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text('➕ Новий проєкт', 'proj:new');
    const text = list.length
      ? `Проєкти${active ? '' : ' (активного немає)'}. Натисніть, щоб перемкнутися:`
      : 'Проєктів ще немає. Додайте перший: я прочитаю сторінку проєкту в Notion з усіма підсторінками, файлами й посиланнями.';
    return { text, kb };
  }

  bot.command(['project', 'projects'], async (ctx) => {
    const { text, kb } = await projectsKeyboard();
    await ctx.reply(text, { reply_markup: kb });
  });

  async function newProjectFrom(chatId: number, text: string): Promise<void> {
    const link = findNotionLinks(text)[0];
    const name = text.replace(link ?? '', '').trim().replace(/^[«"]|[»"]$/g, '');
    const r = await createProject(s, chatId, { name: name || undefined, notion_link: link });
    const lead = r.status === 'created' || r.status === 'switched' ? `✅ Проєкт «${r.project}»` : '⚠️';
    await bot.api.sendMessage(chatId, `${lead}\n${r.note.replace(/ Скажи про це коротко\.$/, '')}`, { link_preview_options: { is_disabled: true } });
  }

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    if (awaitingProject.delete(ctx.chat.id)) {
      if (findNotionLinks(text).length) return void (await newProjectFrom(ctx.chat.id, text));
      await ctx.reply('Без посилання на Notion створю проєкт лише з назвою — матеріали збиратимуться з чату.');
      return void (await newProjectFrom(ctx.chat.id, text));
    }
    // an explicit "gpt:" / "dot:" prefix: material to file away in Notion «Матеріали»
    if (/^(gpt|chatgpt|dot)\s*[:\-]/i.test(text)) {
      const body = text.replace(/^(gpt|chatgpt|dot)\s*[:\-]\s*/i, '');
      return void (await startImport(ctx.chat.id, { text: body }));
    }
    // a forwarded letter or a long pasted text is kept in the project, then answered like any message
    const fwd = ctx.message.forward_origin;
    const from = fwd ? forwardName(fwd) : '';
    if (fwd || text.length >= LONG_MESSAGE) {
      const project = await activeProject(s);
      const title = `${fwd ? `Переслане${from ? ` від ${from}` : ''}: ` : ''}${text.split('\n')[0]!.slice(0, 80)}`;
      await projectsOf(s)
        .addMaterial({ projectId: project?.id, kind: 'chat', title, text, meta: { forwarded: Boolean(fwd), from } })
        .catch((e) => s.log.warn('chat_material_failed', { error: errMsg(e).slice(0, 200) }));
    }
    await ask(ctx.chat.id, fwd ? `[Переслане повідомлення${from ? ` від ${from}` : ''}]\n${text}` : text, false);
  });

  // ---------- confirm buttons ----------

  bot.on('callback_query:data', async (ctx) => {
    const [ns, action, id, arg] = ctx.callbackQuery.data.split(':');
    if (ns === 'proj') {
      if (action === 'new') {
        awaitingProject.add(ctx.chat?.id ?? ownerId);
        await ctx.answerCallbackQuery();
        await ctx.reply('Надішліть посилання на головну сторінку проєкту в Notion (Share → Copy link). Можна разом з назвою, напр.: «Ігристий чай https://www.notion.so/…»');
        return;
      }
      const p = await projectsOf(s).get(Number(id));
      if (!p) return void (await ctx.answerCallbackQuery({ text: 'Проєкт не знайдено' }));
      await s.settings.update({ activeProjectId: p.id });
      await ctx.answerCallbackQuery({ text: p.name });
      const { text, kb } = await projectsKeyboard();
      await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
      await s.messages.add(ctx.chat?.id ?? ownerId, 'assistant', `(Власниця перемкнулась на проєкт «${p.name}»)`);
      return;
    }
    if (ns !== 'pend' || !id) return void (await ctx.answerCallbackQuery());
    const msg = ctx.callbackQuery.message;
    const edit = (text: string) => (msg ? ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(() => {}) : Promise.resolve());

    if (action === 'ok') {
      await ctx.answerCallbackQuery({ text: 'Виконую…' });
      await edit(`⏳ Виконую…`);
      const r = await runPending(s, id);
      await edit(`${r.ok ? '✅' : '⚠️'} ${esc(r.text)}`);
      if (r.claimed) await s.messages.add(ctx.chat?.id ?? ownerId, 'assistant', `${r.ok ? 'Підтверджено і виконано' : 'Помилка виконання'}: ${r.text}`);
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
