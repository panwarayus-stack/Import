/* AI Website & Shorts Factory — dashboard client */
(function () {
  'use strict';

  const state = {
    view: 'overview',
    overview: null,
    settings: null,
    jobs: [],
    jobsTotal: 0,
    jobsOffset: 0,
    jobsStatus: 'all',
    jobsSearch: '',
    comments: null,
    logs: [],
    logLevel: 'all',
    logSearch: '',
    logJob: '',
    liveLogs: true,
    polling: null,
    modalJobId: null,
  };

  /* ------------------------------------------------------------- utilities */

  const $ = (id) => document.getElementById(id);

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value; // only for static trusted markup
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'attrs') for (const [a, v] of Object.entries(value)) node.setAttribute(a, v);
        else node.setAttribute(key, value);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
    return node;
  }

  const icon = (path) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  };

  function badge(text, tone, { pulse = false } = {}) {
    return el('span', { class: `badge ${tone}${pulse ? ' pulse' : ''}`, text });
  }

  const STATUS_TONE = {
    succeeded: 'success',
    running: 'running',
    queued: 'neutral',
    retrying: 'warning',
    failed: 'danger',
    canceled: 'neutral',
  };

  function timeAgo(iso) {
    if (!iso) return '—';
    const diff = Date.now() - Date.parse(iso);
    if (!Number.isFinite(diff)) return '—';
    const sec = Math.round(diff / 1000);
    if (sec < 45) return 'just now';
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function toast(message, type = 'info', timeout = 6000) {
    const node = el('div', { class: `toast ${type}`, attrs: { role: type === 'error' ? 'alert' : 'status' } }, [
      el('span', { text: message }),
      el('button', { text: '✕', attrs: { 'aria-label': 'Dismiss' }, onclick: () => node.remove() }),
    ]);
    $('toast-stack').appendChild(node);
    if (timeout) setTimeout(() => node.remove(), timeout);
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'dashboard',
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      window.location.replace('/login');
      throw new Error('Session expired');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  /* ------------------------------------------------------------------- nav */

  const VIEWS = ['overview', 'jobs', 'comments', 'logs', 'settings'];

  function setView(view, { skipHash = false } = {}) {
    if (!VIEWS.includes(view)) view = 'overview';
    state.view = view;
    for (const name of VIEWS) {
      const section = $(`view-${name}`);
      const tab = $(`tab-${name}`);
      const active = name === view;
      if (section) section.hidden = !active;
      if (tab) tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (!skipHash && window.location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    if (view === 'jobs') loadJobs({ reset: true });
    if (view === 'comments') loadComments();
    if (view === 'logs') loadLogs();
    if (view === 'settings') loadSettings();
  }

  function bindTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => setView(tab.dataset.view));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const index = VIEWS.indexOf(state.view);
        const next = VIEWS[(index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
        setView(next);
        $(`tab-${next}`)?.focus();
      });
    }
    for (const link of document.querySelectorAll('[data-goto]')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        setView(link.dataset.goto);
      });
    }
    window.addEventListener('hashchange', () => setView(window.location.hash.replace('#', ''), { skipHash: true }));
  }

  /* -------------------------------------------------------------- overview */

  function renderWarnings(warnings, extra = []) {
    const container = $('warnings-container');
    container.textContent = '';
    const all = [...(warnings || []), ...extra];
    for (const warning of all.slice(0, 4)) {
      container.appendChild(el('div', { class: 'notice warning' }, [el('span', { text: '⚠' }), el('span', { text: warning })]));
    }
  }

  function renderWorker(overview) {
    const worker = overview.worker || {};
    const settings = worker.settings || {};
    const active = worker.activeJob || null;
    const running = Boolean(worker.running);
    const paused = Boolean(worker.paused || settings.paused);
    const dot = $('worker-dot');
    dot.className = `status-dot ${paused ? 'paused' : running ? 'running' : ''}`;
    dot.classList.add(paused ? 'paused' : running ? 'running' : 'error');

    $('worker-title').textContent = paused ? 'Automation paused' : running ? 'Automation running' : 'Worker not running';
    const bits = [];
    if (worker.lastHeartbeat) bits.push(`heartbeat ${timeAgo(worker.lastHeartbeat)}`);
    if (worker.lastPollAt) bits.push(`last poll ${timeAgo(worker.lastPollAt)}`);
    bits.push(`jobs today ${worker.jobsToday ?? 0}/${settings.dailyJobLimit ?? '—'}`);
    bits.push(`uploads today ${worker.uploadsToday ?? 0}/${settings.dailyUploadLimit ?? '—'}`);
    if (worker.uptimeSec) bits.push(`uptime ${Math.round(worker.uptimeSec / 60)}m`);
    $('worker-sub').textContent = bits.join(' · ');

    const progress = active ? active.progress || 0 : 0;
    $('job-progress-bar').style.width = `${progress}%`;
    $('job-progress-label').textContent = active
      ? `Job ${active.id} — ${active.status} (${progress}%)`
      : 'No active job — waiting for the next eligible comment';
    $('job-stage-label').textContent = active ? `stage: ${active.stage}` : '';

    const stages = ['select_comment', 'generate_idea', 'build_site', 'test_site', 'deploy_site', 'write_script', 'narrate', 'record_site', 'subtitles', 'render_video', 'upload_video'];
    const completed = active?.state?.completedStages || [];
    const track = $('stage-track');
    track.textContent = '';
    for (const stage of stages) {
      const status = completed.includes(stage) ? 'done' : active?.stage === stage ? 'current' : '';
      track.appendChild(el('span', { class: `stage-chip ${status}`, text: stage.replace(/_/g, ' ') }));
    }

    $('pause-btn').disabled = paused || !running;
    $('resume-btn').disabled = !paused;
  }

  function statCard(label, value, sub) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'label', text: label }),
      el('div', { class: 'value', text: String(value) }),
      sub ? el('div', { class: 'sub', text: sub }) : null,
    ]);
  }

  function renderStats(overview) {
    const stats = overview.stats || {};
    const grid = $('stats-grid');
    grid.textContent = '';
    const comments = stats.comments || {};
    grid.append(
      statCard('Comments discovered', comments.total ?? 0, `${comments.eligible ?? 0} eligible · ${comments.rejected ?? 0} rejected`),
      statCard('Jobs processed', Object.values(stats.jobs || {}).reduce((a, b) => a + b, 0), `${stats.jobs?.succeeded ?? 0} succeeded · ${stats.jobs?.failed ?? 0} failed`),
      statCard('Websites generated', stats.websites?.generated ?? 0, `${stats.websites?.verified ?? 0} verified live`),
      statCard('Videos rendered', stats.videos?.rendered ?? 0, `${stats.videos?.simulated ?? 0} dry-run`),
      statCard('Shorts uploaded', stats.uploads?.uploaded ?? 0, `${stats.uploads?.simulated ?? 0} simulated`),
    );
  }

  function renderCapabilities(overview) {
    const caps = overview.capabilities || {};
    const wrap = $('capabilities');
    wrap.textContent = '';

    const item = (label, ok, detail, tone) => {
      const cls = ok === true ? 'ok' : tone === 'warn' ? 'missing' : 'off';
      wrap.appendChild(el('span', { class: `capability ${cls}`, attrs: { title: detail || '' } }, [
        el('span', { class: 'dot' }),
        el('span', { text: label }),
      ]));
    };

    item('FFmpeg', caps.ffmpeg?.available, caps.ffmpeg?.available ? 'Installed' : 'Missing — rendering unavailable', 'warn');
    item('Chromium', caps.browser?.available, caps.browser?.available ? `Source: ${caps.browser.source}` : 'Missing — browser tests and recording skipped', 'warn');
    item('TTS', caps.tts?.usable, caps.tts?.usable ? `Engine: ${caps.tts.engine}` : 'No local TTS engine detected', 'warn');
    item('OpenRouter', caps.openrouter?.configured, (caps.openrouter?.models || [])[0] || 'Not configured', 'warn');
    item('YouTube OAuth', caps.youtube?.connected, caps.youtube?.channel || (caps.youtube?.oauthConfigured ? 'Configured, not connected' : 'Not configured'), 'warn');
    item('Hosting', caps.deploy?.configured, `Provider: ${caps.deploy?.provider}`, 'off');

    const kv = $('quota-kv');
    kv.textContent = '';
    const quota = overview.quota;
    const usage = overview.usage || {};
    const rows = [
      ['YouTube quota today', quota ? `${quota.used} / ${quota.limit} units` : 'unknown'],
      ['AI calls today', `${usage.openrouter?.calls || 0} / ${overview.config?.limits?.maxOpenRouterCallsPerDay ?? '—'}`],
      ['Dry-run mode', [
        overview.dryRun?.ai ? 'AI offline' : null,
        overview.dryRun?.upload ? 'uploads simulated' : null,
        overview.dryRun?.deploy ? 'local deployment' : null,
      ].filter(Boolean).join(' · ') || 'fully live'],
      ['Server time', formatDate(overview.serverTime)],
    ];
    for (const [key, value] of rows) {
      kv.append(el('dt', { text: key }), el('dd', { text: value }));
    }
  }

  function jobsTable(jobs, { compact = false } = {}) {
    if (!jobs.length) return el('div', { class: 'empty-state', text: 'No jobs yet. Use “Generate now” or wait for the scheduler to pick up a comment.' });
    const table = el('table');
    const head = el('thead');
    head.appendChild(
      el('tr', null, [
        el('th', { text: 'Job' }),
        el('th', { text: 'Comment' }),
        el('th', { text: 'Status' }),
        compact ? null : el('th', { text: 'Stage' }),
        el('th', { text: 'Progress' }),
        compact ? null : el('th', { text: 'Created' }),
        el('th', { text: 'Artifacts' }),
        el('th', { text: '' }),
      ]),
    );
    table.appendChild(head);
    const body = el('tbody');
    for (const job of jobs) {
      const row = el('tr');
      row.appendChild(el('td', null, [el('span', { class: 'mono', text: job.id.replace('job_', '') })]));
      row.appendChild(el('td', null, [
        el('div', { class: 'truncate', text: (job.comment_text || '—').slice(0, 90), attrs: { title: job.comment_text || '' } }),
        job.comment_author ? el('div', { class: 'small-text', text: `@${String(job.comment_author).replace(/^@/, '')}` }) : null,
      ]));
      row.appendChild(el('td', null, [badge(job.status, STATUS_TONE[job.status] || 'neutral', { pulse: job.status === 'running' })]));
      if (!compact) row.appendChild(el('td', null, [el('span', { class: 'small-text', text: job.stage })]));
      const progressWrap = el('td', null, [
        el('div', { class: 'progress', attrs: { style: 'min-width:90px' } }, [
          el('span', { attrs: { style: `width:${job.progress || 0}%` } }),
        ]),
      ]);
      row.appendChild(progressWrap);
      if (!compact) row.appendChild(el('td', null, [el('span', { class: 'small-text', text: timeAgo(job.created_at) })]));
      const artifacts = el('td', null, [
        el('div', { class: 'row-actions' }, [
          job.website_url ? el('a', { class: 'btn small ghost', text: 'Site', href: job.website_url, target: '_blank', rel: 'noopener noreferrer' }) : null,
          job.video_path ? el('a', { class: 'btn small ghost', text: 'Video', href: `/media/videos/${job.id}/short.mp4`, target: '_blank', rel: 'noopener' }) : null,
          job.youtube_url ? el('a', { class: 'btn small ghost', text: 'YouTube', href: job.youtube_url, target: '_blank', rel: 'noopener noreferrer' }) : null,
        ]),
      ]);
      row.appendChild(artifacts);
      const actions = el('td', null, [
        el('div', { class: 'row-actions' }, [
          el('button', { class: 'btn small', text: 'Open', onclick: () => openJobModal(job.id) }),
          ['running', 'queued', 'retrying'].includes(job.status)
            ? el('button', { class: 'btn small danger', text: 'Cancel', onclick: () => cancelJob(job.id) })
            : ['failed', 'canceled'].includes(job.status)
              ? el('button', { class: 'btn small', text: 'Retry', onclick: () => retryJob(job.id) })
              : null,
        ]),
      ]);
      row.appendChild(actions);
      body.appendChild(row);
    }
    table.appendChild(body);
    return el('div', { class: 'table-wrap' }, [table]);
  }

  function renderRecentJobs(overview) {
    const target = $('recent-jobs');
    target.textContent = '';
    target.appendChild(jobsTable(overview.recentJobs || [], { compact: true }));
  }

  function renderLatestSites(overview) {
    const wrap = $('latest-sites');
    wrap.textContent = '';
    const sites = (overview.recentJobs || []).filter((job) => job.website_title).slice(0, 6);
    if (!sites.length) {
      wrap.appendChild(el('div', { class: 'empty-state', text: 'Generated websites appear here.' }));
      return;
    }
    for (const job of sites) {
      const siteId = job.state?.siteId || '';
      const preview = job.website_url || (job.state?.previewUrl || '');
      const img = el('img', {
        class: 'thumb',
        src: `/media/sites/${siteId}/screenshot.png`,
        alt: `Screenshot of ${job.website_title}`,
        loading: 'lazy',
      });
      img.addEventListener('error', () => {
        img.replaceWith(el('div', { class: 'thumb', attrs: { style: 'aspect-ratio:16/10;display:grid;place-items:center;color:#77809f;font-size:.75rem' }, text: 'no screenshot' }));
      });
      wrap.appendChild(
        el('div', null, [
          el('a', { href: preview || '#', target: '_blank', rel: 'noopener noreferrer' }, [img]),
          el('div', { class: 'small-text', text: job.website_title, attrs: { style: 'margin-top:.4rem;color:var(--text)' } }),
          el('div', { class: 'small-text', text: timeAgo(job.created_at) }),
        ]),
      );
    }
  }

  async function loadOverview() {
    try {
      const overview = await api('/overview');
      state.overview = overview;
      renderWarnings(overview.warnings || []);
      renderWorker(overview);
      renderStats(overview);
      renderCapabilities(overview);
      renderRecentJobs(overview);
      renderLatestSites(overview);
      const status = $('global-status');
      const worker = overview.worker || {};
      if (!worker.running) {
        status.className = 'badge neutral no-dot';
        status.textContent = 'worker offline';
      } else if (worker.paused) {
        status.className = 'badge warning no-dot';
        status.textContent = 'paused';
      } else {
        status.className = 'badge running no-dot';
        status.textContent = 'live';
      }
    } catch (error) {
      $('global-status').className = 'badge danger no-dot';
      $('global-status').textContent = 'connection error';
      toast(error.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ jobs */

  async function loadJobs({ reset = false } = {}) {
    if (reset) {
      state.jobsOffset = 0;
      state.jobs = [];
    }
    state.jobsStatus = $('job-status-filter').value;
    state.jobsSearch = $('job-search').value.trim();
    const params = new URLSearchParams({
      limit: '25',
      offset: String(state.jobsOffset),
      status: state.jobsStatus,
    });
    if (state.jobsSearch) params.set('search', state.jobsSearch);
    try {
      const data = await api(`/jobs?${params.toString()}`);
      state.jobsTotal = data.total;
      state.jobs = state.jobsOffset === 0 ? data.jobs : state.jobs.concat(data.jobs);
      const container = $('jobs-table');
      container.textContent = '';
      container.appendChild(jobsTable(state.jobs));
      $('jobs-more').hidden = state.jobs.length >= state.jobsTotal;
      $('jobs-more').textContent = `Load more (${state.jobs.length}/${state.jobsTotal})`;
      populateJobFilter(state.jobs);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function populateJobFilter(jobs) {
    const select = $('log-job');
    const current = select.value;
    const options = new Set(jobs.map((job) => job.id));
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: 'All jobs' }));
    for (const id of options) select.appendChild(el('option', { value: id, text: id.replace('job_', '').slice(0, 16) }));
    if ([...options].includes(current)) select.value = current;
  }

  async function cancelJob(id) {
    if (!window.confirm('Cancel this job? Finished artifacts are kept.')) return;
    try {
      await api(`/jobs/${id}/cancel`, { method: 'POST', body: '{}' });
      toast('Cancellation requested', 'warning');
      loadJobs({ reset: true });
      loadOverview();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function retryJob(id) {
    try {
      await api(`/jobs/${id}/retry`, { method: 'POST', body: '{}' });
      toast('Job re-queued', 'success');
      loadJobs({ reset: true });
      loadOverview();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ------------------------------------------------------------ job modal */

  function closeModal() {
    $('modal').hidden = true;
    state.modalJobId = null;
    document.body.style.overflow = '';
  }

  async function openJobModal(id) {
    try {
      const data = await api(`/jobs/${id}`);
      state.modalJobId = id;
      const { job, website, video, upload, logs } = data;
      $('modal-title').textContent = `Job ${job.id.replace('job_', '')}`;
      const body = $('modal-body');
      body.textContent = '';

      body.appendChild(el('div', { class: 'btn-row' }, [
        badge(job.status, STATUS_TONE[job.status] || 'neutral'),
        badge(job.stage, 'primary', { pulse: false }),
        badge(`${job.progress}%`, 'neutral'),
        job.simulated ? badge('dry-run artifacts', 'warning') : null,
        job.state?.videoSkipped ? badge('no video (no browser)', 'danger') : null,
      ].filter(Boolean)));

      if (job.comment_text) {
        body.appendChild(el('blockquote', { class: 'job-comment', text: `“${job.comment_text}”` }));
      }

      const kv = el('dl', { class: 'kv' });
      const rows = [
        ['Comment author', job.comment_author || '—'],
        ['Source video', job.video_title || '—'],
        ['Created', formatDate(job.created_at)],
        ['Finished', formatDate(job.finished_at)],
        ['Attempts', `${job.attempt}/${job.max_attempts}`],
        ['AI calls', String(job.state?.aiCalls || 0)],
        ['Website', website?.title || '—'],
        ['Site preview', website?.preview_url || '—'],
        ['Deployed URL', website?.deploy_url || (website?.deploy_provider === 'local' ? 'local preview only' : '—')],
        ['Deploy provider', website?.deploy_provider || '—'],
        ['Video file', video?.output_path || (job.state?.videoSkipped ? 'not produced — Chromium unavailable' : '—')],
        ['Video length', video?.duration_sec ? `${video.duration_sec.toFixed(1)}s` : '—'],
        ['YouTube', upload?.url || upload?.status || '—'],
        ['Error', job.error || '—'],
      ];
      for (const [key, value] of rows) kv.append(el('dt', { text: key }), el('dd', { text: String(value) }));
      body.appendChild(kv);

      if (job.state?.warnings?.length) {
        const warnings = el('div', { class: 'grid', attrs: { style: 'gap:.4rem' } });
        for (const warning of job.state.warnings) warnings.appendChild(el('div', { class: 'notice warning', text: warning }));
        body.appendChild(warnings);
      }

      const actions = el('div', { class: 'btn-row' });
      if (website?.preview_url) actions.appendChild(el('a', { class: 'btn', text: 'Open site preview', href: website.preview_url, target: '_blank', rel: 'noopener' }));
      if (website?.deploy_url) actions.appendChild(el('a', { class: 'btn', text: 'Open deployed site', href: website.deploy_url, target: '_blank', rel: 'noopener noreferrer' }));
      if (video?.output_path) actions.appendChild(el('a', { class: 'btn', text: 'Download MP4', href: `/media/videos/${job.id}/short.mp4`, target: '_blank', rel: 'noopener' }));
      if (video?.subtitles_srt) actions.appendChild(el('a', { class: 'btn', text: 'Subtitles (.srt)', href: `/media/videos/${job.id}/subtitles.srt`, target: '_blank', rel: 'noopener' }));
      if (upload?.url) actions.appendChild(el('a', { class: 'btn primary', text: 'View on YouTube', href: upload.url, target: '_blank', rel: 'noopener noreferrer' }));
      if (['running', 'queued', 'retrying'].includes(job.status)) actions.appendChild(el('button', { class: 'btn danger', text: 'Cancel job', onclick: () => { closeModal(); cancelJob(job.id); } }));
      if (['failed', 'canceled'].includes(job.status)) actions.appendChild(el('button', { class: 'btn', text: 'Retry job', onclick: () => { closeModal(); retryJob(job.id); } }));
      body.appendChild(actions);

      if (video?.output_path) {
        body.appendChild(el('video', {
          class: 'video-preview',
          controls: 'controls',
          preload: 'metadata',
          src: `/media/videos/${job.id}/short.mp4`,
          attrs: { playsinline: '' },
        }));
      }

      const logCard = el('div');
      logCard.appendChild(el('h3', { text: 'Job log', attrs: { style: 'font-size:.92rem;margin-bottom:.5rem' } }));
      const list = el('div', { class: 'log-list' });
      for (const entry of logs.slice().reverse()) {
        list.appendChild(
          el('div', { class: 'log-row' }, [
            el('span', { class: 'ts', text: new Date(entry.ts).toLocaleTimeString() }),
            el('span', { class: `lvl ${entry.level}`, text: entry.level }),
            el('span', { class: 'msg' }, [
              el('span', { class: 'scope', text: `[${entry.scope}] ` }),
              el('span', { text: entry.message }),
            ]),
          ]),
        );
      }
      logCard.appendChild(list);
      body.appendChild(logCard);

      $('modal').hidden = false;
      document.body.style.overflow = 'hidden';
      $('modal-close').focus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* -------------------------------------------------------------- comments */

  async function loadComments() {
    try {
      const data = await api('/comments?limit=40');
      state.comments = data;
      const grid = $('comment-stats');
      grid.textContent = '';
      grid.append(
        statCard('Discovered', data.counts.total, 'stored comment ids'),
        statCard('Eligible', data.counts.eligible, 'ready to process'),
        statCard('Processed', data.counts.used, 'already turned into sites'),
        statCard('Rejected', data.counts.rejected, 'spam, duplicate or unsuitable'),
      );
      const container = $('comments-table');
      container.textContent = '';
      if (!data.comments.length) {
        container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state', text: 'No comments collected yet. Poll comments from the dashboard or wait for the scheduler.' })]));
        return;
      }
      const table = el('table');
      table.appendChild(el('thead', null, [el('tr', null, [
        el('th', { text: 'Comment' }), el('th', { text: 'Author' }), el('th', { text: 'Likes' }), el('th', { text: 'Status' }), el('th', { text: 'Discovered' }),
      ])]));
      const body = el('tbody');
      for (const comment of data.comments) {
        body.appendChild(el('tr', null, [
          el('td', null, [el('div', { class: 'truncate', text: comment.text, attrs: { title: comment.text } })]),
          el('td', { text: comment.author || '—' }),
          el('td', { text: String(comment.like_count || 0) }),
          el('td', null, [badge(comment.status, comment.status === 'eligible' ? 'success' : comment.status === 'rejected' ? 'danger' : 'neutral')]),
          el('td', { class: 'small-text', text: timeAgo(comment.discovered_at) }),
        ]));
      }
      table.appendChild(body);
      container.appendChild(el('div', { class: 'table-wrap' }, [table]));
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ logs */

  async function loadLogs() {
    const params = new URLSearchParams({ limit: '200' });
    if (state.logLevel !== 'all') params.set('level', state.logLevel);
    if (state.logSearch) params.set('q', state.logSearch);
    if (state.logJob) params.set('job', state.logJob);
    try {
      const data = await api(`/logs?${params.toString()}`);
      state.logs = data.logs;
      const list = $('log-list');
      list.textContent = '';
      if (!data.logs.length) {
        list.appendChild(el('div', { class: 'empty-state', text: 'No log entries match this filter.' }));
        return;
      }
      for (const entry of data.logs) {
        list.appendChild(
          el('div', { class: 'log-row' }, [
            el('span', { class: 'ts', text: new Date(entry.ts).toLocaleString() }),
            el('span', { class: `lvl ${entry.level}`, text: entry.level }),
            el('span', { class: 'msg' }, [
              el('span', { class: 'scope', text: `[${entry.scope}] ` }),
              el('span', { text: entry.message }),
            ]),
          ]),
        );
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* -------------------------------------------------------------- settings */

  const ENV_ROWS = [
    ['OpenRouter', (c) => (c.openrouter.configured ? `configured · ${c.openrouter.models[0]}` : 'missing OPENROUTER_API_KEY')],
    ['Models', (c) => (c.openrouter.models || []).join(', ')],
    ['YouTube OAuth', (c) => (c.youtube.configured ? 'configured' : 'missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET')],
    ['OAuth redirect URI', (c) => c.youtube.redirectUri],
    ['Channel id', (c) => c.youtube.channelId || 'not connected'],
    ['Quota budget', (c) => `${c.youtube.dailyQuotaUnits} units/day`],
    ['Deploy provider', (c) => c.deploy.provider],
    ['GitHub owner', (c) => (c.deploy.github.configured ? c.deploy.github.owner : 'not configured')],
    ['Local preview base', (c) => c.deploy.localPublicBaseUrl],
    ['TTS engine', (c) => `${c.tts.engine} (${c.tts.voice}, ${c.tts.language}, ×${c.tts.speed})`],
    ['Video format', (c) => `${c.video.width}×${c.video.height} @ ${c.video.fps}fps, max ${c.video.maxDurationSec}s`],
    ['Upload privacy', (c) => `${c.upload.privacy}${c.upload.allowPublicUpload ? '' : ' (public blocked)'}`],
    ['Worker', (c) => `enabled=${c.worker.enabled} scheduler=${c.worker.schedulerEnabled} retries=${c.worker.maxAttempts}`],
    ['Dry-run', (c) => Object.entries(c.dryRun).filter(([, v]) => v).map(([k]) => k).join(', ') || 'off'],
  ];

  async function loadSettings() {
    try {
      const data = await api('/settings');
      state.settings = data;
      const automation = data.automation || {};
      $('set-daily-jobs').value = automation.dailyJobLimit ?? 3;
      $('set-daily-uploads').value = automation.dailyUploadLimit ?? 1;
      $('set-poll').value = automation.pollIntervalMinutes ?? 20;
      $('set-duration').value = automation.targetDurationSec ?? 42;
      $('set-queue').value = automation.maxJobsInQueue ?? 10;
      $('set-privacy').value = automation.privacy || 'private';
      $('set-model').value = data.ai?.model || '';
      const modelOptions = $('model-options');
      modelOptions.textContent = '';
      for (const model of data.ai?.models || []) modelOptions.appendChild(el('option', { value: model }));
      $('set-auto-enqueue').checked = Boolean(automation.autoEnqueue);
      $('set-comment-polling').checked = Boolean(automation.commentPollingEnabled);

      const notices = $('settings-notices');
      notices.textContent = '';
      for (const warning of data.config.warnings || []) {
        notices.appendChild(el('div', { class: 'notice warning', text: warning }));
      }
      if (!data.config.upload.allowPublicUpload) {
        notices.appendChild(el('div', { class: 'notice', text: 'Public uploads are blocked by ALLOW_PUBLIC_UPLOAD=false. Videos upload as private until you change it.' }));
      }

      const oauthState = $('oauth-state');
      oauthState.textContent = '';
      if (!data.oauth.configured) {
        oauthState.appendChild(el('div', { class: 'notice warning', text: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart.' }));
      } else if (data.youtube.connected) {
        oauthState.appendChild(el('div', { class: 'notice', text: `Connected to “${data.youtube.channel || 'YouTube channel'}”${data.youtube.channelId ? ` (${data.youtube.channelId})` : ''}.` }));
      } else {
        oauthState.appendChild(el('div', { class: 'notice', text: `Not connected. Register this redirect URI in Google Cloud Console: ${data.oauth.redirectUri}` }));
      }

      const env = $('env-config');
      env.textContent = '';
      const table = el('table');
      table.appendChild(el('thead', null, [el('tr', null, [el('th', { text: 'Setting' }), el('th', { text: 'Value' })])]));
      const tbody = el('tbody');
      for (const [label, getter] of ENV_ROWS) {
        let value = '—';
        try {
          value = String(getter(data.config));
        } catch {
          value = '—';
        }
        tbody.appendChild(el('tr', null, [el('td', { text: label }), el('td', { class: 'mono', text: value })]));
      }
      table.appendChild(tbody);
      env.appendChild(el('div', { class: 'table-wrap' }, [table]));

      const checkpoints = $('checkpoints');
      checkpoints.textContent = '';
      const rows = [
        ['AI calls today', `${data.ai?.callsToday ?? 0} / ${data.ai?.dailyCallLimit ?? '—'}`],
        ['Editable fields', (data.editable || []).join(', ')],
        ['Env-only fields', (data.envOnly || []).join(', ')],
        ['Panel URL', window.location.origin],
      ];
      for (const [key, value] of rows) checkpoints.append(el('dt', { text: key }), el('dd', { text: value }));
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const payload = {
      dailyJobLimit: Number($('set-daily-jobs').value),
      dailyUploadLimit: Number($('set-daily-uploads').value),
      pollIntervalMinutes: Number($('set-poll').value),
      targetDurationSec: Number($('set-duration').value),
      maxJobsInQueue: Number($('set-queue').value),
      privacy: $('set-privacy').value,
      model: $('set-model').value.trim(),
      autoEnqueue: $('set-auto-enqueue').checked,
      commentPollingEnabled: $('set-comment-polling').checked,
    };
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
      toast('Settings saved', 'success');
      loadOverview();
      loadSettings();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- wiring */

  async function action(path, successMessage) {
    try {
      await api(path, { method: 'POST', body: '{}' });
      if (successMessage) toast(successMessage, 'success');
      loadOverview();
      if (state.view === 'jobs') loadJobs({ reset: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function bindControls() {
    $('refresh-btn').addEventListener('click', loadOverview);
    $('run-once-btn').addEventListener('click', () => action('/automation/run-once', 'Job queued'));
    $('pause-btn').addEventListener('click', () => action('/automation/pause', 'Automation paused'));
    $('resume-btn').addEventListener('click', () => action('/automation/resume', 'Automation resumed'));
    $('poll-btn').addEventListener('click', async () => {
      const button = $('poll-btn');
      button.disabled = true;
      button.textContent = 'Polling…';
      try {
        const summary = await api('/comments/poll', { method: 'POST', body: '{}' });
        if (summary.skipped) toast(`Poll skipped: ${summary.reason}`, 'warning');
        else toast(`Poll finished: ${summary.inserted ?? 0} new, ${summary.eligible ?? 0} eligible`, 'success');
        loadOverview();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
        button.textContent = 'Poll comments';
      }
    });

    $('manual-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const comment = $('manual-comment').value.trim();
      const author = $('manual-author').value.trim() || 'manual';
      if (!comment) return;
      try {
        await api('/jobs', { method: 'POST', body: JSON.stringify({ comment, author }) });
        $('manual-comment').value = '';
        toast('Job queued — follow progress in the Jobs tab', 'success');
        loadOverview();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('jobs-refresh').addEventListener('click', () => loadJobs({ reset: true }));
    $('job-status-filter').addEventListener('change', () => loadJobs({ reset: true }));
    let searchTimer;
    $('job-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadJobs({ reset: true }), 300);
    });
    $('jobs-more').addEventListener('click', () => {
      state.jobsOffset += 25;
      loadJobs();
    });

    $('comments-refresh').addEventListener('click', loadComments);
    $('comments-poll').addEventListener('click', async () => {
      $('comments-poll').disabled = true;
      try {
        const summary = await api('/comments/poll', { method: 'POST', body: '{}' });
        toast(summary.skipped ? `Skipped: ${summary.reason}` : `Fetched ${summary.fetched ?? 0} comments`, summary.skipped ? 'warning' : 'success');
        loadComments();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        $('comments-poll').disabled = false;
      }
    });

    $('logs-refresh').addEventListener('click', loadLogs);
    $('log-level').addEventListener('change', () => {
      state.logLevel = $('log-level').value;
      loadLogs();
    });
    $('log-job').addEventListener('change', () => {
      state.logJob = $('log-job').value;
      loadLogs();
    });
    let logTimer;
    $('log-search').addEventListener('input', () => {
      clearTimeout(logTimer);
      logTimer = setTimeout(() => {
        state.logSearch = $('log-search').value.trim();
        loadLogs();
      }, 300);
    });
    $('logs-live').addEventListener('change', () => {
      state.liveLogs = $('logs-live').checked;
    });

    $('auto-settings-form').addEventListener('submit', saveSettings);
    $('settings-reset').addEventListener('click', loadSettings);
    $('oauth-disconnect').addEventListener('click', async () => {
      if (!window.confirm('Disconnect the YouTube channel? Stored tokens will be revoked.')) return;
      try {
        const response = await fetch('/auth/google/disconnect', { method: 'POST', headers: { 'X-Requested-With': 'dashboard' } });
        if (!response.ok) throw new Error('Disconnect failed');
        toast('Channel disconnected', 'success');
        loadSettings();
        loadOverview();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('modal-close').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (event) => {
      if (event.target === $('modal')) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('modal').hidden) closeModal();
    });

    $('logout-btn').addEventListener('click', async () => {
      try {
        await fetch('/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'dashboard' } });
      } finally {
        window.location.replace('/login');
      }
    });
  }

  function startPolling() {
    if (state.polling) clearInterval(state.polling);
    state.polling = setInterval(() => {
      if (document.hidden) return;
      if (state.view === 'overview') loadOverview();
      if (state.view === 'logs' && state.liveLogs) loadLogs();
      if (state.modalJobId) {
        const id = state.modalJobId;
        if (!document.hidden) {
          api(`/jobs/${id}`).then((data) => {
            const status = data.job.status;
            const title = $('modal-title');
            if (title && !['succeeded', 'failed', 'canceled'].includes(status)) {
              $('job-progress-bar').style.width = `${data.job.progress}%`;
            }
          }).catch(() => {});
        }
      }
    }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.view === 'overview') loadOverview();
    });
  }

  function init() {
    bindTabs();
    bindControls();
    const initial = window.location.hash.replace('#', '');
    setView(VIEWS.includes(initial) ? initial : 'overview', { skipHash: true });
    loadOverview();
    startPolling();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
