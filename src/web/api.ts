import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { runPending } from '../actions.js';
import { Agent, type AgentReply } from '../agent/agent.js';
import { buildVoiceTools } from '../agent/tools.js';
import { isAddressed, isEcho, isPhantomTranscript, transcriptionHint } from '../lib/wake.js';
import { kvGet, kvSet } from '../store/kv.js';
import { signState } from '../lib/crypto.js';
import { errMsg } from '../lib/log.js';
import { HHMM } from '../lib/time.js';
import { ELEVEN_VOICES, ElevenLabs, OPENAI_VOICES, OpenAiTts, plainForSpeech, VOICE_STYLES } from '../integrations/tts.js';
import { buildToday } from '../modules/dashboard.js';
import { summarize } from '../modules/finance.js';
import { classifyImport } from '../modules/importer.js';
import { buildEveningReport, buildMorningReport } from '../modules/reports.js';
import { diffTotals } from '../modules/social.js';
import type { SocialData } from '../integrations/social-types.js';
import type { Services } from '../services.js';
import type { PendingAction } from '../store/pending.js';
import { registerRealtime, type SecretFactory } from './realtime.js';
import { registerIntegrations } from './integrations-api.js';
import { OrderedSpeech, SentenceSplitter } from './speech-stream.js';
import { AttemptLimiter, consumeLoginToken, isValidSession, issueSession, passwordMatches, SESSION_COOKIE, SESSION_DAYS } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Built SPA lives in dist/public (not dist/web: that folder holds this compiled server code and Vite empties its outDir).
 * From dist/web/api.js -> ../public; from src/web/api.ts (tsx) -> ../../dist/public.
 */
export function findWebRoot(): string | undefined {
  return [join(here, '..', 'public'), join(here, '..', '..', 'dist', 'public')].find((d) => existsSync(join(d, 'index.html')));
}

const card = (p: PendingAction) => ({ id: p.id, kind: p.kind, summary: p.summary, project: p.payload?.project ?? null, createdAt: p.createdAt });
const replyJson = (r: AgentReply) => ({ text: r.text, proposals: r.proposals.map(card) });

const settingsPatch = z
  .object({
    assistantName: z.string().trim().min(1).max(40),
    ownerName: z.string().trim().max(40),
    ownerGender: z.enum(['female', 'male', '']),
    morningTime: z.string().regex(HHMM),
    eveningTime: z.string().regex(HHMM),
    workdayStart: z.string().regex(HHMM),
    workdayEnd: z.string().regex(HHMM),
    voiceReplies: z.enum(['mirror', 'always', 'never']),
    ttsVoice: z.enum(OPENAI_VOICES.map((v) => v.id) as [string, ...string[]]),
    ttsStyle: z.enum(Object.keys(VOICE_STYLES) as [string, ...string[]]),
    elevenVoice: z.enum(ELEVEN_VOICES.map((v) => v.id) as [string, ...string[]]),
    planCalendar: z.enum(['work', 'personal']),
    mirrorDetails: z.boolean(),
    eventsTopics: z.array(z.string().trim().min(1)).max(3),
    eventsGeo: z.string().max(200),
    eventsWeekday: z.number().int().min(1).max(7),
    eventsTime: z.string().regex(HHMM),
  })
  .partial()
  .strict();

const AUDIO_EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

export interface WebOptions {
  /** serve the built SPA (off in tests) */
  serveStatic?: boolean;
  /** Realtime voice key factory (faked in tests) */
  realtimeSecret?: SecretFactory;
}

/**
 * Web UI API. Same agent, same confirmation gate and same conversation as Telegram (chat id = owner id).
 * Auth: one-time link from the bot (/web) or WEB_PASSWORD -> signed httpOnly cookie.
 * Mutating requests must carry `X-Requested-With` (a cross-site form cannot set it) on top of SameSite=Lax.
 */
export async function registerWeb(app: FastifyInstance, s: Services, agent: Agent, opts: WebOptions = {}): Promise<void> {
  const { cfg } = s;
  const ownerId = cfg.OWNER_TELEGRAM_ID;
  const limiter = new AttemptLimiter();
  const voiceAgent = new Agent(s, buildVoiceTools(), 'voice', { name: cfg.OPENAI_VOICE_MODEL || cfg.OPENAI_MODEL, maxTokens: 400, effort: 'none' });
  const speech = async (text: string): Promise<string | undefined> => {
    if (!s.tts || !text) return undefined;
    try {
      return Buffer.from(await s.tts.speak(plainForSpeech(text).slice(0, 1200))).toString('base64');
    } catch (e) {
      s.log.warn('tts_failed', { error: errMsg(e).slice(0, 200) });
      return undefined;
    }
  };
  await app.register(cookie);

  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  const setSession = (req: FastifyRequest, reply: FastifyReply) =>
    reply.setCookie(SESSION_COOKIE, issueSession(cfg.APP_SECRET, ownerId, s.clock().getTime()), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: SESSION_DAYS * 86400,
    });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'aia') return reply.code(403).send({ error: 'csrf' });
    if (req.url.startsWith('/api/auth/')) return;
    if (!isValidSession(req.cookies[SESSION_COOKIE], cfg.APP_SECRET, ownerId, s.clock().getTime())) return reply.code(401).send({ error: 'unauthorized' });
  });

  // ---------- auth ----------

  app.get('/api/auth/me', async (req) => ({
    authenticated: isValidSession(req.cookies[SESSION_COOKIE], cfg.APP_SECRET, ownerId, s.clock().getTime()),
    passwordLogin: Boolean(cfg.WEB_PASSWORD),
  }));

  app.post<{ Body: { token?: string } }>('/api/auth/magic', async (req, reply) => {
    if (!(await consumeLoginToken(s.db, String(req.body?.token ?? '')))) return reply.code(401).send({ error: 'Посилання недійсне або вже використане. Надішліть /web у бот ще раз.' });
    setSession(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { password?: string } }>('/api/auth/password', async (req, reply) => {
    if (!cfg.WEB_PASSWORD) return reply.code(404).send({ error: 'Вхід за паролем вимкнено' });
    if (!limiter.allow(req.ip)) return reply.code(429).send({ error: 'Забагато спроб. Спробуйте за 15 хвилин.' });
    if (!passwordMatches(String(req.body?.password ?? ''), cfg.WEB_PASSWORD)) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: 'Невірний пароль' });
    }
    setSession(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------- assistant ----------

  app.get('/api/history', async () => ({ messages: await s.messages.recent(ownerId, 60, 24 * 7) }));

  app.post<{ Body: { text?: string } }>('/api/chat', async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'empty' });
    if (text.length > 8000) return reply.code(413).send({ error: 'Задовге повідомлення' });
    return replyJson(await agent.handle(ownerId, text));
  });

  /**
   * Voice turn without Realtime: transcribe -> agent -> speech.
   * `conversation=1`: the voice agent (spoken confirmations), reply always spoken.
   * `handsFree=1`: answer only when called by name, or right after the assistant spoke (`follow=1`).
   */
  app.post<{ Querystring: { conversation?: string; handsFree?: string; follow?: string } }>('/api/voice', async (req, reply) => {
    const audio = req.body as Buffer | undefined;
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!;
    if (!audio?.length) return reply.code(400).send({ error: 'empty' });
    const st = await s.settings.get();
    const conversation = req.query.conversation === '1';
    const heard = await s.llm.transcribe(new Uint8Array(audio), `voice.${AUDIO_EXT[mime] ?? 'webm'}`, mime, st.language, transcriptionHint(st.assistantName));
    const transcript = isPhantomTranscript(heard, st.assistantName) ? '' : heard;
    if (!transcript) return { transcript: '', text: conversation ? '' : 'Не вдалося розпізнати голос. Спробуйте ще раз.', proposals: [], skipped: conversation };
    if (req.query.handsFree === '1' && req.query.follow !== '1' && !isAddressed(transcript, st.assistantName)) return { transcript, text: '', proposals: [], skipped: true };
    const r = await (conversation ? voiceAgent : agent).handle(ownerId, transcript);
    const speak = conversation ? st.voiceReplies !== 'never' : st.voiceReplies !== 'never' && r.text.length <= 900 && !r.proposals.length;
    return { transcript, ...replyJson(r), audio: speak ? await speech(r.text) : undefined };
  });

  /**
   * Streaming voice turn (NDJSON). Audio body = the owner spoke; JSON body = typed question (`text`), instruction (`ask`)
   * or plain announcement (`say`). Events: transcript, skipped, text (deltas), audio (one mp3 per sentence, in order),
   * proposals, done, error. The first sentence is spoken while the model is still writing the rest.
   */
  app.post<{ Querystring: { handsFree?: string; follow?: string }; Body: Buffer | { text?: string; ask?: string; say?: string; agent?: 'text' | 'voice'; speak?: boolean } }>(
    '/api/voice/stream',
    async (req, reply) => {
      const st = await s.settings.get();
      const started = Date.now();
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      const emit = (ev: Record<string, unknown>) => reply.raw.write(`${JSON.stringify(ev)}\n`);
      let closed = false;
      req.raw.on('close', () => (closed = true));
      try {
        let userText: string | undefined;
        let instruction: string | undefined;
        let sayOnly: string | undefined;
        let useVoiceAgent = true;
        let speak = st.voiceReplies !== 'never';
        if (Buffer.isBuffer(req.body)) {
          const mime = String(req.headers['content-type'] ?? '').split(';')[0]!;
          userText = await s.llm.transcribe(
            new Uint8Array(req.body),
            `voice.${AUDIO_EXT[mime] ?? 'webm'}`,
            mime,
            st.language,
            transcriptionHint(st.assistantName),
            cfg.OPENAI_VOICE_TRANSCRIBE_MODEL,
          );
          if (userText && isPhantomTranscript(userText, st.assistantName)) userText = '';
          // the mic heard the assistant's last answer from the speakers
          const lastSaid = (await s.messages.recent(ownerId, 2, 1)).filter((m) => m.role === 'assistant').at(-1)?.content;
          if (userText && isEcho(userText, lastSaid)) userText = '';
          emit({ type: 'transcript', text: userText, ms: Date.now() - started });
          if (!userText || (req.query.handsFree === '1' && req.query.follow !== '1' && !isAddressed(userText, st.assistantName))) {
            emit({ type: 'skipped' });
            emit({ type: 'done', text: '' });
            return;
          }
        } else {
          const b = req.body ?? {};
          if (b.say) sayOnly = String(b.say).slice(0, 2000);
          else if (b.ask) instruction = String(b.ask).slice(0, 2000);
          else userText = String(b.text ?? '').trim().slice(0, 8000);
          useVoiceAgent = b.agent !== 'text';
          if (b.speak === false) speak = false;
          if (!sayOnly && !instruction && !userText) throw new Error('empty');
        }

        const tts = speak ? s.tts : undefined;
        const speech = new OrderedSpeech(
          async (text, onAudio) => {
            if (!tts) return;
            const spoken = plainForSpeech(text);
            if (!spoken) return;
            if (tts.streamPcm) await tts.streamPcm(spoken, (pcm) => onAudio(Buffer.from(pcm).toString('base64')));
            else onAudio(Buffer.from(await tts.speak(spoken)).toString('base64'));
          },
          (seq, chunk) => {
            if (closed) return;
            if ('end' in chunk) emit({ type: 'audio_end', seq });
            else emit({ type: 'audio', seq, format: tts?.streamPcm ? 'pcm24' : 'mp3', data: chunk.audio, ms: Date.now() - started });
          },
        );
        const splitter = new SentenceSplitter();
        const onText = (delta: string) => {
          if (closed) return;
          emit({ type: 'text', delta });
          for (const piece of splitter.push(delta)) speech.add(piece);
        };

        let proposals: PendingAction[] = [];
        let finalText: string;
        if (sayOnly) {
          onText(sayOnly);
          finalText = sayOnly;
        } else {
          const r = await (useVoiceAgent ? voiceAgent : agent).handle(ownerId, (instruction ?? userText)!, onText);
          proposals = r.proposals;
          finalText = r.text;
        }
        const rest = splitter.flush();
        if (rest) speech.add(rest);
        if (proposals.length) emit({ type: 'proposals', items: proposals.map(card) });
        await speech.done();
        emit({ type: 'done', text: finalText, ms: Date.now() - started });
      } catch (e) {
        s.log.warn('voice_stream_failed', { error: errMsg(e).slice(0, 200) });
        emit({ type: 'error', message: errMsg(e).slice(0, 300) });
      } finally {
        reply.raw.end();
      }
    },
  );

  /** First voice session of the day starts with a spoken briefing. */
  app.post('/api/voice/start', async () => {
    const st = await s.settings.get();
    const today = DateTime.fromJSDate(s.clock(), { zone: st.timezone }).toISODate()!;
    const greet = (await kvGet<string>(s.db, 'voice_greeted_on')) !== today;
    if (greet) await kvSet(s.db, 'voice_greeted_on', today);
    return { assistantName: st.assistantName, greet, tts: Boolean(s.tts) };
  });

  /** `ask`: run the voice agent on an instruction (briefing). Otherwise just say the text (proactive nudge). */
  app.post<{ Body: { text?: string; ask?: boolean } }>('/api/voice/speak', async (req, reply) => {
    const text = String(req.body?.text ?? '').trim().slice(0, 2000);
    if (!text) return reply.code(400).send({ error: 'empty' });
    if (!req.body?.ask) return { text, proposals: [], audio: await speech(text) };
    const r = await voiceAgent.handle(ownerId, text);
    return { ...replyJson(r), audio: await speech(r.text) };
  });

  app.post<{ Body: { text?: string } }>('/api/import', async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'empty' });
    const st = await s.settings.get();
    const g = await classifyImport(s.llm, st.projects, text);
    const preview = text.replace(/\s+/g, ' ').slice(0, 120);
    const p = await s.pending.create(
      'note.save',
      { title: g.title, project: g.project, source: g.source, text },
      `«${g.title}»${g.project ? ` → ${g.project}` : ''} (${g.source})\n${preview}${text.length > 120 ? '…' : ''}`,
      ownerId,
    );
    return { proposal: card(p) };
  });

  // ---------- confirmations ----------

  app.get('/api/pending', async () => ({ items: (await s.pending.listPending()).map(card) }));

  app.post<{ Params: { id: string } }>('/api/pending/:id/confirm', async (req) => {
    const r = await runPending(s, req.params.id);
    if (r.claimed) await s.messages.add(ownerId, 'assistant', `${r.ok ? 'Підтверджено і виконано' : 'Помилка виконання'}: ${r.text}`);
    return r;
  });

  app.post<{ Params: { id: string } }>('/api/pending/:id/cancel', async (req) => {
    const ok = await s.pending.cancel(req.params.id);
    if (ok) await s.messages.add(ownerId, 'assistant', 'Користувач скасував підготовлену дію.');
    return { ok };
  });

  app.post<{ Params: { id: string }; Body: { project?: string } }>('/api/pending/:id/project', async (req, reply) => {
    const p = await s.pending.get(req.params.id);
    const projects = (await s.settings.get()).projects;
    const project = projects.find((x) => x === req.body?.project);
    if (!p || p.status !== 'pending' || p.kind !== 'note.save' || !project) return reply.code(400).send({ error: 'bad request' });
    const summary = p.summary.replace(/ → [^(]+/, ' ').replace(/^«([^»]*)»\s*/, `«$1» → ${project} `);
    await s.pending.updatePayload(p.id, { ...p.payload, project }, summary);
    return { proposal: card({ ...p, summary, payload: { ...p.payload, project } }) };
  });

  // ---------- data screens ----------

  app.get('/api/today', async () => buildToday(s));

  app.get<{ Querystring: { project?: string; done?: string } }>('/api/tasks', async (req) => {
    const notion = await s.notion();
    const tasks = await notion.queryTasks({ project: req.query.project || undefined, open: req.query.done !== '1', limit: 300 });
    return { tasks, projects: (await s.settings.get()).projects };
  });

  /** A click in the UI is the owner's own confirmation: the action still goes through the pending/claim path. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/complete', async (req) => {
    const t = await (await s.notion()).getTask(req.params.id);
    const p = await s.pending.create('task.complete', { id: t.id, label: t.title }, `Завершити задачу «${t.title}»`, ownerId);
    return runPending(s, p.id);
  });

  app.post<{ Body: { title?: string; project?: string; due?: string } }>('/api/tasks', async (req, reply) => {
    const title = String(req.body?.title ?? '').trim();
    if (title.length < 2) return reply.code(400).send({ error: 'Вкажіть назву' });
    const st = await s.settings.get();
    const project = req.body?.project ? st.projects.find((p) => p === req.body!.project) : undefined;
    if (req.body?.project && !project) return reply.code(400).send({ error: 'Невідомий проєкт' });
    const due = req.body?.due && /^\d{4}-\d{2}-\d{2}$/.test(req.body.due) ? req.body.due : undefined;
    const notion = await s.notion();
    const dup = await notion.findDuplicate(title, project);
    if (dup) return reply.code(409).send({ error: `Схожа задача вже є: «${dup.title}»`, existing: dup });
    const p = await s.pending.create('task.create', { title, project, due }, `Створити задачу «${title}»`, ownerId);
    return runPending(s, p.id);
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/finance', async (req) => {
    const zone = (await s.settings.get()).timezone;
    const now = DateTime.fromJSDate(s.clock(), { zone });
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const from = req.query.from && iso.test(req.query.from) ? req.query.from : now.startOf('month').toISODate()!;
    const to = req.query.to && iso.test(req.query.to) ? req.query.to : now.endOf('month').toISODate()!;
    const entries = await (await s.notion()).queryFinance(from, to);
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return { from, to, totals: summarize(entries), entries: entries.slice(0, 300) };
  });

  app.get('/api/social', async () => {
    const out: Array<{ data: SocialData; delta: Record<string, number> }> = [];
    for (const platform of ['instagram', 'youtube']) {
      const { rows } = await s.db.query<{ data: SocialData; taken_on: Date }>(
        'SELECT data, taken_on FROM social_snapshots WHERE platform = $1 ORDER BY taken_on DESC LIMIT 1',
        [platform],
      );
      if (!rows[0]) continue;
      const prev = await s.db.query<{ data: SocialData }>(
        `SELECT data FROM social_snapshots WHERE platform = $1 AND taken_on <= ($2::date - 7) ORDER BY taken_on DESC LIMIT 1`,
        [platform, rows[0].taken_on],
      );
      out.push({ data: rows[0].data, delta: diffTotals(prev.rows[0]?.data, rows[0].data) });
    }
    return { accounts: out };
  });

  app.get<{ Params: { kind: string } }>('/api/reports/:kind', async (req, reply) => {
    if (req.params.kind === 'morning') return { html: await buildMorningReport(s) };
    if (req.params.kind === 'evening') return { html: await buildEveningReport(s) };
    return reply.code(404).send({ error: 'unknown report' });
  });

  registerRealtime(app, s, opts.realtimeSecret);
  if (s.integrations) registerIntegrations(app, s);

  /** Voice picker: catalogue + a sample in the chosen voice/style (not saved). */
  const provider = () => (s.tts instanceof ElevenLabs ? 'elevenlabs' : s.tts instanceof OpenAiTts ? 'openai' : s.tts ? 'other' : 'none');

  app.get('/api/voice/options', async () => ({
    provider: provider(),
    voices: s.tts instanceof ElevenLabs ? ELEVEN_VOICES : OPENAI_VOICES,
    styles: Object.entries(VOICE_STYLES).map(([id, v]) => ({ id, label: v.label })),
  }));

  app.post<{ Body: { voice?: string; style?: string } }>('/api/voice/preview', async (req, reply) => {
    if (!s.tts) return reply.code(404).send({ error: 'Голос не підключено' });
    const catalogue = s.tts instanceof ElevenLabs ? ELEVEN_VOICES : OPENAI_VOICES;
    const voice = catalogue.find((v) => v.id === req.body?.voice)?.id;
    const style = req.body?.style && req.body.style in VOICE_STYLES ? req.body.style : undefined;
    const st = await s.settings.get();
    const text = `Привіт${st.ownerName ? `, ${st.ownerName}` : ''}! Я ${st.assistantName}. О третій у тебе рев’ю дизайну, а до того є хвилин сорок — можемо швиденько закрити лист юристу. Як тобі?`;
    const mp3 = s.tts instanceof ElevenLabs || s.tts instanceof OpenAiTts ? await s.tts.speak(text, { voice, style }) : await s.tts.speak(text);
    return { audio: Buffer.from(mp3).toString('base64') };
  });

  // ---------- settings & connections ----------

  app.get('/api/settings', async () => {
    const { notion: _n, ...st } = await s.settings.get();
    return st;
  });

  app.patch('/api/settings', async (req, reply) => {
    const parsed = settingsPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const { notion: _n, ...st } = await s.settings.update(parsed.data);
    return st;
  });

  app.get('/api/status', async () => {
    const st = await s.settings.get();
    const slot = async (name: 'google:work' | 'google:personal' | 'google:youtube' | 'instagram') => {
      const t = await s.tokens.get(name);
      if (!t || !(t.refreshToken || t.accessToken)) return { state: 'off' as const };
      return { state: t.meta.broken ? ('broken' as const) : ('on' as const), expiresAt: name === 'instagram' ? t.expiresAt : undefined };
    };
    const state = (sl: string) => signState({ slot: sl, owner: String(ownerId) }, cfg.APP_SECRET);
    return {
      integrations: {
        notion: { state: !s.notionApi ? 'off' : st.notion ? 'on' : 'setup' },
        work: { ...(await slot('google:work')), connectUrl: s.googleAuth?.authUrl('google:work', state('google:work')) },
        personal: { ...(await slot('google:personal')), connectUrl: s.googleAuth?.authUrl('google:personal', state('google:personal')) },
        youtube: { ...(await slot('google:youtube')), connectUrl: s.googleAuth?.authUrl('google:youtube', state('google:youtube')) },
        instagram: { ...(await slot('instagram')), connectUrl: s.instagram?.authUrl(state('instagram')) },
        voice: { state: s.tts ? 'on' : 'off' },
      },
    };
  });

  app.setErrorHandler((err, req, reply) => {
    s.log.error('web_error', { url: req.url.split('?')[0], error: errMsg(err).slice(0, 300) });
    const status = (err as { statusCode?: number }).statusCode;
    reply.code(status && status < 500 ? status : 500).send({ error: errMsg(err).slice(0, 300) });
  });

  // ---------- SPA ----------

  const root = opts.serveStatic === false ? undefined : findWebRoot();
  if (root) {
    await app.register(fastifyStatic, { root });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }
}
