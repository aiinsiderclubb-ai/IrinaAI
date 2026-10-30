"""Writes the v2 scenes (compositions/*.html) and index.html.

One kit for every scene: AI Insider identity (paper / ink / cobalt, Inter, header with logo and
chapter dashes, numbered chips) with the motion grammar of the reference (Unbounded slams,
extruded numbers, whips, floods, a flight through rings). Scene start times come from BEATS.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).parent
FONTS = (ROOT / 'fonts.css.txt').read_text()

# beat grid of the music (seconds); filled in from the track analysis
BPM = 124
BEAT = 60 / BPM

PAPER, INK, BLUE, CORE = '#F2F1EC', '#0B0B0F', '#3A2BFC', '#04090D'

BASE_CSS = f"""
{FONTS}
#root {{ position: absolute; inset: 0; overflow: hidden; font-family: 'Inter', sans-serif; color: {INK}; }}
.full {{ position: absolute; inset: 0; }}
.kin {{ font-family: 'Unbounded', sans-serif; font-weight: 900; text-transform: uppercase; letter-spacing: -0.02em; line-height: 0.92; }}
.h1 {{ font-weight: 900; letter-spacing: -0.045em; line-height: 1.02; }}
.hl {{ background: {BLUE}; color: #fff; padding: 0 0.12em 0.04em; border-radius: 0.14em; -webkit-box-decoration-break: clone; box-decoration-break: clone; }}
.hl-ink {{ background: {INK}; color: #fff; padding: 0 0.12em 0.04em; border-radius: 0.14em; }}
.caps {{ font-weight: 700; text-transform: uppercase; letter-spacing: 0.32em; }}
.mono {{ font-family: 'JetBrains Mono', monospace; font-weight: 500; }}
.hdr {{ position: absolute; left: 72px; right: 72px; top: 64px; height: 44px; display: flex; align-items: center; justify-content: space-between; }}
.hdr img {{ height: 40px; }}
.dashes {{ display: flex; gap: 10px; }}
.dashes i {{ display: block; width: 46px; height: 8px; border-radius: 4px; background: currentColor; opacity: 0.18; }}
.dashes i.on {{ background: {BLUE}; opacity: 1; }}
.chip {{ position: absolute; left: 72px; top: 196px; display: flex; align-items: center; gap: 18px; font-size: 28px; }}
.chip b {{ display: inline-flex; align-items: center; justify-content: center; height: 40px; padding: 0 14px; border-radius: 8px; background: {BLUE}; color: #fff; font-weight: 800; font-size: 26px; letter-spacing: 0.04em; }}
/* the phone: a black body with the Telegram-style chat of the assistant */
.phone {{ position: absolute; width: 760px; height: 1540px; border-radius: 108px; background: #0A0A0C; padding: 18px; box-shadow: 0 60px 120px rgb(10 10 30 / 0.35), inset 0 0 0 2px rgb(255 255 255 / 0.16); }}
.screen {{ position: relative; width: 100%; height: 100%; border-radius: 92px; overflow: hidden; background: #0E1013; }}
.island {{ position: absolute; left: 50%; top: 22px; width: 190px; height: 54px; margin-left: -95px; border-radius: 27px; background: #000; z-index: 3; }}
.tg-top {{ position: absolute; left: 0; right: 0; top: 0; height: 200px; padding: 104px 36px 0; background: #17191D; display: flex; align-items: center; gap: 20px; color: #fff; }}
.tg-ava {{ width: 72px; height: 72px; border-radius: 50%; background: {BLUE} url('assets/ai-insider-mark-white.png') center / 56% no-repeat; }}
.tg-name {{ font-weight: 700; font-size: 36px; line-height: 1.1; }}
.tg-sub {{ font-size: 28px; color: #8A8F98; }}
.bubble {{ position: absolute; left: 30px; right: 70px; background: #1F2227; color: #E9EBEF; border-radius: 34px 34px 34px 10px; padding: 28px 32px; font-size: 32px; line-height: 1.42; }}
.bubble b {{ color: #fff; font-weight: 700; }}
.ln {{ display: block; }}
.gap {{ display: block; height: 18px; }}
"""


def ext(color, n=14, step=2):
    """Extruded type: a stack of offset shadows in one colour."""
    return ', '.join(f'{i * step}px {i * step}px 0 {color}' for i in range(1, n + 1))


def scene(sid, css, body, script, bg):
    return f"""<template>
  <style>{BASE_CSS}
    #root {{ background: {bg}; }}
{css}
  </style>
  <div id="root" data-composition-id="{sid}" data-width="1080" data-height="1920">
{body}
  </div>
  <script>
    window.__timelines = window.__timelines || {{}};
    const tl = gsap.timeline({{ paused: true }});
    const R = document.querySelector('[data-composition-id="{sid}"]');
    const $ = (s) => R.querySelectorAll(s);
    // slam: arrives big and blurred, lands hard
    const slam = (s, at, from = 1.6) => tl.fromTo(s, {{ opacity: 0, scale: from, filter: 'blur(14px)' }}, {{ opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.16, ease: 'expo.out' }}, at);
    // per-word blur-in, no travel
    const words = (s, at, gap = 0.06) => tl.fromTo(s, {{ opacity: 0, filter: 'blur(8px)' }}, {{ opacity: 1, filter: 'blur(0px)', duration: 0.14, stagger: gap, ease: 'power2.out' }}, at);
    // whip out sideways with a smear
    const whip = (s, at, x = -1300) => tl.to(s, {{ x, filter: 'blur(18px)', duration: 0.22, ease: 'power3.in' }}, at);
{script}
    window.__timelines['{sid}'] = tl;
  </script>
</template>
"""


def header(active, dark=False, total=4, on_blue=False):
    logo = 'ai-insider-logo-light.png' if dark else 'ai-insider-logo-dark.png'
    color = '#fff' if dark else INK
    on = ' style="background:#fff"' if on_blue else ''
    dashes = ''.join(f'<i class="on"{on}></i>' if i < active else '<i></i>' for i in range(total))
    return f'<div class="hdr" style="color:{color}"><img src="assets/{logo}" alt="AI Insider"><div class="dashes">{dashes}</div></div>'


def chip(n, label, dark=False, on_blue=False):
    color = '#fff' if dark or on_blue else INK
    style = f' style="background:#fff;color:{BLUE}"' if on_blue else ''
    return f'<div class="chip caps" style="color:{color}"><b{style}>{n:02d}</b>{label}</div>'


def phone(pid, bubble_html, left=160, top=640, bubble_top=232):
    return f"""<div class="phone" id="{pid}" style="left:{left}px; top:{top}px">
  <div class="screen"><div class="island"></div>
    <div class="tg-top"><div class="tg-ava"></div><div><div class="tg-name">Асистент</div><div class="tg-sub">бот</div></div></div>
    <div class="bubble" id="{pid}-b" style="top:{bubble_top}px">{bubble_html}</div>
  </div>
</div>"""


import math
STAR = ' '.join(f'{(96 if i % 2 == 0 else 70) * math.cos(i * math.pi / 12):.1f},{(96 if i % 2 == 0 else 70) * math.sin(i * math.pi / 12):.1f}' for i in range(24))

S = {}

# ---------------------------------------------------------------- A: hook
S['a'] = scene('a', f"""
    .a-card {{ position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }}
    .a-num {{ font-size: 560px; line-height: 0.85; }}
    .a-word {{ font-size: 104px; margin-top: 30px; }}
    #a1 {{ background: {INK}; color: #fff; }} #a1 .a-num {{ text-shadow: {ext('#2A2A33')}; }}
    #a2 {{ background: {PAPER}; color: {INK}; }} #a2 .a-num {{ text-shadow: {ext('#C9C7BF')}; }}
    #a3 {{ background: {BLUE}; color: #fff; }} #a3 .a-num {{ text-shadow: {ext('#1F14B8')}; }}
    #a3 .a-word span {{ display: inline-block; }}
""", f"""
    <div class="a-card" id="a1" data-layout-allow-overlap><div class="kin a-num" id="a1n">5</div><div class="kin a-word" id="a1w">зустрічей</div></div>
    <div class="a-card" id="a2" data-layout-allow-occlusion data-layout-allow-overlap><div class="kin a-num" id="a2n">2</div><div class="kin a-word" id="a2w">календарі</div></div>
    <div class="a-card" id="a3" data-layout-allow-occlusion data-layout-allow-overlap><div class="kin a-num" id="a3n">1</div><div class="kin a-word" id="a3w">{''.join(f'<span>{c}</span>' for c in 'накладка')}</div></div>
""", """
    tl.fromTo('#a1n', { scale: 1.25, filter: 'blur(10px)' }, { scale: 1, filter: 'blur(0px)', duration: 0.2, ease: 'expo.out' }, 0);
    tl.fromTo('#a1w', { opacity: 0.35, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.2 }, 0.0);
    tl.fromTo('#a2', { opacity: 0 }, { opacity: 1, duration: 0.01 }, B(2));
    slam('#a2n', B(2)); words('#a2w', B(2) + 0.2);
    tl.fromTo('#a3', { opacity: 0 }, { opacity: 1, duration: 0.01 }, B(4));
    slam('#a3n', B(4));
    // the word shakes apart: letters land out of line, then snap straight
    const rnd = (i) => { const x = Math.sin(i * 91.7) * 43758.5; return x - Math.floor(x); };
    $('#a3w span').forEach((el, i) => tl.fromTo(el, { y: (rnd(i) - 0.5) * 160, rotation: (rnd(i + 9) - 0.5) * 50, opacity: 0 }, { y: (rnd(i) - 0.5) * 40, rotation: (rnd(i + 9) - 0.5) * 14, opacity: 1, duration: 0.18, ease: 'expo.out' }, B(4) + 0.12 + i * 0.03));
    $('#a3w span').forEach((el, i) => tl.to(el, { y: 0, rotation: 0, duration: 0.12, ease: 'power3.out' }, B(5) + 0.1));
    // tape stop: the frame stutters, then squeezes into a line
    [0, 1, 2].forEach((k) => tl.fromTo('#a3', { scale: 1 }, { scale: 1.06, duration: 0.05, yoyo: true, repeat: 1, ease: 'power1.inOut' }, B(5.5) + k * 0.12));
    tl.to('#a3', { scaleY: 0.004, duration: 0.18, ease: 'power3.in' }, SCENE - 0.2);
""", INK)

# ---------------------------------------------------------------- B: title
S['b'] = scene('b', """
    #b-mark { position: absolute; left: 290px; top: 470px; width: 500px; height: 468px; background: url('assets/ai-insider-mark-white.png') center / contain no-repeat; transform-origin: 50% 50%; }
    #b-title { position: absolute; left: 72px; right: 72px; top: 1000px; text-align: center; color: #fff; font-size: 132px; }
    #b-title span { display: inline-block; }
    #b-sub { position: absolute; left: 0; right: 0; top: 1330px; text-align: center; color: #fff; font-size: 30px; opacity: 0.86; }
    #b-paper { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; background: #F2F1EC; transform-origin: 50% 100%; }
""", """
    <div id="b-wrap" class="full" style="perspective: 1400px"><div id="b-mark"></div></div>
    <div id="b-title" class="h1"><span>Особистий</span> <span><span class="hl-ink">AI</span>‑асистент</span></div>
    <div id="b-sub" class="caps">Telegram · голос · веб‑кабінет</div>
    <div id="b-paper"></div>
""", """
    // the line from the hook opens into the blue field; the mark turns to face us
    tl.fromTo('#root', { clipPath: 'inset(49.8% 0% 49.8% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.28, ease: 'expo.out' }, 0);
    tl.fromTo('#b-mark', { rotationY: -90, scale: 1.7, opacity: 0 }, { rotationY: 0, scale: 1, opacity: 1, duration: 0.7, ease: 'expo.out' }, 0.08);
    tl.to('#b-mark', { y: -130, scale: 0.72, duration: 0.5, ease: 'power3.inOut' }, B(2));
    words('#b-title > span', B(2) + 0.25, 0.12);
    words('#b-sub', B(4));
    // paper wipes up into the first chapter
    tl.fromTo('#b-paper', { scaleY: 0 }, { scaleY: 1, duration: 0.36, ease: 'power3.in' }, SCENE - 0.36);
""", BLUE)

MORNING = """<span class="ln"><b>☀️ Доброго ранку! ср, 28 жовт.</b></span><span class="gap"></span>
<span class="ln"><b>🗓 Графік дня</b></span>
<span class="ln">• 09:30 Стендап команди</span>
<span class="ln">• 11:00 Зустріч з фондом</span>
<span class="ln">• 11:30 Стоматолог</span>
<span class="ln">• 15:00 Рев’ю лендингу</span>
<span class="ln">• 19:00 Тренування</span>
<span class="ln" id="c-conf" style="color:#FF6B6B">⚠️ <b style="color:#FF6B6B">Конфлікт:</b> фонд ↔ стоматолог</span><span class="gap"></span>
<span class="ln"><b>⭐ Три головні пріоритети</b></span>
<span class="ln">• Відповісти юристу</span>
<span class="ln">• Презентація для інвесторів</span>"""

# ---------------------------------------------------------------- C: morning
S['c'] = scene('c', f"""
    #c-title {{ position: absolute; left: 72px; right: 72px; top: 280px; font-size: 104px; }}
    #c-title span {{ display: inline-block; }}
    #c-star {{ position: absolute; left: 520px; top: 1180px; width: 520px; height: 520px; }}
    #c-star-t {{ position: absolute; left: 520px; top: 1180px; width: 520px; height: 520px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 54px; }}
""", f"""
    {header(1)}
    {chip(1, 'Ранок')}
    <div id="c-title" class="h1"><span>Звіт</span> <span>уже</span> <span>чекає</span> <span>о</span> <span class="hl">07:58</span></div>
    {phone('c-ph', MORNING, left=160, top=620)}
    <svg id="c-star" viewBox="-100 -100 200 200"><polygon fill="{BLUE}" points="{STAR}"/></svg>
    <div id="c-star-t" class="kin" data-layout-allow-overlap data-layout-allow-occlusion>накладка</div>
""", """
    words('#c-title span', 0.1, 0.07);
    tl.fromTo('#c-ph', { y: 1100 }, { y: 0, duration: 0.7, ease: 'expo.out' }, 0.25);
    tl.fromTo('#c-ph-b', { opacity: 0, scale: 0.9, transformOrigin: '0% 100%' }, { opacity: 1, scale: 1, duration: 0.4, ease: 'expo.out' }, B(2));
    words('#c-ph-b .ln', B(2) + 0.1, 0.05);
    tl.fromTo('#c-conf', { backgroundColor: 'rgba(255,107,107,0)' }, { backgroundColor: 'rgba(255,107,107,0.2)', duration: 0.2 }, B(5));
    // the conflict gets a sticker, spinning in
    tl.fromTo(['#c-star', '#c-star-t'], { scale: 0, rotation: -160 }, { scale: 1, rotation: -10, duration: 0.4, ease: 'back.out(2)' }, B(6));
    tl.to('#c-star', { rotation: 20, duration: SCENE - B(6) - 0.4, ease: 'none' }, B(6) + 0.4);
    whip([...R.children], SCENE - 0.24);
""", PAPER)

# ---------------------------------------------------------------- D: voice
S['d'] = scene('d', f"""
    #d-k1 {{ position: absolute; left: 72px; top: 280px; color: #fff; font-size: 92px; }}
    #d-k2 {{ position: absolute; left: 72px; top: 375px; color: {BLUE}; font-size: 150px; text-shadow: {ext('#170F7A', 8, 2)}; }}
    #d-k2 span {{ display: inline-block; }}
    #d-prompt {{ position: absolute; left: 72px; right: 72px; top: 590px; border-radius: 26px; background: #14161C; border: 2px solid #23262E; padding: 26px 32px; color: #E9EBEF; font-size: 40px; }}
    #d-prompt small {{ display: block; font-size: 26px; color: #6E7480; letter-spacing: 0.12em; margin-bottom: 10px; }}
    #d-caret {{ display: inline-block; width: 18px; height: 44px; background: {BLUE}; vertical-align: -6px; margin-left: 4px; }}
    #d-core {{ position: absolute; left: 40px; top: 860px; width: 1000px; height: 1000px; -webkit-mask-image: radial-gradient(closest-side, #000 72%, transparent 100%); mask-image: radial-gradient(closest-side, #000 72%, transparent 100%); }}
    #d-card {{ position: absolute; left: 72px; right: 72px; top: 1150px; border-radius: 30px; background: #12161C; border: 2px solid #262A33; padding: 34px 40px 38px 46px; color: #fff; overflow: hidden; }}
    #d-edge, #d-edge-ok {{ position: absolute; left: 0; top: 0; bottom: 0; width: 8px; background: #FFB36B; }}
    #d-edge-ok {{ background: #7FE3A8; opacity: 0; }}
    #d-lab {{ font-size: 26px; color: #8A8F98; margin-bottom: 14px; }}
    #d-sum {{ font-size: 42px; line-height: 1.3; font-weight: 600; margin-bottom: 30px; }}
    .d-btn {{ display: inline-flex; align-items: center; height: 96px; padding: 0 44px; border-radius: 48px; font-weight: 700; font-size: 36px; }}
    #d-ok {{ background: {BLUE}; color: #fff; }}
    #d-no {{ color: #8A8F98; }}
    #d-done {{ position: absolute; left: 46px; right: 40px; top: 96px; font-size: 46px; font-weight: 700; opacity: 0; }}
    #d-cur {{ position: absolute; left: 0; top: 0; width: 92px; height: 118px; }}
    #d-s1 {{ position: absolute; left: 72px; top: 300px; color: #fff; font-size: 74px; }}
    #d-s2 {{ position: absolute; left: 72px; top: 400px; color: {BLUE}; font-size: 190px; text-shadow: {ext('#170F7A', 10, 2)}; }}
    #d-iris {{ position: absolute; inset: 0; background: {BLUE}; clip-path: circle(0px at 290px 1440px); }}
""", f"""
    {header(2, dark=True)}
    {chip(2, 'Голос', dark=True)}
    <div id="d-k1" class="kin">ти просто</div>
    <div id="d-k2" class="kin">{''.join(f'<span>{c}</span>' for c in 'кажеш')}</div>
    <div id="d-prompt"><small class="mono">&gt; ГОЛОС</small><span id="d-typed"></span><span id="d-caret"></span></div>
    <video id="d-core" class="clip" src="assets/video/core-voice.mp4" data-start="0" data-duration="8.4" data-track-index="2" muted playsinline></video>
    <div id="d-card"><div id="d-edge"></div><div id="d-edge-ok"></div>
      <div id="d-lab" class="caps">Перенесення</div>
      <div id="d-sum">Перенести «Презентація для інвесторів» на 29.10, 10:00</div>
      <span id="d-ok" class="d-btn">Підтвердити</span><span id="d-no" class="d-btn">Скасувати</span>
      <div id="d-done">✅ Перенесено на 29.10, 10:00</div>
    </div>
    <svg id="d-cur" viewBox="0 0 28 36"><path d="M2 2 L2 29 L9 22.5 L13.6 33 L18 31 L13.5 20.8 L23 20.8 Z" fill="#fff" stroke="#0B0B0F" stroke-width="2" stroke-linejoin="round"/></svg>
    <div id="d-s1" class="kin">без твого «так»</div>
    <div id="d-s2" class="kin">нічого</div>
    <div id="d-iris"></div>
""", """
    words('#d-k1', 0.05);
    $('#d-k2 span').forEach((el, i) => tl.fromTo(el, { y: -220, opacity: 0, rotation: -12 }, { y: 0, opacity: 1, rotation: 0, duration: 0.3, ease: 'back.out(2.2)' }, 0.3 + i * 0.05));
    // she speaks; the words type in as she says them
    const said = 'перенеси презентацію на завтра, 10:00';
    const typed = R.querySelector('#d-typed');
    const ty = { n: 0 };
    tl.to(ty, { n: said.length, duration: 1.7, ease: 'none', onUpdate: () => { typed.textContent = said.slice(0, Math.round(ty.n)); } }, 0.95);
    tl.fromTo('#d-core', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'expo.out' }, 0.6);
    // the core thinks, then hands over the card
    tl.fromTo('#d-card', { opacity: 0, scale: 0.4, y: -120, filter: 'blur(12px)' }, { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', duration: 0.5, ease: 'expo.out' }, 4.0);
    tl.fromTo('#d-cur', { x: 1200, y: 1900 }, { x: 250, y: 1440, duration: 0.6, ease: 'power3.out' }, 4.6);
    tl.to('#d-cur', { scale: 0.85, duration: 0.07, transformOrigin: '0% 0%' }, 5.25);
    tl.to('#d-cur', { scale: 1, duration: 0.1 }, 5.32);
    tl.to(['#d-sum', '#d-ok', '#d-no', '#d-lab'], { opacity: 0, filter: 'blur(8px)', duration: 0.12 }, 5.32);
    tl.to('#d-edge-ok', { opacity: 1, duration: 0.15 }, 5.32);
    tl.to('#d-done', { opacity: 1, duration: 0.15 }, 5.4);
    // "без твого «так» — нічого"
    tl.to(['#d-k1', '#d-k2', '#d-prompt'], { opacity: 0, filter: 'blur(10px)', duration: 0.15 }, 5.6);
    slam('#d-s1', 5.75, 1.4);
    slam('#d-s2', 6.0, 2.2);
    tl.fromTo('#d-s2', { x: 0 }, { x: 14, duration: 0.04, yoyo: true, repeat: 5, ease: 'none' }, 6.2);
    // the click opens the next world
    tl.fromTo('#d-iris', { clipPath: 'circle(0px at 290px 1440px)' }, { clipPath: 'circle(2300px at 290px 1440px)', duration: 0.5, ease: 'power3.in' }, SCENE - 0.5);
""", CORE)

# ---------------------------------------------------------------- E: finance
S['e'] = scene('e', f"""
    #e-q {{ position: absolute; left: 72px; right: 72px; top: 290px; color: #fff; font-size: 76px; }}
    #e-q span {{ display: inline-block; }}
    #e-numclip {{ position: absolute; left: 0; right: 0; top: 560px; text-align: center; color: #fff; font-size: 230px; text-shadow: {ext('#1F14B8', 16, 2)}; white-space: nowrap; }}
    #e-unit {{ position: absolute; left: 0; right: 0; top: 820px; text-align: center; color: #fff; font-size: 30px; }}
    #e-list {{ position: absolute; left: 72px; right: 72px; top: 980px; border-radius: 30px; background: {INK}; padding: 18px 36px; }}
    .e-row {{ display: flex; align-items: center; justify-content: space-between; height: 118px; border-bottom: 2px solid #1E2027; color: #fff; font-size: 38px; }}
    .e-row:last-child {{ border-bottom: 0; }}
    .e-row small {{ display: block; color: #7C818C; font-size: 26px; margin-top: 4px; }}
    .e-row .amt {{ font-family: 'JetBrains Mono', monospace; font-size: 34px; }}
    .e-ok {{ display: inline-flex; align-items: center; height: 46px; padding: 0 16px; border-radius: 8px; background: {BLUE}; color: #fff; font-size: 22px; font-weight: 800; letter-spacing: 0.18em; margin-right: 20px; }}
    #e-cap {{ position: absolute; left: 72px; right: 72px; top: 1620px; text-align: center; font-size: 60px; color: #fff; }}
""", f"""
    {header(3, dark=True, on_blue=True)}
    {chip(3, 'Фінанси', on_blue=True)}
    <div id="e-q" class="h1"><span>«Мінус</span> <span>45</span> <span>доларів,</span> <span>таксі»</span></div>
    <div id="e-numclip" class="kin" data-layout-allow-overflow><span id="e-num">511,50</span></div>
    <div id="e-unit" class="caps">USD · витрати за жовтень</div>
    <div id="e-list">
      <div class="e-row" id="e-new"><div>Таксі<small>28 жовт. · особисте</small></div><div><span class="e-ok">✓ записано</span><span class="amt">−45,00</span></div></div>
      <div class="e-row"><div>Подорожі<small>27 жовт. · Інвестори</small></div><div class="amt">−310,00</div></div>
      <div class="e-row"><div>Сервіси<small>24 жовт. · Запуск продукту</small></div><div class="amt">−129,00</div></div>
    </div>
    <div id="e-cap" class="h1">суму рахує <span class="hl-ink">код</span>, не модель</div>
""", """
    words('#e-q span', 0.08, 0.1);
    tl.fromTo('#e-numclip', { opacity: 0, scale: 1.5, filter: 'blur(16px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.2, ease: 'expo.out' }, B(2));
    words('#e-unit', B(2) + 0.2);
    tl.fromTo('#e-list', { y: 1000 }, { y: 0, duration: 0.5, ease: 'expo.out' }, B(2));
    tl.fromTo('#e-new', { opacity: 0, x: -200 }, { opacity: 1, x: 0, duration: 0.3, ease: 'expo.out' }, B(3));
    const n = { v: 511.5 };
    const el = R.querySelector('#e-num');
    tl.to(n, { v: 556.5, duration: 0.9, ease: 'power2.inOut', onUpdate: () => { el.textContent = (Math.round(n.v * 2) / 2).toFixed(2).replace('.', ','); } }, B(3) + 0.1);
    tl.fromTo('#e-numclip', { scale: 1 }, { scale: 1.08, duration: 0.08, yoyo: true, repeat: 1 }, B(3) + 1.0);
    words('#e-cap', B(5));
    // zoom through the number into the tunnel
    tl.to('#e-numclip', { scale: 14, opacity: 0, duration: 0.3, ease: 'power3.in' }, SCENE - 0.3);
    tl.to(['#e-list', '#e-q', '#e-unit', '#e-cap', ...$('.hdr'), ...$('.chip')], { opacity: 0, filter: 'blur(12px)', duration: 0.2 }, SCENE - 0.3);
""", BLUE)

# ---------------------------------------------------------------- F: tunnel
RINGS = 14
TUNNEL_WORDS = ['Notion', 'Google Calendar', 'Telegram', 'Instagram', 'YouTube', 'ChatGPT', 'Dot', 'Голос', 'Звіти', 'Фінанси', 'Події', 'Памʼять']
S['f'] = scene('f', """
    #f-rings { position: absolute; inset: 0; }
    .f-word { position: absolute; left: 0; right: 0; top: 860px; text-align: center; color: #fff; font-size: 104px; white-space: nowrap; }
    #f-last { position: absolute; left: 0; right: 0; top: 820px; text-align: center; font-size: 128px; color: #fff; }
""", f"""
    <svg id="f-rings" viewBox="0 0 1080 1920" data-layout-ignore>{''.join(f'<circle class="f-ring" cx="540" cy="960" r="100" fill="none" stroke="{BLUE if i % 3 else "#fff"}" stroke-width="{7 if i % 3 else 4}" stroke-dasharray="{"" if i % 2 else "14 18"}"/>' for i in range(RINGS))}</svg>
    {''.join(f'<div class="f-word kin" id="f-w{i}" style="font-size:{min(120, int(1180 / max(6, len(w))))}px">{w}</div>' for i, w in enumerate(TUNNEL_WORDS))}
    <div id="f-last" class="h1"><span class="hl">один асистент</span></div>
""", f"""
    // the camera flies through the rings; each ring's depth is a function of time
    const rings = $('.f-ring');
    const fly = {{ t: 0 }};
    const place = () => {{
      const t = fly.t;
      const speed = 0.55 + 0.9 * Math.min(1, t / SCENE);
      rings.forEach((c, i) => {{
        const z = ((i / {RINGS}) + t * speed * 0.5) % 1;      // 0 far .. 1 passing the camera
        const r = 40 / (1.03 - z);
        c.setAttribute('r', r.toFixed(1));
        c.setAttribute('opacity', (Math.min(1, z * 3) * (1 - Math.max(0, z - 0.85) / 0.15)).toFixed(3));
      }});
    }};
    tl.to(fly, {{ t: SCENE, duration: SCENE, ease: 'none', onUpdate: place }}, 0);
    place();
    // one module per beat, each slams and blurs out
    const W = $('.f-word');
    W.forEach((w, i) => {{
      const at = B(i);
      tl.fromTo(w, {{ opacity: 0, scale: 2.4, filter: 'blur(16px)' }}, {{ opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.12, ease: 'expo.out' }}, at);
      tl.to(w, {{ opacity: 0, scale: 0.55, filter: 'blur(10px)', duration: 0.12, ease: 'power2.in' }}, at + BEAT - 0.12);
    }});
    slam('#f-last', B(W.length) + 0.02, 1.8);
    whip('#f-last', SCENE - 0.22, 0);
    tl.to('#f-last', {{ y: -1400, duration: 0.22, ease: 'power3.in' }}, SCENE - 0.22);
""", INK)

EVENING = """<span class="ln"><b>🌙 Підсумок дня, ср, 28 жовт.</b></span><span class="gap"></span>
<span class="ln"><b>✅ Завершено сьогодні</b></span>
<span class="ln">• Надіслати рахунок клієнту</span><span class="gap"></span>
<span class="ln"><b>⏳ Не завершено</b></span>
<span class="ln">• Відповісти юристу</span>
<span class="ln">• Погодити бюджет маркетингу</span><span class="gap"></span>
<span class="ln"><b>🎯 Пріоритети на завтра</b></span>
<span class="ln">• Презентація для інвесторів</span>"""

# ---------------------------------------------------------------- G: evening
S['g'] = scene('g', f"""
    #g-clock {{ position: absolute; left: 0; right: 0; top: 270px; text-align: center; font-size: 228px; color: {INK}; text-shadow: {ext(BLUE, 14, 3)}; }}
    #g-line {{ position: absolute; left: 72px; right: 72px; top: 610px; text-align: center; font-size: 66px; }}
""", f"""
    {header(4)}
    {chip(4, 'Вечір')}
    <div id="g-clock" class="kin">20:00</div>
    <div id="g-line" class="h1">підсумок дня <span class="hl">складається сам</span></div>
    {phone('g-ph', EVENING, left=160, top=800, bubble_top=232)}
""", """
    slam('#g-clock', 0.04, 1.9);
    words('#g-line', 0.35);
    tl.fromTo('#g-ph', { y: 1200 }, { y: 0, duration: 0.6, ease: 'expo.out' }, 0.25);
    tl.fromTo('#g-ph-b', { opacity: 0, scale: 0.9, transformOrigin: '0% 100%' }, { opacity: 1, scale: 1, duration: 0.35, ease: 'expo.out' }, B(2));
    words('#g-ph-b .ln', B(2) + 0.1, 0.07);
    tl.to([...R.children], { y: -1500, filter: 'blur(16px)', duration: 0.24, ease: 'power3.in' }, SCENE - 0.24);
""", PAPER)

# ---------------------------------------------------------------- H: numbers
BARS = [('модулів у договорі', '8', 0.36, INK), ('інструментів агента', '25', 0.62, INK), ('автотестів', '108', 0.92, INK), ('днів до запуску', '7', 0.78, BLUE)]
S['h'] = scene('h', f"""
    #h-title {{ position: absolute; left: 72px; right: 72px; top: 260px; font-size: 104px; }}
    .h-lab {{ position: absolute; left: 72px; font-size: 26px; color: #6A6D75; }}
    .h-bar {{ position: absolute; left: 72px; height: 150px; border-radius: 20px; transform: skewX(-10deg); transform-origin: 0 50%; }}
    .h-val {{ position: absolute; right: 40px; top: 0; height: 150px; display: flex; align-items: center; color: #fff; font-size: 104px; transform: skewX(10deg); }}
""", f"""
    {header(4)}
    <div id="h-title" class="h1">кейс у <span class="hl">цифрах</span></div>
    {''.join(f'<div class="h-lab caps" id="h-l{i}" style="top:{620 + i * 300}px">{lab}</div><div class="h-bar" id="h-b{i}" style="top:{672 + i * 300}px; width:{int(936 * w)}px; background:{c}"><div class="h-val kin" id="h-v{i}">{v}</div></div>' for i, (lab, v, w, c) in enumerate(BARS))}
""", """
    words('#h-title', 0.04);
    [0, 1, 2, 3].forEach((i) => {
      const at = 0.2 + i * BEAT;
      tl.fromTo('#h-l' + i, { opacity: 0 }, { opacity: 1, duration: 0.1 }, at);
      tl.fromTo('#h-b' + i, { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: 'expo.out' }, at);
      tl.fromTo('#h-v' + i, { opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.15 }, at + 0.15);
    });
    tl.to([...R.children], { x: -1300, filter: 'blur(18px)', duration: 0.22, ease: 'power3.in' }, SCENE - 0.22);
""", PAPER)

# ---------------------------------------------------------------- I: end card
S['i'] = scene('i', f"""
    #i-logo {{ position: absolute; left: 140px; top: 700px; width: 800px; height: 201px; background: url('assets/ai-insider-logo-dark.png') center / 100% 100% no-repeat; }}
    #i-tag {{ position: absolute; left: 72px; right: 72px; top: 990px; text-align: center; font-size: 50px; }}
    #i-cta {{ position: absolute; left: 0; right: 0; top: 1110px; text-align: center; }}
    #i-btn {{ display: inline-flex; align-items: center; gap: 18px; height: 120px; padding: 0 60px; border-radius: 26px; background: {BLUE}; color: #fff; font-weight: 800; font-size: 46px; box-shadow: 0 24px 50px rgb(58 43 252 / 0.35); }}
    #i-url {{ position: absolute; left: 0; right: 0; top: 1290px; text-align: center; font-size: 34px; }}
""", """
    <div id="i-logo" role="img" aria-label="AI Insider"></div>
    <div id="i-tag" class="h1">Особистий AI‑асистент під ваш день</div>
    <div id="i-cta"><span id="i-btn">Обговорити проєкт →</span></div>
    <div id="i-url" class="caps">aiinsider.it.com</div>
""", """
    // the mark lands on the music's last hit, the wordmark wipes in beside it
    tl.fromTo('#i-logo', { clipPath: 'inset(0% 79% 0% 0%)', scale: 1.4, filter: 'blur(12px)', opacity: 0 }, { scale: 1, filter: 'blur(0px)', opacity: 1, duration: 0.25, ease: 'expo.out' }, 0);
    tl.to('#i-logo', { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.5, ease: 'power3.inOut' }, 0.3);
    words('#i-tag', 0.7);
    tl.fromTo('#i-btn', { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'expo.out' }, 1.0);
    words('#i-url', 1.3);
""", PAPER)


def build(starts, total, music=None, sfx=()):
    """starts: {scene: (start, duration)} in seconds."""
    comp = ROOT / 'compositions'
    comp.mkdir(exist_ok=True)
    for sid, html in S.items():
        dur = starts[sid][1]
        body = html.replace('words(', 'words(').replace('{B_DEF}', '')
        # each scene knows its length and the beat grid, measured from its own start
        start = starts[sid][0]
        prelude = f"    const SCENE = {dur:.3f}; const BEAT = {BEAT:.5f}; const B = (k) => Math.max(0, {BEAT:.5f} * k + {beat_offset(start):.4f});\n"
        body = body.replace("    const tl = gsap.timeline({ paused: true });\n", "    const tl = gsap.timeline({ paused: true });\n" + prelude, 1)
        (comp / f'{sid}.html').write_text(body)
    hosts = '\n'.join(
        f'      <div id="{sid}" data-composition-id="{sid}" data-composition-src="compositions/{sid}.html" data-start="{s:.3f}" data-duration="{d:.3f}" data-track-index="1" data-track-kind="graphics" data-width="1080" data-height="1920"></div>'
        for sid, (s, d) in starts.items())
    audio = ''
    if music:
        audio += f'\n      <audio id="music" class="clip" src="{music}" data-start="0" data-duration="{total}" data-track-index="3" data-volume="1" data-fade-out="0.6"></audio>'
    for i, (src, at, vol) in enumerate(sfx):
        audio += f'\n      <audio id="sfx{i}" class="clip" src="{src}" data-start="{at:.3f}" data-track-index="{4 + i % 3}" data-volume="{vol}"></audio>'
    (ROOT / 'index.html').write_text(f"""<!doctype html>
<html lang="uk" data-composition-variables='[{{"id":"color-accent","type":"color","label":"Accent","default":"{BLUE}"}}]'>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1080px; height: 1920px; overflow: hidden; background: {INK}; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{total}" data-width="1080" data-height="1920" data-fps="60" data-motion-blur="on">
{hosts}{audio}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      window.__timelines["main"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
""")


GRID_ZERO = 0.0  # time of the first downbeat in the track


def beat_offset(scene_start):
    """B(k) inside a scene is the k-th beat after the scene's first downbeat."""
    k0 = -(-(scene_start - GRID_ZERO) // BEAT)  # first beat at or after the start
    return GRID_ZERO + k0 * BEAT - scene_start


if __name__ == '__main__':
    import sys
    plan = json.loads((ROOT / 'plan.json').read_text())
    BPM = plan['bpm']; BEAT = 60 / BPM; GRID_ZERO = plan['grid_zero']
    starts = {k: tuple(v) for k, v in plan['scenes'].items()}
    build(starts, plan['total'], plan.get('music'), [tuple(x) for x in plan.get('sfx', [])])
    print('built', len(starts), 'scenes')
