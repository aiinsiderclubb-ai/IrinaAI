# Personal AI Executive Assistant

Backend of the assistant from the contract of 21.10.2026 (AI Insider): Telegram bot (voice + text) that manages tasks in Notion,
two Google calendars, morning/evening reports, personal finance, Instagram/YouTube metrics, ChatGPT/Dot imports and event search.

Plan and contract analysis: [PLAN.md](PLAN.md).

Two front doors to the same assistant: the **Telegram bot** and a **web cabinet** (served by the same Render service at `PUBLIC_URL`).
Both use one agent, one conversation history and the same confirmation gate.

> The web cabinet is outside Appendix 1 of the contract ("веб-панель … — додаткові роботи", §2.3): agree it with the client as additional work.

## How it works

```
Telegram ──webhook──▶ Fastify (Render web service)
                        │  ack at once, process updates one by one (dedupe by update_id)
                        ▼
              grammY bot ─ voice ▶ OpenAI transcription ─┐
                        │                                 ▼
                        └────────────▶ Agent (OpenAI tool-calling, 6 steps max)
                                          │ read tools: run immediately
                                          │ change tools: create a PENDING ACTION only
                                          ▼
                              Telegram card  ✅ Підтвердити / ❌ Скасувати
                                          ▼ (confirm = claim once, then execute)
                         Notion · Google Calendar · finance table · notes
Scheduler (in-process, 30 s tick, idempotent per job+period in Postgres):
  morning/evening report · weekly events · calendar mirror (5 min) · social snapshots · token health · housekeeping
```

Design rules that come straight from the contract:

* **§2.5 confirmation**: every change of the owner's data is a `pending_actions` row and runs only after the button (`src/actions.ts`). The model cannot write anything itself.
* **Numbers are never computed by the model**: finance totals are summed in integer cents in code (`src/modules/finance.ts`).
* **§7.3 / §7.7 read-only social**: only official APIs, only read scopes; metrics the API refuses are listed as "API не віддає", never invented.
* **§9 data**: one allowed Telegram user, tokens encrypted at rest (AES-256-GCM), logs carry metadata only, chat history pruned after 30 days.
* **No duplicates / done tasks stay done**: a similar open task in the same project blocks creation; completed tasks are never carried forward.

| Contract module | Code |
|---|---|
| 1 Voice & text | `telegram/bot.ts`, `agent/*`, `integrations/openai.ts`, `integrations/tts.ts` |
| 2 Projects (Notion) | `notion/*`, tools `task_*`, `decision_log`, `waiting_*` |
| 3 Calendar | `integrations/google-*.ts`, `calendar/logic.ts` (conflicts, free slots, day plan), `calendar/sync.ts` (two-way mirror) |
| 4 Reports | `modules/reports.ts`, `scheduler.ts` |
| 5 Finance | `modules/finance.ts`, tools `finance_*` |
| 6 Instagram & YouTube | `integrations/instagram.ts`, `youtube.ts`, `modules/social.ts` |
| 7 ChatGPT & Dot | forwarded message / file / `gpt:` prefix → `modules/importer.ts` → «Матеріали» |
| 8 Events | `modules/events.ts` (OpenAI web search, dedupe, weekly job) |

## Web cabinet

| Screen | What it shows / does |
|---|---|
| Сьогодні | both calendars (mirrors hidden, conflicts flagged), focus tasks, expected replies, week deadlines, pending confirmations, morning/evening report on demand, "plan my day" |
| Асистент | chat with the agent, voice from the browser mic (reply played back via ElevenLabs), confirm/cancel cards, paste a ChatGPT/Dot answer "as material" |
| Задачі | tasks by project from Notion, quick add (duplicate guard), complete |
| Фінанси | month totals per currency, expenses by category, all records |
| Соцмережі | latest Instagram/YouTube snapshot with 7-day delta |
| Налаштування | integration status + connect buttons, report times, voice mode, events topics |

Login: send **/web** to the bot → one-time link (10 min, token in the URL fragment so link previews can't use it) → httpOnly signed
cookie for 30 days. Optional `WEB_PASSWORD` adds a password form (5 attempts / 15 min). Mutating API calls require an
`X-Requested-With: aia` header (CSRF) on top of `SameSite=Lax`.

Code: `src/web/*` (API + auth), `web/` (React + Vite SPA, built into `dist/web` and served by Fastify).

### Try it without any keys

```bash
npm run build && npm run demo     # http://localhost:3000, login link and password are printed
npm run demo & npm run dev:web    # hot reload on http://localhost:5173
```

The demo runs on in-memory Postgres with a fake Notion and calendar filled with sample data. Without `OPENAI_API_KEY` the
"model" is a keyword stub (plan day, add task, "мінус 20 доларів таксі", spending this month); with the key the real agent runs on the fake data.

## Local development

```bash
cp .env.example .env        # fill it in; TELEGRAM_MODE=polling needs no public URL
docker run -d --name aia-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=aia -p 5432:5432 postgres:16-alpine
npm ci
npm run dev
```

Node 22. `npm test` (no network, no Postgres needed: PGlite + fakes), `npm run test:pg` (same flows on a real Postgres at `localhost:55432`), `npm run typecheck`.

## Setup per client (Stage 1)

1. **Telegram**: create the bot in @BotFather (or transfer ownership at handover), put the token and the owner's numeric id (`OWNER_TELEGRAM_ID`).
2. **Notion**: create an internal integration, share the tasks database and one parent page with it, then
   ```bash
   npm run setup:notion -- --parent <page-id> --tasks <tasks-db-id> \
     --projects "Alpha,Beta" --expense "Таксі,Їжа" --income "Клієнт"
   ```
   It maps the existing tasks DB (status values, project, due, priority, notes) and creates 4 databases next to it: decisions, expected replies, finance, materials. **Read the printed mapping** — the guess is heuristic; correct `settings.notion` in the `kv` table if a status name is wrong.
3. **Google**: Cloud project → OAuth consent screen → **publish to Production** (in "Testing" refresh tokens die after 7 days) → Web client, redirect `PUBLIC_URL/oauth/google/callback`. APIs to enable: Calendar, YouTube Data, YouTube Analytics. Then `/connect` in the bot (work calendar, personal calendar, YouTube). Google will show "unverified app": Advanced → continue.
4. **Instagram**: Meta app with "Instagram API with Instagram Login", redirect `PUBLIC_URL/oauth/instagram/callback`; the account must be Business/Creator and added as an app role (Instagram tester) while the app is in development mode. `/connect` → Instagram. The token lives 60 days and is refreshed automatically; the bot warns if it cannot.
5. **Voice**: ElevenLabs key + one voice id. Without them replies are text only.
6. **Settings** by chat: "ранковий звіт о 7:30", "/voice on". Projects, categories, event topics/geography live in `settings` (set by `setup:notion` or via the agent for topics).

## Deploy on Render

`render.yaml` describes one Docker web service (Starter) and Postgres (Basic) in Frankfurt.

1. New → Blueprint → this repo. Fill the `sync: false` secrets. `PUBLIC_URL` = the service URL.
2. Run `npm run setup:notion` once with `DATABASE_URL` set to the **external** database URL (or run it in a Render shell).
3. Open the bot, `/connect`, `/status`.

The scheduler runs inside the web process, so the service must stay on a paid instance (a free one sleeps). Do not change `ENCRYPTION_KEY` after the first deploy.

## Handover checklist (contract §8.4)

- [ ] Repo/archive, `render.yaml`, this README (tech docs) + short user guide for the owner
- [ ] Bot token (or ownership transfer), env values, Render access or redeploy into the client's workspace (Blueprint + `pg_dump`/restore)
- [ ] Third-party components: grammY, Fastify, pg, zod, luxon (MIT); no n8n is used
- [ ] 1 h walkthrough; after the warranty period delete our copies of data and access (§9.3)

## What is verified and what is not

Verified by automated tests (`npm test`, 72 tests): confirmation gate and double-tap safety, duplicate guard, task/finance/decision flows
against an in-memory Notion, conflicts / free slots / day planning / reschedule, two-way calendar mirror without ping-pong, report
sections and fallbacks, scheduler windows, retries and the 25.10 DST switch, event parsing/dedupe, webhook secret/dedupe/ordering,
OAuth state signing, token encryption, web login (one-time link, password limit, CSRF), web chat/confirm/import/today/tasks/finance/settings endpoints, and the same flows on a real PostgreSQL 16. The web UI was also clicked through in a browser in demo mode (desktop and phone width, light and dark).

**Not yet exercised against the live services** (no credentials were available): Notion API, Google Calendar/YouTube, Instagram Graph,
OpenAI (chat/transcription/web search), ElevenLabs, Telegram. The request shapes follow the public docs but need a first run on the
client's accounts — this is the purpose of Stage 4's real-data scenarios. Known soft spots to check first:

* OpenAI model names (`OPENAI_*` env) and the Responses `web_search` tool type;
* Instagram insight metric names change often; unsupported ones are reported as unavailable, not fatal;
* Notion file upload (`/v1/file_uploads`) — on failure the text is still saved and the file error is shown;
* ElevenLabs → OGG/Opus needs `ffmpeg` (present in the Docker image); without it voice falls back to an mp3 audio message;
* Dot has no known API: use forward/share to the bot (contract §7.4).

## Known limits

* Notion API version is pinned to `2022-06-28` (single-source databases); multi-source databases need the newer version and data-source ids.
* Finance has no currency conversion (not in scope): totals are per currency.
* Updates are acknowledged before processing, so a crash mid-processing loses that message (the owner resends).
* One instance only: migrations are not locked; scheduler claims are, so a brief overlap during deploy is safe for jobs.
