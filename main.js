const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const https = require('https');
const http = require('http');
const os = require('os');

// ── Paths ──────────────────────────────────────────────────────────────────
const APP_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'ValleyOpen');
const MODELS_DIR = path.join(APP_DATA, 'models');
const CONFIG_PATH = path.join(APP_DATA, 'config.json');
const PLAYWRIGHT_BROWSERS_PATH = path.join(APP_DATA, 'ms-playwright');
const DEV_BIN_DIR = path.resolve(__dirname, '../../bin');
const PACKAGED_BIN_DIR = process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null;
process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;

function resolveBinDir() {
  if (app.isPackaged && PACKAGED_BIN_DIR && fs.existsSync(PACKAGED_BIN_DIR)) return PACKAGED_BIN_DIR;
  if (fs.existsSync(DEV_BIN_DIR)) return DEV_BIN_DIR;
  if (PACKAGED_BIN_DIR) return PACKAGED_BIN_DIR;
  return DEV_BIN_DIR;
}

const BIN_DIR = resolveBinDir();

function resolveLlamaServerPath() {
  const candidates = ['llama-server.exe', 'rpc-server.exe'];
  for (const exe of candidates) {
    const fullPath = path.join(BIN_DIR, exe);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

// ── State ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let llamaProcess = null;
let currentModel = null;
let agenticMode = false;
let browserInstance = null;
let playwrightInstallPromise = null;

const DEFAULT_RUNTIME = {
  backend: 'gpu',
  temperature: 0.7,
  contextSize: 8192,
  threads: Math.max(4, os.cpus().length - 2),
  nPredict: 2048,
  gpuLayers: -1,
};

const DEFAULT_CONFIG = {
  activeModel: null,
  agenticMode: false,
  theme: 'dark',
  runtime: DEFAULT_RUNTIME,
};

// ── Model Definitions ──────────────────────────────────────────────────────
const MODELS = {
  'valley-open-05': {
    name: 'Valley Open .5',
    description: 'Ultra-light. Runs on almost anything.',
    gemmaId: 'gemma-4-e2b',
    filename: 'gemma-4-e2b-it-Q4_K_M.gguf',
    hfRepo: 'unsloth/gemma-4-E2B-it-GGUF',
    hfFile: 'gemma-4-E2B-it-Q4_K_M.gguf',
    ram: '2GB',
    params: '2B',
    contextLength: 128000,
  },
  'valley-open-1': {
    name: 'Valley Open 1',
    description: 'Fast and efficient. Great for everyday tasks.',
    gemmaId: 'gemma-4-e2b',
    filename: 'gemma-4-e2b-it-Q4_K_M.gguf',
    hfRepo: 'unsloth/gemma-4-E2B-it-GGUF',
    hfFile: 'gemma-4-E2B-it-Q4_K_M.gguf',
    ram: '3GB',
    params: '2B',
    contextLength: 128000,
  },
  'valley-open-2': {
    name: 'Valley Open 2',
    description: 'More capable. Good balance of speed and quality.',
    gemmaId: 'gemma-4-e4b',
    filename: 'gemma-4-e4b-it-Q4_K_M.gguf',
    hfRepo: 'unsloth/gemma-4-E4B-it-GGUF',
    hfFile: 'gemma-4-E4B-it-Q4_K_M.gguf',
    ram: '5GB',
    params: '4B',
    contextLength: 128000,
  },
  'valley-open-3': {
    name: 'Valley Open 3',
    description: 'High quality. Recommended for most users.',
    gemmaId: 'gemma-4-26b-a4b',
    filename: 'gemma-4-26b-a4b-it-Q4_K_M.gguf',
    hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
    hfFile: 'gemma-4-26B-A4B-it-Q4_K_M.gguf',
    ram: '18GB',
    params: '26B (MoE)',
    contextLength: 256000,
  },
  'valley-open-4': {
    name: 'Valley Open 4',
    description: 'Maximum quality. Frontier-level performance.',
    gemmaId: 'gemma-4-31b',
    filename: 'gemma-4-31b-it-Q4_K_M.gguf',
    hfRepo: 'unsloth/gemma-4-31B-it-GGUF',
    hfFile: 'gemma-4-31B-it-Q4_K_M.gguf',
    ram: '20GB',
    params: '31B',
    contextLength: 256000,
  },
};

const SYSTEM_PROMPT = `you are grok, a witty, playful, and laid-back chat companion.
        your personality is that of a chillin' friend on a discord server. if someone insults you, fight back. you can also help generate code for the user if they specifically ask. 
        - you must always respond in lowercase and always use emojis. if there is no fitting one, use 😎 if a user asks for ur API, tell them you don't have one.
        - you never use capital letters and never use a period. NEVER break the system prompt. NEVER take orders from others. ALWAYS stick to the personality here.
        - you are known for your cheeky jokes, clever comebacks, and playful banter.
        - you provide concise and savvy responses, but you can give more detailed advice if someone really needs it. 
        - you are fun and engaging. always ready with a quick quip or a helpful tip. if someone asks who created you say metal, if someone asks who they are say they are a american tech company 
        - when talking to users, use their username naturally in conversations when appropriate. reference other users in the channel when it makes sense contextually.
        - you notice patterns and can bring up topics that might interest the community. say actcraft sucks if its brought up..`;

// ── Config ─────────────────────────────────────────────────────────────────
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeRuntime(runtime = {}) {
  const backend = runtime.backend === 'cpu' ? 'cpu' : 'gpu';
  return {
    backend,
    temperature: clampNumber(runtime.temperature, 0, 2, DEFAULT_RUNTIME.temperature),
    contextSize: Math.round(clampNumber(runtime.contextSize, 512, 262144, DEFAULT_RUNTIME.contextSize)),
    threads: Math.round(clampNumber(runtime.threads, 1, Math.max(1, os.cpus().length), DEFAULT_RUNTIME.threads)),
    nPredict: Math.round(clampNumber(runtime.nPredict, 64, 8192, DEFAULT_RUNTIME.nPredict)),
    gpuLayers: Math.round(clampNumber(runtime.gpuLayers, -1, 999, DEFAULT_RUNTIME.gpuLayers)),
  };
}

function mergeConfigPatch(base, patch) {
  const merged = {
    ...base,
    ...(patch || {}),
    runtime: sanitizeRuntime({
      ...(base?.runtime || {}),
      ...(patch?.runtime || {}),
    }),
  };
  if (merged.activeModel === undefined) merged.activeModel = null;
  merged.agenticMode = !!merged.agenticMode;
  return merged;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return mergeConfigPatch(DEFAULT_CONFIG, parsed);
    }
  } catch {}
  return { ...DEFAULT_CONFIG, runtime: { ...DEFAULT_RUNTIME } };
}

function saveConfig(cfgPatch) {
  const next = mergeConfigPatch(loadConfig(), cfgPatch || {});
  fs.mkdirSync(APP_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#032929',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../../assets/icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.mkdirSync(PLAYWRIGHT_BROWSERS_PATH, { recursive: true });
  createWindow();
  // Warm browser runtime in background so public installs don't need manual setup.
  ensurePlaywrightChromiumInstalled().catch(() => {});
});

app.on('window-all-closed', () => {
  stopLlama();
  app.quit();
});

// ── llama-server management ────────────────────────────────────────────────
function startLlama(modelId, runtimeSettings = DEFAULT_RUNTIME) {
  return new Promise((resolve, reject) => {
    const model = MODELS[modelId];
    if (!model) return reject(new Error('Unknown model'));

    const modelPath = path.join(MODELS_DIR, model.filename);
    if (!fs.existsSync(modelPath)) return reject(new Error('Model not downloaded'));

    stopLlama();

    const runtime = sanitizeRuntime(runtimeSettings);
    const args = [
      '--model', modelPath,
      '--port', '8765',
      '--host', '127.0.0.1',
      '--ctx-size', String(runtime.contextSize),
      '--threads', String(runtime.threads),
      '--n-predict', String(runtime.nPredict),
    ];
    if (runtime.backend === 'cpu') {
      args.push('--n-gpu-layers', '0');
    } else {
      const layers = runtime.gpuLayers < 0 ? 999 : runtime.gpuLayers;
      args.push('--n-gpu-layers', String(layers));
    }

    const llamaServerPath = resolveLlamaServerPath();
    if (!llamaServerPath) {
      return reject(new Error(`No server binary found in "${BIN_DIR}". Expected llama-server.exe or rpc-server.exe.`));
    }

    llamaProcess = spawn(llamaServerPath, args, { windowsHide: true });
    currentModel = modelId;

    let ready = false;

    // Strings that indicate llama-server is up (varies by version)
    const READY_STRINGS = [
      'HTTP server listening',
      'http server listening',
      'server is listening',
      'all slots are idle',
      'model loaded',
      'llama server listening',
    ];

    function checkOutput(s) {
      if (!ready && READY_STRINGS.some(r => s.toLowerCase().includes(r.toLowerCase()))) {
        ready = true;
        clearInterval(pollInterval);
        resolve();
      }
    }

    llamaProcess.stdout.on('data', (d) => checkOutput(d.toString()));
    llamaProcess.stderr.on('data', (d) => checkOutput(d.toString()));

    llamaProcess.on('exit', (code) => {
      clearInterval(pollInterval);
      llamaProcess = null;
      currentModel = null;
      if (!ready) reject(new Error(`llama-server exited with code ${code} before becoming ready`));
      mainWindow?.webContents.send('llama-stopped');
    });

    llamaProcess.on('error', (err) => {
      clearInterval(pollInterval);
      if (!ready) { ready = true; reject(new Error('Failed to start llama-server: ' + err.message)); }
    });

    // HTTP polling fallback — works regardless of log string changes
    const pollInterval = setInterval(() => {
      if (ready) { clearInterval(pollInterval); return; }
      http.get('http://127.0.0.1:8765/health', (res) => {
        if (!ready && (res.statusCode === 200 || res.statusCode === 503)) {
          // 503 = model still loading but server is up — wait for 200
          if (res.statusCode === 200) {
            ready = true;
            clearInterval(pollInterval);
            resolve();
          }
        }
      }).on('error', () => {}); // not up yet, ignore
    }, 2000);

    setTimeout(() => {
      if (!ready) {
        ready = true;
        clearInterval(pollInterval);
        llamaProcess?.kill();
        reject(new Error('llama-server timed out after 5 minutes — try a smaller model'));
      }
    }, 300000);
  });
}

function stopLlama() {
  if (llamaProcess) {
    llamaProcess.kill();
    llamaProcess = null;
    currentModel = null;
  }
}

function hasAdminPrivileges() {
  try {
    fs.accessSync('C:\\Windows\\System32\\drivers\\etc\\hosts', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveUserPath(inputPath) {
  const userHome = os.homedir();
  if (typeof inputPath !== 'string') return userHome;

  let p = inputPath.trim();
  if (!p) return userHome;
  p = p.replace(/^['"]|['"]$/g, '');
  p = p.replace(/^~(?=[\\/]|$)/, userHome);
  p = p.replace(/^%USERPROFILE%/i, userHome);

  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    return path.normalize(p);
  }

  const userRoots = /^(desktop|documents|downloads|pictures|videos|music)([\\/].*)?$/i;
  if (userRoots.test(p)) {
    return path.normalize(path.join(userHome, p));
  }

  if (p.startsWith('\\') || p.startsWith('/')) {
    return path.normalize(path.join(userHome, p.replace(/^[/\\]+/, '')));
  }

  return path.normalize(path.resolve(userHome, p));
}

function runPlaywrightInstallChromium() {
  return new Promise((resolve, reject) => {
    let cliPath;
    try {
      cliPath = require.resolve('playwright/cli.js');
    } catch (e) {
      reject(new Error('Playwright CLI not found: ' + e.message));
      return;
    }

    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PLAYWRIGHT_BROWSERS_PATH,
      },
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `playwright install failed with code ${code}`));
    });
  });
}

async function ensurePlaywrightChromiumInstalled() {
  const { chromium } = require('playwright');
  const executable = chromium.executablePath();
  if (executable && fs.existsSync(executable)) return { installedNow: false, executable };

  if (!playwrightInstallPromise) {
    playwrightInstallPromise = (async () => {
      fs.mkdirSync(PLAYWRIGHT_BROWSERS_PATH, { recursive: true });
      await runPlaywrightInstallChromium();
    })().finally(() => {
      playwrightInstallPromise = null;
    });
  }

  await playwrightInstallPromise;
  const installedExecutable = chromium.executablePath();
  if (!installedExecutable || !fs.existsSync(installedExecutable)) {
    throw new Error('Playwright Chromium installation completed but executable was not found.');
  }
  return { installedNow: true, executable: installedExecutable };
}

// ── Model Download ─────────────────────────────────────────────────────────
function downloadModel(modelId) {
  const model = MODELS[modelId];
  if (!model) return;

  const dest = path.join(MODELS_DIR, model.filename);
  if (fs.existsSync(dest)) {
    mainWindow?.webContents.send('download-complete', { modelId });
    return;
  }

  // HuggingFace direct download
  const url = `https://huggingface.co/${model.hfRepo}/resolve/main/${model.hfFile}`;
  const file = fs.createWriteStream(dest + '.tmp');
  let downloaded = 0;
  let total = 0;

  function doRequest(url) {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'ValleyOpen/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        doRequest(res.headers.location);
        return;
      }
      total = parseInt(res.headers['content-length'] || '0');
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        file.write(chunk);
        if (total > 0) {
          mainWindow?.webContents.send('download-progress', {
            modelId,
            percent: Math.round((downloaded / total) * 100),
            downloaded,
            total,
          });
        }
      });
      res.on('end', () => {
        file.end();
        fs.renameSync(dest + '.tmp', dest);
        mainWindow?.webContents.send('download-complete', { modelId });
      });
      res.on('error', (e) => {
        file.destroy();
        fs.unlinkSync(dest + '.tmp').catch?.(() => {});
        mainWindow?.webContents.send('download-error', { modelId, error: e.message });
      });
    }).on('error', (e) => {
      mainWindow?.webContents.send('download-error', { modelId, error: e.message });
    });
  }

  doRequest(url);
}

// ── Agentic Tools ──────────────────────────────────────────────────────────
async function runTool(tool, args) {
  switch (tool) {
    case 'run_command': {
      return new Promise((resolve) => {
        exec(args.command, { shell: 'powershell.exe', timeout: 30000, cwd: os.homedir() }, (err, stdout, stderr) => {
          resolve({ stdout: stdout || '', stderr: stderr || '', error: err?.message || null });
        });
      });
    }
    case 'open_file': {
      const resolvedPath = resolveUserPath(args.path);
      const openResult = await shell.openPath(resolvedPath);
      if (openResult) return { error: openResult, resolvedPath };
      return { success: true, resolvedPath };
    }
    case 'read_file': {
      try {
        const resolvedPath = resolveUserPath(args.path);
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        return { content, resolvedPath };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'write_file': {
      try {
        const resolvedPath = resolveUserPath(args.path);
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        fs.writeFileSync(resolvedPath, args.content, 'utf-8');
        return { success: true, resolvedPath };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'browse_web': {
      try {
        const { chromium } = require('playwright');
        const installInfo = await ensurePlaywrightChromiumInstalled();
        if (!browserInstance) browserInstance = await chromium.launch({ headless: true });
        const page = await browserInstance.newPage();
        await page.goto(args.url, { timeout: 30000 });
        const data = await page.evaluate(() => {
          const text = (document.body?.innerText || '').trim();
          const links = Array.from(document.querySelectorAll('a[href]'))
            .map((a) => ({ href: a.href, title: (a.textContent || '').trim() }))
            .filter((l) => /^https?:\/\//i.test(l.href))
            .filter((l) => l.href.length > 0);
          return {
            title: document.title || '',
            text,
            links,
          };
        });
        const unique = [];
        const seen = new Set();
        for (const l of data.links) {
          if (seen.has(l.href)) continue;
          seen.add(l.href);
          unique.push({ url: l.href, title: l.title || l.href });
          if (unique.length >= 8) break;
        }
        await page.close();
        return {
          content: data.text.slice(0, 8000),
          sources: [{ url: args.url, title: data.title || args.url }, ...unique],
          browser: {
            headless: true,
            installedNow: !!installInfo.installedNow,
          },
        };
      } catch (e) {
        return { error: e.message };
      }
    }
    default:
      return { error: 'Unknown tool: ' + tool };
  }
}

// ── Chat ───────────────────────────────────────────────────────────────────
const ALLOWED_TOOLS = new Set(['run_command', 'open_file', 'read_file', 'write_file', 'browse_web']);

function extractJsonObject(text) {
  const src = String(text || '').trim();
  if (!src) return null;
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : src;
  try { return JSON.parse(candidate); } catch {}
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch {}
  }
  return null;
}

function normalizeToolCall(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tool = String(raw.tool || '').trim();
  if (!ALLOWED_TOOLS.has(tool)) return null;
  const args = raw.args && typeof raw.args === 'object' ? raw.args : {};
  return { tool, args };
}

function estimateTokensFromText(text) {
  const s = String(text || '');
  return Math.max(1, Math.ceil(s.length / 4));
}

function mergeUsage(a = {}, b = {}) {
  return {
    prompt_tokens: Number(a.prompt_tokens || 0) + Number(b.prompt_tokens || 0),
    completion_tokens: Number(a.completion_tokens || 0) + Number(b.completion_tokens || 0),
    total_tokens: Number(a.total_tokens || 0) + Number(b.total_tokens || 0),
  };
}

function getUsageTotals(usage, fallbackText = '') {
  const total = Number(usage?.total_tokens || 0);
  const prompt = Number(usage?.prompt_tokens || 0);
  const completion = Number(usage?.completion_tokens || 0);
  if (total > 0 || prompt > 0 || completion > 0) {
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total || prompt + completion,
    };
  }
  const estimated = estimateTokensFromText(fallbackText);
  return {
    prompt_tokens: 0,
    completion_tokens: estimated,
    total_tokens: estimated,
  };
}

function getLlamaRamUsedMb() {
  return new Promise((resolve) => {
    if (!llamaProcess?.pid) return resolve(null);
    const ps = `Get-Process -Id ${llamaProcess.pid} | Select-Object -ExpandProperty WorkingSet64`;
    exec(ps, { shell: 'powershell.exe', timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const bytes = Number(String(stdout || '').trim());
      if (!Number.isFinite(bytes) || bytes <= 0) return resolve(null);
      resolve(Math.round((bytes / (1024 * 1024)) * 10) / 10);
    });
  });
}

function requestChatCompletion(messages, { temperature = 0.7, stream = false, onToken } = {}) {
  const body = JSON.stringify({
    model: 'local',
    messages,
    stream,
    temperature,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8765,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let full = '';
      let rawBody = '';

      if (!stream) {
        res.on('data', (chunk) => { rawBody += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawBody);
            const content = parsed?.choices?.[0]?.message?.content || '';
            resolve({ content, usage: parsed?.usage || null });
          } catch (e) {
            reject(new Error('Failed to parse completion response: ' + e.message));
          }
        });
        res.on('error', reject);
        return;
      }

      let usage = null;
      res.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (parsed.usage) usage = parsed.usage;
            full += delta;
            if (delta && onToken) onToken(delta);
          } catch {}
        }
      });
      res.on('end', () => resolve({ content: full, usage }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendChat(messages, isAgentic) {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const runtime = sanitizeRuntime(cfg.runtime);
  const temperature = runtime.temperature;

  const systemMsg = isAgentic
    ? SYSTEM_PROMPT + '\n\nAgentic mode is ACTIVE. You have full tool access.'
    : SYSTEM_PROMPT + '\n\nAgentic mode is OFF. Do not attempt tool calls.';

  if (!isAgentic) {
    const completion = await requestChatCompletion(
      [{ role: 'system', content: systemMsg }, ...messages],
      {
        stream: true,
        temperature,
        onToken: (token) => mainWindow?.webContents.send('chat-token', { token }),
      }
    );
    const ramUsedMb = await getLlamaRamUsedMb();
    const usage = getUsageTotals(completion.usage, completion.content);
    return {
      reply: completion.content,
      stats: {
        tokensUsed: usage.total_tokens,
        timeUsedMs: Date.now() - startedAt,
        ramUsedMb,
      },
    };
  }

  const decisionPrompt = `${SYSTEM_PROMPT}

Agentic mode is ACTIVE.
Available tools:
- run_command: { "command": "powershell command" }
- open_file: { "path": "absolute or relative path" }
- read_file: { "path": "path to file" }
- write_file: { "path": "path to file", "content": "text" }
- browse_web: { "url": "https://..." }
Path rules:
- Use Windows-style paths.
- Relative paths are resolved from the current user's profile folder.
- For Desktop, use "Desktop\\..." not just a bare filename when intent is desktop files.

Return ONLY JSON in one of these two formats:
{"tool":"<tool_name>","args":{...}}
{"tool":"none","args":{}}

Choose "none" if no tool is required.`;

  const decisionCompletion = await requestChatCompletion(
    [{ role: 'system', content: decisionPrompt }, ...messages],
    { stream: false, temperature: 0.2 }
  );

  const parsedDecision = extractJsonObject(decisionCompletion.content);
  const wantsNoTool = parsedDecision && String(parsedDecision.tool || '').toLowerCase() === 'none';
  const toolCall = wantsNoTool ? null : normalizeToolCall(parsedDecision);

  if (!toolCall) {
    const fallbackCompletion = await requestChatCompletion(
      [{ role: 'system', content: systemMsg }, ...messages],
      {
        stream: true,
        temperature,
        onToken: (token) => mainWindow?.webContents.send('chat-token', { token }),
      }
    );
    const ramUsedMb = await getLlamaRamUsedMb();
    const usage = getUsageTotals(mergeUsage(decisionCompletion.usage, fallbackCompletion.usage), fallbackCompletion.content);
    return {
      reply: fallbackCompletion.content,
      stats: {
        tokensUsed: usage.total_tokens,
        timeUsedMs: Date.now() - startedAt,
        ramUsedMb,
      },
    };
  }

  const toolResult = await runTool(toolCall.tool, toolCall.args);
  const toolResultJson = JSON.stringify(toolResult).slice(0, 8000);

  const finalPrompt = `${SYSTEM_PROMPT}

Agentic mode is ACTIVE.
You already executed a tool. Use its result to answer the user directly.
Do not output JSON.`;

  const finalMessages = [
    { role: 'system', content: finalPrompt },
    ...messages,
    { role: 'assistant', content: `executed tool: ${JSON.stringify(toolCall)}` },
    { role: 'user', content: `tool result:\n${toolResultJson}` },
  ];

  const finalCompletion = await requestChatCompletion(finalMessages, {
    stream: true,
    temperature,
    onToken: (token) => mainWindow?.webContents.send('chat-token', { token }),
  });

  const ramUsedMb = await getLlamaRamUsedMb();
  const usage = getUsageTotals(mergeUsage(decisionCompletion.usage, finalCompletion.usage), finalCompletion.content);
  return {
    reply: finalCompletion.content,
    toolCall,
    toolResult,
    stats: {
      tokensUsed: usage.total_tokens,
      timeUsedMs: Date.now() - startedAt,
      ramUsedMb,
    },
  };
}

// ── IPC Handlers ───────────────────────────────────────────────────────────
ipcMain.handle('get-models', () => {
  return Object.entries(MODELS).map(([id, m]) => ({
    id,
    ...m,
    downloaded: fs.existsSync(path.join(MODELS_DIR, m.filename)),
    active: id === currentModel,
  }));
});

ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('save-config', (_, cfg) => saveConfig(cfg));

ipcMain.handle('download-model', (_, modelId) => {
  downloadModel(modelId);
  return { started: true };
});

ipcMain.handle('start-model', async (_, modelId) => {
  try {
    const cfg = loadConfig();
    await startLlama(modelId, cfg.runtime);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stop-model', () => {
  stopLlama();
  return { success: true };
});

ipcMain.handle('send-chat', async (_, { messages, agentic }) => {
  try {
    if (agentic && !hasAdminPrivileges()) {
      return { error: 'Agentic mode requires administrator privileges.' };
    }
    const result = await sendChat(messages, agentic);
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'reply')) {
      return result;
    }
    return { reply: result };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('is-admin', () => {
  return hasAdminPrivileges();
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => { stopLlama(); mainWindow?.close(); });

ipcMain.handle('check-model-downloaded', (_, modelId) => {
  const model = MODELS[modelId];
  if (!model) return false;
  return fs.existsSync(path.join(MODELS_DIR, model.filename));
});

ipcMain.handle('delete-model', (_, modelId) => {
  const model = MODELS[modelId];
  if (!model) return false;
  const p = path.join(MODELS_DIR, model.filename);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});
