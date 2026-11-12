import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebPageError, htmlToText, isPublicHost, openPage } from '../src/integrations/webpage.js';

/** Cloudflare "email protection" encoding: first byte is the XOR key */
const cfEncode = (email: string, key = 0x5a) =>
  key.toString(16).padStart(2, '0') +
  [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

const FILLER =
  'Підприємство має власний конструкторський відділ, лабораторію контролю якості та склад готової продукції. ' +
  'All boilers are certified to EN 303-5 and shipped across Europe with full documentation. ' +
  'Ми виготовляємо продукцію під замовлення: нестандартні розміри, підвищена потужність, індивідуальне облицювання.';

const PAGE = `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<title>ТОВ &laquo;Завод Енергомаш&raquo; &mdash; котли</title>
<meta name="description" content="Виробник котлів &amp; бойлерів з 1998 року">
<meta property="og:description" content="OG опис">
<style>body { color: red }</style>
<script>window.dataLayer = []; document.write('<p>script text</p>');</script>
<script type="application/ld+json">{"@type":"Organization","telephone":"+380 44 555 66 77","email":"office@energomash.ua"}</script>
</head>
<body>
<div class="cookie-banner" id="gdpr">Ми використовуємо cookies, щоб сайт працював краще. <button>Прийняти</button></div>
<header class="site-header">
  <a href="/"><img src="/logo.png" alt="Енергомаш"></a>
  <nav>
    <ul>
      <li><a href="/pro-nas/">Про нас</a></li>
      <li><a href="/produktsiya">Продукція</a></li>
      <li><a href="/vyrobnytstvo#top">Виробництво</a></li>
      <li><a href="kontakty.html">Контакти</a></li>
      <li><a href="/cart">Кошик</a></li>
      <li><a href="https://facebook.com/energomash">Facebook</a></li>
    </ul>
  </nav>
</header>
<main>
  <h1>Виробництво котлів</h1>
  <p>ТОВ &quot;Завод&nbsp;Енергомаш&quot; &ndash; український виробник твердопаливних котлів&#8230; Працюємо з 1998&#160;року &#x2014; понад 25 років.</p>
  <!-- <p>hidden comment text</p> -->
  <p>We manufacture <b>industrial boilers</b> and <a href="catalog/boilers.html#specs">heat exchangers</a> for export to EU.</p>
  <h2>Що ми виготовляємо</h2>
  <ul>
    <li>Котли твердопаливні
    <li>Бойлери непрямого нагріву</li>
    <li><p>Теплообмінники</p></li>
  </ul>
  <h4>Технічні характеристики</h4>
  <table>
    <thead><tr><th>Модель</th><th>Потужність, кВт</th><th>Ціна, грн</th></tr></thead>
    <tbody>
      <tr><td>КТ-20</td><td>20</td><td>45&nbsp;000</td></tr>
      <tr><td>КТ-50<td>50<td>98 000
    </tbody>
  </table>
  <p>Рядок<br>з переносом</p>
  <p>***</p>
  <p>Повтор</p><p>Повтор</p>
  <svg viewBox="0 0 10 10"><title>icon</title><text>svg text</text></svg>
  <noscript>Увімкніть JavaScript</noscript>
  <img src="/photo.jpg" alt="Фото цеху">
  <p>${FILLER}</p>
</main>
<aside><h3>Новини</h3><p>Ми взяли участь у виставці.</p></aside>
<footer>
  <p>Тел.: +38 (044) 123-45-67, (067) 765-43-21</p>
  <p>E-mail: <a href="mailto:Info@Energomash.ua?subject=Запит">Info@Energomash.ua</a>, sales@energomash.ua</p>
  <p><a href="tel:+380441234567">Подзвонити</a> <a href="viber://chat?number=%2B380671112233">Viber</a>
     <a href="https://t.me/energomash_ua">Telegram</a> <a href="https://wa.me/380671112233">WhatsApp</a>
     <a href="https://t.me/share/url?url=https://energomash.ua">Поділитися</a></p>
  <p>logo@2x.png user@example.com</p>
  <p><a href="/cdn-cgi/l/email-protection#${cfEncode('director@energomash.ua')}">[email&#160;protected]</a>
     <span class="__cf_email__" data-cfemail="${cfEncode('hr@energomash.ua', 0x31)}">[email&#160;protected]</span></p>
  <p>&copy; 2024 Енергомаш</p>
</footer>
</body></html>`;

describe('htmlToText', () => {
  const r = htmlToText(PAGE, 'https://energomash.ua/uk/');

  it('reads title, description and language with entities decoded', () => {
    expect(r.title).toBe('ТОВ «Завод Енергомаш» — котли');
    expect(r.description).toBe('Виробник котлів & бойлерів з 1998 року');
    expect(r.lang).toBe('uk');
  });

  it('keeps the main content as light Markdown', () => {
    expect(r.text.startsWith('## Виробництво котлів')).toBe(true);
    expect(r.text).toContain(
      'ТОВ "Завод Енергомаш" – український виробник твердопаливних котлів… Працюємо з 1998 року — понад 25 років.',
    );
    expect(r.text).toContain('We manufacture industrial boilers and heat exchangers for export to EU.');
    expect(r.text).toContain('## Що ми виготовляємо');
    expect(r.text).toContain('- Котли твердопаливні\n- Бойлери непрямого нагріву\n- Теплообмінники');
    expect(r.text).toMatch(/^Технічні характеристики$/m);
    expect(r.text).toContain(
      '| Модель | Потужність, кВт | Ціна, грн |\n| КТ-20 | 20 | 45 000 |\n| КТ-50 | 50 | 98 000 |',
    );
    expect(r.text).toContain('Рядок\nз переносом');
    expect(r.text).toContain('лабораторію контролю якості');
    expect(r.text).not.toMatch(/\n{3,}/);
  });

  it('drops chrome, scripts, comments, svg, images and junk lines', () => {
    for (const noise of [
      'cookies', 'Прийняти', 'Facebook', 'Кошик', 'Про нас', 'Новини', 'виставці', '+38 (044)', 'Енергомаш.ua',
      '2024', 'script text', 'dataLayer', 'color: red', 'hidden comment', 'svg text', 'icon', 'JavaScript',
      'Фото цеху', '***',
    ]) {
      expect(r.text, noise).not.toContain(noise);
    }
    expect(r.text.split('Повтор')).toHaveLength(2); // consecutive duplicates collapse
  });

  it('collects absolute links from the whole page without fragments', () => {
    expect(r.links).toEqual(
      expect.arrayContaining([
        { text: 'Енергомаш', url: 'https://energomash.ua/' },
        { text: 'Про нас', url: 'https://energomash.ua/pro-nas/' },
        { text: 'Виробництво', url: 'https://energomash.ua/vyrobnytstvo' },
        { text: 'Контакти', url: 'https://energomash.ua/uk/kontakty.html' },
        { text: 'heat exchangers', url: 'https://energomash.ua/uk/catalog/boilers.html' },
        { text: 'Telegram', url: 'https://t.me/energomash_ua' },
      ]),
    );
    expect(r.links.every((l) => /^https?:\/\//.test(l.url) && !l.url.includes('#'))).toBe(true);
    expect(new Set(r.links.map((l) => l.url)).size).toBe(r.links.length);
  });

  it('resolves links against <base href>', () => {
    const t = htmlToText('<head><base href="https://cdn.site.ua/root/"></head><body><a href="x/y">Y</a></body>', 'https://site.ua/a/b');
    expect(t.links).toEqual([{ text: 'Y', url: 'https://cdn.site.ua/root/x/y' }]);
  });

  it('falls back to the body when <main> is not substantial', () => {
    const t = htmlToText(
      '<body><nav><a href="/">Меню</a></nav><main><p>Короткий вступ</p></main><div class="info">Інший текст поза main</div></body>',
      'https://site.ua/',
    );
    expect(t.text).toContain('Короткий вступ');
    expect(t.text).toContain('Інший текст поза main');
    expect(t.text).not.toContain('Меню');
  });

  it("keeps an article's own header (it holds the title)", () => {
    const t = htmlToText(
      `<body><header>Шапка сайту</header><article><header><h1>Заголовок статті</h1></header><p>${FILLER}</p></article></body>`,
      'https://site.ua/',
    );
    expect(t.text).toContain('## Заголовок статті');
    expect(t.text).not.toContain('Шапка сайту');
  });

  it('survives malformed real-world HTML', () => {
    const t = htmlToText(
      `<html><head><title>Тест</title><body>
       <div><p>Перший<p>Другий<div>Третій</span></div>
       <ul><li>один<li>два</ul>
       <p>a < b and c > d</p>
       <a href=/x?a=1&amp;b=2&copy=3 class=link>Лінк</a>
       <script>var s = "</div><p>не текст</p>";</script>
       <table><tr><td>Комірка 1<td>Комірка 2</table>
       <div>Незакритий`,
      'https://site.ua/',
    );
    expect(t.title).toBe('Тест');
    for (const s of ['Перший', 'Другий', 'Третій', '- один\n- два', 'a < b and c > d', '| Комірка 1 | Комірка 2 |', 'Незакритий']) {
      expect(t.text).toContain(s);
    }
    expect(t.text).not.toContain('не текст');
    expect(t.links).toEqual([{ text: 'Лінк', url: 'https://site.ua/x?a=1&b=2&copy=3' }]);
  });

  it('reads layout tables as blocks, not as giant rows', () => {
    const t = htmlToText(
      '<table><tr><td><table><tr><td>Меню</td></tr></table></td><td><h2>Про компанію</h2><p>Ми робимо котли.</p></td></tr></table>',
      'https://site.ua/',
    );
    expect(t.text).not.toContain('|');
    expect(t.text).toContain('## Про компанію\n\nМи робимо котли.');
  });

  it('handles JS-only pages, deep nesting and big documents', () => {
    expect(htmlToText('<body><div id="root"></div><script>render()</script></body>', 'https://a.ua/').text).toBe('');
    const deep = `${'<div><font>'.repeat(5000)}глибоко${'</font></div>'.repeat(5000)}`;
    expect(htmlToText(deep, 'https://a.ua/').text).toBe('глибоко');
    const cards = Array.from({ length: 15000 }, (_, k) => `<div class="card"><a href="/p/${k}">Товар ${k}</a><span>${k} грн</span></div>`).join('');
    const started = Date.now();
    const big = htmlToText(`<html><body>${cards}</body></html>`, 'https://a.ua/');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(big.links).toHaveLength(1000);
    expect(big.text).toContain('Товар 14999');
  });
});

describe('isPublicHost / SSRF guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects loopback, private, link-local, CGNAT, multicast and internal names', async () => {
    for (const host of [
      '127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', '::1', 'localhost', 'LOCALHOST.', 'api.localhost',
      'printer.local', 'db.internal', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '[::ffff:127.0.0.1]', '::ffff:7f00:1', '[::ffff:a9fe:a9fe]', 'fd12:3456::1',
      'fe80::1', '64:ff9b::a00:1', '2002:a00:1::1', '::',
    ]) {
      expect(await isPublicHost(host), host).toBe(false);
    }
  });

  it('accepts public addresses without touching DNS', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup');
    for (const host of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888', '[2606:4700:4700::1111]', '::ffff:8.8.8.8']) {
      expect(await isPublicHost(host), host).toBe(true);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves names and requires every address to be public', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup');
    lookup.mockImplementation((async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]) as never);
    expect(await isPublicHost('rebind.example.net')).toBe(false);
    lookup.mockImplementation((async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]) as never);
    expect(await isPublicHost('zavod.example.net')).toBe(true);
  });

  it('openPage refuses internal targets before any request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const url of [
      'http://127.0.0.1:8080/', 'http://[::1]/', 'http://localhost/admin', 'http://169.254.169.254/latest/meta-data/',
      'http://2130706433/', 'http://10.0.0.5/',
    ]) {
      const err = await openPage(url, { fetchImpl }).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(WebPageError);
      expect((err as WebPageError).message).toBe('Це внутрішня адреса — її не відкриваю');
      expect((err as WebPageError).code).toBe('blocked');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a hostname that resolves to a private address is refused', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: '127.0.0.1', family: 4 }]) as never);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(openPage('https://evil.example.net/', { fetchImpl })).rejects.toThrow('внутрішня адреса');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an unknown domain is a clear DNS error', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    }) as never);
    const err = (await openPage('https://no-such-zavod.example/', { fetchImpl: vi.fn() as never }).catch((e: unknown) => e)) as WebPageError;
    expect(err).toBeInstanceOf(WebPageError);
    expect(err.code).toBe('dns');
    expect(err.message).toContain('Не вдалося знайти сайт');
  });

  it('re-checks every redirect hop and sends browser-like headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }) as typeof fetch;
    const err = (await openPage('http://93.184.216.34/start', { fetchImpl }).catch((e: unknown) => e)) as WebPageError;
    expect(err).toBeInstanceOf(WebPageError);
    expect(err.code).toBe('blocked');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://93.184.216.34/start');
    expect(calls[0]!.init?.redirect).toBe('manual');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0 .*Chrome\/[\d.]+ Safari\/[\d.]+$/);
    expect(headers['User-Agent']).not.toContain('@');
    expect(headers.Accept).toBe('text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8');
    expect(headers['Accept-Language']).toBe('uk,en;q=0.8,ru;q=0.6');
  });

  it('a redirect to localhost is refused too', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 301, headers: { location: 'http://localhost:8080/admin' } })) as unknown as typeof fetch;
    await expect(openPage('http://93.184.216.34/', { fetchImpl })).rejects.toThrow('внутрішня адреса');
  });

  it('only http/https', async () => {
    for (const url of ['ftp://example.com/file.pdf', 'javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.ua', '']) {
      const err = (await openPage(url, { fetchImpl: vi.fn() as never }).catch((e: unknown) => e)) as WebPageError;
      expect(err, url).toBeInstanceOf(WebPageError);
      expect(err.code, url).toBe('bad_url');
    }
  });
});

// ───────────── openPage against a local server ─────────────

const CP1251 = new Map<string, number>();
{
  const dec = new TextDecoder('windows-1251');
  for (let b = 0; b < 256; b++) CP1251.set(dec.decode(Uint8Array.of(b)), b);
}
const cp1251 = (s: string) => Uint8Array.from([...s].map((ch) => CP1251.get(ch) ?? 63));
const CP_TEXT = 'Виробник металоконструкцій: Ґанок, їжак, Єнот, ІІ категорія. Ціни у гривнях — «опт».';

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

let server: http.Server;
let base = '';
let bigClosed = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    switch (path) {
      case '/page':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      case '/cp1251':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(cp1251(`<html><head><meta charset="windows-1251"><title>Завод</title></head><body><p>${CP_TEXT}</p></body></html>`));
        return;
      case '/cp1251-header':
        res.writeHead(200, { 'content-type': 'text/html; charset=windows-1251' });
        res.end(cp1251(`<html><body><p>${CP_TEXT}</p></body></html>`));
        return;
      case '/cp1251-bare':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(cp1251(`<html><body><p>${CP_TEXT}</p></body></html>`));
        return;
      case '/r1':
        res.writeHead(302, { location: '/r2' });
        res.end();
        return;
      case '/r2':
        res.writeHead(301, { location: `${base}/page#from-r2` });
        res.end();
        return;
      case '/cookie':
        // a language/geo redirect that only stops once the cookie comes back
        if ((req.headers.cookie ?? '').split('; ').includes('lang=uk')) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(`<html><body><p>Кука: ${req.headers.cookie}</p></body></html>`);
        } else {
          res.writeHead(302, {
            location: '/cookie',
            'set-cookie': ['lang=uk; Path=/; HttpOnly', 'tracker=1; Domain=other.example', 'old=1; Max-Age=0'],
          });
          res.end();
        }
        return;
      case '/loop':
        res.writeHead(307, { location: '/loop' });
        res.end();
        return;
      case '/refresh':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><meta http-equiv="refresh" content="0; url=\'/page\'"></head><body>Зачекайте…</body></html>');
        return;
      case '/missing':
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<h1>Not found</h1>');
        return;
      case '/forbidden':
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<h1>Forbidden</h1>');
        return;
      case '/files/catalog.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(PDF);
        return;
      case '/download':
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="price-list.xlsx"',
        });
        res.end(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1, 2, 3));
        return;
      case '/photo.jpg':
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(Uint8Array.of(0xff, 0xd8, 0xff));
        return;
      case '/plain':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Прайс-лист 2025\r\nЗамовлення: opt@zavod.ua, +380 50 123 45 67\r\n');
        return;
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"name":"Завод"}');
        return;
      case '/big': {
        // never ends on its own: proves the reader stops at maxBytes and hangs up
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.write('<html><body>');
        const chunk = '<p>Рядок каталогу з описом продукції.</p>'.repeat(200);
        const timer = setInterval(() => res.write(chunk), 5);
        res.on('close', () => {
          clearInterval(timer);
          bigClosed = true;
        });
        return;
      }
      case '/slow-body':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.write('<html><body><h1>Початок сторінки</h1><p>Перша частина тексту.</p>');
        return; // and then nothing
      case '/slow':
        return; // never answers
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const local = { allowPrivate: true };

describe('openPage', () => {
  it('opens an HTML page: text, metadata, contacts from the footer, key links', async () => {
    const p = await openPage(`${base}/page`, local);
    expect(p.url).toBe(`${base}/page`);
    expect(p.finalUrl).toBe(`${base}/page`);
    expect(p.title).toBe('ТОВ «Завод Енергомаш» — котли');
    expect(p.description).toBe('Виробник котлів & бойлерів з 1998 року');
    expect(p.lang).toBe('uk');
    expect(p.text).toContain('## Виробництво котлів');
    expect(p.truncated).toBeUndefined();
    expect(p.binary).toBeUndefined();

    expect(p.contacts.emails).toEqual(
      expect.arrayContaining(['info@energomash.ua', 'sales@energomash.ua', 'director@energomash.ua', 'hr@energomash.ua', 'office@energomash.ua']),
    );
    expect(p.contacts.emails).toHaveLength(5); // no logo@2x.png, no user@example.com
    expect(p.contacts.phones).toEqual(expect.arrayContaining(['+380441234567', '+380677654321', '+380445556677']));
    expect(p.contacts.phones).toHaveLength(3); // the tel: link and the footer text are the same number
    expect(p.contacts.messengers).toEqual([
      'viber://chat?number=%2B380671112233',
      'https://t.me/energomash_ua',
      'https://wa.me/380671112233',
    ]);

    const urls = p.keyLinks.map((l) => l.url);
    expect(p.keyLinks[0]).toEqual({ text: 'Контакти', url: `${base}/kontakty.html` });
    expect(urls).toEqual(
      expect.arrayContaining([`${base}/pro-nas/`, `${base}/produktsiya`, `${base}/vyrobnytstvo`, `${base}/catalog/boilers.html`]),
    );
    expect(urls.some((u) => u.includes('facebook') || u.includes('/cart') || u.includes('#'))).toBe(false);
  });

  it('adds https:// when the scheme is missing (and falls back to http when https does not work)', async () => {
    const p = await openPage(`${base.replace('http://', '')}/page`, local);
    expect(p.url).toBe(`${base.replace('http://', 'https://')}/page`);
    expect(p.finalUrl).toBe(`${base}/page`);
    expect(p.title).toContain('Енергомаш');
  });

  it('decodes windows-1251 pages (meta charset, header charset, undeclared)', async () => {
    for (const path of ['/cp1251', '/cp1251-header', '/cp1251-bare']) {
      const p = await openPage(`${base}${path}`, local);
      expect(p.text, path).toBe(CP_TEXT);
    }
    expect((await openPage(`${base}/cp1251`, local)).title).toBe('Завод');
  });

  it('follows a redirect chain and reports the final URL', async () => {
    const p = await openPage(`${base}/r1`, local);
    expect(p.url).toBe(`${base}/r1`);
    expect(p.finalUrl).toBe(`${base}/page`);
    expect(p.title).toContain('Енергомаш');
  });

  it('keeps cookies between redirect hops (only for this call)', async () => {
    const p = await openPage(`${base}/cookie`, local);
    expect(p.text).toBe('Кука: lang=uk');
  });

  it('gives up after 5 redirects', async () => {
    const err = (await openPage(`${base}/loop`, local).catch((e: unknown) => e)) as WebPageError;
    expect(err).toBeInstanceOf(WebPageError);
    expect(err.code).toBe('redirects');
  });

  it('follows an instant <meta http-equiv="refresh">', async () => {
    const p = await openPage(`${base}/refresh`, local);
    expect(p.finalUrl).toBe(`${base}/page`);
  });

  it('HTTP errors become WebPageError with the status', async () => {
    const err = (await openPage(`${base}/missing`, local).catch((e: unknown) => e)) as WebPageError;
    expect(err).toBeInstanceOf(WebPageError);
    expect(err.message).toBe('Сторінка недоступна (HTTP 404)');
    expect(err.status).toBe(404);
    await expect(openPage(`${base}/forbidden`, local)).rejects.toThrow('Сторінка недоступна (HTTP 403)');
  });

  it('returns PDFs and office files as binary for the caller to extract', async () => {
    const pdf = await openPage(`${base}/files/catalog.pdf`, local);
    expect(pdf.text).toBe('');
    expect(pdf.binary?.contentType).toBe('application/pdf');
    expect(pdf.binary?.filename).toBe('catalog.pdf');
    expect(Buffer.from(pdf.binary!.data).equals(Buffer.from(PDF))).toBe(true);

    const xlsx = await openPage(`${base}/download`, local);
    expect(xlsx.binary?.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.binary?.filename).toBe('price-list.xlsx');
    expect(xlsx.binary?.data).toHaveLength(7);
  });

  it('refuses images', async () => {
    await expect(openPage(`${base}/photo.jpg`, local)).rejects.toThrow('Це зображення/відео, а не сторінка');
  });

  it('returns plain text and JSON as is', async () => {
    const t = await openPage(`${base}/plain`, local);
    expect(t.text).toBe('Прайс-лист 2025\nЗамовлення: opt@zavod.ua, +380 50 123 45 67');
    expect(t.contacts.emails).toEqual(['opt@zavod.ua']);
    expect(t.contacts.phones).toEqual(['+380501234567']);
    expect((await openPage(`${base}/json`, local)).text).toBe('{"ok":true,"name":"Завод"}');
  });

  it('stops reading at maxBytes and hangs up', async () => {
    const p = await openPage(`${base}/big`, { ...local, maxBytes: 20_000 });
    expect(p.truncated).toBe(true);
    expect(p.text).toContain('Рядок каталогу з описом продукції.');
    expect(p.text.length).toBeLessThan(20_000);
    for (let k = 0; k < 100 && !bigClosed; k++) await new Promise((r) => setTimeout(r, 20));
    expect(bigClosed).toBe(true);
  });

  it('caps the text at maxChars', async () => {
    const p = await openPage(`${base}/page`, { ...local, maxChars: 120 });
    expect(p.truncated).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(120);
    expect(p.text.startsWith('## Виробництво котлів')).toBe(true);
  });

  it('times out on a silent server', async () => {
    const started = Date.now();
    const err = (await openPage(`${base}/slow`, { ...local, timeoutMs: 300 }).catch((e: unknown) => e)) as WebPageError;
    expect(err).toBeInstanceOf(WebPageError);
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('Сайт не відповів за 0,3 с');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('keeps what arrived when the body stalls', async () => {
    const p = await openPage(`${base}/slow-body`, { ...local, timeoutMs: 400 });
    expect(p.truncated).toBe(true);
    expect(p.text).toContain('## Початок сторінки');
    expect(p.text).toContain('Перша частина тексту.');
  });

  it('refuses the local server without allowPrivate', async () => {
    await expect(openPage(`${base}/page`)).rejects.toThrow('Це внутрішня адреса — її не відкриваю');
  });
});

describe('keyLinks', () => {
  it('ranks contacts/about first, prefers section pages and caps at 15', async () => {
    const products = Array.from({ length: 40 }, (_, k) => `<a href="/catalog/kotly/kt-${k}">Котел КТ-${k}</a>`).join('');
    const html = `<html><body>${products}
      <a href="/catalog/">Каталог</a><a href="/about-us">About us</a><a href="/contacts">Контакти</a>
      <a href="https://other.ua/contacts">Чужі контакти</a><a href="/login">Увійти</a><a href="/news/1">Новина</a>
      <a href="/uploads/certificate.jpg">Сертифікат</a></body></html>`;
    const fetchImpl = (async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const p = await openPage('http://93.184.216.34/', { fetchImpl });
    expect(p.keyLinks).toHaveLength(15);
    expect(p.keyLinks.slice(0, 3)).toEqual([
      { text: 'Контакти', url: 'http://93.184.216.34/contacts' },
      { text: 'About us', url: 'http://93.184.216.34/about-us' },
      { text: 'Каталог', url: 'http://93.184.216.34/catalog/' },
    ]);
    const urls = p.keyLinks.map((l) => l.url).join(' ');
    expect(urls).not.toMatch(/other\.ua|login|news|\.jpg/);
  });
});
