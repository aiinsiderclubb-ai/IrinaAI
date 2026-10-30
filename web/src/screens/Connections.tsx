import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { ErrorNote, Loading, useLoad, useToast } from '../ui';

type State = 'on' | 'off' | 'broken' | 'setup';
interface McpToolView {
  name: string;
  description: string;
  enabled: boolean;
  confirm: boolean;
}
type CustomView =
  | { id: string; type: 'webhook'; name: string; description: string; url: string; secret?: string; params: Array<{ name: string; description: string; required: boolean }>; enabled: boolean }
  | { id: string; type: 'mcp'; name: string; url: string; authorization?: string; tools: McpToolView[]; enabled: boolean };

interface View {
  notion: { state: State; token?: string; readOnly: boolean; tasksDb?: string; mapping?: any; contextPages: string[]; helperDbs: Record<string, boolean> };
  google: { configured: boolean; clientId?: string; clientSecret?: string; redirectUri: string; readOnly: boolean; calendars: Record<'work' | 'personal', string>; accounts: Record<'work' | 'personal' | 'youtube', { state: State; connectUrl?: string }> };
  meta: { configured: boolean; appId?: string; appSecret?: string; redirectUri: string; login: 'facebook' | 'instagram'; configId?: string; instagram: { state: State; connectUrl?: string; expiresAt?: string; username?: string } };
  elevenlabs: { state: State; apiKey?: string };
  openai: { apiKey?: string; model: string };
  custom: CustomView[];
}

const STATE: Record<State, string> = { on: 'підключено', off: 'не підключено', broken: 'перепідключити', setup: 'потрібне налаштування' };
const Pill = ({ state, label }: { state: State; label?: string }) => <span className={`pill pill-${state}`}>{label ?? STATE[state]}</span>;

function useSave(setView: (v: View) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<View | { view: View } | void>, ok?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r && 'view' in r) setView(r.view);
      else if (r) setView(r as View);
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

function Section({ title, hint, right, children, open: initial = false }: { title: string; hint: string; right?: ReactNode; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <li className="conn">
      <button type="button" className="conn-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="grow">
          <div className="title">{title}</div>
          <div className="meta">{hint}</div>
        </div>
        {right}
        <span className="conn-chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && <div className="conn-body">{children}</div>}
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

function Copy({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="copy-row">
      <code>{value}</code>
      <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(value).then(() => toast('Скопійовано'))}>
        Копіювати
      </button>
    </div>
  );
}

/** Опції → Підключення: configure and connect everything from the cabinet. */
export function Connections() {
  const { data, error, loading, setData } = useLoad<View>('/api/integrations');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorNote text={error} />;
  return <ConnectionsBody view={data} setView={setData} />;
}

function ConnectionsBody({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { busy, run } = useSave(setView);
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Підключення</h2>
          <span className="count">ключі зберігаються зашифрованими</span>
        </div>
        <ul className="list conns">
          <NotionSection view={view} setView={setView} />
          <GoogleSection view={view} busy={busy} run={run} />
          <MetaSection view={view} busy={busy} run={run} />
          <TelegramSection />
          <KeySection
            title="Голос (ElevenLabs)"
            hint="Найбільш людяні голоси. Без ключа — голос OpenAI"
            state={view.elevenlabs.state}
            current={view.elevenlabs.apiKey}
            placeholder="sk_…"
            onSave={(apiKey) => run('eleven', () => api.put<View>('/api/integrations/elevenlabs', { apiKey }), 'ElevenLabs підключено')}
            onClear={() => run('eleven', () => api.del<View>('/api/integrations/elevenlabs'))}
            busy={busy === 'eleven'}
          />
          <KeySection
            title="OpenAI"
            hint={`Мозок асистента (${view.openai.model}). Ключ клієнта для постійної роботи`}
            state="on"
            current={view.openai.apiKey}
            placeholder="sk-proj-…"
            onSave={(apiKey) => run('openai', () => api.put<View>('/api/integrations/openai', { apiKey }), 'Ключ OpenAI оновлено')}
            onClear={() => run('openai', () => api.del<View>('/api/integrations/openai'))}
            busy={busy === 'openai'}
          />
        </ul>
      </section>
      <CustomSection view={view} busy={busy} run={run} />
    </>
  );
}

// ---------- Telegram: who may talk to the bot ----------

interface TgUser {
  id: number;
  name: string;
  reports: boolean;
}
interface TgAccess {
  ownerId: number;
  allowed: TgUser[];
  requests: Array<{ id: number; name: string; username?: string; at: string }>;
}

function TelegramSection() {
  const toast = useToast();
  const [data, setData] = useState<TgAccess | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get<TgAccess>('/api/integrations/telegram').then(setData, () => {});
  useEffect(() => void load(), []);
  const act = async (fn: () => Promise<TgAccess>, ok?: string) => {
    setBusy(true);
    try {
      setData(await fn());
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const allow = (body: { id: number; name: string }) => act(() => api.post<TgAccess>('/api/integrations/telegram', { ...body, reports: false }), 'Доступ надано');
  const extra = data?.allowed.length ?? 0;
  return (
    <Section title="Telegram · доступ" hint="Хто ще може писати боту, окрім власника" right={<Pill state="on" label={extra ? `+${extra}` : 'лише власник'} />}>
      {!data ? (
        <div className="muted">Завантаження…</div>
      ) : (
        <>
          <div className="muted">
            Власник: {data.ownerId}. Додані люди бачать ті самі дані й можуть підтверджувати дії. Хто напише боту без доступу, зʼявиться нижче.
          </div>
          {data.requests.length > 0 && (
            <ul className="steps" style={{ marginTop: 10 }}>
              {data.requests.map((r) => (
                <li key={r.id}>
                  <div className="row">
                    <span className="grow">
                      <b>{r.name || 'Без імені'}</b>
                      {r.username ? ` @${r.username}` : ''} <span className="muted">· ID {r.id} · {new Date(r.at).toLocaleString('uk-UA')}</span>
                    </span>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void allow({ id: r.id, name: r.name })}>
                      Дозволити
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.del<TgAccess>(`/api/integrations/telegram/${r.id}`))}>
                      Відхилити
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.allowed.length > 0 && (
            <ul className="steps" style={{ marginTop: 10 }}>
              {data.allowed.map((u) => (
                <li key={u.id}>
                  <div className="row">
                    <span className="grow">
                      <b>{u.name}</b> <span className="muted">· ID {u.id}</span>
                    </span>
                    <label className="toggle">
                      <input type="checkbox" checked={u.reports} disabled={busy} onChange={(e) => void act(() => api.patch<TgAccess>(`/api/integrations/telegram/${u.id}`, { reports: e.target.checked }))} />
                      звіти й нагадування
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => confirm(`Забрати доступ у ${u.name}?`) && void act(() => api.del<TgAccess>(`/api/integrations/telegram/${u.id}`), 'Доступ забрано')}
                    >
                      Забрати
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="form-grid" style={{ padding: '10px 0 0' }}>
            <Field label="Telegram ID">
              <input className="input" inputMode="numeric" value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} placeholder="напр. 123456789" />
            </Field>
            <Field label="Імʼя">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" disabled={!id || busy} onClick={() => void allow({ id: Number(id), name }).then((ok) => ok && (setId(''), setName('')))}>
              Додати
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load()}>
              Оновити
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

// ---------- Notion ----------

interface BrowseItem {
  id: string;
  type: 'database' | 'page';
  title: string;
}

function NotionSection({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { busy, run } = useSave(setView);
  const [token, setToken] = useState('');
  const [items, setItems] = useState<BrowseItem[] | null>(null);
  const [tasksDb, setTasksDb] = useState(view.notion.tasksDb ?? '');
  const [pages, setPages] = useState<string[]>(view.notion.contextPages ?? []);
  const [preview, setPreview] = useState<{ mapping: any; projects: string[]; sample: Array<{ title: string; project?: string; status: string; due?: string }> } | null>(null);
  const n = view.notion;
  const toast = useToast();

  const browse = () =>
    run('notion-browse', async () => {
      const r = await api.get<{ items: BrowseItem[] }>('/api/integrations/notion/browse');
      setItems(r.items);
      if (!r.items.length) toast('Інтеграція поки нічого не бачить: додайте її до сторінок через «•••» → Connections');
    });

  const connectToken = () =>
    run('notion-token', async () => {
      const r = await api.post<{ bot: string; workspace?: string; view: View }>('/api/integrations/notion/token', { token });
      setToken('');
      toast(`Підключено${r.workspace ? ` до «${r.workspace}»` : ''}`);
      const b = await api.get<{ items: BrowseItem[] }>('/api/integrations/notion/browse');
      setItems(b.items);
      return r.view;
    });

  const configure = () =>
    run(
      'notion-cfg',
      async () => {
        const r = await api.post<{ mapping: any; projects: string[]; sample: any[]; view: View }>('/api/integrations/notion/configure', { tasksDb, contextPages: pages });
        setPreview(r);
        return r.view;
      },
      'Налаштовано (лише читання)',
    );

  const setReadOnly = (readOnly: boolean) => {
    if (!readOnly && !window.confirm('Дозволити асистенту записувати в Notion (задачі, статуси) після вашого підтвердження кожної дії? Переконайтесь, що власниця простору погодила.')) return;
    void run('notion-ro', () => api.patch<View>('/api/integrations/notion', { readOnly }), readOnly ? 'Notion: лише читання' : 'Запис у Notion увімкнено');
  };

  const dbs = (items ?? []).filter((i) => i.type === 'database');
  const pgs = (items ?? []).filter((i) => i.type === 'page');

  return (
    <Section
      title="Notion"
      hint="Задачі, рішення, фінанси, контекст власника"
      right={<>{n.token && <span className={`pill ${n.readOnly ? 'pill-setup' : 'pill-on'}`}>{n.readOnly ? 'лише читання' : 'читання і запис'}</span>}<Pill state={n.state} /></>}
    >
      <ol className="steps">
        <li>
          <b>Токен інтеграції.</b> notion.so/profile/integrations → New integration (Internal) → скопіюйте «Internal Integration Secret».
          {n.token && <div className="muted">Зараз: {n.token}</div>}
          <div className="row">
            <input className="input grow-input" type="password" placeholder="ntn_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <button type="button" className="btn btn-primary btn-sm" disabled={!token || busy === 'notion-token'} onClick={() => void connectToken()}>
              {busy === 'notion-token' ? 'Перевіряю…' : 'Підключити'}
            </button>
          </div>
        </li>
        <li>
          <b>Доступ до сторінок.</b> У Notion на потрібних сторінках і базах: «•••» → Connections → додайте інтеграцію. Асистент бачить лише те, що ви дозволили.
          {n.token && (
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => void browse()} disabled={busy === 'notion-browse'}>
                {busy === 'notion-browse' ? 'Шукаю…' : items ? 'Оновити список' : 'Показати, що бачить асистент'}
              </button>
            </div>
          )}
        </li>
        {items && (
          <li>
            <b>Що використовувати.</b>
            <div className="form-grid" style={{ padding: '10px 0 0' }}>
              <Field label="База задач (наявна, нічого не створюємо)">
                <select className="select" value={tasksDb} onChange={(e) => setTasksDb(e.target.value)}>
                  <option value="">— оберіть —</option>
                  {dbs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {pgs.length > 0 && (
              <div className="checks">
                <div className="muted" style={{ fontSize: 13 }}>Сторінки з правилами й пріоритетами, які асистент читає (до 5):</div>
                {pgs.map((p) => (
                  <label key={p.id} className="toggle">
                    <input
                      type="checkbox"
                      checked={pages.includes(p.id)}
                      onChange={(e) => setPages(e.target.checked ? [...pages, p.id].slice(0, 5) : pages.filter((x) => x !== p.id))}
                    />
                    {p.title}
                  </label>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={!tasksDb || busy === 'notion-cfg'} onClick={() => void configure()}>
                {busy === 'notion-cfg' ? 'Читаю структуру…' : 'Застосувати (лише читання)'}
              </button>
            </div>
          </li>
        )}
      </ol>

      {(preview || n.mapping) && (
        <div className="mapping">
          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Як асистент зрозумів вашу базу задач:</div>
          <MappingView mapping={preview?.mapping ?? n.mapping} />
          {preview?.sample?.length ? (
            <ul className="mini">
              {preview.sample.map((t, i) => (
                <li key={i}>
                  {t.title} <span className="muted">· {t.status}{t.project ? ` · ${t.project}` : ''}{t.due ? ` · до ${t.due.slice(0, 10)}` : ''}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {n.token && (
        <div className="row" style={{ marginTop: 12 }}>
          <label className="toggle">
            <input type="checkbox" checked={!n.readOnly} onChange={(e) => setReadOnly(!e.target.checked)} />
            Дозволити запис у Notion (кожна дія — після «Підтвердити»)
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.confirm('Відключити Notion від асистента? У самому Notion нічого не зміниться.') && void run('notion-off', () => api.del<View>('/api/integrations/notion'))}>
            Відключити
          </button>
        </div>
      )}
    </Section>
  );
}

function MappingView({ mapping }: { mapping: any }) {
  if (!mapping) return null;
  const row = (label: string, v?: { name: string; type: string }) => (
    <div className="map-row" key={label}>
      <span className="muted">{label}</span>
      <span>{v ? `${v.name}` : '—'}</span>
    </div>
  );
  return (
    <div className="map">
      {row('Назва', mapping.title)}
      <div className="map-row">
        <span className="muted">Статус</span>
        <span>
          {mapping.status?.name}: «{mapping.status?.todo}» → {mapping.status?.doing ? `«${mapping.status.doing}» → ` : ''}«{mapping.status?.done}»
        </span>
      </div>
      {mapping.projectFromTitle ? (
        <div className="map-row">
          <span className="muted">Проєкт</span>
          <span>з назви задачі («MLI · …»)</span>
        </div>
      ) : (
        row('Проєкт', mapping.project)
      )}
      {row('Дедлайн', mapping.due)}
      {row('Пріоритет', mapping.priority)}
      {row('Напрям', mapping.area)}
      {row('Відповідальний', mapping.owner)}
      {row('Примітка', mapping.notes)}
    </div>
  );
}

// ---------- Google / Meta ----------

type Run = (key: string, fn: () => Promise<View | { view: View } | void>, ok?: string) => Promise<boolean>;

function GoogleSection({ view, busy, run }: { view: View; busy: string | null; run: Run }) {
  const g = view.google;
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const connected = Object.values(g.accounts).filter((a) => a.state === 'on').length;
  const setCalendarReadOnly = (readOnly: boolean) => {
    if (!readOnly && !window.confirm('Дозволити асистенту створювати події в календарі після вашого підтвердження кожної дії? Переконайтесь, що власниця календаря погодила.')) return;
    void run('google-ro', () => api.patch<View>('/api/integrations/google', { readOnly }), readOnly ? 'Календар: лише читання' : 'Запис у календар увімкнено');
  };
  return (
    <Section title="Google: календарі та YouTube" hint="Робочий і особистий календар, статистика YouTube (лише читання)" right={<Pill state={connected ? 'on' : g.configured ? 'setup' : 'off'} label={connected ? `${connected}/3 підключено` : undefined} />}>
      <ol className="steps">
        <li>
          <b>OAuth-клієнт Google.</b> console.cloud.google.com → APIs: Calendar, YouTube Data, YouTube Analytics → OAuth consent screen (Publish app) → Credentials → OAuth client ID (Web). Authorized redirect URI:
          <Copy value={g.redirectUri} />
          {g.clientId && <div className="muted">Зараз: {g.clientId}{g.clientSecret ? ` · ${g.clientSecret}` : ''}</div>}
          <div className="form-grid" style={{ padding: '8px 0 0' }}>
            <Field label="Client ID">
              <input className="input" value={id} onChange={(e) => setId(e.target.value)} placeholder="…apps.googleusercontent.com" />
            </Field>
            <Field label="Client secret">
              <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={g.clientSecret ? 'залишити як є' : 'GOCSPX-…'} autoComplete="off" />
            </Field>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" disabled={!id || busy === 'google'} onClick={() => void run('google', () => api.put<View>('/api/integrations/google', { clientId: id, clientSecret: secret }), 'Google налаштовано')}>
              Зберегти
            </button>
            {g.clientSecret && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run('google', () => api.del<View>('/api/integrations/google'))}>
                Видалити ключі
              </button>
            )}
          </div>
        </li>
        <li>
          <b>Підключити акаунти.</b> Google покаже «неперевірений застосунок» — «Додатково → Перейти». Можна увійти акаунтом, якому надали доступ до календарів, — і нижче обрати потрібний календар.
          <ul className="list" style={{ padding: 0 }}>
            {([['work', 'Календар — робочий'], ['personal', 'Календар — особистий'], ['youtube', 'YouTube (статистика)']] as const).map(([k, label]) => (
              <li key={k}>
                <span className="grow">{label}</span>
                <Pill state={g.accounts[k].state} />
                {g.accounts[k].connectUrl && (
                  <a className="btn btn-sm" href={g.accounts[k].connectUrl} target="_blank" rel="noreferrer">
                    {g.accounts[k].state === 'on' ? 'Перепідключити' : 'Підключити'}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </li>
        {(g.accounts.work.state === 'on' || g.accounts.personal.state === 'on') && (
          <li>
            <b>Який календар читати.</b>
            <ul className="list" style={{ padding: 0 }}>
              {(['work', 'personal'] as const)
                .filter((k) => g.accounts[k].state === 'on')
                .map((k) => (
                  <CalendarPick key={k} account={k} current={g.calendars[k]} busy={busy} run={run} />
                ))}
            </ul>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="toggle">
                <input type="checkbox" checked={!g.readOnly} onChange={(e) => setCalendarReadOnly(!e.target.checked)} />
                Дозволити запис у календар (події, план дня, дзеркало робочий↔особистий; кожна подія — після «Підтвердити»)
              </label>
            </div>
          </li>
        )}
      </ol>
    </Section>
  );
}

function CalendarPick({ account, current, busy, run }: { account: 'work' | 'personal'; current: string; busy: string | null; run: Run }) {
  const [items, setItems] = useState<Array<{ id: string; name: string; primary: boolean; access: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ items: Array<{ id: string; name: string; primary: boolean; access: string }> }>(`/api/integrations/google/calendars/${account}`)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [account]);
  const ACCESS: Record<string, string> = { owner: 'власник', writer: 'редагування', reader: 'перегляд', freeBusyReader: 'лише зайнятість' };
  const value = current === 'primary' ? items?.find((c) => c.primary)?.id ?? 'primary' : current;
  return (
    <li>
      <span className="grow">{account === 'work' ? 'Робочий' : 'Особистий'}</span>
      {error ? (
        <span className="muted">{error}</span>
      ) : !items ? (
        <span className="muted">завантажую…</span>
      ) : (
        <select
          className="select"
          style={{ maxWidth: 320 }}
          value={value}
          disabled={busy === `cal-${account}`}
          onChange={(e) => void run(`cal-${account}`, () => api.patch<View>('/api/integrations/google', { calendars: { [account]: e.target.value } }), 'Календар обрано')}
        >
          {items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.primary ? ' (основний)' : ''} · {ACCESS[c.access] ?? c.access}
            </option>
          ))}
        </select>
      )}
    </li>
  );
}

function MetaSection({ view, busy, run }: { view: View; busy: string | null; run: Run }) {
  const m = view.meta;
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [configId, setConfigId] = useState(m.configId ?? '');
  const [login, setLogin] = useState<'facebook' | 'instagram'>(m.login);
  const fb = login === 'facebook';
  const savedId = m.appId && !m.appId.includes('сервера') ? m.appId : '';
  return (
    <Section title="Instagram" hint="Business / Creator, лише читання статистики" right={<Pill state={m.instagram.state === 'on' ? 'on' : m.configured ? 'setup' : 'off'} />}>
      <ol className="steps">
        <li>
          <b>Як входимо.</b>
          <div className="row" style={{ marginTop: 6 }}>
            <select className="input" value={login} onChange={(e) => setLogin(e.target.value as 'facebook' | 'instagram')}>
              <option value="facebook">Через Facebook (доступ у бізнес-портфоліо)</option>
              <option value="instagram">Логін самим акаунтом Instagram</option>
            </select>
          </div>
        </li>
        <li>
          <b>Застосунок Meta.</b>{' '}
          {fb
            ? 'developers.facebook.com → Create app → тип Business → продукт «Facebook Login for Business» (або сценарій «Instagram API setup with Facebook login»). Valid OAuth Redirect URI:'
            : 'developers.facebook.com → Create app → продукт «Instagram API with Instagram Login». Redirect URI:'}
          <Copy value={m.redirectUri} />
          {m.appId && <div className="muted">Зараз: {m.appId}{m.appSecret ? ` · ${m.appSecret}` : ''}</div>}
          <div className="form-grid" style={{ padding: '8px 0 0' }}>
            <Field label={fb ? 'App ID' : 'Instagram App ID'}>
              <input className="input" value={id} onChange={(e) => setId(e.target.value)} />
            </Field>
            <Field label={fb ? 'App secret' : 'Instagram App secret'}>
              <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={m.appSecret ? 'залишити як є' : ''} autoComplete="off" />
            </Field>
            {fb && (
              <Field label="Configuration ID (необовʼязково)">
                <input className="input" value={configId} onChange={(e) => setConfigId(e.target.value)} placeholder="з Facebook Login for Business" />
              </Field>
            )}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!(id || savedId) || busy === 'meta'}
              onClick={() => void run('meta', () => api.put<View>('/api/integrations/meta', { appId: id || savedId, appSecret: secret, login, configId: fb ? configId : '' }), 'Instagram налаштовано')}
            >
              Зберегти
            </button>
          </div>
        </li>
        <li>
          <b>Підключити акаунт.</b> {fb ? 'Увійдіть акаунтом Facebook, якому надали доступ до Instagram, і позначте цей Instagram у вікні дозволів.' : ''}
          <div className="row">
            <Pill state={m.instagram.state} />
            {m.instagram.username && <span>@{m.instagram.username}</span>}
            {m.instagram.expiresAt && <span className="muted">токен до {new Date(m.instagram.expiresAt).toLocaleDateString('uk-UA')}</span>}
            {m.instagram.connectUrl && (
              <a className="btn btn-sm" href={m.instagram.connectUrl} target="_blank" rel="noreferrer">
                {m.instagram.state === 'on' ? 'Перепідключити' : 'Підключити Instagram'}
              </a>
            )}
          </div>
        </li>
      </ol>
    </Section>
  );
}

function KeySection(props: { title: string; hint: string; state: State; current?: string; placeholder: string; onSave: (v: string) => Promise<boolean>; onClear: () => void; busy: boolean }) {
  const [value, setValue] = useState('');
  return (
    <Section title={props.title} hint={props.hint} right={<Pill state={props.state} />}>
      {props.current && <div className="muted">Зараз: {props.current}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <input className="input grow-input" type="password" placeholder={props.placeholder} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        <button type="button" className="btn btn-primary btn-sm" disabled={!value || props.busy} onClick={() => void props.onSave(value).then((ok) => ok && setValue(''))}>
          {props.busy ? 'Перевіряю…' : 'Зберегти'}
        </button>
        {props.current && !props.current.includes('сервера') && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={props.onClear}>
            Видалити
          </button>
        )}
      </div>
    </Section>
  );
}

// ---------- custom integrations ----------

function CustomSection({ view, busy, run }: { view: View; busy: string | null; run: Run }) {
  const [adding, setAdding] = useState<'webhook' | 'mcp' | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Інші інтеграції</h2>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => setAdding(adding === 'webhook' ? null : 'webhook')}>
            + Дія (Make, Zapier, n8n)
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setAdding(adding === 'mcp' ? null : 'mcp')}>
            + MCP-сервер
          </button>
        </div>
      </div>
      <div className="empty" style={{ paddingTop: 4 }}>
        Підключайте будь-які сервіси: пошту, CRM, таблиці, месенджери. Асистент сам вирішує, коли їх використати; дії, що щось змінюють, — лише після вашого «Підтвердити».
      </div>
      {adding === 'webhook' && <WebhookForm busy={busy} run={run} onDone={() => setAdding(null)} />}
      {adding === 'mcp' && <McpForm busy={busy} run={run} onDone={() => setAdding(null)} />}
      {view.custom.length > 0 && (
        <ul className="list conns">
          {view.custom.map((c) => (
            <CustomItem key={c.id} c={c} busy={busy} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WebhookForm({ busy, run, onDone }: { busy: string | null; run: Run; onDone: () => void }) {
  const [f, setF] = useState({ name: '', description: '', url: '', secret: '' });
  const [params, setParams] = useState([{ name: '', description: '', required: true }]);
  const save = async () => {
    const ok = await run('webhook', () => api.post<View>('/api/integrations/custom/webhook', { ...f, params: params.filter((p) => p.name.trim()), enabled: true }), 'Дію додано');
    if (ok) onDone();
  };
  return (
    <div className="conn-body">
      <div className="muted" style={{ fontSize: 13 }}>
        У Make / Zapier / n8n створіть сценарій з тригером «Webhook» і вставте сюди його адресу. Асистент надсилатиме JSON: action, params.
      </div>
      <div className="form-grid" style={{ padding: '10px 0 0' }}>
        <Field label="Назва">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Надіслати лист" />
        </Field>
        <Field label="Адреса webhook (https)">
          <input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://hook.eu2.make.com/…" />
        </Field>
        <Field label="Секрет (необовʼязково)">
          <input className="input" type="password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} autoComplete="off" />
        </Field>
      </div>
      <Field label="Коли використовувати (опис для асистента)">
        <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Надіслати email від імені власника. Параметри: кому, тема, текст." />
      </Field>
      <div className="muted" style={{ fontSize: 13, margin: '12px 0 6px' }}>Параметри, які асистент заповнює:</div>
      {params.map((p, i) => (
        <div className="row" key={i} style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
          <input className="input" style={{ width: 140 }} value={p.name} placeholder="to" onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="input grow-input" value={p.description} placeholder="email отримувача" onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
          <label className="toggle" style={{ whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={p.required} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
            обовʼязковий
          </label>
        </div>
      ))}
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={() => setParams([...params, { name: '', description: '', required: false }])}>
          + параметр
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!f.name || !f.url || !f.description || busy === 'webhook'} onClick={() => void save()}>
          Додати дію
        </button>
      </div>
    </div>
  );
}

function McpForm({ busy, run, onDone }: { busy: string | null; run: Run; onDone: () => void }) {
  const [f, setF] = useState({ name: '', url: '', authorization: '' });
  const save = async () => {
    const ok = await run('mcp', () => api.post<View>('/api/integrations/custom/mcp', f), 'MCP-сервер підключено');
    if (ok) onDone();
  };
  return (
    <div className="conn-body">
      <div className="muted" style={{ fontSize: 13 }}>
        MCP — стандарт підключення інструментів до AI. Багато сервісів дають готовий MCP-сервер (Gmail, Slack, Linear, HubSpot, Zapier MCP). Потрібна адреса Streamable HTTP і, якщо треба, ключ.
      </div>
      <div className="form-grid" style={{ padding: '10px 0 0' }}>
        <Field label="Назва">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Gmail" />
        </Field>
        <Field label="Адреса сервера (https)">
          <input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…/mcp" />
        </Field>
        <Field label="Authorization (необовʼязково)">
          <input className="input" type="password" value={f.authorization} onChange={(e) => setF({ ...f, authorization: e.target.value })} placeholder="Bearer …" autoComplete="off" />
        </Field>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" disabled={!f.name || !f.url || busy === 'mcp'} onClick={() => void save()}>
          {busy === 'mcp' ? 'Підключаюсь…' : 'Підключити та показати інструменти'}
        </button>
      </div>
    </div>
  );
}

function CustomItem({ c, busy, run }: { c: CustomView; busy: string | null; run: Run }) {
  const remove = () => window.confirm(`Видалити «${c.name}»?`) && void run(`del-${c.id}`, () => api.del<View>(`/api/integrations/custom/${c.id}`));
  const toggle = (enabled: boolean) => void run(`tog-${c.id}`, () => api.patch<View>(`/api/integrations/custom/${c.id}`, { enabled }));
  return (
    <Section
      title={c.name}
      hint={c.type === 'webhook' ? `Дія · ${c.description}` : `MCP · ${c.tools.filter((t) => t.enabled).length} з ${c.tools.length} інструментів`}
      right={<Pill state={c.enabled ? 'on' : 'off'} label={c.enabled ? 'увімкнено' : 'вимкнено'} />}
    >
      <div className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{c.url}</div>
      {c.type === 'mcp' && (
        <ul className="list" style={{ padding: '6px 0' }}>
          {c.tools.map((t) => (
            <li key={t.name}>
              <div className="grow">
                <div className="title">{t.name}</div>
                <div className="meta">{t.description.slice(0, 160)}</div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={t.enabled} onChange={(e) => void run(`t-${c.id}`, () => api.patch<View>(`/api/integrations/custom/${c.id}`, { tools: [{ name: t.name, enabled: e.target.checked }] }))} />
                увімк.
              </label>
              <label className="toggle" title="Виклик показується карткою і виконується після «Підтвердити»">
                <input type="checkbox" checked={t.confirm} onChange={(e) => void run(`t-${c.id}`, () => api.patch<View>(`/api/integrations/custom/${c.id}`, { tools: [{ name: t.name, confirm: e.target.checked }] }))} />
                з підтвердженням
              </label>
            </li>
          ))}
        </ul>
      )}
      {c.type === 'webhook' && c.params.length > 0 && <div className="muted" style={{ fontSize: 13 }}>Параметри: {c.params.map((p) => p.name + (p.required ? '*' : '')).join(', ')}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <label className="toggle">
          <input type="checkbox" checked={c.enabled} onChange={(e) => toggle(e.target.checked)} />
          Увімкнено
        </label>
        {c.type === 'mcp' && (
          <button type="button" className="btn btn-sm" disabled={busy === 'mcp'} onClick={() => void run('mcp', () => api.post<View>('/api/integrations/custom/mcp', { id: c.id, name: c.name, url: c.url }), 'Інструменти оновлено')}>
            Оновити інструменти
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={remove}>
          Видалити
        </button>
      </div>
    </Section>
  );
}
