/**
 * Flow Kit — Side Panel
 * Displays live connection status, metrics, and request log.
 */

// ── Type label map ───────────────────────────────────────────

const TYPE_LABELS = {
  // Worker request types
  GENERATE_IMAGE:           'GEN IMAGE',
  REGENERATE_IMAGE:         'REGEN IMAGE',
  EDIT_IMAGE:               'EDIT IMAGE',
  GENERATE_CHARACTER_IMAGE: 'GEN REF',
  REGENERATE_CHARACTER_IMAGE: 'REGEN REF',
  EDIT_CHARACTER_IMAGE:     'EDIT REF',
  GENERATE_VIDEO:           'GEN VIDEO',
  GENERATE_VIDEO_REFS:      'GEN VIDEO FROM REFS',
  UPSCALE_VIDEO:            'UPSCALE VIDEO',
  // Captcha action types
  IMAGE_GENERATION:         'GEN IMAGE',
  VIDEO_GENERATION:         'GEN VIDEO',
  // Extension-classified API types
  GEN_IMG:                  'GEN IMAGE',
  GEN_VID:                  'GEN VIDEO',
  GEN_VID_REF:              'GEN VIDEO FROM REFS',
  UPSCALE:                  'UPSCALE VIDEO',
  UPS_IMG:                  'UPSCALE IMAGE',
  POLL:                     'CHECK GEN VIDEO',
  CREDITS:                  'CHECK CREDIT',
  CREATE_PROJECT:           'CREATE PROJECT',
  UPLOAD:                   'UPLOAD IMAGE',
  MEDIA:                    'READ MEDIA',
  TRACKING:                 'GOOGLE FLOW TRACK',
  URL_REFRESH:              'URL REFRESH',
  TRPC:                     'TRPC',
  API:                      'API',
};

function formatType(type) {
  if (!type) return '—';
  return TYPE_LABELS[type] || type.slice(0, 5).toUpperCase();
}

// ── Time formatting ──────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '—';
  }
}

// ── Status update ────────────────────────────────────────────

function updateStatus(data) {
  if (!data) return;

  // Connection dot
  const dot = document.getElementById('conn-dot');
  const connected = data.agentConnected;
  dot.className = connected ? 'on' : '';

  // Toggle state
  const toggle = document.getElementById('main-toggle');
  const toggleLabel = document.getElementById('toggle-label');
  const isOn = data.state !== 'off';
  toggle.checked = isOn;
  toggleLabel.textContent = isOn ? 'ON' : 'OFF';

  // State badge
  const stateBadge = document.getElementById('state-badge');
  const st = data.state || 'off';
  stateBadge.textContent = st;
  stateBadge.className = st; // idle | running | off

  // Token status
  const tokenEl = document.getElementById('token-status');
  if (data.flowKeyPresent) {
    const ageMs = data.tokenAge || 0;
    const ageMin = Math.round(ageMs / 60000);
    if (ageMs > 3600000) {
      tokenEl.textContent = `token expired — open Flow to refresh`;
      tokenEl.className = 'warn';
    } else {
      tokenEl.textContent = `token synced ${ageMin}m`;
      tokenEl.className = 'ok';
    }
    // Auto-refresh when token age > 55 min and connected
    if (ageMs > 3300000 && data.agentConnected) {
      chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    }
  } else {
    tokenEl.textContent = 'no token';
    tokenEl.className = 'bad';
  }

  // Metrics
  const m = data.metrics || {};
  document.getElementById('m-total').textContent   = m.requestCount || 0;
  document.getElementById('m-success').textContent = m.successCount || 0;
  document.getElementById('m-failed').textContent  = m.failedCount  || 0;
}

// ── Request log ──────────────────────────────────────────────

function updateRequestLog(entries) {
  const tbody = document.getElementById('log-body');
  const countEl = document.getElementById('log-count');

  if (!entries || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="log-empty">No requests yet</td></tr>';
    countEl.textContent = '0';
    return;
  }

  countEl.textContent = entries.length;
  _logEntries = entries;

  // Render newest first (entries already sorted DESC by background.js)
  const rows = entries.map((entry) => {
    const shortId = entry.id ? String(entry.id).slice(0, 8) : '—';
    const type   = formatType(entry.type || entry.method);
    const time   = formatTime(entry.time || entry.timestamp || entry.createdAt);
    const status = entry.status || entry.state || 'pending';
    const error  = entry.error || '';

    let badgeHtml;
    if (status === 'COMPLETED' || status === 'success') {
      badgeHtml = '<span class="badge badge-ok">&#10003; done</span>';
    } else if (status === 'FAILED' || status === 'failed' || (typeof status === 'number' && status >= 400)) {
      badgeHtml = '<span class="badge badge-fail">&#10007; fail</span>';
    } else if (status === 'PROCESSING') {
      badgeHtml = '<span class="badge badge-proc">&#9203; gen...</span>';
    } else if (status === 200 || status === 'processing') {
      badgeHtml = '<span class="badge badge-proc">&#9203; sent</span>';
    } else {
      badgeHtml = '<span class="badge badge-proc">&#9203; sent</span>';
    }

    const errorDisplay = error
      ? `<td class="td-error" title="${escHtml(error)}">${escHtml(truncate(error, 28))}</td>`
      : `<td class="td-error empty">—</td>`;

    return `<tr>
      <td class="td-id" data-request-id="${escHtml(entry.id || '')}">${escHtml(shortId)}</td>
      <td class="td-type">${escHtml(type)}</td>
      <td class="td-time">${escHtml(time)}</td>
      <td>${badgeHtml}</td>
      ${errorDisplay}
    </tr>`;
  });

  tbody.innerHTML = rows.join('');

  // Attach click handlers to ID cells
  tbody.querySelectorAll('.td-id[data-request-id]').forEach(td => {
    td.addEventListener('click', () => {
      const reqId = td.getAttribute('data-request-id');
      if (reqId) showRequestDetail(reqId);
    });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str || str.length <= len) return str;
  return str.slice(0, len) + '…';
}

// ── Request detail modal ────────────────────────────────────

let _logEntries = [];

function showRequestDetail(reqId) {
  const entry = _logEntries.find(e => e.id === reqId);
  if (!entry) return;

  const overlay = document.getElementById('detail-overlay');
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');

  title.textContent = `Request ${String(reqId).slice(0, 12)}`;

  const fields = [
    ['ID', entry.id],
    ['Type', formatType(entry.type || entry.method)],
    ['Time', formatTime(entry.time || entry.timestamp || entry.createdAt)],
    ['Status', entry.status || entry.state || 'pending'],
    ['HTTP', entry.httpStatus || '—'],
    ['URL', entry.url || '—'],
    ['Payload', entry.payloadSummary || '—'],
    ['Response', entry.responseSummary || '—'],
    ['Error', entry.error || '—'],
  ];

  body.innerHTML = fields.map(([label, value]) => {
    let cls = 'detail-value';
    if (label === 'Error' && value && value !== '—') cls += ' error';
    if (label === 'Status' && (value === 'COMPLETED' || value === 'success')) cls += ' ok';
    return `<div class="detail-row">
      <div class="detail-label">${escHtml(label)}</div>
      <div class="${cls}">${escHtml(String(value || '—'))}</div>
    </div>`;
  }).join('');

  overlay.classList.add('open');
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-overlay').classList.remove('open');
});

document.getElementById('detail-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
  }
});

// ── Initial data fetch ───────────────────────────────────────

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (data) => {
    if (chrome.runtime.lastError) return;
    updateStatus(data);
  });
}

function fetchLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG' }, (data) => {
    if (chrome.runtime.lastError) return;
    if (data && data.log) updateRequestLog(data.log);
  });
}

// ── Message listener (push updates) ─────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') {
    fetchStatus();
  }
  if (msg.type === 'REQUEST_LOG_UPDATE') {
    if (msg.log) updateRequestLog(msg.log);
  }
});

// ── Toggle (connect / disconnect) ───────────────────────────

document.getElementById('main-toggle').addEventListener('change', (e) => {
  const msgType = e.target.checked ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type: msgType }, () => {
    if (chrome.runtime.lastError) return;
    setTimeout(fetchStatus, 400);
  });
});

// ── Action buttons ───────────────────────────────────────────

document.getElementById('btn-flow').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' }, () => {
    if (chrome.runtime.lastError) return;
  });
});

document.getElementById('btn-token').addEventListener('click', () => {
  const btn = document.getElementById('btn-token');
  btn.textContent = 'Opening...';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
    btn.textContent = 'Refresh Token';
    btn.disabled = false;
  });
});

// ── Init ─────────────────────────────────────────────────────

// ── Chat ─────────────────────────────────────────────────────

const API_BASE = 'http://127.0.0.1:8100';
let chatMessages = [];
let chatStreaming = false;
let availableSkills = [];

// Hardcoded fallback — covers all commands when API server isn't running
const FALLBACK_SKILLS = [
  "fk-add-material","fk-brand-logo","fk-camera-guide","fk-change-model",
  "fk-concat","fk-concat-fit-narrator","fk-create-project","fk-creative-mix",
  "fk-dashboard","fk-doctor","fk-fix-uuids","fk-gen-chain-videos",
  "fk-gen-images","fk-gen-music","fk-gen-narrator","fk-gen-refs",
  "fk-gen-text-overlays","fk-gen-tts-template","fk-gen-videos",
  "fk-import-voice","fk-insert-scene","fk-monitor","fk-pipeline",
  "fk-refresh-urls","fk-research","fk-review-board","fk-review-video",
  "fk-status","fk-switch-project","fk-thumbnail","fk-thumbnail-guide",
  "fk-upload-image","fk-youtube-seo","fk-youtube-upload",
].map(name => ({ name, usage: `/${name}`, file: "" }));

async function loadChatModels() {
  const select = document.getElementById('chat-model');
  try {
    const resp = await fetch(`${API_BASE}/api/models/chat`);
    if (!resp.ok) return;
    const data = await resp.json();
    const models = data.models || [];
    select.innerHTML = '';
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'gpt-4o-mini';
      opt.textContent = 'gpt-4o-mini';
      select.appendChild(opt);
      return;
    }
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = `${m.provider}/${m.alias}`;
      opt.textContent = `[${m.provider}] ${m.alias}`;
      select.appendChild(opt);
    });
  } catch {
    select.innerHTML = `
      <option value="gpt-4o-mini">gpt-4o-mini</option>
      <option value="gpt-4o">gpt-4o</option>
    `;
  }
}

async function loadSkills() {
  try {
    const resp = await fetch(`${API_BASE}/api/skills`);
    if (!resp.ok) throw new Error('not ok');
    const data = await resp.json();
    availableSkills = Array.isArray(data) && data.length > 0 ? data : FALLBACK_SKILLS;
  } catch {
    availableSkills = FALLBACK_SKILLS;
  }
}

function scrollChatToBottom() {
  const el = document.getElementById('chat-messages');
  el.scrollTop = el.scrollHeight;
}

function formatMarkdownLite(text) {
  let s = escHtml(text);
  // Bold: **text**
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Inline code: `text`
  s = s.replace(/`([^`]+)`/g, '<code style="background:rgba(59,130,246,0.15);padding:1px 4px;border-radius:3px;font-size:9px">$1</code>');
  // Bullet points: lines starting with • or -
  s = s.replace(/^(\s*[•\-]\s+)/gm, '<span style="color:var(--accent)">$1</span>');
  return s;
}

function renderChat() {
  const container = document.getElementById('chat-messages');
  if (chatMessages.length === 0) {
    container.innerHTML = '<div class="chat-empty">Type <span style="color:var(--accent)">/</span> for commands, or ask anything...</div>';
    return;
  }
  container.innerHTML = chatMessages.map((msg) => {
    const isCommand = msg.role === 'user' && /^\/fk[- ]/.test((msg.content || '').trim());
    const roleClass = msg.role === 'user' ? 'user' : msg.error ? 'error' : 'assistant';
    const roleLabel = msg.role === 'user' ? (isCommand ? '⚡ Command' : 'You') : msg.error ? 'Error' : 'Assistant';
    const bubble = msg.role === 'assistant'
      ? formatMarkdownLite(msg.content || (msg.error ? msg.error : ''))
      : escHtml(msg.content || (msg.error ? msg.error : ''));
    return `<div class="chat-msg ${roleClass}${isCommand ? ' command' : ''}">
      <div class="chat-role">${escHtml(roleLabel)}</div>
      <div class="chat-bubble">${bubble}</div>
    </div>`;
  }).join('');
  scrollChatToBottom();
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const text = input.value.trim();
  if (!text || chatStreaming) return;
  const isCommand = /^\/fk[- ]/.test(text.trim()) || text.trim() === '/fk' || text.trim() === '/fk-list';

  // Track skill usage on send
  const skillMatch = text.trim().match(/^\/([\w-]+)/);
  if (skillMatch) saveSkillUsage(skillMatch[1]);

  // Add user message
  chatMessages.push({ role: 'user', content: text });
  renderChat();
  input.value = '';
  hideSkillDropdown();

  // Build outgoing messages BEFORE adding assistant placeholder
  const outMessages = chatMessages
    .filter(m => !m.error && m.role && m.content)
    .map(m => ({ role: m.role, content: m.content }));

  // Add placeholder for assistant (after building outMessages)
  const placeholderIdx = chatMessages.length;
  chatMessages.push({ role: 'assistant', content: '' });
  chatStreaming = true;
  sendBtn.disabled = true;

  const container = document.getElementById('chat-messages');
  const placeholder = document.createElement('div');
  placeholder.className = 'chat-typing';
  placeholder.id = 'chat-typing';
  placeholder.textContent = isCommand ? '⚡ executing skill...' : 'typing...';
  container.appendChild(placeholder);
  scrollChatToBottom();

  try {
    const model = document.getElementById('chat-model').value;
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: outMessages,
        model,
      }),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      chatMessages[placeholderIdx] = { role: 'assistant', error: errData.error || `HTTP ${resp.status}` };
    } else {
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await resp.json();
        chatMessages[placeholderIdx] = { role: 'assistant', content: data.content || '' };
      } else {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        placeholder.textContent = isCommand ? '⚡ skill active — LLM responding...' : 'typing...';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE lines: data: {...}\n\n
          const lines = chunk.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullContent += content;
                chatMessages[placeholderIdx] = { role: 'assistant', content: fullContent };
                // Update only the last bubble
                const bubbles = container.querySelectorAll('.chat-msg.assistant .chat-bubble');
                const last = bubbles[bubbles.length - 1];
                if (last) last.textContent = fullContent;
                scrollChatToBottom();
              }
            } catch { /* skip malformed chunks */ }
          }
        }
        if (!fullContent) {
          chatMessages[placeholderIdx] = { role: 'assistant', error: 'No response received' };
        }
      }
    }
  } catch (e) {
    chatMessages[placeholderIdx] = { role: 'assistant', error: `Connection error: ${e.message}` };
  }

  chatStreaming = false;
  sendBtn.disabled = false;
  const typingEl = document.getElementById('chat-typing');
  if (typingEl) typingEl.remove();
  renderChat();
}

document.getElementById('chat-send').addEventListener('click', sendChat);

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Auto-resize textarea
document.getElementById('chat-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  handleSkillAutocomplete(this.value);
});

// ── Skill autocomplete dropdown ─────────────────────────────

const SKILL_USAGE_KEY = 'fk_skill_usage';

function getSkillUsageCounts() {
  try {
    return JSON.parse(localStorage.getItem(SKILL_USAGE_KEY) || '{}');
  } catch { return {}; }
}

function saveSkillUsage(skillName) {
  try {
    const counts = getSkillUsageCounts();
    counts[skillName] = (counts[skillName] || 0) + 1;
    localStorage.setItem(SKILL_USAGE_KEY, JSON.stringify(counts));
  } catch { /* ignore */ }
}

function buildSkillItems(skills) {
  const counts = getSkillUsageCounts();
  const sorted = skills.slice().sort((a, b) => (counts[b.name] || 0) - (counts[a.name] || 0));
  const pinned = sorted.slice(0, 3).filter(s => (counts[s.name] || 0) > 0);
  const rest = sorted.slice(pinned.length);

  return { pinned, rest, sorted };
}

function renderSkillDropdown(matches, inputText) {
  const dropdown = document.getElementById('skill-dropdown');
  if (!dropdown) return;

  const { pinned, rest } = buildSkillItems(matches);
  const showPinned = pinned.length > 0 && (inputText.trim() === '/' || inputText.trim() === '' || inputText.trim().startsWith('/'));
  const items = showPinned ? [...pinned, ...rest] : rest;

  if (items.length === 0) {
    dropdown.classList.remove('open');
    return;
  }

  const parts = [];

  if (showPinned) {
    parts.push('<div class="skill-section-label">Frequent</div>');
    pinned.forEach((s, i) => {
      parts.push(`<div class="skill-item" data-cmd="/${s.name}" data-skill="${escHtml(s.name)}">
        <span class="skill-rank">${i + 1}</span>
        <span class="skill-cmd">/${escHtml(s.name)}</span>
      </div>`);
    });
    parts.push('<div class="skill-separator"></div>');
    parts.push('<div class="skill-section-label">All commands</div>');
  }

  rest.forEach((s, i) => {
    parts.push(`<div class="skill-item" data-cmd="/${s.name}" data-skill="${escHtml(s.name)}">
      <span class="skill-cmd">/${escHtml(s.name)}</span>
    </div>`);
  });

  dropdown.innerHTML = parts.join('');

  dropdown.querySelectorAll('.skill-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cmd = el.getAttribute('data-cmd');
      const skill = el.getAttribute('data-skill');
      const input = document.getElementById('chat-input');
      input.value = cmd + ' ';
      saveSkillUsage(skill);
      input.focus();
      dropdown.classList.remove('open');
    });
  });

  dropdown.classList.add('open');
}

function handleSkillAutocomplete(text) {
  const dropdown = document.getElementById('skill-dropdown');
  if (!dropdown) return;
  const trimmed = text.trim();

  if (!trimmed.startsWith('/') || availableSkills.length === 0) {
    dropdown.classList.remove('open');
    return;
  }

  const query = trimmed.toLowerCase();
  let matches;

  if (query === '/') {
    matches = availableSkills.slice();
  } else {
    const q = query.startsWith('/') ? query.slice(1) : query;
    const q2 = q.startsWith('fk-') ? q : (q.startsWith('fk') ? 'fk-' + q.slice(2) : q);
    matches = availableSkills.filter(s => {
      const cmd = s.name.toLowerCase();
      return cmd.startsWith(q) || cmd.startsWith(q2) || cmd.includes(q) || cmd.includes(q2);
    }).slice(0, 12);
  }

  renderSkillDropdown(matches, text);
}

function hideSkillDropdown() {
  const dropdown = document.getElementById('skill-dropdown');
  if (dropdown) dropdown.classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchLog();
  loadChatModels();
  loadSkills();
});
