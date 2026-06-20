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

  replyToWord(id, word) {
    App.setDirectTarget(id);
    const input = document.getElementById('debate-input');
    if (input && !input.value.trim()) {
      input.value = `Regarding "${word}" — `;
      App.autoResize(input);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
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
  // Highlight dining table seat
  document.getElementById(`table-seat-${id}`)?.classList.add('speaking');
  // Create room message placeholder, capture its ID
  const msgId = createRoomMessagePlaceholder(id, thinker);
  if (state.streamBufs[id]) state.streamBufs[id].msgId = msgId;
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
    // Room message thinking buffer
    const rt = document.getElementById(`room-thinking-${id}`);
    if (rt) rt.textContent = buf.thinking;
  } else {
    buf.response += content;
    // Update panel response
    const pr = document.getElementById(`panel-response-current-${id}`);
    if (pr) { pr.textContent = buf.response; pr.classList.add('stream-cursor'); }
    // Update room message text
    const rm = document.getElementById(`room-msg-text-${id}`);
    if (rm) { rm.textContent = buf.response; rm.classList.add('stream-cursor'); }
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
  document.getElementById(`room-msg-text-${id}`)?.classList.remove('stream-cursor');

  // Remove speaking state from dining table seat
  document.getElementById(`table-seat-${id}`)?.classList.remove('speaking');

  // Save to conversation history
  if (!state.conversations[id]) state.conversations[id] = [];
  state.conversations[id].push({ role: 'assistant', content: buf.response });

  // Make completed message text interactive
  if (buf.msgId) makeTextInteractive(id, buf.msgId);

  // Finalise panel: archive current response into history block
  archivePanelResponse(id, buf);
}

/* ── Room view rendering ──────────────────────────────────────────────────── */
function createRoomMessagePlaceholder(id, thinker) {
  // In room view the text target lives inside the seat, not in a feed.
  const textEl = document.getElementById(`room-msg-text-${id}`);
  if (textEl) {
    textEl.innerHTML = '';
    textEl.classList.add('stream-cursor');
  }
  // Hide the global empty overlay once debate starts
  const emptyOverlay = document.getElementById('room-empty');
  if (emptyOverlay) emptyOverlay.style.display = 'none';
  // Return the seat text element id — this is buf.msgId
  return `room-msg-text-${id}`;
}

function appendRoomUserMessage(text) {
  const strip = document.getElementById('room-question-strip');
  if (!strip) return;
  strip.textContent = text;
  strip.classList.add('visible');
}

function appendRoomSystemMessage(text) {
  // Surface errors in the question strip so the user sees them
  const strip = document.getElementById('room-question-strip');
  if (!strip) return;
  strip.textContent = text;
  strip.classList.add('visible');
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
  // No-op: room view seats are fixed positions, not a scrolling feed.
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

      <div class="panel-thinking-section">
        <div class="panel-thinking-label">[Internal Reasoning]</div>
        <div class="panel-thinking-text" id="panel-thinking-${id}">
          <span style="color:var(--ink-faint)">Awaiting the debate…</span>
        </div>
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

/* ── Dining table builder ────────────────────────────────────────────────── */
function buildDiningTable() {
  const scene = document.getElementById('room-table-scene');
  const table = document.getElementById('dining-table');
  if (!scene || !table) return;

  // Remove previous seats (not the table itself)
  scene.querySelectorAll('.table-seat').forEach(el => el.remove());

  // Add candles to table
  table.querySelectorAll('.table-candle').forEach(el => el.remove());
  [{ left: '28%' }, { left: '72%' }].forEach(pos => {
    const candle = document.createElement('div');
    candle.className = 'table-candle';
    candle.style.cssText = `position:absolute;left:${pos.left};top:0;transform:translateX(-50%) translateY(-100%);`;
    candle.innerHTML = `<div class="table-candle-flame"></div><div class="table-candle-body"></div>`;
    table.appendChild(candle);
  });

  const n = state.selected.length;

  // Seat = portrait(92px) + gap(12px) + speech(210px) = 314px wide.
  // Table is 360px wide (±180px from center). Use 215px so seats clear the table.
  // Left seats: anchor RIGHT edge; right seats: anchor LEFT edge.
  const CSS_POS = {
    2: [
      { right: 'calc(50% + 215px)', top: '50%',              transform: 'translateY(-50%)' },
      { left:  'calc(50% + 215px)', top: '50%',              transform: 'translateY(-50%)' },
    ],
    3: [
      { right: 'calc(50% + 215px)', top: 'calc(50% - 85px)', transform: '' },
      { left:  'calc(50% + 215px)', top: 'calc(50% - 85px)', transform: '' },
      { left:  '50%',               top: 'calc(50% + 95px)', transform: 'translateX(-50%)' },
    ],
  };
  const positions = CSS_POS[n] || CSS_POS[2];

  state.selected.forEach((id, i) => {
    const t = getThinker(id);
    const pos = positions[i] || positions[0];

    const seat = document.createElement('div');
    seat.className = 'table-seat';
    seat.id = `table-seat-${id}`;

    const styleStr = Object.entries(pos)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
    seat.style.cssText = styleStr;

    seat.innerHTML = `
      <div class="table-seat-portrait" style="border-color:${t.color}40"
           onclick="App.setDirectTarget('${id}')" title="Ask ${t.name} directly">
        ${t.image
          ? `<img src="${t.image}" alt="${t.name}" onerror="this.onerror=null;this.src=this.src.replace('.png','.svg')">`
          : `<div class="table-seat-initials" style="color:${t.color}">${t.initials}</div>`}
      </div>
      <div class="seat-speech">
        <div class="seat-speaker-label" style="color:${t.color}"
             onclick="App.setDirectTarget('${id}')">${t.name}</div>
        <div class="seat-message-text" id="room-msg-text-${id}">
          <span class="seat-empty">Awaiting the debate…</span>
        </div>
        <button class="seat-reply-btn" onclick="App.setDirectTarget('${id}')">[↩ reply to ${t.name.split(' ')[0]}]</button>
      </div>
    `;

    scene.appendChild(seat);
  });
}

/* ── Interactive text ────────────────────────────────────────────────────── */
function makeTextInteractive(id, msgId) {
  // msgId IS the text element's id (room-msg-text-{id})
  const textEl = document.getElementById(msgId);
  if (!textEl || !textEl.textContent.trim()) return;

  const rawText = textEl.textContent;
  const html = rawText.split(/(\s+)/).map(token => {
    if (/^\s+$/.test(token)) return token.replace(/\n/g, '<br>');
    const safe = token.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const esc  = token.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return `<span class="word-token" onclick="App.replyToWord('${id}','${esc}')" title="Click to ask about this">${safe}</span>`;
  }).join('');

  textEl.innerHTML = html;

  // Show the per-seat reply button
  const seat = document.getElementById(`table-seat-${id}`);
  if (seat) seat.querySelector('.seat-reply-btn')?.classList.add('visible');
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

  // Dining table seats
  buildDiningTable();

  // Reset question strip and empty overlay
  const strip = document.getElementById('room-question-strip');
  if (strip) { strip.textContent = ''; strip.classList.remove('visible'); }
  const emptyOverlay = document.getElementById('room-empty');
  if (emptyOverlay) emptyOverlay.style.display = '';

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
      <div class="card-portrait-full">
        ${t.image
          ? `<img src="${t.image}" alt="${t.name}" onerror="this.onerror=null;this.src=this.src.replace('.png','.svg')" />`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-size:48px;color:${t.color};background:var(--bg-alt)">${t.initials}</div>`}
        <div class="card-overlay">
          <span class="card-num" id="cardnum-${t.id}">${String(i + 1).padStart(2, '0')}.</span>
          <div class="card-badge" id="badge-${t.id}"></div>
        </div>
      </div>
      <div class="card-info">
        <div class="card-name">${t.name}</div>
        <div class="card-domain">${t.domain}</div>
        <div class="card-era">${t.era}</div>
      </div>
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
  { id: 'modi',      name: 'Narendra Modi',   domain: 'Politics & Governance', era: '21st Century',      color: '#6a3a10', initials: 'NM', image: '/static/portraits/modi.png' },
  { id: 'einstein',  name: 'Albert Einstein', domain: 'Science & Physics',     era: '20th Century',      color: '#7a5820', initials: 'AE', image: '/static/portraits/einstein.png' },
  { id: 'musk',      name: 'Elon Musk',       domain: 'Tech Entrepreneurship', era: '21st Century',      color: '#1a5a5a', initials: 'EM', image: '/static/portraits/musk.png' },
  { id: 'kalam',     name: 'APJ Abdul Kalam', domain: 'Science & Leadership',  era: '20th–21st Century', color: '#1a3a6a', initials: 'AK', image: '/static/portraits/kalam.png' },
  { id: 'cleopatra', name: 'Cleopatra',       domain: 'Leadership & Power',    era: 'Ancient World',     color: '#6a5010', initials: 'CL', image: '/static/portraits/cleopatra.png' },
  { id: 'michelle',  name: 'Michelle Obama',  domain: 'Leadership & Advocacy', era: '21st Century',      color: '#5a1a3a', initials: 'MO', image: '/static/portraits/michelle.png' },
  { id: 'tesla',     name: 'Nikola Tesla',    domain: 'Invention & Vision',    era: '19th–20th Century', color: '#3a2a6a', initials: 'NT', image: '/static/portraits/tesla.png' },
  { id: 'trump',     name: 'Donald Trump',    domain: 'Business & Politics',   era: '21st Century',      color: '#6a1a1a', initials: 'DT', image: '/static/portraits/trump.png' },
  { id: 'buffett',   name: 'Warren Buffett',  domain: 'Finance & Investing',   era: '20th–21st Century', color: '#1a4a1a', initials: 'WB', image: '/static/portraits/buffett.png' },
  { id: 'curie',     name: 'Marie Curie',     domain: 'Science & Discovery',   era: '19th–20th Century', color: '#0a4040', initials: 'MC', image: '/static/portraits/curie.png' },
];

/* ── Boot ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
