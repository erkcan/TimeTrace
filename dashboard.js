// dashboard.js

// ─── Utilities ────────────────────────────────────────────────────────────────

// Instead of storing and re-loading arbitrary third-party favicon URLs
// (which can trigger CSP violations on the extension page), we derive
// a safe favicon URL from the domain name using Google's favicon CDN.
function faviconUrl(domain) {
  if (!domain) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

// Kept for import sanitisation — strips chrome:// URLs from imported data
function sanitiseFavicon(url) {
  if (!url) return '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return '';
  return url;
}

function formatTime(seconds) {
  if (!seconds || seconds === 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatTimeLong(seconds) {
  if (!seconds || seconds === 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function isoToday() { return isoLocalDate(0); }

function isoWeekMonday() {
  const d = new Date();
  const day = d.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysFromMonday);
  return `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
}

// Returns YYYY-MM-DD in local time for a Date offset by `offsetDays` from today
function isoLocalDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Returns ISO date strings for the current week (Mon → today)
function thisWeekDays() {
  const today = new Date();
  const day = today.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const days = [];
  for (let i = daysFromMonday; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return days;
}

// Returns ISO date strings for the last 7 rolling days (used only for Today chart context)
function last7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(isoLocalDate(-i));
  return days;
}

// Convert M/D/YYYY → YYYY-MM-DD for matching against ISO keys
function displayDateToISO(dateStr) {
  const [m, d, y] = dateStr.split('/');
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let currentPeriod = 'day';
let allData = {};
let limits = {}; // { [domain]: { limitSecs, snoozeSecs } }

async function loadData() {
  allData = await chrome.storage.local.get(null);
  limits = allData.limits || {};
  const settings = allData.settings || {};
  const input = document.getElementById('inactivityInput');
  if (input) input.value = settings.inactivityTimeoutMins || 5;
  const debugLevelEl = document.getElementById('debugLevel');
  const level = parseInt(debugLevelEl?.value || '0');
  document.getElementById('debugPanel').classList.toggle('visible', level > 0);
  if (level > 0) refreshDebugLog();
  render();
}

// ─── Period views ────────────────────────────────────────────────────────────
//
// For 'day' and 'week' we derive data from the site: entries + their days[]
// rather than the legacy aggregation keys, so the view is always consistent
// with the export logic and immune to stale/mismatched aggregation keys.

function getDomainsForPeriod(period) {
  if (period === 'all') {
    // All-time: read directly from legacy all: keys (fastest, always correct)
    const domains = [];
    let total = 0;
    for (const [key, value] of Object.entries(allData)) {
      if (!key.startsWith('all:')) continue;
      const domain = key.slice('all:'.length);
      if (domain === '__total__') { total = value; continue; }
      const siteEntry = allData[`site:${domain}`];
      domains.push({ domain, seconds: value, favicon: siteEntry?.favicon || '' });
    }
    domains.sort((a, b) => b.seconds - a.seconds);
    return { domains, total };
  }

  // For day/week: filter site: entries by the allowed date strings
  const allowedDates = getDateStringsForPeriod(period);
  const domainMap = {};

  for (const [key, site] of Object.entries(allData)) {
    if (!key.startsWith('site:')) continue;
    const domain = site.url;
    const filteredDays = (site.days || []).filter(d => allowedDates.has(d.date));
    if (filteredDays.length === 0) continue;
    const seconds = filteredDays.reduce((sum, d) => sum + (d.summary || 0), 0);
    if (seconds <= 0) continue;
    domainMap[domain] = { domain, seconds, favicon: site.favicon || '' };
  }

  const domains = Object.values(domainMap);
  domains.sort((a, b) => b.seconds - a.seconds);
  const total = domains.reduce((sum, d) => sum + d.seconds, 0);
  return { domains, total };
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const now = new Date();
  document.getElementById('headerDate').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const { domains, total } = getDomainsForPeriod(currentPeriod);

  document.getElementById('statTotal').textContent = formatTime(total);
  document.getElementById('statTotalSub').textContent = { day: 'today', week: 'this week', all: 'all time' }[currentPeriod];
  document.getElementById('statSites').textContent = domains.length;
  document.getElementById('statSitesSub').textContent = `unique domain${domains.length !== 1 ? 's' : ''}`;

  if (domains.length > 0) {
    const top = domains[0];
    document.getElementById('statTop').textContent = top.domain;
    document.getElementById('statTopSub').textContent = formatTime(top.seconds);
  } else {
    document.getElementById('statTop').textContent = '—';
    document.getElementById('statTopSub').textContent = '';
  }

  const chartSection = document.getElementById('chartSection');
  if (currentPeriod !== 'all') { chartSection.style.display = 'block'; renderChart(currentPeriod); }
  else chartSection.style.display = 'none';

  renderDonut(domains, total);

  const tbody = document.getElementById('tableBody');
  if (domains.length === 0) {
    tbody.innerHTML = `<div class="empty-state"><div class="big">◷</div>No data for this period yet.<br>Start browsing to see your stats here.</div>`;
    return;
  }

  const maxSec = domains[0].seconds;
  tbody.innerHTML = domains.map((item, i) => {
    const pct = total > 0 ? ((item.seconds / total) * 100).toFixed(1) : '0.0';
    const barWidth = Math.round((item.seconds / maxSec) * 100);
    const faviconHtml = `<img src="${faviconUrl(item.domain)}" class="favicon" data-fallback>`;
    const lim = limits[item.domain];
    const isExceeded = lim && item.seconds >= lim.limitSecs;
    const limitLabel = lim
      ? `⏱ ${formatTime(lim.limitSecs)}`
      : `+ limit`;
    const badgeClass = lim ? (isExceeded ? 'limit-badge set exceeded' : 'limit-badge set') : 'limit-badge';
    const limitInputVal = lim ? Math.round(lim.limitSecs / 60) : '';
    const snoozeInputVal = lim ? Math.round(lim.snoozeSecs / 60) : 15;
    return `
      <div class="table-row" data-domain="${item.domain}">
        <div class="row-rank">${i + 1}</div>
        <div class="row-domain">${faviconHtml}<span>${item.domain}</span></div>
        <div class="row-bar-wrap"><div class="bar-track"><div class="bar-fill" style="width:${barWidth}%"></div></div></div>
        <div class="row-time">${formatTime(item.seconds)}</div>
        <div class="row-pct">${pct}%</div>
        <div class="limit-cell">
          <span class="${badgeClass}" data-domain="${item.domain}">${limitLabel}</span>
        </div>
      </div>
      <div class="limit-editor" id="limit-editor-${i}" data-domain="${item.domain}">
        <div class="limit-field">
          <label>Daily limit (minutes)</label>
          <input type="number" min="1" class="limit-input" placeholder="e.g. 45" value="${limitInputVal}">
        </div>
        <div class="limit-field">
          <label>Snooze period (minutes)</label>
          <input type="number" min="1" class="snooze-input" placeholder="e.g. 15" value="${snoozeInputVal}">
        </div>
        <div class="limit-actions">
          <button class="limit-save" data-index="${i}">Save</button>
          <button class="limit-remove" data-index="${i}">Remove</button>
        </div>
      </div>`;
  }).join('');

  // Hide broken favicon images
  tbody.querySelectorAll('img.favicon[data-fallback]').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });

  // Limit badge click — toggle inline editor
  tbody.querySelectorAll('.limit-badge').forEach(badge => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const domain = badge.dataset.domain;
      const row = badge.closest('.table-row');
      const editor = row.nextElementSibling;
      const isOpen = editor.classList.contains('open');
      // Close all editors first
      tbody.querySelectorAll('.limit-editor.open').forEach(ed => ed.classList.remove('open'));
      if (!isOpen) editor.classList.add('open');
    });
  });

  // Save limit
  tbody.querySelectorAll('.limit-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const editor = btn.closest('.limit-editor');
      const domain = editor.dataset.domain;
      const limitMins = parseInt(editor.querySelector('.limit-input').value);
      const snoozeMins = parseInt(editor.querySelector('.snooze-input').value);
      if (!limitMins || limitMins < 1) { showToast('Enter a valid limit in minutes', 'error'); return; }
      if (!snoozeMins || snoozeMins < 1) { showToast('Enter a valid snooze period in minutes', 'error'); return; }
      limits[domain] = { limitSecs: limitMins * 60, snoozeSecs: snoozeMins * 60 };
      await chrome.storage.local.set({ limits });
      editor.classList.remove('open');
      showToast(`Limit set for ${domain}`);
      render();
    });
  });

  // Remove limit
  tbody.querySelectorAll('.limit-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const editor = btn.closest('.limit-editor');
      const domain = editor.dataset.domain;
      delete limits[domain];
      await chrome.storage.local.set({ limits });
      editor.classList.remove('open');
      showToast(`Limit removed for ${domain}`);
      render();
    });
  });
}

function renderChart(period) {
  // 'day' shows last 7 days for context; 'week' shows Mon → today
  const days = period === 'week' ? thisWeekDays() : last7Days();
  const todayStr = isoLocalDate(0);
  const maxVal = Math.max(1, ...days.map(d => allData[`day:${d}:__total__`] || 0));
  document.getElementById('chartBars').innerHTML = days.map(dateStr => {
    const val = allData[`day:${dateStr}:__total__`] || 0;
    const heightPct = Math.max(2, Math.round((val / maxVal) * 100));
    const d = new Date(dateStr + 'T12:00:00');
    const isToday = dateStr === todayStr;
    return `
      <div class="chart-col">
        <div class="chart-bar ${isToday ? 'today' : val > 0 ? 'has-data' : ''}" style="height:${heightPct}%" title="${DAY_NAMES[d.getDay()]}: ${formatTime(val)}"></div>
        <div class="chart-day-label ${isToday ? 'today' : ''}">${DAY_NAMES[d.getDay()]}</div>
      </div>`;
  }).join('');
}

// ─── Export ───────────────────────────────────────────────────────────────────

// Returns the set of M/D/YYYY date strings that fall within the given period.
function getDateStringsForPeriod(period) {
  if (period === 'all') return null; // null = no date filter

  const today = new Date();

  if (period === 'day') {
    const d = today;
    return new Set([`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`]);
  }

  // 'week' — Monday through today
  const dates = new Set();
  const day = today.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  for (let i = daysFromMonday; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    dates.add(`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`);
  }
  return dates;
}

function buildExportData(period) {
  const allowedDates = getDateStringsForPeriod(period);
  const entries = [];

  for (const [key, value] of Object.entries(allData)) {
    if (!key.startsWith('site:')) continue;
    const site = value;

    if (allowedDates === null) {
      // All-time: export as-is
      entries.push(site);
    } else {
      // Filter days to only those in the period
      const filteredDays = (site.days || []).filter(d => allowedDates.has(d.date));
      if (filteredDays.length === 0) continue;

      const summaryTime = filteredDays.reduce((sum, d) => sum + (d.summary || 0), 0);
      const counter = filteredDays.reduce((sum, d) => sum + (d.counter || 0), 0);

      entries.push({
        url: site.url,
        favicon: site.favicon || '',
        summaryTime,
        counter,
        days: filteredDays,
      });
    }
  }

  entries.sort((a, b) => (b.summaryTime || 0) - (a.summaryTime || 0));
  return entries;
}

function exportJSON() {
  const data = buildExportData(currentPeriod);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const periodLabel = { day: 'today', week: 'this-week', all: 'all-time' }[currentPeriod];
  a.href = url;
  a.download = `timetrace-${periodLabel}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${periodLabel.replace('-', ' ')} data`);
}

// ─── Import ───────────────────────────────────────────────────────────────────

async function importJSON(file) {
  let imported;
  try {
    const text = await file.text();
    imported = JSON.parse(text);
  } catch {
    showToast('Invalid JSON file', 'error');
    return;
  }

  if (!Array.isArray(imported)) {
    showToast('Expected a JSON array', 'error');
    return;
  }

  const mode = document.querySelector('input[name="importMode"]:checked').value;

  if (mode === 'replace') {
    await chrome.storage.local.clear();
    allData = {};
  }

  const updates = {};

  for (const entry of imported) {
    if (!entry.url) continue;
    const domain = entry.url.replace(/^www\./, '');
    const key = `site:${domain}`;

    let base = mode === 'merge' ? (allData[key] || { url: domain, favicon: '', summaryTime: 0, counter: 0, days: [] }) : { url: domain, favicon: sanitiseFavicon(entry.favicon || ''), summaryTime: 0, counter: 0, days: [] };

    if (mode === 'merge') {
      // Merge summaryTime and counter
      base.summaryTime = (base.summaryTime || 0) + (entry.summaryTime || 0);
      base.counter = (base.counter || 0) + (entry.counter || 0);
      if (entry.favicon && !base.favicon) base.favicon = sanitiseFavicon(entry.favicon);

      // Merge days
      for (const importDay of (entry.days || [])) {
        const existing = base.days.find(d => d.date === importDay.date);
        if (existing) {
          existing.summary = (existing.summary || 0) + (importDay.summary || 0);
          existing.counter = (existing.counter || 0) + (importDay.counter || 0);
        } else {
          base.days.push({ ...importDay });
        }
      }
    } else {
      base.summaryTime = entry.summaryTime || 0;
      base.counter = entry.counter || 0;
      base.favicon = sanitiseFavicon(entry.favicon || '');
      base.days = (entry.days || []).map(d => ({ ...d }));
    }

    updates[key] = base;

    // Rebuild aggregation keys from the days array
    for (const day of base.days) {
      const iso = displayDateToISO(day.date);
      const aggKey = `day:${iso}:${domain}`;
      updates[aggKey] = (updates[aggKey] || 0) + (day.summary || 0);

      const totalKey = `day:${iso}:__total__`;
      updates[totalKey] = (updates[totalKey] || 0) + (day.summary || 0);
    }

    // all: key
    updates[`all:${domain}`] = base.summaryTime;
  }

  // Recompute all:__total__ from scratch as the sum of every all:{domain} key,
  // merging what we just wrote (in updates) with what remains in storage (allData).
  // This avoids double-counting domains that exist in both.
  const mergedAll = { ...allData, ...updates };
  let allTotal = 0;
  for (const [key, value] of Object.entries(mergedAll)) {
    if (key.startsWith('all:') && !key.startsWith('all:__')) {
      allTotal += value;
    }
  }
  updates[`all:__total__`] = allTotal;

  await chrome.storage.local.set(updates);
  allData = await chrome.storage.local.get(null);
  render();
  showToast(`Imported ${imported.length} site${imported.length !== 1 ? 's' : ''}`);
  document.getElementById('importModal').classList.remove('open');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    render();
  });
});

// Clear
document.getElementById('clearBtn').addEventListener('click', () => document.getElementById('modalOverlay').classList.add('open'));
document.getElementById('cancelClear').addEventListener('click', () => document.getElementById('modalOverlay').classList.remove('open'));
document.getElementById('confirmClear').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  allData = {};
  document.getElementById('modalOverlay').classList.remove('open');
  render();
});

// Export
document.getElementById('exportBtn').addEventListener('click', exportJSON);

// Import — open modal
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importModal').classList.add('open');
  document.getElementById('importFile').value = '';
  document.getElementById('importFileName').textContent = 'No file chosen';
  document.getElementById('doImportBtn').disabled = true;
});

// File picker
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  document.getElementById('importFileName').textContent = file ? file.name : 'No file chosen';
  document.getElementById('doImportBtn').disabled = !file;
});

document.getElementById('importDropZone').addEventListener('click', () => document.getElementById('importFile').click());

document.getElementById('importDropZone').addEventListener('dragover', (e) => {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
});

document.getElementById('importDropZone').addEventListener('dragleave', (e) => e.currentTarget.classList.remove('dragover'));

document.getElementById('importDropZone').addEventListener('drop', (e) => {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) {
    document.getElementById('importFileName').textContent = file.name;
    document.getElementById('doImportBtn').disabled = false;
    // Store file reference for the import button
    document.getElementById('importFile')._droppedFile = file;
  }
});

document.getElementById('cancelImport').addEventListener('click', () => document.getElementById('importModal').classList.remove('open'));

document.getElementById('doImportBtn').addEventListener('click', () => {
  const fileInput = document.getElementById('importFile');
  const file = fileInput._droppedFile || fileInput.files[0];
  if (file) importJSON(file);
});

// ─── Debug log ───────────────────────────────────────────────────────────────

const TYPE_CLASS = { track: 'track', pause: 'pause', audible: 'audible', limit: 'limit', tab: 'tab' };
const TICK_TYPES = new Set(['track', 'pause', 'tick']); // only shown at verbose level

async function refreshDebugLog() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' });
  const logEl = document.getElementById('debugLog');
  const displayLevel = parseInt(document.getElementById('debugLevel').value) || 0;
  const levelLabel = ['Off', 'Normal', 'Verbose'][displayLevel];
  document.getElementById('debugPanel').querySelector('.debug-panel-header span').textContent =
    `🐛 Debug log — ${levelLabel}`;

  // Show last heartbeat from storage
  const hbResult = await chrome.storage.local.get('lastHeartbeat');
  const hb = hbResult.lastHeartbeat;
  if (hb) {
    const hbTime = new Date(hb.time);
    const hbStr = `${String(hbTime.getHours()).padStart(2,'0')}:${String(hbTime.getMinutes()).padStart(2,'0')}:${String(hbTime.getSeconds()).padStart(2,'0')}`;
    const hbEl = document.getElementById('debugHeartbeat');
    if (hbEl) hbEl.textContent = `Last heartbeat: ${hbStr} | domain=${hb.activeDomain || 'none'} | audible=${hb.activeTabAudible} | idle=${hb.isIdle} | lastTickTime=${hb.lastTickTime ? hb.lastTickTime.slice(11,19) : 'null'}`;
  }

  // Show worker restart history from storage (survives memory wipes)
  const stored = await chrome.storage.local.get('workerRestarts');
  const restarts = stored.workerRestarts || [];
  if (!response) { logEl.innerHTML = '<div class="debug-empty">Could not reach background worker.</div>'; return; }
  // Merge in-memory log with restart entries from storage, sort newest first
  const restartEntries = restarts.map(ts => ({ time: ts, type: 'worker', msg: 'service worker started/restarted' }));
  const allEntries = [...(response.log || []), ...restartEntries]
    .filter(entry => TICK_TYPES.has(entry.type) ? displayLevel >= 2 : true)
    .sort((a, b) => b.time.localeCompare(a.time));
  if (allEntries.length === 0) { logEl.innerHTML = '<div class="debug-empty">Debug log is empty. Start browsing to see events.</div>'; return; }
  const ENTRY_COLORS = { worker: '#ff9f43' };
  logEl.innerHTML = allEntries.map(entry => {
    const t = new Date(entry.time);
    const timeStr = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    const cls = TYPE_CLASS[entry.type] || '';
    const style = ENTRY_COLORS[entry.type] ? ` style="color:${ENTRY_COLORS[entry.type]}"` : '';
    return `<div class="debug-entry"><span class="debug-time">${timeStr}</span><span class="debug-msg ${cls}"${style}>[${entry.type}] ${entry.msg}</span></div>`;
  }).join('');
}

document.getElementById('debugLevel').addEventListener('input', (e) => {
  const level = parseInt(e.target.value);
  document.getElementById('debugPanel').classList.toggle('visible', level > 0);
  if (level > 0) refreshDebugLog();
});

document.getElementById('debugClear').addEventListener('click', refreshDebugLog);

// Inactivity setting — save on change
document.getElementById('inactivityInput').addEventListener('change', async () => {
  const mins = Math.max(1, parseInt(document.getElementById('inactivityInput').value) || 5);
  document.getElementById('inactivityInput').value = mins;
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || {};
  settings.inactivityTimeoutMins = mins;
  await chrome.storage.local.set({ settings });
  const saved = document.getElementById('settingsSaved');
  saved.classList.add('show');
  setTimeout(() => saved.classList.remove('show'), 2000);
});

// Auto-refresh
setInterval(() => {
  loadData();
  const settings = JSON.parse(JSON.stringify(allData.settings || {}));
  if ((parseInt(document.getElementById('debugLevel')?.value) || 0) > 0) refreshDebugLog();
}, 5000);
loadData();

// ─── Donut chart ──────────────────────────────────────────────────────────────

const DONUT_COLORS = [
  '#6fa8ff', // blue
  '#b47fff', // purple
  '#ff7eb6', // pink
  '#ff6b6b', // red
  '#ff9f43', // orange
  '#ffd166', // yellow
  '#a8e063', // lime
  '#43d9a0', // teal
  '#4dd0e1', // cyan
  '#aaaaaa', // grey — always used for "Others"
];

let donutHovered = -1; // index of hovered slice (-1 = none)

function renderDonut(domains, total) {
  const section = document.getElementById('donutSection');
  const canvas  = document.getElementById('donutCanvas');
  const legend  = document.getElementById('donutLegend');

  if (domains.length === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  // Build slices: top 9 + Others
  const top     = domains.slice(0, 9);
  const others  = domains.slice(9);
  const slices  = top.map((d, i) => ({
    label:   d.domain,
    seconds: d.seconds,
    color:   DONUT_COLORS[i],
  }));

  if (others.length > 0) {
    const othersTotal = others.reduce((s, d) => s + d.seconds, 0);
    slices.push({ label: `${others.length} other site${others.length > 1 ? 's' : ''}`, seconds: othersTotal, color: DONUT_COLORS[9] });
  }

  drawDonut(canvas, slices, total);
  buildLegend(legend, slices, total, canvas);
}

function drawDonut(canvas, slices, total, highlightIndex = -1) {
  const dpr  = window.devicePixelRatio || 1;
  const size = 400; // logical px (canvas width/height attr)
  canvas.width  = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width  = '200px';
  canvas.style.height = '200px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cx = size / 2, cy = size / 2;
  const outerR  = 170;
  const innerR  = 100;
  const gap     = 0.018; // radians gap between slices

  ctx.clearRect(0, 0, size, size);

  let angle = -Math.PI / 2; // start at 12 o'clock

  slices.forEach((slice, i) => {
    const frac  = slice.seconds / total;
    const sweep = frac * 2 * Math.PI - gap;
    if (sweep <= 0) return;

    const isHovered = i === highlightIndex;
    const r = isHovered ? outerR + 8 : outerR;

    ctx.beginPath();
    ctx.moveTo(cx + innerR * Math.cos(angle + gap / 2), cy + innerR * Math.sin(angle + gap / 2));
    ctx.arc(cx, cy, r,      angle + gap / 2, angle + gap / 2 + sweep);
    ctx.arc(cx, cy, innerR, angle + gap / 2 + sweep, angle + gap / 2, true);
    ctx.closePath();

    ctx.fillStyle = isHovered ? slice.color : slice.color + 'dd';
    ctx.fill();

    if (isHovered) {
      ctx.shadowColor = slice.color;
      ctx.shadowBlur  = 18;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    angle += frac * 2 * Math.PI;
  });
}

function buildLegend(legend, slices, total, canvas) {
  legend.innerHTML = slices.map((slice, i) => {
    const pct = total > 0 ? ((slice.seconds / total) * 100).toFixed(1) : '0';
    return `
      <div class="legend-item" data-index="${i}">
        <div class="legend-dot" style="background:${slice.color}"></div>
        <span class="legend-name">${slice.label}</span>
        <span class="legend-time">${formatTimeLong(slice.seconds)}</span>
        <span class="legend-pct">${pct}%</span>
      </div>`;
  }).join('');

  // Hover interactions
  legend.querySelectorAll('.legend-item').forEach(item => {
    const idx = parseInt(item.dataset.index);

    item.addEventListener('mouseenter', () => {
      donutHovered = idx;
      legend.querySelectorAll('.legend-item').forEach((el, j) => {
        el.classList.toggle('dimmed', j !== idx);
      });
      // Rebuild slices from DOM state is not available here — re-derive from current render
      // Instead, store slices on canvas as a data attribute (JSON-safe subset)
      const slicesData = JSON.parse(canvas.dataset.slices || '[]');
      const tot = JSON.parse(canvas.dataset.total || '0');
      drawDonut(canvas, slicesData, tot, idx);
    });

    item.addEventListener('mouseleave', () => {
      donutHovered = -1;
      legend.querySelectorAll('.legend-item').forEach(el => el.classList.remove('dimmed'));
      const slicesData = JSON.parse(canvas.dataset.slices || '[]');
      const tot = JSON.parse(canvas.dataset.total || '0');
      drawDonut(canvas, slicesData, tot, -1);
    });
  });

  // Store slices on canvas for hover redraws
  canvas.dataset.slices = JSON.stringify(slices);
  canvas.dataset.total  = JSON.stringify(total);
}
