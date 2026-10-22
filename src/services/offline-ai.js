'use strict';

/**
 * Deterministic offline generator.
 *
 * Used when OpenRouter is not configured or every free model fails. It produces the
 * same data shapes as the AI path so the rest of the pipeline stays testable, and the
 * resulting site is a real, polished, interactive page — not a placeholder.
 *
 * Every artifact created through this path is flagged `{ simulated: true, source: 'offline-template' }`
 * so the dashboard never presents it as AI output.
 */

const THEMES = [
  {
    key: 'aurora',
    background: '#070b18',
    surface: '#0f1730',
    primary: '#7c5cff',
    accent: '#22d3ee',
    text: '#eef2ff',
    muted: '#a3aecb',
    tone: 'premium',
  },
  {
    key: 'ember',
    background: '#140d09',
    surface: '#241610',
    primary: '#ff7a45',
    accent: '#ffd166',
    text: '#fff6ef',
    muted: '#d3b6a6',
    tone: 'energetic',
  },
  {
    key: 'moss',
    background: '#07130f',
    surface: '#0e221b',
    primary: '#34d399',
    accent: '#a3e635',
    text: '#ecfdf5',
    muted: '#9dbfb1',
    tone: 'calm',
  },
  {
    key: 'daylight',
    background: '#f6f5ff',
    surface: '#ffffff',
    primary: '#4f46e5',
    accent: '#0891b2',
    text: '#16182b',
    muted: '#5a6076',
    tone: 'editorial',
  },
];

const STOP_WORDS = new Set(
  'the a an and or but if then than that this these those for with without into onto from about above below over under again very really just like want need make made making can could should would will your you yours our we they them their it its is are was were be been being have has had do does did not no yes please video channel comment great good best'.split(
    ' ',
  ),
);

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function titleCase(text) {
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Pull a few meaningful words out of the comment to seed the concept. */
function keywordsFrom(comment) {
  const words = String(comment)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word);
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'comment-concept'
  );
}

function generateBrief(comment, { author = 'a viewer' } = {}) {
  const keywords = keywordsFrom(comment);
  const seed = hash(comment);
  const theme = THEMES[seed % THEMES.length];
  const subject = keywords[0] || 'ideas';
  const secondary = keywords[1] || 'workflow';
  const third = keywords[2] || 'people';

  const nameParts = [titleCase(subject), titleCase(secondary)];
  const title = `${nameParts[0]} ${nameParts[1]}`.slice(0, 34);
  const slug = slugify(`${subject}-${secondary}-studio`);

  return {
    title,
    slug,
    tagline: `A clear, friendly home for ${subject} ideas`,
    audience: `People who care about ${subject} and want a calmer way to organise ${secondary}.`,
    problem: `Most advice about ${subject} is scattered across long videos and comment threads, so nothing is easy to find or reuse.`,
    solution: `A single, fast page that turns one good comment into a practical starting point for ${subject}.`,
    tone: theme.tone,
    palette: {
      background: theme.background,
      surface: theme.surface,
      primary: theme.primary,
      accent: theme.accent,
      text: theme.text,
      muted: theme.muted,
    },
    fontHeading: 'system-ui',
    fontBody: 'system-ui',
    hero: {
      headline: `Make ${subject} simple again`,
      subheadline: `One page that collects the good parts of ${secondary}, so your next step is obvious instead of overwhelming.`,
      primaryCta: 'Try the planner',
      secondaryCta: 'See how it works',
    },
    stats: [
      { value: '3 steps', label: 'to get started' },
      { value: '0 accounts', label: 'nothing to sign up for' },
      { value: '1 page', label: 'everything in one place' },
    ],
    sections: [
      {
        id: 'features',
        heading: 'What you get',
        body: `Three small tools that respect your time and keep ${subject} work visible.`,
        items: [
          {
            title: 'Quick start planner',
            description: `Pick a goal, choose a pace, and get a realistic plan for ${secondary}.`,
          },
          {
            title: 'Idea filter',
            description: `Sort ${third}-focused ideas by effort and impact, with no account needed.`,
          },
          {
            title: 'Comment wall',
            description: 'Capture questions from viewers so good suggestions stop disappearing.',
          },
        ],
      },
      {
        id: 'process',
        heading: 'How it works',
        body: 'No setup, no installs. The page runs entirely in your browser.',
        items: [
          { title: 'Read the idea', description: 'Start with the comment that inspired this page.' },
          { title: 'Shape the plan', description: 'Use the planner to choose what matters this week.' },
          { title: 'Share the result', description: 'Copy a short summary and post it wherever you already talk.' },
        ],
      },
    ],
    faq: [
      {
        q: 'Where did this idea come from?',
        a: `It started as a comment from ${author} on a YouTube video, then became a small, self-contained page.`,
      },
      {
        q: 'Do I need an account?',
        a: 'No. Everything runs locally in your browser and nothing is uploaded.',
      },
      {
        q: 'Can I use this on my phone?',
        a: 'Yes. The layout is mobile first and works down to 360 pixels wide.',
      },
    ],
    interactions: [
      'Goal and pace controls update a live weekly plan',
      'Filterable idea cards with an empty state',
      'Accessible FAQ accordion with keyboard support',
    ],
    keywords: [...new Set([subject, secondary, third, 'planner', 'checklist', 'creator tools', 'youtube comment'])].slice(0, 8),
    sourceComment: comment,
    simulated: true,
    source: 'offline-template',
  };
}

function buildSiteFiles(brief, { author = 'a viewer', comment = '' } = {}) {
  const p = brief.palette;
  const isLight = isLightColor(p.background);
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="${isLight ? 'light' : 'dark'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(brief.title)} — ${escapeHtml(brief.tagline)}</title>
<meta name="description" content="${escapeHtml(brief.solution)}" />
<link rel="stylesheet" href="styles.css" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='${encodeURIComponent(p.primary)}'/%3E%3Cpath d='M9 22V10l14 6-14 6z' fill='white'/%3E%3C/svg%3E" />
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header" id="top">
  <div class="container header-inner">
    <a class="brand" href="#top" aria-label="${escapeHtml(brief.title)} home">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M4 18V6l14 6-14 6z" fill="currentColor"/></svg>
      </span>
      <span>${escapeHtml(brief.title)}</span>
    </a>
    <nav aria-label="Primary">
      <ul class="nav-list">
        <li><a href="#planner">Planner</a></li>
        <li><a href="#ideas">Ideas</a></li>
        <li><a href="#faq">FAQ</a></li>
      </ul>
    </nav>
    <a class="btn btn-primary btn-sm" href="#planner">${escapeHtml(brief.hero.primaryCta)}</a>
  </div>
</header>

<main id="main">
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-glow" aria-hidden="true"></div>
    <div class="container hero-inner">
      <p class="eyebrow">${escapeHtml(brief.tagline)}</p>
      <h1 id="hero-title">${escapeHtml(brief.hero.headline)}</h1>
      <p class="lede">${escapeHtml(brief.hero.subheadline)}</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#planner">${escapeHtml(brief.hero.primaryCta)}</a>
        <a class="btn btn-ghost" href="#process">${escapeHtml(brief.hero.secondaryCta)}</a>
      </div>
      <dl class="stats" aria-label="At a glance">
        ${brief.stats
          .map(
            (s) => `<div class="stat"><dt>${escapeHtml(s.label)}</dt><dd>${escapeHtml(s.value)}</dd></div>`,
          )
          .join('\n        ')}
      </dl>
    </div>
  </section>

  <section class="section" id="planner" aria-labelledby="planner-title">
    <div class="container">
      <div class="section-head">
        <h2 id="planner-title">Plan your first week</h2>
        <p>Move the sliders. The plan updates instantly and nothing leaves your browser.</p>
      </div>
      <div class="panel planner">
        <div class="control">
          <label for="goal">Weekly goal</label>
          <input id="goal" type="range" min="1" max="5" value="3" step="1" />
          <output for="goal" id="goal-out">3 sessions</output>
        </div>
        <div class="control">
          <label for="pace">Session length</label>
          <input id="pace" type="range" min="15" max="90" value="30" step="15" />
          <output for="pace" id="pace-out">30 minutes</output>
        </div>
        <div class="plan-result" role="status" aria-live="polite">
          <p class="plan-total" id="plan-total">1.5 hours per week</p>
          <ul id="plan-list" class="plan-list"></ul>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="ideas" aria-labelledby="ideas-title">
    <div class="container">
      <div class="section-head">
        <h2 id="ideas-title">${escapeHtml(brief.sections[0]?.heading || 'What you get')}</h2>
        <p>${escapeHtml(brief.sections[0]?.body || '')}</p>
      </div>
      <div class="filters" role="group" aria-label="Filter ideas">
        <button class="chip is-active" type="button" data-filter="all" aria-pressed="true">All</button>
        <button class="chip" type="button" data-filter="quick" aria-pressed="false">Quick win</button>
        <button class="chip" type="button" data-filter="deep" aria-pressed="false">Deep work</button>
      </div>
      <ul class="cards" id="idea-cards">
        ${(brief.sections[0]?.items || [])
          .map(
            (item, index) => `<li class="card" data-kind="${index % 2 === 0 ? 'quick' : 'deep'}">
          <span class="card-icon" aria-hidden="true">${index + 1}</span>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.description)}</p>
        </li>`,
          )
          .join('\n        ')}
      </ul>
      <p class="empty" id="empty-state" hidden>No ideas match that filter yet. Try another one.</p>
    </div>
  </section>

  <section class="section" id="process" aria-labelledby="process-title">
    <div class="container">
      <div class="section-head">
        <h2 id="process-title">${escapeHtml(brief.sections[1]?.heading || 'How it works')}</h2>
        <p>${escapeHtml(brief.sections[1]?.body || '')}</p>
      </div>
      <ol class="steps">
        ${(brief.sections[1]?.items || [])
          .map(
            (item, index) => `<li class="step">
          <span class="step-num" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.description)}</p>
        </li>`,
          )
          .join('\n        ')}
      </ol>
    </div>
  </section>

  <section class="section" id="faq" aria-labelledby="faq-title">
    <div class="container narrow">
      <div class="section-head">
        <h2 id="faq-title">Questions</h2>
        <p>Short answers, no fine print.</p>
      </div>
      <div class="accordion">
        ${brief.faq
          .map(
            (item, index) => `<div class="accordion-item">
          <h3>
            <button class="accordion-trigger" type="button" aria-expanded="false" aria-controls="faq-panel-${index}" id="faq-trigger-${index}">
              <span>${escapeHtml(item.q)}</span>
              <svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </h3>
          <div class="accordion-panel" id="faq-panel-${index}" role="region" aria-labelledby="faq-trigger-${index}" hidden>
            <p>${escapeHtml(item.a)}</p>
          </div>
        </div>`,
          )
          .join('\n        ')}
      </div>
    </div>
  </section>

  <section class="cta-band" aria-labelledby="cta-title">
    <div class="container cta-inner">
      <h2 id="cta-title">Start with one small step</h2>
      <p>Use the planner above, pick a single idea, and give it a week.</p>
      <a class="btn btn-primary" href="#planner">${escapeHtml(brief.hero.primaryCta)}</a>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <p>${escapeHtml(brief.title)} — ${escapeHtml(brief.tagline)}</p>
    <p class="fine">Built from a YouTube comment by ${escapeHtml(author)}${comment ? '' : ''}.</p>
  </div>
</footer>
<script src="app.js"></script>
</body>
</html>
`;

  const css = `:root {
  --bg: ${p.background};
  --surface: ${p.surface};
  --primary: ${p.primary};
  --accent: ${p.accent};
  --text: ${p.text};
  --muted: ${p.muted};
  --border: color-mix(in srgb, var(--text) 12%, transparent);
  --radius: 18px;
  --container: 1120px;
  --shadow: 0 18px 50px -24px rgba(0, 0, 0, 0.55);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

* { box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  margin: 0;
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

img, svg { display: block; max-width: 100%; }

a { color: inherit; }

h1, h2, h3 { line-height: 1.12; letter-spacing: -0.02em; margin: 0 0 0.5em; }

h1 { font-size: clamp(2.2rem, 6vw, 4.2rem); }
h2 { font-size: clamp(1.6rem, 3.4vw, 2.4rem); }
h3 { font-size: 1.05rem; }

p { margin: 0 0 1rem; }

.container {
  width: min(100% - 2.5rem, var(--container));
  margin-inline: auto;
}

.container.narrow { width: min(100% - 2.5rem, 760px); }

.skip-link {
  position: absolute;
  left: -999px;
  top: 0;
  background: var(--primary);
  color: #fff;
  padding: 0.6rem 1rem;
  z-index: 100;
}
.skip-link:focus { left: 1rem; top: 1rem; }

.site-header {
  position: sticky;
  top: 0;
  z-index: 40;
  backdrop-filter: blur(14px);
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  border-bottom: 1px solid var(--border);
}

.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 0.85rem;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-weight: 700;
  text-decoration: none;
  letter-spacing: -0.01em;
}

.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(140deg, var(--primary), var(--accent));
  box-shadow: 0 8px 20px -10px var(--primary);
}

.nav-list {
  display: flex;
  gap: 1.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 0.95rem;
}

.nav-list a {
  text-decoration: none;
  color: var(--muted);
  padding: 0.25rem 0;
  border-bottom: 1px solid transparent;
}
.nav-list a:hover { color: var(--text); border-bottom-color: var(--primary); }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.8rem 1.4rem;
  border-radius: 999px;
  border: 1px solid transparent;
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
.btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.btn-primary {
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #08101f;
  box-shadow: 0 14px 30px -16px var(--primary);
}
.btn-primary:hover { transform: translateY(-2px); }
.btn-ghost { border-color: var(--border); color: var(--text); background: transparent; }
.btn-ghost:hover { background: color-mix(in srgb, var(--text) 8%, transparent); }
.btn-sm { padding: 0.55rem 1rem; font-size: 0.9rem; }

.hero { position: relative; padding: clamp(3rem, 8vw, 6.5rem) 0 clamp(2rem, 5vw, 3.5rem); overflow: hidden; }

.hero-glow {
  position: absolute;
  inset: -30% -10% auto;
  height: 70%;
  background:
    radial-gradient(38% 55% at 22% 35%, color-mix(in srgb, var(--primary) 55%, transparent), transparent 70%),
    radial-gradient(32% 45% at 78% 25%, color-mix(in srgb, var(--accent) 45%, transparent), transparent 72%);
  filter: blur(20px);
  opacity: 0.55;
  pointer-events: none;
}

.hero-inner { position: relative; max-width: 780px; }

.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.72rem;
  color: var(--accent);
  margin-bottom: 1rem;
}

.lede { font-size: clamp(1.02rem, 1.6vw, 1.2rem); color: var(--muted); max-width: 56ch; }

.hero-actions { display: flex; flex-wrap: wrap; gap: 0.8rem; margin: 1.6rem 0 2.6rem; }

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
  margin: 0;
  padding: 1.1rem 0 0;
  border-top: 1px solid var(--border);
}

.stat dt { order: 2; font-size: 0.8rem; color: var(--muted); }
.stat dd { order: 1; margin: 0; font-size: 1.35rem; font-weight: 700; }
.stat { display: flex; flex-direction: column-reverse; gap: 0.15rem; }

.section { padding: clamp(3rem, 6vw, 5rem) 0; }

.section-head { max-width: 620px; margin-bottom: 2rem; }
.section-head p { color: var(--muted); margin: 0; }

.panel {
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 92%, transparent), var(--surface));
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) + 6px);
  padding: clamp(1.3rem, 3vw, 2.2rem);
  box-shadow: var(--shadow);
}

.planner { display: grid; gap: 1.6rem; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.control { display: grid; gap: 0.55rem; }
.control label { font-weight: 600; font-size: 0.92rem; }
.control output { color: var(--accent); font-variant-numeric: tabular-nums; font-weight: 600; }

input[type="range"] {
  -webkit-appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 18%, transparent);
  outline-offset: 6px;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--primary);
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--border);
  cursor: grab;
}
input[type="range"]::-moz-range-thumb {
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--primary); border: 3px solid var(--bg); cursor: grab;
}
input[type="range"]:focus-visible { outline: 3px solid var(--accent); }

.plan-result { grid-column: 1 / -1; border-top: 1px solid var(--border); padding-top: 1.2rem; }
.plan-total { font-size: 1.15rem; font-weight: 700; margin-bottom: 0.6rem; }
.plan-list { margin: 0; padding-left: 1.1rem; color: var(--muted); }
.plan-list li { margin-bottom: 0.35rem; }

.filters { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1.4rem; }

.chip {
  font: inherit;
  font-size: 0.88rem;
  padding: 0.45rem 1rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.16s ease;
}
.chip:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.chip:hover { color: var(--text); }
.chip.is-active { background: var(--primary); border-color: var(--primary); color: #08101f; font-weight: 600; }

.cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.4rem;
  transition: transform 0.18s ease, border-color 0.18s ease;
}
.card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--primary) 55%, var(--border)); }
.card p { color: var(--muted); margin: 0; font-size: 0.94rem; }
.card-icon {
  display: inline-grid;
  place-items: center;
  width: 32px; height: 32px;
  border-radius: 10px;
  margin-bottom: 0.9rem;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.card[hidden] { display: none; }

.empty { color: var(--muted); font-style: italic; }

.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); counter-reset: step; }
.step { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.4rem; }
.step p { color: var(--muted); margin: 0; font-size: 0.94rem; }
.step-num { display: block; font-size: 0.75rem; letter-spacing: 0.18em; color: var(--accent); margin-bottom: 0.7rem; }

.accordion { border-top: 1px solid var(--border); }
.accordion-item { border-bottom: 1px solid var(--border); }
.accordion-item h3 { margin: 0; }
.accordion-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.15rem 0.2rem;
  background: none;
  border: 0;
  color: var(--text);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.accordion-trigger:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 8px; }
.chev { transition: transform 0.2s ease; flex: none; }
.accordion-trigger[aria-expanded="true"] .chev { transform: rotate(180deg); }
.accordion-panel { padding-bottom: 1.1rem; color: var(--muted); }
.accordion-panel p { margin: 0; }

.cta-band { padding: clamp(2.5rem, 6vw, 4rem) 0; }
.cta-inner {
  text-align: center;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) + 8px);
  padding: clamp(2rem, 5vw, 3.5rem) 1.5rem;
  background:
    radial-gradient(60% 100% at 50% 0%, color-mix(in srgb, var(--primary) 22%, transparent), transparent 70%),
    var(--surface);
}
.cta-inner p { color: var(--muted); max-width: 45ch; margin-inline: auto; }

.site-footer { border-top: 1px solid var(--border); padding: 2rem 0 2.5rem; color: var(--muted); font-size: 0.9rem; }
.footer-inner { display: flex; flex-wrap: wrap; gap: 0.6rem; justify-content: space-between; }
.fine { margin: 0; }

.reveal { opacity: 0; transform: translateY(14px); transition: opacity 0.5s ease, transform 0.5s ease; }
.reveal.is-visible { opacity: 1; transform: none; }

@media (max-width: 720px) {
  .nav-list { display: none; }
  .header-inner { gap: 0.5rem; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  .reveal { opacity: 1; transform: none; }
}
`;

  const js = `(function () {
  'use strict';

  var goal = document.getElementById('goal');
  var pace = document.getElementById('pace');
  var goalOut = document.getElementById('goal-out');
  var paceOut = document.getElementById('pace-out');
  var planTotal = document.getElementById('plan-total');
  var planList = document.getElementById('plan-list');

  function formatMinutes(minutes) {
    if (minutes < 60) return minutes + ' minutes';
    var hours = minutes / 60;
    var rounded = Math.round(hours * 10) / 10;
    return rounded + (rounded === 1 ? ' hour' : ' hours');
  }

  function renderPlan() {
    if (!goal || !pace || !planTotal || !planList) return;
    var sessions = Number(goal.value);
    var minutes = Number(pace.value);
    var total = sessions * minutes;

    goalOut.textContent = sessions + (sessions === 1 ? ' session' : ' sessions');
    paceOut.textContent = minutes + ' minutes';
    planTotal.textContent = formatMinutes(total) + ' per week, spread over ' + sessions + (sessions === 1 ? ' sitting' : ' sittings');

    var blocks = ['Read the idea and pick one outcome', 'Shape the smallest useful version', 'Share it where your people already are'];
    planList.innerHTML = '';
    for (var i = 0; i < sessions; i += 1) {
      var li = document.createElement('li');
      li.textContent = 'Session ' + (i + 1) + ': ' + blocks[i % blocks.length] + ' (' + minutes + ' min)';
      planList.appendChild(li);
    }
  }

  if (goal && pace) {
    goal.addEventListener('input', renderPlan);
    pace.addEventListener('input', renderPlan);
    renderPlan();
  }

  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-filter]'));
  var cards = Array.prototype.slice.call(document.querySelectorAll('#idea-cards .card'));
  var emptyState = document.getElementById('empty-state');

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var filter = chip.getAttribute('data-filter');
      chips.forEach(function (other) {
        var isActive = other === chip;
        other.classList.toggle('is-active', isActive);
        other.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      var visible = 0;
      cards.forEach(function (card) {
        var show = filter === 'all' || card.getAttribute('data-kind') === filter;
        card.hidden = !show;
        if (show) visible += 1;
      });
      if (emptyState) emptyState.hidden = visible !== 0;
    });
  });

  var triggers = Array.prototype.slice.call(document.querySelectorAll('.accordion-trigger'));
  triggers.forEach(function (trigger) {
    trigger.addEventListener('click', function () {
      var expanded = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      var panel = document.getElementById(trigger.getAttribute('aria-controls'));
      if (panel) panel.hidden = expanded;
    });
    trigger.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      var index = triggers.indexOf(trigger);
      var next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      if (next < 0) next = triggers.length - 1;
      if (next >= triggers.length) next = 0;
      triggers[next].focus();
    });
  });

  if ('IntersectionObserver' in window) {
    var targets = document.querySelectorAll('.card, .step, .panel');
    Array.prototype.forEach.call(targets, function (target) {
      target.classList.add('reveal');
    });
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 },
    );
    Array.prototype.forEach.call(targets, function (target) {
      observer.observe(target);
    });
  }
})();
`;

  return {
    title: brief.title,
    description: brief.solution,
    files: [
      { path: 'index.html', content: html },
      { path: 'styles.css', content: css },
      { path: 'app.js', content: js },
    ],
    simulated: true,
    source: 'offline-template',
  };
}

function generateScript(brief, comment, { author = 'a viewer', url = '', seconds = 45 } = {}) {
  const feature = brief.sections?.[0]?.items?.[0];
  const feature2 = brief.sections?.[0]?.items?.[1];
  const segments = [
    {
      section: 'hook',
      text: `One comment turned into a real website. Here is how it works.`,
    },
    {
      section: 'context',
      text: `${author} asked about ${brief.keywords?.[0] || 'this topic'}. So we built a single page around that question, instead of another long video.`,
    },
    {
      section: 'feature',
      text: `${feature ? feature.title : 'The planner'} is the first thing you see. ${brief.hero?.subheadline || ''}`.trim(),
    },
    {
      section: 'feature',
      text: `${feature2 ? feature2.title : 'The idea list'} filters instantly, and the plan updates while you move the sliders.`,
    },
    {
      section: 'outro',
      text: `No sign ups, no clutter. The link is in the description.`,
    },
  ];

  const words = segments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
  return {
    title: `${brief.title}: built from a comment`.slice(0, 95),
    description: `${brief.hero?.headline || brief.tagline}.\n\n${url ? `Live site: ${url}\n\n` : ''}Built from a comment by ${author}.\n\n#Shorts`,
    tags: [...(brief.keywords || []).slice(0, 8), 'shorts'],
    hook: segments[0].text,
    segments,
    targetSeconds: seconds,
    wordCount: words,
    simulated: true,
    source: 'offline-template',
  };
}

function isLightColor(hex) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return false;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

module.exports = { generateBrief, buildSiteFiles, generateScript, keywordsFrom, THEMES, isLightColor };
