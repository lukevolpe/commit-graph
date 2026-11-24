// Interactive rebase editor: the todo as rows, oldest first. Sends the final rows back on Start.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');
  const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
  const KEYS = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
  const HINT = {
    pick: 'Keep the commit',
    reword: 'Keep the commit, change its message',
    edit: 'Stop after this commit to amend it',
    squash: 'Fold into the commit above, combining messages',
    fixup: "Fold into the commit above, dropping this one's message",
    drop: 'Remove the commit',
  };

  /** @type {{sha:string, subject:string, message:string, author:string, date:number, action:string, newMessage:string}[]} */
  let rows = [];
  let focused = 0;
  let busy = false;
  let dragFrom = -1;

  const short = (sha) => sha.slice(0, 7);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmtDate = (s) =>
    new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  /** Same rules as validateTodo in src/rebase.ts. */
  function problem() {
    if (!rows.length) return 'There are no commits to rebase.';
    const first = rows.find((r) => r.action !== 'drop');
    if (first && (first.action === 'squash' || first.action === 'fixup')) {
      return `The first commit can't be ${first.action}: there's no commit above it to fold into.`;
    }
    const empty = rows.find((r) => r.action === 'reword' && !r.newMessage.trim());
    if (empty) return `Reworded commit ${short(empty.sha)} needs a message.`;
    return null;
  }

  /** Index of the row a squash/fixup at `i` folds into, or -1. */
  function foldTarget(i) {
    for (let j = i - 1; j >= 0; j--) {
      const a = rows[j].action;
      if (a === 'drop') continue;
      if (a === 'squash' || a === 'fixup') return foldTarget(j);
      return j;
    }
    return -1;
  }

  function render(focusWhat) {
    rowsEl.textContent = '';
    rows.forEach((r, i) => rowsEl.appendChild(renderRow(r, i)));
    update();
    focusRow(focused, focusWhat);
  }

  function renderRow(r, i) {
    const row = el('div', 'row');
    row.dataset.i = String(i);
    row.dataset.action = r.action;
    row.tabIndex = -1;
    row.setAttribute('role', 'listitem');
    const folds = (r.action === 'squash' || r.action === 'fixup') && foldTarget(i) >= 0;
    if (folds) row.classList.add('folded');
    row.setAttribute('aria-label', `${r.action} ${short(r.sha)} ${r.subject}`);

    const grip = el('span', 'grip codicon codicon-gripper');
    grip.title = 'Drag to move (or Alt+↑ / Alt+↓)';
    grip.addEventListener('mousedown', () => (row.draggable = true));
    row.appendChild(grip);

    const select = el('select', 'action');
    select.setAttribute('aria-label', 'Action');
    for (const a of ACTIONS) {
      const o = el('option', '', a);
      o.value = a;
      o.title = HINT[a];
      select.appendChild(o);
    }
    select.value = r.action;
    select.title = HINT[r.action];
    select.addEventListener('change', () => setAction(i, select.value, 'select'));
    row.appendChild(select);

    const main = el('div', 'main');
    const line = el('div', 'line');
    if (folds) {
      const into = el('span', 'into codicon codicon-arrow-small-up');
      into.title = `Folds into ${short(rows[foldTarget(i)].sha)}`;
      line.appendChild(into);
    }
    line.appendChild(el('span', 'sha', short(r.sha)));
    line.appendChild(el('span', 'subject', r.action === 'reword' ? r.newMessage.split('\n')[0] || r.subject : r.subject));
    line.appendChild(el('span', 'meta', `${r.author} · ${fmtDate(r.date)}`));
    main.appendChild(line);

    if (r.action === 'reword') {
      const ta = el('textarea', 'message');
      ta.value = r.newMessage;
      ta.rows = Math.min(8, Math.max(3, r.newMessage.split('\n').length + 1));
      ta.spellcheck = true;
      ta.setAttribute('aria-label', `New message for ${short(r.sha)}`);
      ta.addEventListener('input', () => {
        r.newMessage = ta.value;
        line.querySelector('.subject').textContent = ta.value.split('\n')[0] || r.subject;
        update();
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          focusRow(i);
        }
      });
      main.appendChild(ta);
    }
    row.appendChild(main);

    row.addEventListener('focusin', () => (focused = i));
    row.addEventListener('dragstart', (e) => {
      dragFrom = i;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', r.sha);
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      dragFrom = -1;
      clearDrop();
      row.classList.remove('dragging');
    });
    return row;
  }

  function clearDrop() {
    for (const r of rowsEl.querySelectorAll('.drop-before, .drop-after')) r.classList.remove('drop-before', 'drop-after');
  }

  /** Where a drop at clientY lands: index to insert before. */
  function dropIndex(y) {
    const items = [...rowsEl.children];
    for (let i = 0; i < items.length; i++) {
      const b = items[i].getBoundingClientRect();
      if (y < b.top + b.height / 2) return i;
    }
    return items.length;
  }

  rowsEl.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    clearDrop();
    const at = dropIndex(e.clientY);
    const items = rowsEl.children;
    if (at < items.length) items[at].classList.add('drop-before');
    else if (items.length) items[items.length - 1].classList.add('drop-after');
  });
  rowsEl.addEventListener('drop', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    let at = dropIndex(e.clientY);
    const [r] = rows.splice(dragFrom, 1);
    if (at > dragFrom) at--;
    rows.splice(at, 0, r);
    focused = at;
    dragFrom = -1;
    render();
  });

  function setAction(i, action, focusWhat) {
    const r = rows[i];
    if (!r || r.action === action) return focusRow(i, focusWhat);
    r.action = action;
    focused = i;
    render(focusWhat ?? (action === 'reword' ? 'message' : undefined));
  }

  function move(i, by) {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    focused = j;
    render();
  }

  function focusRow(i, what) {
    const row = rowsEl.children[i];
    if (!row) return;
    const target = what === 'message' ? row.querySelector('textarea') : what === 'select' ? row.querySelector('select') : row;
    (target ?? row).focus();
    for (const r of rowsEl.children) r.tabIndex = -1;
    row.tabIndex = 0;
  }

  function update() {
    const counts = { drop: 0, fold: 0, reword: 0, edit: 0 };
    for (const r of rows) {
      if (r.action === 'drop') counts.drop++;
      else if (r.action === 'squash' || r.action === 'fixup') counts.fold++;
      else if (r.action === 'reword') counts.reword++;
      else if (r.action === 'edit') counts.edit++;
    }
    const parts = [`${rows.length} ${rows.length === 1 ? 'commit' : 'commits'}`];
    if (counts.drop) parts.push(`${counts.drop} dropped`);
    if (counts.fold) parts.push(`${counts.fold} squashed`);
    if (counts.reword) parts.push(`${counts.reword} reworded`);
    if (counts.edit) parts.push(`${counts.edit} to edit`);
    $('summary').textContent = parts.join(' · ');
    const p = problem();
    $('error').textContent = p ?? '';
    $('start').disabled = busy || !!p;
    $('cancel').disabled = busy;
  }

  function start() {
    if (busy || problem()) return;
    vscode.postMessage({
      type: 'start',
      rows: rows.map((r) => ({ sha: r.sha, action: r.action, message: r.action === 'reword' ? r.newMessage : undefined })),
    });
  }

  rowsEl.addEventListener('keydown', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const inText = e.target.tagName === 'TEXTAREA';
    if (inText) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      return move(i, e.key === 'ArrowUp' ? -1 : 1);
    }
    if (e.target !== row) return; // let the dropdown handle its own keys
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (KEYS[k]) {
      e.preventDefault();
      return setAction(i, KEYS[k]);
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      return focusRow(Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1))));
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      return focusRow(e.key === 'Home' ? 0 : rows.length - 1);
    }
    if (e.key === 'Enter' && rows[i].action === 'reword') {
      e.preventDefault();
      return focusRow(i, 'message');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      start();
    }
  });

  $('start').addEventListener('click', start);
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      $('title').textContent = `Rebase ${m.branch}`;
      $('subtitle').textContent = `Onto ${short(m.base.hash)} ${m.base.subject}`;
      rows = m.commits.map((c) => ({ ...c, sha: c.hash, action: 'pick', newMessage: c.message }));
      focused = 0;
      render();
    } else if (m.type === 'busy') {
      busy = m.busy;
      $('progress').classList.toggle('active', busy);
      update();
    } else if (m.type === 'error') {
      $('error').textContent = m.message;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
