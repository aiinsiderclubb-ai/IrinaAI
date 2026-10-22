import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useHash } from '../router';
import { IconMic, IconSend } from '../icons';
import type { ChatMsg, Proposal, Settings } from '../types';
import { ProposalCard, useToast } from '../ui';

interface AgentReply {
  text: string;
  proposals: Proposal[];
  transcript?: string;
  audio?: string;
}

const SUGGESTIONS = [
  'Що в мене сьогодні?',
  'Склади план дня за вільним часом',
  'Які задачі прострочені?',
  'Скільки я витратив цього місяця?',
  'Покажи метрики Instagram і YouTube',
];

const ASK: Record<string, string> = { plan: 'Склади план мого дня на сьогодні за вільним часом.' };

export function Chat({ onChanged }: { onChanged: () => void }) {
  const [log, setLog] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [asMaterial, setAsMaterial] = useState(false);
  const [recording, setRecording] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const recorder = useRef<MediaRecorder | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const { params } = useHash();
  const asked = useRef(false);

  useEffect(() => {
    api.get<{ messages: ChatMsg[] }>('/api/history').then((r) => setLog(r.messages)).catch(() => {});
    api.get<{ items: Proposal[] }>('/api/pending').then((r) => r.items.length && setLog((l) => [...l, { role: 'assistant', content: 'Очікують підтвердження:', proposals: r.items }])).catch(() => {});
    api.get<Settings>('/api/settings').then((s) => setProjects(s.projects)).catch(() => {});
  }, []);

  // block body: scrollIntoView returns a Promise in recent browsers, which React would treat as a cleanup
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log, busy]);

  const push = (m: ChatMsg) => setLog((l) => [...l, m]);

  const handleReply = useCallback(
    (r: AgentReply) => {
      if (r.text || r.proposals.length) push({ role: 'assistant', content: r.text, proposals: r.proposals });
      if (r.audio) void new Audio(`data:audio/mpeg;base64,${r.audio}`).play().catch(() => {});
      if (r.proposals.length) onChanged();
    },
    [onChanged],
  );

  const send = useCallback(
    async (msg: string) => {
      const body = msg.trim();
      if (!body || busy) return;
      setText('');
      push({ role: 'user', content: body });
      setBusy(true);
      try {
        if (asMaterial) {
          const r = await api.post<{ proposal: Proposal }>('/api/import', { text: body });
          push({ role: 'assistant', content: 'Куди зберегти цей матеріал?', proposals: [r.proposal] });
          setAsMaterial(false);
        } else handleReply(await api.post<AgentReply>('/api/chat', { text: body }));
      } catch (e) {
        push({ role: 'assistant', content: `⚠️ ${e instanceof ApiError ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [asMaterial, busy, handleReply],
  );

  useEffect(() => {
    const key = params.get('ask');
    if (key && ASK[key] && !asked.current) {
      asked.current = true;
      window.history.replaceState(null, '', '#/chat');
      void send(ASK[key]);
    }
  }, [params, send]);

  const toggleMic = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Немає доступу до мікрофона');
      return;
    }
    const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType.split(';')[0] || 'audio/webm' });
      if (blob.size < 1500) return;
      setBusy(true);
      try {
        const r = await api.upload<AgentReply>('/api/voice', blob);
        if (r.transcript) push({ role: 'user', content: r.transcript, voice: true });
        handleReply(r);
      } catch (e) {
        push({ role: 'assistant', content: `⚠️ ${e instanceof ApiError ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    };
    recorder.current = rec;
    rec.start();
    setRecording(true);
  };

  return (
    <div className="chat">
      <div className="chat-log" aria-live="polite">
        {log.length === 0 && !busy && (
          <div style={{ textAlign: 'center', paddingTop: '12vh' }}>
            <h1>Чим допомогти?</h1>
            <p className="muted">Пишіть або говоріть. Усі зміни виконуються лише після вашого підтвердження.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="btn" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} style={{ display: 'contents' }}>
            {m.content && <div className={`bubble ${m.role}`}>{m.voice ? `🎙 ${m.content}` : m.content}</div>}
            {m.proposals?.map((p) => <ProposalCard key={p.id} p={p} projects={projects} onResolved={onChanged} />)}
          </div>
        ))}
        {busy && <div className="bubble assistant typing">Думаю…</div>}
        <div ref={endRef} />
      </div>
      <div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <textarea
            className="textarea"
            rows={1}
            value={text}
            placeholder={asMaterial ? 'Вставте відповідь ChatGPT / Dot — розкладу за проєктом' : 'Напишіть асистенту…'}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            aria-label="Повідомлення"
          />
          <button type="button" className={`btn btn-icon mic ${recording ? 'recording' : ''}`} onClick={toggleMic} disabled={busy && !recording} title={recording ? 'Зупинити запис' : 'Голосом'} aria-label={recording ? 'Зупинити запис' : 'Записати голосом'}>
            <IconMic />
          </button>
          <button className="btn btn-primary btn-icon" disabled={busy || !text.trim()} title="Надіслати" aria-label="Надіслати">
            <IconSend />
          </button>
        </form>
        <div className="composer-opts">
          <label className="toggle">
            <input type="checkbox" checked={asMaterial} onChange={(e) => setAsMaterial(e.target.checked)} /> Зберегти як матеріал (ChatGPT, Dot)
          </label>
          <span className="hint-desktop">Enter — надіслати, Shift+Enter — новий рядок</span>
        </div>
      </div>
    </div>
  );
}
