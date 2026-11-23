// Commit Graph webview. Plain JS, no framework: virtual-scrolled list + details pane.
(function () {
  // @ts-ignore provided by VS Code
  const vscode = acquireVsCodeApi();

  const ROW = 26;
  const LANE = 16;
  const MAX_LANES = 24;
  const COLORS = 8;
  const MAX_BADGES = 3;
  const WIP = 'WORKING_TREE';

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const scroller = $('scroller');
  const spacer = $('spacer');
  const body = $('rows');
  const status = $('status');
  const detailsEl = $('details');
  const resizer = $('resizer');
  const searchInput = /** @type {HTMLInputElement} */ ($('search'));
  const searchCount = $('search-count');
  const progress = $('progress');
  const emptyEl = $('empty');

  const saved = vscode.getState() || {};
  const state = {
    rows: [],
    /** hash → row index */
    index: new Map(),
    done: false,
    loading: true,
    head: null,
    scope: 'all',
    graphW: LANE,
    selected: saved.selected || null,
    details: null,
    detailsError: null,
    query: '',
    matches: [],
    matchSet: new Set(),
    matchPos: -1,
    pendingReveal: null,
    busy: 0,
  };
  const layout = JSON.parse(document.body.dataset.layout || '{}');
  setDetailsWidth(layout.width || saved.detailsWidth || 380);
  setDetailsHeight(layout.height || saved.detailsHeight || 0);

  // ---- messages from the extension --------------------------------------------

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'rows':
        onRows(m);
        break;
      case 'wip': {
        const i = state.index.get(WIP);
        if (i !== undefined) state.rows[i].subject = m.subject;
        if (state.selected === WIP) post('select', { hash: WIP });
        render();
        break;
      }
      case 'details':
        if (m.error) {
          if (m.hash === state.selected) {
            state.details = null;
            state.detailsError = m.error;
          }
        } else if (m.details.hash === state.selected) {
          state.details = m.details;
          state.detailsError = null;
        }
        renderDetails();
        break;
      case 'search':
        if (m.query !== state.query) break;
        state.matches = m.hashes;
        state.matchSet = new Set(m.hashes);
        state.matchPos = -1;
        updateSearchCount();
        if (m.hashes.length) gotoMatch(1);
        render();
        break;
      case 'reveal':
        if (state.pendingReveal === m.hash) {
          state.pendingReveal = null;
          if (state.index.has(m.hash)) select(m.hash, { center: true });
        }
        break;
      case 'repoChanged':
        state.rows = [];
        state.index = new Map();
        state.selected = null;
        state.details = null;
        state.query = '';
        state.matches = [];
        state.matchSet = new Set();
        searchInput.value = '';
        updateSearchCount();
        spacer.style.height = '0px';
        status.textContent = '';
        persist();
        renderDetails();
        render();
        break;
      case 'goToHead':
        if (state.head) reveal(state.head);
        scroller.focus();
        break;
      case 'focusSearch':
        searchInput.focus();
        searchInput.select();
        break;
      case 'busy':
        state.busy += m.busy ? 1 : -1;
        progress.classList.toggle('active', state.busy > 0);
        break;
      case 'error':
        state.loading = false;
        showEmpty(m.message, true);
        break;
    }
  });

  function onRows(m) {
    state.loading = false;
    if (m.mode === 'reset') {
      const top = scroller.scrollTop;
      state.rows = m.rows;
      state.head = m.head;
      state.scope = m.scope;
      updateScopeButtons();
      if (!m.keep) scroller.scrollTop = 0;
      else scroller.scrollTop = top;
    } else {
      state.rows = state.rows.concat(m.rows);
    }
    state.done = m.done;
    state.index = new Map(state.rows.map((r, i) => [r.hash, i]));
    updateWidth();
    spacer.style.height = state.rows.length * ROW + 'px';

    const commits = state.rows.length - (state.index.has(WIP) ? 1 : 0);
    status.textContent = `${commits.toLocaleString()}${state.done ? '' : '+'} commits`;
    if (!state.rows.length) showEmpty('No commits yet.');
    else emptyEl.hidden = true;

    if (m.mode === 'reset') {
      if (state.selected && !state.index.has(state.selected)) closeDetails();
      else if (state.selected === WIP || (state.selected && !state.details)) post('select', { hash: state.selected });
      renderDetails();
    }
    render();
  }

  // ---- list rendering --------------------------------------------------------

  function updateWidth() {
    let max = 0;
    for (const r of state.rows) {
      if (r.graph.col > max) max = r.graph.col;
      for (const l of r.graph.lines) if (l.lane > max) max = l.lane;
    }
    state.graphW = Math.min(max + 1, MAX_LANES) * LANE + LANE / 2;
    document.documentElement.style.setProperty('--graph-w', state.graphW + 'px');
  }

  let frame = 0;
  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(renderNow);
  }

  function renderNow() {
    const top = scroller.scrollTop;
    const start = Math.max(0, Math.floor(top / ROW) - 8);
    const end = Math.min(state.rows.length, Math.ceil((top + scroller.clientHeight) / ROW) + 8);
    body.style.transform = `translateY(${start * ROW}px)`;
    let html = '';
    for (let i = start; i < end; i++) html += rowHtml(state.rows[i], i);
    body.innerHTML = html;

    if (!state.done && !state.loading && state.rows.length && end >= state.rows.length - 150) {
      state.loading = true;
      post('loadMore');
    }
  }

  const x = (lane) => LANE / 2 + lane * LANE;

  function graphSvg(r) {
    const g = r.graph;
    const cx = x(g.col);
    const cy = ROW / 2;
    let paths = '';
    for (const l of g.lines) {
      const lx = x(l.lane);
      let d;
      if (l.kind === 'pass') d = `M${lx} 0V${ROW}`;
      else if (l.kind === 'in') d = lx === cx ? `M${lx} 0V${cy}` : `M${lx} 0C${lx} ${cy * 0.9} ${cx} ${cy * 0.4} ${cx} ${cy}`;
      else d = lx === cx ? `M${cx} ${cy}V${ROW}` : `M${cx} ${cy}C${cx} ${cy * 1.6} ${lx} ${cy * 1.1} ${lx} ${ROW}`;
      const dashed = r.wip && l.kind === 'out' ? ' wip' : '';
      paths += `<path class="l c${l.color % COLORS}${dashed}" d="${d}"/>`;
    }
    // HEAD row: the dashed line from the uncommitted row arrives here.
    const c = `c${g.color % COLORS}`;
    let node;
    if (r.wip) node = `<circle class="n wip ${c}" cx="${cx}" cy="${cy}" r="4.5"/>`;
    else if (r.hash === state.head) node = `<circle class="n ${c}" cx="${cx}" cy="${cy}" r="3.5"/><circle class="n ring ${c}" cx="${cx}" cy="${cy}" r="6.5"/>`;
    else if (r.parents.length > 1) node = `<circle class="n merge ${c}" cx="${cx}" cy="${cy}" r="3"/>`;
    else node = `<circle class="n ${c}" cx="${cx}" cy="${cy}" r="4"/>`;
    return `<svg class="graph" width="${state.graphW}" height="${ROW}" aria-hidden="true">${paths}${node}</svg>`;
  }

  function rowHtml(r, i) {
    const sel = r.hash === state.selected;
    const dim = state.query && !state.matchSet.has(r.hash);
    const cls = ['row', sel && 'selected', dim && 'dim', r.hash === state.head && 'head', r.wip && 'wip-row']
      .filter(Boolean)
      .join(' ');
    const ctx = r.wip
      ? { webviewSection: 'wip', preventDefaultContextMenuItems: true }
      : { webviewSection: 'commit', sha: r.hash, preventDefaultContextMenuItems: true };
    const color = r.graph.color % COLORS;
    const author = r.wip
      ? '<div class="col-author"></div>'
      : `<div class="col-author" title="${esc(r.author)} &lt;${esc(r.email)}&gt;">${avatar(r.author, r.email)}<span>${esc(r.author)}</span></div>`;
    return `<div class="${cls}" data-i="${i}" role="option" aria-selected="${sel}" data-vscode-context='${attr(JSON.stringify(ctx))}'>
<div class="col-graph">${graphSvg(r)}</div>
<div class="col-msg">${badges(r.refs, color)}<span class="subject">${highlight(r.subject)}</span></div>
${author}
<div class="col-date" title="${r.wip ? '' : fullDate(r.date)}">${r.wip ? '' : relDate(r.date)}</div>
<div class="col-sha">${r.wip ? '<i class="codicon codicon-edit"></i>' : r.hash.slice(0, 7)}</div>
</div>`;
  }

  /** Folds `origin/x` into local `x` when both point here; caps the count. */
  function groupRefs(refs) {
    const locals = new Set(refs.filter((r) => r.kind === 'branch').map((r) => r.name));
    const out = [];
    const synced = new Map();
    for (const r of refs) {
      if (r.kind === 'remote') {
        const local = r.name.slice(r.name.indexOf('/') + 1);
        if (locals.has(local)) {
          synced.set(local, (synced.get(local) || []).concat(r.name));
          continue;
        }
      }
      out.push({ ...r });
    }
    for (const r of out) if (r.kind === 'branch' && synced.has(r.name)) r.remotes = synced.get(r.name);
    // Current branch first, then branches, tags, remotes.
    const rank = (r) => (r.current ? 0 : r.kind === 'head' ? 1 : r.kind === 'branch' ? 2 : r.kind === 'tag' ? 3 : 4);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  function badges(refs, color) {
    if (!refs.length) return '';
    const all = groupRefs(refs);
    const shown = all.slice(0, MAX_BADGES);
    const rest = all.slice(MAX_BADGES);
    let html = shown.map((r) => badge(r, color)).join('');
    if (rest.length) {
      html += `<span class="ref more" title="${esc(rest.map((r) => r.name).join('\n'))}">+${rest.length}</span>`;
    }
    return `<span class="refs">${html}</span>`;
  }

  function badge(r, color) {
    const icon =
      r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : r.kind === 'head' ? 'debug-disconnect' : r.current ? 'check' : 'git-branch';
    const ctx = {
      webviewSection: 'ref',
      refName: r.name,
      refKind: r.kind,
      refCurrent: !!r.current,
      preventDefaultContextMenuItems: true,
    };
    const tip = [r.name, ...(r.remotes || [])].join(', ') + (r.current ? ' (checked out)' : '');
    const sync = r.remotes ? '<i class="codicon codicon-cloud sync"></i>' : '';
    return `<span class="ref ${r.kind}${r.current ? ' current' : ''} c${color}" title="${esc(tip)}" data-vscode-context='${attr(JSON.stringify(ctx))}'><i class="codicon codicon-${icon}"></i><span>${esc(r.name)}</span>${sync}</span>`;
  }

  // ---- details pane ----------------------------------------------------------

  function renderDetails() {
    const d = state.details;
    const open = !!state.selected;
    detailsEl.hidden = !open;
    resizer.hidden = !open;
    if (!open) return;
    if (state.detailsError) {
      detailsEl.innerHTML = `${closeBtn()}<div class="d-error">${esc(state.detailsError)}</div>`;
      return;
    }
    if (!d) {
      detailsEl.innerHTML = `${closeBtn()}<div class="d-loading">Loading…</div>`;
      return;
    }
    const row = state.rows[state.index.get(d.hash)];
    if (d.wip) {
      detailsEl.innerHTML = `${closeBtn()}
<div class="d-head">
  <h2 class="d-subject">Uncommitted changes</h2>
  <div class="d-meta">Compared with HEAD${state.head ? ` <code>${state.head.slice(0, 7)}</code>` : ''}</div>
</div>
${filesHtml(d)}`;
      return;
    }
    const [subject, ...bodyLines] = d.message.split('\n');
    const body = bodyLines.join('\n').trim();
    const committedSeparately = d.committer !== d.author || d.committerDate !== d.date;
    const parents = d.parents.length
      ? d.parents.map((p) => `<button class="link sha" data-goto="${p}" title="Go to ${p}">${p.slice(0, 7)}</button>`).join(' ')
      : '<span class="muted">none (root commit)</span>';
    detailsEl.innerHTML = `${closeBtn()}
<div class="d-head">
  <h2 class="d-subject">${esc(subject)}</h2>
  <div class="d-person">
    ${avatar(d.author, d.email, true)}
    <div>
      <div><strong>${esc(d.author)}</strong> <span class="muted">${esc(d.email)}</span></div>
      <div class="muted" title="${fullDate(d.date)}">authored ${relDate(d.date, true)}${
        committedSeparately ? ` · committed by ${esc(d.committer)} ${relDate(d.committerDate, true)}` : ''
      }</div>
    </div>
  </div>
  <dl class="d-ids">
    <dt>Commit</dt>
    <dd><button class="link sha" data-copy="${d.hash}" title="Copy full SHA">${d.hash.slice(0, 10)}<i class="codicon codicon-copy"></i></button></dd>
    <dt>${d.parents.length > 1 ? 'Parents' : 'Parent'}</dt>
    <dd>${parents}</dd>
  </dl>
  ${row && row.refs.length ? `<div class="d-refs">${groupRefs(row.refs).map((r) => badge(r, row.graph.color % COLORS)).join('')}</div>` : ''}
</div>
${body ? `<div class="d-body">${linkify(esc(body))}</div>` : ''}
${d.parents.length > 1 ? `<div class="d-note">Changes compared with first parent <code>${d.parents[0].slice(0, 7)}</code></div>` : ''}
${filesHtml(d)}`;
  }

  function closeBtn() {
    return `<button class="icon d-close" data-close title="Close (Esc)" aria-label="Close details"><i class="codicon codicon-close"></i></button>`;
  }

  function filesHtml(d) {
    if (!d.files.length) return `<div class="d-files"><div class="muted d-files-empty">No file changes.</div></div>`;
    let add = 0;
    let del = 0;
    for (const f of d.files) {
      add += f.added || 0;
      del += f.deleted || 0;
    }
    const items = d.files
      .map((f, i) => {
        const slash = f.path.lastIndexOf('/');
        const name = f.path.slice(slash + 1);
        const dir = slash >= 0 ? f.path.slice(0, slash) : '';
        const stat = f.untracked
          ? '<span class="muted">untracked</span>'
          : f.added === null
            ? '<span class="muted">binary</span>'
            : `<span class="add">+${f.added}</span><span class="del">−${f.deleted}</span>`;
        const renamed = f.oldPath ? ` title="Renamed from ${esc(f.oldPath)}"` : '';
        const canOpen = f.status !== 'D';
        return `<li>
  <button class="file" data-file="${i}"${renamed}>
    <span class="st st-${f.status}" title="${statusName(f.status)}">${f.status}</span>
    <span class="fname">${esc(name)}</span>
    <span class="fdir">${esc(dir)}</span>
    <span class="fstat">${stat}</span>
  </button>
  ${canOpen ? `<button class="icon fopen" data-open="${i}" title="Open file" aria-label="Open ${esc(name)}"><i class="codicon codicon-go-to-file"></i></button>` : ''}
</li>`;
      })
      .join('');
    return `<div class="d-files">
  <div class="d-files-head">
    <span><strong>${d.files.length}</strong> ${d.files.length === 1 ? 'file' : 'files'} changed</span>
    <span class="add">+${add}</span><span class="del">−${del}</span>
    <span class="spacer"></span>
    <button class="icon" data-open-all title="Open all changes" aria-label="Open all changes"><i class="codicon codicon-diff-multiple"></i></button>
  </div>
  <ul>${items}</ul>
</div>`;
  }

  detailsEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('[data-file],[data-open],[data-open-all],[data-copy],[data-goto],[data-close]');
    if (!t || !state.details) {
      if (t && t.hasAttribute('data-close')) closeDetails();
      return;
    }
    const d = state.details;
    const parent = d.parents[0] || null;
    if (t.hasAttribute('data-file')) {
      post('openDiff', { hash: d.hash, parent, file: d.files[Number(t.dataset.file)] });
    } else if (t.hasAttribute('data-open')) {
      post('openFile', { path: d.files[Number(t.dataset.open)].path });
    } else if (t.hasAttribute('data-open-all')) {
      post('openAll', { hash: d.hash, parent, files: d.files });
    } else if (t.dataset.copy) {
      post('copy', { text: t.dataset.copy, label: 'commit SHA' });
    } else if (t.dataset.goto) {
      reveal(t.dataset.goto);
    } else if (t.hasAttribute('data-close')) {
      closeDetails();
    }
  });

  function closeDetails() {
    state.selected = null;
    state.details = null;
    state.detailsError = null;
    persist();
    renderDetails();
    render();
  }

  // ---- selection & navigation -------------------------------------------------

  function select(hash, opts = {}) {
    if (hash !== state.selected) {
      state.selected = hash;
      state.details = null;
      state.detailsError = null;
      persist();
      post('select', { hash });
      renderDetails();
    }
    const i = state.index.get(hash);
    if (i !== undefined) scrollToRow(i, opts.center);
    render();
  }

  function scrollToRow(i, center) {
    const top = i * ROW;
    const h = scroller.clientHeight;
    if (center) {
      if (top < scroller.scrollTop || top + ROW > scroller.scrollTop + h) scroller.scrollTop = top - h / 2 + ROW / 2;
    } else if (top < scroller.scrollTop) {
      scroller.scrollTop = top;
    } else if (top + ROW > scroller.scrollTop + h) {
      scroller.scrollTop = top + ROW - h;
    }
  }

  /** Selects a commit, loading more history if it isn't loaded yet. */
  function reveal(hash) {
    if (state.index.has(hash)) {
      select(hash, { center: true });
    } else if (!state.done) {
      state.pendingReveal = hash;
      post('loadUntil', { hash });
    }
  }

  body.addEventListener('mousedown', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('.row');
    if (!row) return;
    const r = state.rows[Number(row.dataset.i)];
    if (r) select(r.hash);
  });

  body.addEventListener('dblclick', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('.row');
    const d = state.details;
    if (row && d && d.hash === state.rows[Number(row.dataset.i)]?.hash && d.files.length) {
      post('openAll', { hash: d.hash, parent: d.parents[0] || null, files: d.files });
    }
  });

  scroller.addEventListener('keydown', (e) => {
    const n = state.rows.length;
    if (!n) return;
    const cur = state.selected ? state.index.get(state.selected) ?? -1 : -1;
    const page = Math.max(1, Math.floor(scroller.clientHeight / ROW) - 1);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'PageDown') next = Math.min(n - 1, cur + page);
    else if (e.key === 'PageUp') next = Math.max(0, cur - page);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Enter' && state.details && state.details.files.length) {
      const d = state.details;
      post('openAll', { hash: d.hash, parent: d.parents[0] || null, files: d.files });
    } else if (e.key === 'Escape') closeDetails();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && state.selected && state.selected !== WIP) {
      post('copy', { text: state.selected, label: 'commit SHA' });
    } else return;
    e.preventDefault();
    if (next >= 0) select(state.rows[next].hash);
  });

  scroller.addEventListener('scroll', render, { passive: true });
  window.addEventListener('resize', () => {
    applyDetailsSize();
    render();
  });

  // ---- search ----------------------------------------------------------------

  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = searchInput.value.trim();
      state.matches = [];
      state.matchSet = new Set();
      state.matchPos = -1;
      updateSearchCount();
      post('search', { query: state.query });
      render();
    }, 150);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (searchInput.value) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
      } else {
        scroller.focus();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      scroller.focus();
    }
  });

  $('search-next').addEventListener('click', () => gotoMatch(1));
  $('search-prev').addEventListener('click', () => gotoMatch(-1));

  function gotoMatch(dir) {
    const n = state.matches.length;
    if (!n) return;
    state.matchPos = state.matchPos < 0 ? (dir > 0 ? 0 : n - 1) : (state.matchPos + dir + n) % n;
    updateSearchCount();
    reveal(state.matches[state.matchPos]);
  }

  function updateSearchCount() {
    const box = $('search-box');
    box.classList.toggle('has-query', !!state.query);
    box.classList.toggle('no-results', !!state.query && !state.matches.length);
    if (!state.query) searchCount.textContent = '';
    else if (!state.matches.length) searchCount.textContent = 'No results';
    else searchCount.textContent = `${state.matchPos + 1 || '–'} of ${state.matches.length.toLocaleString()}`;
  }

  function highlight(text) {
    const q = state.query.toLowerCase();
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  // ---- toolbar ---------------------------------------------------------------

  $('refresh').addEventListener('click', () => post('refresh'));
  $('fetch').addEventListener('click', () => post('fetch'));
  $('go-head').addEventListener('click', () => {
    if (state.head) reveal(state.head);
    scroller.focus();
  });
  $('scope-all').addEventListener('click', () => setScope('all'));
  $('scope-current').addEventListener('click', () => setScope('current'));

  function setScope(scope) {
    if (scope === state.scope) return;
    state.scope = scope;
    updateScopeButtons();
    post('setScope', { scope });
  }

  function updateScopeButtons() {
    for (const s of ['all', 'current']) {
      const b = $(`scope-${s}`);
      b.classList.toggle('active', state.scope === s);
      b.setAttribute('aria-checked', String(state.scope === s));
    }
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === 'F3') {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
    }
  });

  // ---- details resizing ------------------------------------------------------

  const isStacked = () => getComputedStyle(detailsEl.parentElement).flexDirection === 'column';

  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    const stacked = isStacked();
    const start = stacked ? e.clientY : e.clientX;
    const rect = detailsEl.getBoundingClientRect();
    const startSize = stacked ? rect.height : rect.width;
    const move = (ev) => {
      // Clamp while dragging so the saved size is what the user actually saw.
      if (stacked) setDetailsHeight(Math.min(startSize + (start - ev.clientY), window.innerHeight * 0.75));
      else setDetailsWidth(Math.min(startSize + (start - ev.clientX), window.innerWidth * 0.55));
      render();
    };
    const up = () => {
      resizer.classList.remove('dragging');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      persist();
      post('layout', { width: state.detailsWidth, height: state.detailsHeight });
      render();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });

  // state holds the size the user chose; only the applied CSS value is clamped to the
  // current window, so a temporarily small (or hidden, 0px) view doesn't shrink the choice.
  function setDetailsWidth(w) {
    state.detailsWidth = Math.max(260, Math.round(w));
    applyDetailsSize();
  }

  function setDetailsHeight(h) {
    state.detailsHeight = h ? Math.max(120, Math.round(h)) : 0;
    applyDetailsSize();
  }

  function applyDetailsSize() {
    const W = window.innerWidth, H = window.innerHeight;
    const w = W ? Math.max(260, Math.min(state.detailsWidth, W * 0.55)) : state.detailsWidth;
    const want = state.detailsHeight || Math.round(H * 0.45);
    const h = H ? Math.max(120, Math.min(want, H * 0.75)) : want;
    document.documentElement.style.setProperty('--details-w', w + 'px');
    document.documentElement.style.setProperty('--details-h', h + 'px');
  }

  function persist() {
    vscode.setState({ selected: state.selected, detailsWidth: state.detailsWidth, detailsHeight: state.detailsHeight });
  }

  // ---- helpers ---------------------------------------------------------------

  function post(type, data) {
    vscode.postMessage({ type, ...data });
  }

  function showEmpty(text, isError) {
    emptyEl.hidden = false;
    emptyEl.className = 'empty' + (isError ? ' error' : '');
    emptyEl.textContent = text;
  }

  function avatar(name, email, large) {
    const initials =
      (name || '?')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('') || '?';
    let h = 0;
    for (const ch of email || name) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return `<span class="av c${Math.abs(h) % COLORS}${large ? ' lg' : ''}" aria-hidden="true">${esc(initials)}</span>`;
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const absFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const shortFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  function relDate(sec, long) {
    const diff = sec - Date.now() / 1000;
    const abs = Math.abs(diff);
    if (!long && abs > 60 * 60 * 24 * 30) return shortFmt.format(sec * 1000);
    const units = [
      ['year', 31536000],
      ['month', 2592000],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ];
    for (const [u, s] of units) if (abs >= s) return rtf.format(Math.round(diff / s), /** @type {any} */ (u));
    return 'just now';
  }

  function fullDate(sec) {
    return absFmt.format(sec * 1000);
  }

  function statusName(s) {
    return { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged' }[s] || s;
  }

  function linkify(html) {
    return html.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => `<a href="${u}">${u}</a>`);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  function attr(s) {
    return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  }

  updateScopeButtons();
  post('ready');
})();
