import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { buildSystemPrompt, runToolCall } from '../agent/agent.js';
import { buildVoiceTools, toolSpecs, type ToolContext } from '../agent/tools.js';
import { createRealtimeSecret, type RealtimeSecret } from '../integrations/openai.js';
import { nudgesAfter } from '../modules/nudges.js';
import type { Services } from '../services.js';
import { kvGet, kvSet } from '../store/kv.js';
import type { PendingAction } from '../store/pending.js';

export type SecretFactory = (session: Record<string, unknown>) => Promise<RealtimeSecret>;

const card = (p: PendingAction) => ({ id: p.id, kind: p.kind, summary: p.summary, project: p.payload?.project ?? null });

/** Session config for OpenAI Realtime (speech-to-speech). Tools are executed by our server, not by OpenAI. */
export async function buildRealtimeSession(s: Services, opts: { handsFree: boolean }): Promise<Record<string, unknown>> {
  const st = await s.settings.get();
  const tools = toolSpecs(buildVoiceTools()).map((t) => ({ type: 'function', ...t }));
  return {
    type: 'realtime',
    model: s.cfg.OPENAI_REALTIME_MODEL,
    instructions: await buildSystemPrompt(s, 'voice'),
    audio: {
      input: {
        // no context prompt here: on noise the recogniser would return the prompt itself as «speech»
        transcription: { model: s.cfg.OPENAI_TRANSCRIBE_MODEL, language: st.language },
        // laptop mic + speakers: suppress room noise before it reaches the model
        noise_reduction: { type: 'far_field' },
        // The browser decides when to answer, from the transcript: noise and the assistant's own voice coming back
        // through the speakers must neither start a reply nor cut the current one.
        turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: false },
      },
      output: { voice: s.cfg.OPENAI_REALTIME_VOICE },
    },
    tools,
    tool_choice: 'auto',
  };
}

export function registerRealtime(app: FastifyInstance, s: Services, createSecret?: SecretFactory): void {
  const ownerId = s.cfg.OWNER_TELEGRAM_ID;
  const tools = buildVoiceTools();
  const secretFactory: SecretFactory = createSecret ?? ((session) => createRealtimeSecret(s.cfg.OPENAI_API_KEY, session));

  app.post<{ Body: { handsFree?: boolean } }>('/api/realtime/session', async (req) => {
    const st = await s.settings.get();
    const handsFree = Boolean(req.body?.handsFree);
    const secret = await secretFactory(await buildRealtimeSession(s, { handsFree }));
    // first voice session of the day starts with a short spoken briefing
    const today = DateTime.fromJSDate(s.clock(), { zone: st.timezone }).toISODate()!;
    const greet = (await kvGet<string>(s.db, 'voice_greeted_on')) !== today;
    if (greet) await kvSet(s.db, 'voice_greeted_on', today);
    return { value: secret.value, expiresAt: secret.expiresAt, model: s.cfg.OPENAI_REALTIME_MODEL, assistantName: st.assistantName, greet };
  });

  app.post<{ Body: { name?: string; arguments?: string; lastUserText?: string } }>('/api/realtime/tool', async (req, reply) => {
    const name = String(req.body?.name ?? '');
    if (!name) return reply.code(400).send({ error: 'name required' });
    const ctx: ToolContext = { s, chatId: ownerId, proposals: [], lastUserText: req.body?.lastUserText };
    const output = await runToolCall(tools, name, String(req.body?.arguments ?? '{}'), ctx);
    return { output, proposals: ctx.proposals.map(card) };
  });

  /** Voice turns go into the same history as Telegram and text chat, so context carries over. */
  app.post<{ Body: { role?: string; text?: string } }>('/api/realtime/transcript', async (req, reply) => {
    const role = req.body?.role === 'assistant' ? 'assistant' : req.body?.role === 'user' ? 'user' : null;
    const text = String(req.body?.text ?? '').trim();
    if (!role || !text) return reply.code(400).send({ error: 'bad request' });
    await s.messages.add(ownerId, role, role === 'user' ? `🎙 ${text}` : text);
    return { ok: true };
  });

  app.get<{ Querystring: { after?: string } }>('/api/nudges', async (req) => ({ items: await nudgesAfter(s, req.query.after) }));

  app.get('/api/memories', async () => ({ items: await s.memory.list() }));
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req) => ({ ok: await s.memory.forget(Number(req.params.id)) }));
}
