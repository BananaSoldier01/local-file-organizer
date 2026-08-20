/**
 * app.js — 前端主逻辑 (V0.2)
 *
 * 单工作区架构：Browse → Understand → Review → Organize
 * 不再使用 Wizard 式跳页。
 */

// ── API 客户端 ────────────────────────────────────────────
const API = {
  base: '',

  async request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    opts.signal = controller.signal;

    try {
      const res = await fetch(this.base + path, opts);
      clearTimeout(timeoutId);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') throw new Error('请求超时');
      throw fetchErr;
    }
  },

  async get(path) { return this.request('GET', path); },
  async post(path, body) { return this.request('POST', path, body); },

  scan(rootPath, options) { return this.post('/api/scan', { rootPath, options }); },
  pickFolder() { return this.post('/api/pick-folder', {}); },
  classify(files, config) { return this.post('/api/classify', { files, config }); },
  generatePlan(files, options) { return this.post('/api/plan', { files, options }); },
  executePlan(plan, conflictStrategy) { return this.post('/api/execute', { plan, conflictStrategy }); },
  undo(sessionId) { return this.post('/api/undo', { sessionId }); },
  getHistory(limit) { return this.get('/api/history?limit=' + (limit || 50)); },
  getHistoryStats() { return this.get('/api/history/stats'); },
  clearHistory() { return this.post('/api/history/clear'); },
  getFileTypes() { return this.get('/api/file-types'); },
  getSettings() { return this.get('/api/settings'); },
  saveSettings(s) { return this.post('/api/settings', s); },
  checkExists(paths) { return this.post('/api/exists', { paths }); },
};

// ── 路径工具 ──────────────────────────────────────────────
const path = {
  basename: (p) => { if (!p) return ''; const parts = p.split('/'); return parts[parts.length - 1]; },
  extname: (p) => { const parts = p.split('.'); return parts.length > 1 ? '.' + parts[parts.length - 1] : ''; },
};

// ── 工具函数 ──────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(ts) {
  if (!ts) return '未知';
  const date = new Date(ts);
  const now = new Date();
  const diff = now - date;
  const day = 86400000;
  if (diff < day) return '今天';
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return Math.floor(diff / day) + ' 天前';
  if (diff < day * 30) return Math.floor(diff / (day * 7)) + ' 周前';
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function truncatePath(p, maxLen) {
  if (!p) return '';
  if (p.length <= maxLen) return p;
  return '…' + p.slice(p.length - maxLen + 1);
}

// ── 状态 ──────────────────────────────────────────────────
const state = {
  files: [],           // 原始文件列表
  classifiedFiles: [], // 分类后的文件
  plan: null,          // 整理方案
  currentFolder: null,
  excludedFiles: new Set(),    // 排除的文件路径
  customTargetRoot: null,      // 自定义目标根目录
  fileTypes: [],      // 文件类型列表
  settings: {},
  filters: {
    fileType: null,    // 当前选中的文件类型筛选
    risk: null,        // 当前选中的风险筛选
    search: '',
  },
  sortColumn: null,
  sortDir: 1,
};

// ── DOM 引用 ──────────────────────────────────────────────
let states = {};
function $(id) { return document.getElementById(id); }

function initStates() {
  states = {
    empty: $('state-empty'),
    scanning: $('state-scanning'),
    workspace: $('state-workspace'),
    executing: $('state-executing'),
    done: $('state-done'),
  };
}

// ── 状态切换 ──────────────────────────────────────────────
function showState(name) {
  if (!states) return;
  for (const [key, el] of Object.entries(states)) {
    if (el) el.classList.toggle('active', key === name);
  }

  // 控制边栏 sections
  $('sidebar-stats').style.display = (name === 'workspace') ? '' : 'none';
  $('sidebar-filters').style.display = (name === 'workspace') ? '' : 'none';

  // 底部栏
  const bb = $('bottombar');
  if (bb) bb.style.display = (name === 'workspace') ? 'flex' : 'none';

  // 顶部路径
  if (name === 'workspace' && state.currentFolder) {
    $('topbar-path').textContent = state.currentFolder;
  } else if (name === 'empty') {
    $('topbar-path').textContent = '未选择文件夹';
  }
}

// ── Toast ─────────────────────────────────────────────────
function toast(message, type) {
  type = type || 'success';
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

// ── 确认弹窗 ──────────────────────────────────────────────
function showConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = $('confirm-overlay');
    $('confirm-title').textContent = title;
    $('confirm-message').innerHTML = message;
    overlay.classList.add('active');

    const cleanup = () => {
      overlay.classList.remove('active');
      document.removeEventListener('keydown', escHandler);
    };
    const escHandler = (e) => { if (e.key === 'Escape') { cleanup(); resolve(false); } };

    $('confirm-ok').addEventListener('click', () => { cleanup(); resolve(true); });
    $('confirm-cancel').addEventListener('click', () => { cleanup(); resolve(false); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
    document.addEventListener('keydown', escHandler);
  });
}

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  initStates();

  try { state.settings = (await API.getSettings()).data; } catch (e) { console.warn(e); }
  try { state.fileTypes = (await API.getFileTypes()).data; } catch (e) { console.warn(e); }

  buildFileFilters();
  bindEvents();
  showState('empty');
}

function buildFileFilters() {
  const ftContainer = $('filter-filetypes');
  if (!ftContainer || !state.fileTypes.length) return;

  // "全部" chip
  const allChip = document.createElement('span');
  allChip.className = 'filter-chip active';
  allChip.textContent = '全部';
  allChip.dataset.filter = 'fileType';
  allChip.dataset.value = '';
  ftContainer.appendChild(allChip);

  for (const ft of state.fileTypes) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.textContent = ft.label;
    chip.dataset.filter = 'fileType';
    chip.dataset.value = ft.key;
    ftContainer.appendChild(chip);
  }

  // 风险筛选
  const riskContainer = $('filter-risks');
  const riskDefs = [
    { key: 'sensitive', label: '⚠ 敏感', color: 'var(--danger)' },
    { key: 'large', label: '📦 大文件', color: 'var(--warning)' },
    { key: 'temp_likely', label: '🗑 临时', color: 'var(--text-tertiary)' },
    { key: 'no_extension', label: '? 无扩展名', color: 'var(--text-tertiary)' },
  ];
  for (const r of riskDefs) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.textContent = r.label;
    chip.dataset.filter = 'risk';
    chip.dataset.value = r.key;
    riskContainer.appendChild(chip);
  }

  // 筛选事件
  ftContainer.addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    ftContainer.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.filters.fileType = chip.dataset.value || null;
    renderWorkspace();
  });
  riskContainer.addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    riskContainer.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.filters.risk = chip.dataset.value || null;
    renderWorkspace();
  });
}

function bindEvents() {
  $('btn-select-folder').addEventListener('click', selectFolder);
  $('folder-path-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') selectFolder();
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('sidebar-history').addEventListener('click', openHistory);
  $('sidebar-settings').addEventListener('click', openSettings);

  $('btn-close-history').addEventListener('click', closeHistory);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-clear-history').addEventListener('click', clearHistory);

  // 工作区事件
  $('search-input').addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    renderWorkspace();
  });

  $('btn-select-all').addEventListener('click', toggleSelectAll);
  $('btn-exclude-selected').addEventListener('click', excludeSelected);

  $('custom-target-input').addEventListener('change', (e) => {
    state.customTargetRoot = e.target.value.trim() || null;
    regeneratePlan();
  });

  $('btn-rescan').addEventListener('click', () => {
    if (state.currentFolder) startScan(state.currentFolder);
  });

  $('btn-execute').addEventListener('click', executePlan);
  $('btn-execute-bottom').addEventListener('click', executePlan);
  $('btn-undo-last').addEventListener('click', undoLast);
  $('btn-new-scan').addEventListener('click', newScan);
  $('btn-back').addEventListener('click', () => { showState('workspace'); });

  // 遮罩 + Escape
  const backdrop = $('backdrop');
  if (backdrop) backdrop.addEventListener('click', () => { closeHistory(); closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const hp = $('history-panel'), sp = $('settings-panel');
    if (hp && hp.style.display === 'flex') { closeHistory(); return; }
    if (sp && sp.style.display === 'flex') { closeSettings(); return; }
  });
}

// ── 选择文件夹 ────────────────────────────────────────────
async function selectFolder() {
  const input = $('folder-path-input');
  let folderPath = (input ? input.value.trim() : '');

  if (!folderPath) {
    const btn = $('btn-select-folder');
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.21-8.79"/><path d="M21 3v5h-5"/></svg> 选择中…';
    try {
      const result = await API.pickFolder();
      if (result.success && result.data.path) {
        folderPath = result.data.path;
        if (input) input.value = folderPath;
      } else if (result.success && result.data.canceled) {
        return;
      } else {
        toast('无法调用系统文件夹选择器，请手动输入路径', 'error');
        return;
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  if (!folderPath) { toast('请输入文件夹路径', 'error'); return; }
  await startScan(folderPath);
}

// ── 扫描 ──────────────────────────────────────────────────
async function startScan(folderPath) {
  showState('scanning');
  $('scan-percent').textContent = '0%';
  $('scan-text').textContent = '正在扫描…';
  $('scan-detail').textContent = '已发现 0 个文件';

  // 模拟进度
  const progressInterval = setInterval(() => {
    const current = parseFloat($('scan-percent').textContent);
    if (current < 85) {
      $('scan-percent').textContent = (current + 3) + '%';
    }
  }, 200);

  try {
    const scanResult = await API.scan(folderPath, {
      skipHidden: state.settings.skipHidden !== false,
      skipDirs: (state.settings.skipDirs || []),
    });

    clearInterval(progressInterval);
    $('scan-percent').textContent = '100%';

    state.files = scanResult.data.files;
    state.currentFolder = folderPath;

    // 分类
    $('scan-text').textContent = '正在分析…';
    $('scan-detail').textContent = `已发现 ${state.files.length} 个文件，正在分类`;

    const classifyResult = await API.classify(state.files, {
      llm: state.settings.llm,
      context: { dirs: [...new Set(state.files.map(f => f.dir))].slice(0, 20) },
    });

    state.classifiedFiles = classifyResult.data;

    // 生成方案
    state.plan = (await API.generatePlan(state.classifiedFiles, {
      targetRoot: state.customTargetRoot,
    })).data;

    // 更新 UI
    updateSidebarStats();
    $('topbar-path').textContent = folderPath;
    $('custom-target-input').value = state.customTargetRoot || '';
    renderWorkspace();
    showState('workspace');

    const moveCount = state.plan.moves.filter(m => !state.excludedFiles.has(m.from)).length;
    if (moveCount === 0) {
      toast('所有文件已在正确位置', 'success');
    }
  } catch (err) {
    clearInterval(progressInterval);
    toast('扫描失败: ' + err.message, 'error');
    showState('empty');
  }
}

function updateSidebarStats() {
  $('stat-files').textContent = state.files.length;
  $('stat-size').textContent = formatSize(state.files.reduce((s, f) => s + f.size, 0));
  $('stat-dirs').textContent = [...new Set(state.files.map(f => f.dir))].length;
  const riskCount = state.classifiedFiles.filter(f =>
    f.riskFlag && f.riskFlag.length > 0
  ).length;
  $('stat-risk').textContent = riskCount;
}

// ── 渲染工作区 ────────────────────────────────────────────
function getFilteredFiles() {
  let files = state.classifiedFiles;

  // 排除的文件
  files = files.filter(f => !state.excludedFiles.has(f.path));

  // 文件类型筛选
  if (state.filters.fileType) {
    files = files.filter(f => f.fileType === state.filters.fileType);
  }

  // 风险筛选
  if (state.filters.risk) {
    files = files.filter(f => f.riskFlag && f.riskFlag.includes(state.filters.risk));
  }

  // 搜索
  if (state.filters.search) {
    const q = state.filters.search.toLowerCase();
    files = files.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.contentTheme && f.contentTheme.toLowerCase().includes(q)) ||
      (f.suggestedTarget && f.suggestedTarget.toLowerCase().includes(q))
    );
  }

  return files;
}

function renderWorkspace() {
  const tbody = $('workspace-tbody');
  tbody.innerHTML = '';

  const files = getFilteredFiles();

  if (files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-secondary);">没有匹配的文件</td></tr>';
    updateFooter(0, 0);
    return;
  }

  for (const file of files) {
    tbody.appendChild(renderWorkspaceRow(file));
  }

  // 计算待移动数
  const plan = state.plan;
  const moveCount = plan ? plan.moves.filter(m => !state.excludedFiles.has(m.from)).length : 0;
  const moveSize = plan ? plan.moves
    .filter(m => !state.excludedFiles.has(m.from))
    .reduce((s, m) => s + (m.size || 0), 0) : 0;

  updateFooter(files.length, moveCount, moveSize);
  $('btn-execute').disabled = moveCount === 0;
}

function renderWorkspaceRow(file) {
  const tr = document.createElement('tr');
  if (state.excludedFiles.has(file.path)) tr.classList.add('excluded');

  const riskDots = (file.riskFlag || []).map(r => {
    const labels = { sensitive: '敏感', large: '大文件', temp_likely: '临时', no_extension: '无扩展名', possible_duplicate: '可能重复' };
    const cls = { sensitive: 'sensitive', large: 'large', temp: 'temp', duplicate: 'duplicate', noext: 'noext' };
    return `<span class="risk-dot ${cls[r] || ''}" title="${labels[r] || r}"></span>`;
  }).join('');

  // 当前建议目标（可能被用户修改过）
  const currentTarget = state.plan?.moves.find(m => m.from === file.path)?.to
    ? path.basename(path.dirname(m.to))
    : (file.suggestedTarget || '其他');

  tr.innerHTML =
    '<td class="ws-check"><input type="checkbox" ' + (state.excludedFiles.has(file.path) ? '' : '') + '></td>' +
    '<td class="ws-name">' +
      '<span class="file-icon">' + getFileIcon(file.name, file.fileType) + '</span>' +
      '<span class="ws-file-name">' + escapeHtml(file.name) + '</span>' +
    '</td>' +
    '<td><span class="ws-type-badge">' + escapeHtml(file.fileTypeLabel || file.fileType) + '</span></td>' +
    '<td><input class="ws-theme-input" type="text" value="' + escapeHtml(file.contentTheme || '') + '" placeholder="主题" spellcheck="false"></td>' +
    '<td><input class="ws-target-input" type="text" value="' + escapeHtml(currentTarget) + '" placeholder="目标目录" spellcheck="false"></td>' +
    '<td><div class="ws-risk-dots">' + riskDots + '</div></td>' +
    '<td class="ws-size">' + formatSize(file.size) + '</td>' +
    '<td class="ws-date">' + formatDate(file.modified) + '</td>';

  // 事件
  const checkbox = tr.querySelector('input[type="checkbox"]');
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      state.excludedFiles.add(file.path);
    } else {
      state.excludedFiles.delete(file.path);
    }
    renderWorkspace();
  });

  // 主题修改
  const themeInput = tr.querySelector('.ws-theme-input');
  themeInput.addEventListener('change', () => {
    file.contentTheme = themeInput.value.trim() || '默认';
    file.suggestedTarget = file.contentTheme;
    regeneratePlan();
  });

  // 目标目录修改
  const targetInput = tr.querySelector('.ws-target-input');
  targetInput.addEventListener('change', () => {
    const newTarget = targetInput.value.trim() || '其他';
    file.suggestedTarget = newTarget;
    regeneratePlan();
  });

  return tr;
}

function updateFooter(total, moves, size) {
  $('footer-count').textContent = total;
  $('footer-moves').textContent = moves;
  $('footer-size').textContent = formatSize(size || 0);
}

function getFileIcon(name, fileType) {
  const ext = path.extname(name).toLowerCase();
  const icons = {
    pdf: '📄', doc: '📄', docx: '📄', txt: '📝', md: '📝',
    jpg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️',
    exe: '📦', msi: '📦', pkg: '📦', apk: '📦',
    js: '💻', ts: '💻', py: '💻', java: '💻', html: '💻', css: '💻', json: '💻',
  };
  if (icons[ext.slice(1)]) return icons[ext.slice(1)];
  if (fileType === 'document') return '📄';
  if (fileType === 'image') return '🖼️';
  if (fileType === 'video') return '🎬';
  if (fileType === 'audio') return '🎵';
  if (fileType === 'archive') return '🗜️';
  if (fileType === 'installer') return '📦';
  if (fileType === 'code') return '💻';
  if (fileType === 'temp') return '🗑️';
  return '📄';
}

// ── 全选 / 排除 ──────────────────────────────────────────
function toggleSelectAll() {
  const checkboxes = document.querySelectorAll('#workspace-tbody input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(c => c.checked);
  checkboxes.forEach(c => c.checked = !allChecked);

  // 同步到 excludedFiles
  const visibleFiles = getFilteredFiles();
  if (!allChecked) {
    // 选中所有
    for (const f of visibleFiles) state.excludedFiles.delete(f.path);
  } else {
    // 取消全选
    for (const f of visibleFiles) state.excludedFiles.add(f.path);
  }
  renderWorkspace();
}

function excludeSelected() {
  const checkboxes = document.querySelectorAll('#workspace-tbody input[type="checkbox"]:checked');
  checkboxes.forEach(c => {
    const tr = c.closest('tr');
    const name = tr.querySelector('.ws-file-name').textContent;
    const file = state.classifiedFiles.find(f => f.name === name);
    if (file) state.excludedFiles.add(file.path);
  });
  renderWorkspace();
  toast('已排除 ' + checkboxes.length + ' 个文件', 'success');
}

// ── 重新生成方案 ──────────────────────────────────────────
async function regeneratePlan() {
  try {
    state.plan = (await API.generatePlan(state.classifiedFiles, {
      targetRoot: state.customTargetRoot,
    })).data;
    renderWorkspace();
  } catch (err) {
    console.warn('[plan] 重新生成失败:', err.message);
  }
}

// ── 执行整理 ──────────────────────────────────────────────
async function executePlan() {
  if (!state.plan) return;

  const moves = state.plan.moves.filter(m => !state.excludedFiles.has(m.from));
  if (moves.length === 0) {
    toast('没有需要整理的文件', 'warning');
    return;
  }

  const totalSize = moves.reduce((s, m) => s + (m.size || 0), 0);
  const confirmed = await showConfirm(
    '开始整理？',
    `将移动 <strong>${moves.length}</strong> 个文件（共 ${formatSize(totalSize)}）到目标目录。<br><br>` +
    `此操作可撤销。目标目录: <strong>${state.customTargetRoot || state.currentFolder}</strong>`
  );
  if (!confirmed) return;

  showState('executing');
  $('execute-progress-fill').style.width = '0%';
  $('execute-text').textContent = '正在整理文件…';
  $('execute-detail').textContent = '0 / ' + moves.length;

  const plan = { ...state.plan, moves };
  const total = moves.length;
  let done = 0;

  try {
    const result = await API.executePlan(plan, {
      conflictStrategy: state.settings.conflictStrategy || { overwrite: 'skip' },
    });

    for (let i = 0; i < total; i++) {
      await new Promise(r => setTimeout(r, 30));
      done = i + 1;
      $('execute-progress-fill').style.width = (done / total * 100) + '%';
      $('execute-detail').textContent = done + ' / ' + total + ' · ' + path.basename(moves[i]?.from || '');
    }

    $('done-title').textContent = '整理完成';
    $('done-detail').textContent =
      `已移动 ${result.success.length} 个文件` +
      (result.failed.length > 0 ? `，${result.failed.length} 个失败` : '') +
      (result.skipped.length > 0 ? `，${result.skipped.length} 个跳过` : '');

    if (result.failed.length > 0) {
      toast(`${result.failed.length} 个文件移动失败`, 'error');
    } else {
      toast('整理完成', 'success');
    }

    showState('done');
  } catch (err) {
    toast('执行失败: ' + err.message, 'error');
    showState('workspace');
  }
}

// ── 撤销 ──────────────────────────────────────────────────
async function undoLast() {
  try {
    const result = await API.undo();
    if (result.success) {
      toast(`已撤销 ${result.success} 个操作`, 'success');
    } else {
      toast('撤销失败: ' + (result.errors?.[0]?.error || '未知错误'), 'error');
    }
  } catch (err) {
    toast('撤销失败: ' + err.message, 'error');
  }
}

function newScan() {
  state.files = [];
  state.classifiedFiles = [];
  state.plan = null;
  state.excludedFiles.clear();
  state.customTargetRoot = null;
  $('folder-path-input').value = '';
  $('custom-target-input').value = '';
  $('search-input').value = '';
  state.filters = { fileType: null, risk: null, search: '' };
  // 重置筛选 chip
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.filter-chip[data-value=""]')?.classList.add('active');
  showState('empty');
}

// ── 面板管理 ──────────────────────────────────────────────
function openHistory() { closeSettings(); $('history-panel').style.display = 'flex'; $('backdrop').classList.add('active'); document.body.style.overflow = 'hidden'; loadHistory(); }
function closeHistory() { $('history-panel').style.display = 'none'; $('backdrop').classList.remove('active'); document.body.style.overflow = ''; }
function openSettings() { closeHistory(); loadSettingsUI(); $('settings-panel').style.display = 'flex'; $('backdrop').classList.add('active'); document.body.style.overflow = 'hidden'; }
function closeSettings() { $('settings-panel').style.display = 'none'; $('backdrop').classList.remove('active'); document.body.style.overflow = ''; }

async function loadHistory() {
  try {
    const result = await API.getHistory(50);
    const list = $('history-list');
    list.innerHTML = '';

    if (!result.data || result.data.length === 0) {
      list.innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;">暂无操作历史</p>';
      return;
    }

    for (const session of result.data) {
      list.appendChild(renderHistoryItem(session));
    }
  } catch (err) {
    console.warn('[history] 加载失败:', err.message);
  }
}

function renderHistoryItem(session) {
  const div = document.createElement('div');
  div.className = 'history-item' + (session.undone ? ' undone' : '');
  const date = new Date(session.timestamp).toLocaleString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const moveCount = session.moves ? session.moves.length : 0;
  div.innerHTML =
    '<div class="history-item-header">' +
      '<span class="history-item-date">' + date + '</span>' +
      '<span class="history-item-count">' + moveCount + ' 个移动</span>' +
    '</div>' +
    '<div class="history-item-path" title="' + escapeHtml(session.sourceDir || '') + '">' + escapeHtml(truncatePath(session.sourceDir || '', 60)) + '</div>' +
    '<div class="history-item-actions">' +
      (session.undone ? '<span style="font-size:11px;color:var(--text-tertiary);">已撤销</span>' :
       '<button class="btn-link" onclick="undoSession(\'' + session.id + '\')">撤销</button>') +
    '</div>';
  return div;
}

async function undoSession(sessionId) {
  try {
    const result = await API.undo(sessionId);
    if (result.success) {
      toast('已撤销', 'success');
      loadHistory();
    } else {
      toast('撤销失败', 'error');
    }
  } catch (err) {
    toast('撤销失败: ' + err.message, 'error');
  }
}

function loadSettingsUI() {
  const s = state.settings || {};
  $('setting-llm-enabled').checked = !!(s.llm && s.llm.enabled);
  $('setting-llm-endpoint').value = (s.llm && s.llm.endpoint) || '';
  $('setting-llm-apikey').value = (s.llm && s.llm.apiKey) || '';
  $('setting-llm-model').value = (s.llm && s.llm.model) || '';
  $('setting-skip-hidden').checked = s.skipHidden !== false;
  $('setting-conflict').value = (s.conflictStrategy && s.conflictStrategy.overwrite) || 'skip';
}

async function saveSettings() {
  const newSettings = {
    llm: {
      enabled: $('setting-llm-enabled').checked,
      endpoint: $('setting-llm-endpoint').value.trim(),
      apiKey: $('setting-llm-apikey').value.trim(),
      model: $('setting-llm-model').value.trim() || 'deepseek-chat',
    },
    skipHidden: $('setting-skip-hidden').checked,
    skipDirs: (state.settings && state.settings.skipDirs) || [],
    conflictStrategy: { overwrite: $('setting-conflict').value },
  };
  try {
    await API.saveSettings(newSettings);
    state.settings = newSettings;
    toast('设置已保存', 'success');
    closeSettings();
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}

async function clearHistory() {
  if (!confirm('确定要清空所有操作历史吗？此操作不可恢复。')) return;
  try {
    await API.clearHistory();
    toast('历史已清空', 'success');
    loadHistory();
  } catch (err) {
    toast('清空失败: ' + err.message, 'error');
  }
}

// ── 启动 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);