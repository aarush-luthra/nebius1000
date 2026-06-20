/* ── State ────────────────────────────────────────────────────────────────── */
const state = {
  thinkers: [],                // full roster from API
  selected: [],                // up to 3 thinker ids
  conversations: {},           // { [id]: [{role, content}] }
  currentView: 'landing',
  debateSubview: 'room',
  directTarget: null,          // thinker id for directed questions
  isStreaming: false,
  // live streaming buffers per thinker
  streamBufs: {},              // { [id]: { thinking: '', response: '' } }
};

/* ── Init ─────────────────────────────────────────────────────────────────── */
async function init() {
  try {
    const res = await fetch('/api/thinkers');
    state.thinkers = await res.json();
  } catch (e) {
    console.error('Failed to load thinkers', e);
    // fallback hardcoded so UI still renders without backend
    state.thinkers = FALLBACK_THINKERS;
  }
  renderSelectGrid();
}

/* ── View transitions ─────────────────────────────────────────────────────── */
const App = {
  goToSelect() {
    switchView('select');
  },

  enterDebate() {
    if (state.selected.length < 2) return;
    buildDebateUI();
    switchView('debate');
  },

  setDebateView(name) {
    state.debateSubview = name;
    document.getElementById('room-view').classList.toggle('active', name === 'room');
    document.getElementById('panels-view').classList.toggle('active', name === 'panels');
    document.getElementById('btn-room').classList.toggle('active', name === 'room');
    document.getElementById('btn-panels').classList.toggle('active', name === 'panels');
  },

  handleInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendQuestion();
    }
  },

  autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  },

  setDirectTarget(id) {
    state.directTarget = id;
    const thinker = getThinker(id);
    const badge = document.getElementById('direct-target-badge');
    document.getElementById('direct-target-name').textContent = `→ ${thinker.name}`;
    badge.style.display = 'flex';
    // update header chips
    document.querySelectorAll('.thinker-chip').forEach(c => {
      c.classList.toggle('active-target', c.dataset.id === id);
    });
    document.getElementById('debate-input').focus();
  },

  clearDirectTarget() {
    state.directTarget = null;
    document.getElementById('direct-target-badge').style.display = 'none';
    document.querySelectorAll('.thinker-chip').forEach(c => c.classList.remove('active-target'));
  },

  async sendQuestion() {
    if (state.isStreaming) return;
    const input = document.getElementById('debate-input');
    const question = input.value.trim();
    if (!question) return;

    input.value = '';
    input.style.height = 'auto';

    const targets = state.directTarget ? [state.directTarget] : [...state.selected];
    this.clearDirectTarget();

    // Add user message to room feed
    appendRoomUserMessage(question);

    // Hide empty state
    document.getElementById('room-empty')?.remove();

    state.isStreaming = true;
    document.getElementById('send-btn').disabled = true;

    // Prepare stream buffers and UI placeholders
    state.streamBufs = {};
    targets.forEach(id => {
      state.streamBufs[id] = { thinking: '', response: '', thinkDone: false };
      // Add user message to each thinker's history
      if (!state.conversations[id]) state.conversations[id] = [];
      state.conversations[id].push({ role: 'user', content: question });
    });

    // Build histories payload
    const histories = {};
    targets.forEach(id => {
      // send the history BEFORE we added the current question (already pushed above)
      histories[id] = state.conversations[id].slice(0, -1)
        .map(m => ({ role: m.role, content: m.content }));
    });

    try {
      const res = await fetch('/api/debate/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, thinkers: targets, histories }),
      });

      if (!res.ok) {
        const err = await res.json();
        appendRoomSystemMessage(`Error: ${err.detail}`);
        return;
      }

      await readStream(res.body);
    } catch (e) {
      appendRoomSystemMessage(`Connection error: ${e.message}`);
    } finally {
      state.isStreaming = false;
      document.getElementById('send-btn').disabled = false;
    }
  },
};

/* ── Stream reader ────────────────────────────────────────────────────────── */
async function readStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      try {
        handleEvent(JSON.parse(raw));
      } catch (_) {}
    }
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'start':
      onThinkerStart(ev.thinker);
      break;
    case 'chunk':
      onThinkerChunk(ev.thinker, ev.content, ev.is_thinking);
      break;
    case 'think_end':
      onThinkEnd(ev.thinker);
      break;
    case 'end':
      onThinkerEnd(ev.thinker);
      break;
    case 'error':
      appendRoomSystemMessage(`${getThinker(ev.thinker)?.name}: ${ev.message}`);
      break;
    case 'done':
      // all thinkers finished
      break;
  }
}

/* ── Stream event handlers ────────────────────────────────────────────────── */
function onThinkerStart(id) {
  const thinker = getThinker(id);
  // Highlight seat
  document.getElementById(`seat-${id}`)?.classList.add('speaking');
  // Create room message placeholder
  createRoomMessagePlaceholder(id, thinker);
  // Reset panel thinking
  const pt = document.getElementById(`panel-thinking-${id}`);
  if (pt) pt.textContent = '';
  const pr = document.getElementById(`panel-response-current-${id}`);
  if (pr) pr.textContent = '';
}

function onThinkerChunk(id, content, isThinking) {
  const buf = state.streamBufs[id];
  if (!buf) return;

  if (isThinking) {
    buf.thinking += content;
    // Update panel thinking
    const pt = document.getElementById(`panel-thinking-${id}`);
    if (pt) { pt.textContent = buf.thinking; pt.classList.add('stream-cursor'); }
    // Room message thinking buffer (this round's element)
    if (buf.roomThinkEl) buf.roomThinkEl.textContent = buf.thinking;
  } else {
    buf.response += content;
    // Update panel response
    const pr = document.getElementById(`panel-response-current-${id}`);
    if (pr) { pr.textContent = buf.response; pr.classList.add('stream-cursor'); }
    // Update room message text (this round's element)
    if (buf.roomTextEl) { buf.roomTextEl.textContent = buf.response; buf.roomTextEl.classList.add('stream-cursor'); }
    scrollRoomToBottom();
  }
}

function onThinkEnd(id) {
  state.streamBufs[id].thinkDone = true;
  const pt = document.getElementById(`panel-thinking-${id}`);
  if (pt) pt.classList.remove('stream-cursor');
}

function onThinkerEnd(id) {
  const buf = state.streamBufs[id];
  if (!buf) return;

  // Remove streaming cursors
  document.getElementById(`panel-thinking-${id}`)?.classList.remove('stream-cursor');
  document.getElementById(`panel-response-current-${id}`)?.classList.remove('stream-cursor');
  buf.roomTextEl?.classList.remove('stream-cursor');

  // Remove speaking state
  document.getElementById(`seat-${id}`)?.classList.remove('speaking');

  // Save to conversation history
  if (!state.conversations[id]) state.conversations[id] = [];
  state.conversations[id].push({ role: 'assistant', content: buf.response });

  // Finalise panel: archive current response into history block
  archivePanelResponse(id, buf);
}

/* ── Room view rendering ──────────────────────────────────────────────────── */
function createRoomMessagePlaceholder(id, thinker) {
  const feed = document.getElementById('room-feed');
  const msgId = `room-msg-${id}-${Date.now()}`;

  const div = document.createElement('div');
  div.className = 'room-msg';
  div.id = msgId;

  div.innerHTML = `
    <div class="msg-avatar" style="background:${thinker.color}">
      ${thinker.image
        ? `<img src="${thinker.image}" alt="${thinker.name}" />`
        : thinker.initials}
    </div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name" style="color:${thinker.color}">${thinker.name}</span>
        <span class="msg-model-tag">${thinker.model ? thinker.model.split('/').pop() : ''}</span>
        <button class="msg-think-toggle" onclick="toggleThinking('${msgId}')">[show thinking]</button>
      </div>
      <div class="msg-thinking"></div>
      <div class="msg-text stream-cursor"
           style="border-left-color:${thinker.color}40"></div>
    </div>
  `;

  feed.appendChild(div);

  // Stash this round's elements on the buffer so chunk handlers target the
  // correct (current) message rather than a stale one from a previous round.
  const buf = state.streamBufs[id];
  if (buf) {
    buf.roomThinkEl = div.querySelector('.msg-thinking');
    buf.roomTextEl = div.querySelector('.msg-text');
  }

  scrollRoomToBottom();
}

function appendRoomUserMessage(text) {
  const feed = document.getElementById('room-feed');
  const div = document.createElement('div');
  div.className = 'room-msg user-msg';
  div.innerHTML = `
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name" style="color:var(--text-muted)">You</span></div>
      <div class="msg-text">${escHtml(text)}</div>
    </div>
  `;
  feed.appendChild(div);
  scrollRoomToBottom();
}

function appendRoomSystemMessage(text) {
  const feed = document.getElementById('room-feed');
  const div = document.createElement('div');
  div.className = 'room-msg';
  div.innerHTML = `<div class="msg-body"><div class="msg-text" style="color:var(--text-muted);font-style:italic">${escHtml(text)}</div></div>`;
  feed.appendChild(div);
  scrollRoomToBottom();
}

function toggleThinking(msgId) {
  const msgEl = document.getElementById(msgId);
  if (!msgEl) return;
  const thinkEl = msgEl.querySelector('.msg-thinking');
  const btn = msgEl.querySelector('.msg-think-toggle');
  if (!thinkEl) return;
  const visible = thinkEl.classList.toggle('visible');
  btn.textContent = visible ? 'hide thinking' : 'show thinking';
}

function scrollRoomToBottom() {
  const feed = document.getElementById('room-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/* ── Panels view rendering ────────────────────────────────────────────────── */
function buildPanels() {
  const container = document.getElementById('panels-container');
  container.innerHTML = '';

  state.selected.forEach(id => {
    const thinker = getThinker(id);
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.setProperty('--thinker-color', thinker.color);

    panel.innerHTML = `
      <div class="panel-header">
        <div class="panel-num">${String(state.selected.indexOf(id) + 1).padStart(2,'0')}. — ${thinker.name}</div>
        <div class="panel-name">${thinker.name}</div>
        <div class="panel-domain">${thinker.domain} · ${thinker.era}</div>
        <div class="panel-model-tag">${thinker.model || ''}</div>
        <button class="panel-ask-btn" onclick="App.setDirectTarget('${id}')">
          [Ask ${thinker.name.split(' ')[0]} directly →]
        </button>
      </div>

      <div class="panel-responses" id="panel-responses-${id}">
        <div class="panel-response-text stream-cursor" id="panel-response-current-${id}"></div>
        <div class="panel-empty">The chamber awaits your question.</div>
      </div>
    `;

    container.appendChild(panel);
  });
}

function archivePanelResponse(id, buf) {
  if (!buf.response.trim()) return;

  const responsesEl = document.getElementById(`panel-responses-${id}`);
  if (!responsesEl) return;

  // Remove empty state
  responsesEl.querySelector('.panel-empty')?.remove();

  // Clear the live text node
  const liveEl = document.getElementById(`panel-response-current-${id}`);
  if (liveEl) liveEl.textContent = '';

  // Add archived block at top
  const block = document.createElement('div');
  block.className = 'panel-response-block';
  block.innerHTML = `<div class="panel-response-text">${escHtml(buf.response)}</div>`;
  responsesEl.insertBefore(block, responsesEl.firstChild);
}

/* ── Build debate UI ─────────────────────────────────────────────────────── */
function buildDebateUI() {
  // Header chips
  const bar = document.getElementById('debate-thinkers-bar');
  bar.innerHTML = '';
  state.selected.forEach(id => {
    const t = getThinker(id);
    const chip = document.createElement('div');
    chip.className = 'thinker-chip';
    chip.dataset.id = id;
    chip.title = `Direct a question to ${t.name}`;
    chip.onclick = () => App.setDirectTarget(id);
    chip.innerHTML = `
      <div class="chip-avatar" style="background:${t.color}">${t.initials}</div>
      ${t.name}
    `;
    bar.appendChild(chip);
  });

  // Room seats
  const seats = document.getElementById('room-seats');
  seats.innerHTML = '';
  state.selected.forEach(id => {
    const t = getThinker(id);
    const seat = document.createElement('div');
    seat.className = 'room-seat';
    seat.id = `seat-${id}`;
    seat.title = `Direct a question to ${t.name}`;
    seat.onclick = () => App.setDirectTarget(id);
    seat.innerHTML = `
      <div class="room-seat-avatar" style="border-color:${t.color}40">
        ${t.image ? `<img src="${t.image}" alt="${t.name}">` : `<span style="color:${t.color}">${t.initials}</span>`}
      </div>
      <div class="room-seat-name">${t.name.split(' ')[0]}</div>
    `;
    seats.appendChild(seat);
  });

  // Clear room feed (keep empty state)
  const feed = document.getElementById('room-feed');
  feed.innerHTML = `<div class="room-empty-state" id="room-empty">
    <p>The chamber awaits your question.</p>
    <p class="muted">Type below to open the debate.</p>
  </div>`;

  // Build panels
  buildPanels();

  // Reset conversations
  state.selected.forEach(id => { state.conversations[id] = []; });
}

/* ── Character select grid ────────────────────────────────────────────────── */
function renderSelectGrid() {
  const grid = document.getElementById('thinker-grid');
  grid.innerHTML = '';

  state.thinkers.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'thinker-card';
    card.id = `card-${t.id}`;
    card.onclick = () => toggleSelect(t.id);

    card.innerHTML = `
      <div class="card-num-row">
        <span class="card-num" id="cardnum-${t.id}">${String(i + 1).padStart(2, '0')}.</span>
        <div class="card-badge" id="badge-${t.id}"></div>
      </div>
      <div class="card-portrait" id="portrait-${t.id}">
        ${t.image
          ? `<img src="${t.image}" alt="${t.name}" />`
          : `<span style="color:${t.color}">${t.initials}</span>`}
      </div>
      <div class="card-name">${t.name}</div>
      <div class="card-domain">${t.domain}</div>
      <div class="card-era">${t.era}</div>
    `;

    grid.appendChild(card);
  });
}

function toggleSelect(id) {
  const idx = state.selected.indexOf(id);

  if (idx !== -1) {
    // deselect
    state.selected.splice(idx, 1);
    document.getElementById(`card-${id}`)?.classList.remove('selected');
  } else {
    if (state.selected.length >= 3) return;
    state.selected.push(id);
    document.getElementById(`card-${id}`)?.classList.add('selected');
  }

  updateSelectUI();
}

function updateSelectUI() {
  const n = state.selected.length;

  // Counter text
  document.getElementById('counter-text').textContent = `${n}`;

  // Pips
  for (let i = 0; i < 3; i++) {
    document.getElementById(`pip-${i}`)?.classList.toggle('filled', i < n);
  }

  // Badge numbers
  state.thinkers.forEach(t => {
    const idx = state.selected.indexOf(t.id);
    const badge = document.getElementById(`badge-${t.id}`);
    if (badge) badge.textContent = idx !== -1 ? idx + 1 : '';
    document.getElementById(`card-${t.id}`)?.classList.toggle('disabled', n >= 3 && idx === -1);
  });

  // Enter button
  document.getElementById('enter-btn').disabled = n < 2;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');
  state.currentView = name;
}

function getThinker(id) {
  return state.thinkers.find(t => t.id === id);
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/* ── Fallback roster (used if backend unreachable) ────────────────────────── */
const FALLBACK_THINKERS = [
  { id: 'modi',       name: 'Narendra Modi',      domain: 'Politics & Governance',  era: '21st Century',       color: '#8a5a30', initials: 'NM' },
  { id: 'einstein',   name: 'Albert Einstein',    domain: 'Science & Physics',      era: '20th Century',       color: '#a87d4a', initials: 'AE' },
  { id: 'musk',       name: 'Elon Musk',          domain: 'Tech Entrepreneurship',  era: '21st Century',       color: '#4a8a8a', initials: 'EM' },
  { id: 'kalam',      name: 'A.P.J. Abdul Kalam', domain: 'Science & Leadership',   era: '20th–21st Century',  color: '#5a8ab0', initials: 'AK' },
  { id: 'cleopatra',  name: 'Cleopatra',          domain: 'Leadership & Power',     era: 'Ancient World',      color: '#8a7a30', initials: 'CL' },
  { id: 'mobama',     name: 'Michelle Obama',     domain: 'Leadership & Advocacy',  era: '21st Century',       color: '#7a4a6a', initials: 'MO' },
  { id: 'tesla',      name: 'Nikola Tesla',       domain: 'Invention & Vision',     era: '19th–20th Century',  color: '#5a4a8a', initials: 'NT' },
  { id: 'trump',      name: 'Donald Trump',       domain: 'Business & Politics',    era: '21st Century',       color: '#8a3a3a', initials: 'DT' },
  { id: 'buffett',    name: 'Warren Buffett',     domain: 'Finance & Investing',    era: '20th–21st Century',  color: '#3a6a3a', initials: 'WB' },
  { id: 'curie',      name: 'Marie Curie',        domain: 'Science & Discovery',    era: '19th–20th Century',  color: '#3a8a7a', initials: 'MC' },
];

/* ── Boot ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
