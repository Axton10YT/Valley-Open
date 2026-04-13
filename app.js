/* Valley Open — Renderer */

// system prompt is internal — not exposed to the renderer

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  page: 'chat',
  models: [],
  activeModel: null,
  modelRunning: false,
  agentic: false,
  runtime: {
    backend: 'gpu',
    temperature: 0.7,
    contextSize: 8192,
    threads: Math.max(4, (navigator.hardwareConcurrency || 8) - 2),
    nPredict: 2048,
    gpuLayers: -1,
  },
  isAdmin: false,
  messages: [],      // { role, content }
  streaming: false,
  downloadProgress: {}, // modelId -> percent
};

const RUNTIME_DEFAULTS = {
  backend: 'gpu',
  temperature: 0.7,
  contextSize: 8192,
  threads: Math.max(4, (navigator.hardwareConcurrency || 8) - 2),
  nPredict: 2048,
  gpuLayers: -1,
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeRuntime(runtime = {}) {
  const backend = runtime.backend === 'cpu' ? 'cpu' : 'gpu';
  return {
    backend,
    temperature: clampNumber(runtime.temperature, 0, 2, RUNTIME_DEFAULTS.temperature),
    contextSize: Math.round(clampNumber(runtime.contextSize, 512, 262144, RUNTIME_DEFAULTS.contextSize)),
    threads: Math.round(clampNumber(runtime.threads, 1, 128, RUNTIME_DEFAULTS.threads)),
    nPredict: Math.round(clampNumber(runtime.nPredict, 64, 8192, RUNTIME_DEFAULTS.nPredict)),
    gpuLayers: Math.round(clampNumber(runtime.gpuLayers, -1, 999, RUNTIME_DEFAULTS.gpuLayers)),
  };
}

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

// ── Navigation ─────────────────────────────────────────────────────────────
function setPage(name) {
  state.page = name;
  navItems.forEach(n => n.classList.toggle('active', n.dataset.page === name));
  pages.forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  if (name === 'models') renderModels();
  if (name === 'settings') renderSettings();
}

navItems.forEach(n => n.addEventListener('click', () => setPage(n.dataset.page)));

// ── Titlebar ───────────────────────────────────────────────────────────────
$('btn-minimize').addEventListener('click', () => window.valley.windowMinimize());
$('btn-maximize').addEventListener('click', () => window.valley.windowMaximize());
$('btn-close').addEventListener('click', () => window.valley.windowClose());

// ── Status pill ────────────────────────────────────────────────────────────
function updateStatus() {
  const dot = document.querySelector('.status-dot');
  const label = $('status-label');
  const agenticWrap = $('agentic-wrap');

  if (state.modelRunning) {
    const m = state.models.find(m => m.active) || state.models.find(m => m.id === state.activeModel);
    dot.className = 'status-dot running';
    label.textContent = m ? m.name : 'Running';
    agenticWrap.style.display = 'flex';
  } else {
    dot.className = 'status-dot';
    label.textContent = 'No model loaded';
    agenticWrap.style.display = 'none';
  }
}

// ── Agentic toggle ─────────────────────────────────────────────────────────
$('agentic-toggle').addEventListener('change', (e) => {
  if (e.target.checked && !state.isAdmin) {
    e.target.checked = false;
    alert('Agentic mode requires admin privileges. Run Valley Open as Administrator.');
    return;
  }
  state.agentic = e.target.checked;
  window.valley.saveConfig({
    activeModel: state.activeModel,
    agenticMode: state.agentic,
    runtime: state.runtime,
  });
});

// ── Chat ───────────────────────────────────────────────────────────────────
const chatEmpty = $('chat-empty');
const chatMessages = $('chat-messages');
const chatInputWrap = $('chat-input-wrap');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');
const currentModelLabel = $('current-model-label');

function showChatReady() {
  chatEmpty.style.display = 'none';
  chatMessages.style.display = 'flex';
  chatInputWrap.style.display = 'block';
  sendBtn.disabled = false;
  const m = state.models.find(m => m.id === state.activeModel);
  currentModelLabel.textContent = m ? m.name : 'Valley';
}

function showChatEmpty(msg) {
  chatEmpty.style.display = 'flex';
  chatMessages.style.display = 'none';
  chatInputWrap.style.display = 'none';
  $('empty-sub').textContent = msg || 'Load a model to start chatting.';
}

$('empty-load-btn').addEventListener('click', () => setPage('models'));

// Auto-resize textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled && chatInput.value.trim()) sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

function appendMsg(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `
    <div class="msg-role">${role === 'user' ? 'You' : 'Valley'}</div>
    <div class="msg-bubble">${escapeHtml(content)}</div>
  `;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return { wrap, bubble: wrap.querySelector('.msg-bubble') };
}

function appendTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.id = 'typing-wrap';
  wrap.innerHTML = `
    <div class="msg-role">Valley</div>
    <div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
  `;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

function appendStreamBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="msg-role">Valley</div><div class="msg-bubble"></div>`;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return { wrap, bubble: wrap.querySelector('.msg-bubble') };
}

function formatStats(stats = {}) {
  const tokens = Number(stats.tokensUsed || 0);
  const timeMs = Number(stats.timeUsedMs || 0);
  const ramMb = Number(stats.ramUsedMb);
  const timeText = timeMs > 0 ? `${(timeMs / 1000).toFixed(2)}s` : '—';
  const ramText = Number.isFinite(ramMb) && ramMb > 0 ? `${ramMb.toFixed(1)} MB` : '—';
  return `Tokens used: ${tokens || '—'} · Time used: ${timeText} · RAM used: ${ramText}`;
}

function appendMsgStats(wrap, stats) {
  if (!wrap || !stats) return;
  let el = wrap.querySelector('.msg-stats');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg-stats';
    wrap.appendChild(el);
  }
  el.textContent = formatStats(stats);
}

function appendSources(wrap, sources) {
  if (!wrap || !Array.isArray(sources) || sources.length === 0) return;
  const valid = sources.filter((s) => s && typeof s.url === 'string' && s.url.trim());
  if (valid.length === 0) return;

  let block = wrap.querySelector('.msg-sources');
  if (!block) {
    block = document.createElement('div');
    block.className = 'msg-sources';
    wrap.appendChild(block);
  }

  const links = valid.slice(0, 6).map((s) => {
    const title = escapeHtml(String(s.title || s.url));
    const url = escapeHtml(String(s.url));
    return `<a class="msg-source-link" href="${url}" target="_blank" rel="noreferrer">${title}</a>`;
  }).join('<span class="msg-source-sep"> · </span>');

  block.innerHTML = `<span class="msg-sources-label">Sources:</span> ${links}`;
}

function appendToolBlock(toolCall, result) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `
    <div class="msg-role">Valley · Tool</div>
    <div class="tool-block">
      <div class="tool-title">⚡ ${toolCall.tool}</div>
      <pre>${escapeHtml(JSON.stringify(toolCall.args, null, 2))}</pre>
      <div class="tool-title" style="margin-top:8px;color:var(--green)">Result</div>
      <pre>${escapeHtml(JSON.stringify(result, null, 2).slice(0, 1000))}</pre>
    </div>
  `;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || state.streaming) return;

  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;
  state.streaming = true;

  state.messages.push({ role: 'user', content: text });
  appendMsg('user', text);

  const typingWrap = appendTyping();

  // Remove typing, add stream bubble when first token arrives
  let streamWrap = null;
  let streamBubble = null;
  let fullText = '';
  let firstToken = true;

  const tokenHandler = (d) => {
    if (firstToken) {
      firstToken = false;
      typingWrap.remove();
      const streamed = appendStreamBubble();
      streamWrap = streamed.wrap;
      streamBubble = streamed.bubble;
    }
    fullText += d.token;
    streamBubble.textContent = fullText;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };

  const offChatToken = window.valley.onChatToken(tokenHandler);

  try {
    const res = await window.valley.sendChat({
      messages: state.messages,
      agentic: state.agentic,
    });

    typingWrap.remove();

    if (res.error) {
      appendMsg('assistant', `Error: ${res.error}`);
    } else {
      if (!streamBubble) {
        // no streaming happened, show reply directly
        const appended = appendMsg('assistant', res.reply);
        appendMsgStats(appended.wrap, res.stats);
        appendSources(appended.wrap, res.toolResult?.sources);
      } else {
        streamBubble.textContent = res.reply || fullText;
        appendMsgStats(streamWrap, res.stats);
        appendSources(streamWrap, res.toolResult?.sources);
      }

      if (res.toolCall && res.toolResult) {
        appendToolBlock(res.toolCall, res.toolResult);
        state.messages.push({
          role: 'assistant',
          content: res.reply + `\n\n[Tool: ${res.toolCall.tool} → ${JSON.stringify(res.toolResult).slice(0, 200)}]`,
        });
      } else {
        state.messages.push({ role: 'assistant', content: res.reply || fullText });
      }
    }
  } catch (e) {
    typingWrap.remove();
    appendMsg('assistant', `Something went wrong: ${e.message}`);
  } finally {
    offChatToken?.();
  }

  state.streaming = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

// ── Models Page ────────────────────────────────────────────────────────────
function renderModels() {
  const grid = $('models-grid');
  grid.innerHTML = '';

  state.models.forEach(m => {
    const isActive = m.id === state.activeModel && state.modelRunning;
    const inProgress = state.downloadProgress[m.id] !== undefined && state.downloadProgress[m.id] < 100;
    const pct = state.downloadProgress[m.id] || 0;

    const card = document.createElement('div');
    card.className = `model-card${isActive ? ' active-model' : ''}`;
    card.id = `model-card-${m.id}`;

    card.innerHTML = `
      <div class="model-info">
        <div class="model-name">
          ${escapeHtml(m.name)}
          ${isActive ? '<span class="model-badge">Running</span>' : ''}
        </div>
        <div class="model-desc">${escapeHtml(m.description)}</div>
        <div class="model-specs">
          <span>${m.params}</span>
          <span>·</span>
          <span>${m.ram} RAM</span>
          <span>·</span>
          <span>${(m.contextLength / 1000).toFixed(0)}K ctx</span>
        </div>
        ${inProgress ? `
          <div class="progress-bar-wrap">
            <div class="progress-bar-track"><div class="progress-bar-fill" id="pb-${m.id}" style="width:${pct}%"></div></div>
            <div class="progress-label" id="pl-${m.id}">Downloading... ${pct}%</div>
          </div>
        ` : ''}
      </div>
      <div class="model-actions" id="actions-${m.id}">
        ${renderModelActions(m, isActive, inProgress)}
      </div>
    `;

    grid.appendChild(card);
  });
}

function renderModelActions(m, isActive, inProgress) {
  if (inProgress) return `<button class="btn-outline" disabled>Downloading…</button>`;
  if (!m.downloaded) {
    return `<button class="btn-run" onclick="downloadModel('${m.id}')">Download</button>`;
  }
  if (isActive) {
    return `<button class="btn-stop" onclick="stopModel()">Stop</button>`;
  }
  return `
    <button class="btn-outline" onclick="deleteModel('${m.id}')">Delete</button>
    <button class="btn-run" onclick="loadModel('${m.id}')">Load</button>
  `;
}

window.downloadModel = async function(modelId) {
  await window.valley.downloadModel(modelId);
  state.downloadProgress[modelId] = 0;
  renderModels();
};

window.loadModel = async function(modelId) {
  // Update UI to show loading
  const actionsEl = $(`actions-${modelId}`);
  if (actionsEl) actionsEl.innerHTML = `<button class="btn-outline" disabled>Loading…</button>`;
  const dot = document.querySelector('.status-dot');
  dot.className = 'status-dot loading';
  $('status-label').textContent = 'Loading…';

  const res = await window.valley.startModel(modelId);
  if (res.success) {
    state.activeModel = modelId;
    state.modelRunning = true;
    await window.valley.saveConfig({
      activeModel: modelId,
      agenticMode: state.agentic,
      runtime: state.runtime,
    });
    await refreshModels();
    updateStatus();
    showChatReady();
    renderModels();
    setPage('chat');
  } else {
    alert(`Failed to load model: ${res.error}`);
    updateStatus();
    renderModels();
  }
};

window.stopModel = async function() {
  await window.valley.stopModel();
  state.activeModel = null;
  state.modelRunning = false;
  await refreshModels();
  updateStatus();
  showChatEmpty('Model stopped. Load a model to continue.');
  renderModels();
};

window.deleteModel = async function(modelId) {
  if (!confirm('Delete this model file? You can re-download it later.')) return;
  await window.valley.deleteModel(modelId);
  await refreshModels();
  renderModels();
};

// ── Settings Page ──────────────────────────────────────────────────────────
function renderSettings() {
  const adminBox = $('admin-status-box');
  const adminIcon = $('admin-status-icon');
  const adminText = $('admin-status-text');
  if (state.isAdmin) {
    adminIcon.textContent = '✅';
    adminText.textContent = 'Running as Administrator — Agentic mode available';
    adminBox.style.borderColor = 'var(--green)';
  } else {
    adminIcon.textContent = '⚠️';
    adminText.textContent = 'Not running as Administrator — Restart as admin to enable Agentic mode';
    adminBox.style.borderColor = 'var(--yellow)';
  }

  const backendEl = $('setting-backend');
  const temperatureEl = $('setting-temperature');
  const contextEl = $('setting-context-size');
  const threadsEl = $('setting-threads');
  const predictEl = $('setting-n-predict');
  const gpuLayersEl = $('setting-gpu-layers');

  if (backendEl) backendEl.value = state.runtime.backend;
  if (temperatureEl) temperatureEl.value = String(state.runtime.temperature);
  if (contextEl) contextEl.value = String(state.runtime.contextSize);
  if (threadsEl) threadsEl.value = String(state.runtime.threads);
  if (predictEl) predictEl.value = String(state.runtime.nPredict);
  if (gpuLayersEl) {
    gpuLayersEl.value = String(state.runtime.gpuLayers);
    gpuLayersEl.disabled = state.runtime.backend === 'cpu';
  }
}

function readRuntimeFromSettings() {
  const backend = ($('setting-backend')?.value || 'gpu').toLowerCase() === 'cpu' ? 'cpu' : 'gpu';
  return normalizeRuntime({
    backend,
    temperature: $('setting-temperature')?.value,
    contextSize: $('setting-context-size')?.value,
    threads: $('setting-threads')?.value,
    nPredict: $('setting-n-predict')?.value,
    gpuLayers: $('setting-gpu-layers')?.value,
  });
}

$('setting-backend')?.addEventListener('change', () => {
  const gpuLayersEl = $('setting-gpu-layers');
  if (gpuLayersEl) gpuLayersEl.disabled = $('setting-backend').value === 'cpu';
});

$('save-runtime-btn')?.addEventListener('click', async () => {
  state.runtime = readRuntimeFromSettings();
  await window.valley.saveConfig({
    activeModel: state.activeModel,
    agenticMode: state.agentic,
    runtime: state.runtime,
  });
  const hint = $('runtime-save-hint');
  if (hint) {
    hint.textContent = 'Saved. Reload a model to apply backend/thread/context changes.';
    setTimeout(() => {
      if ($('runtime-save-hint')) $('runtime-save-hint').textContent = 'Saved values are used on next model load.';
    }, 2400);
  }
  renderSettings();
});

// ── IPC Events ─────────────────────────────────────────────────────────────
window.valley.onDownloadProgress((d) => {
  state.downloadProgress[d.modelId] = d.percent;
  const pb = $(`pb-${d.modelId}`);
  const pl = $(`pl-${d.modelId}`);
  if (pb) pb.style.width = d.percent + '%';
  if (pl) pl.textContent = `Downloading… ${d.percent}% (${formatBytes(d.downloaded)} / ${formatBytes(d.total)})`;
});

window.valley.onDownloadComplete(async (d) => {
  delete state.downloadProgress[d.modelId];
  await refreshModels();
  if (state.page === 'models') renderModels();
});

window.valley.onDownloadError((d) => {
  delete state.downloadProgress[d.modelId];
  alert(`Download failed for ${d.modelId}: ${d.error}`);
  if (state.page === 'models') renderModels();
});

window.valley.onLlamaStopped(() => {
  state.modelRunning = false;
  state.activeModel = null;
  updateStatus();
  showChatEmpty('Model stopped unexpectedly. Please reload a model.');
  if (state.page === 'models') renderModels();
});

// ── Helpers ────────────────────────────────────────────────────────────────
async function refreshModels() {
  state.models = await window.valley.getModels();
}

function formatBytes(b) {
  if (!b) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  const [models, config, isAdmin] = await Promise.all([
    window.valley.getModels(),
    window.valley.getConfig(),
    window.valley.isAdmin(),
  ]);

  state.models = models;
  state.isAdmin = isAdmin;
  state.agentic = isAdmin ? (config.agenticMode || false) : false;
  state.runtime = normalizeRuntime(config.runtime || {});
  $('agentic-toggle').checked = state.agentic;

  // Check if previously active model is still loaded
  if (config.activeModel) {
    const m = models.find(m => m.id === config.activeModel);
    if (m && m.downloaded) {
      // Don't auto-start — user needs to manually load
    }
  }

  updateStatus();
  showChatEmpty('Load a model to start chatting.');
  renderSettings();
}

init();
