// popup.js

function formatTime(seconds) {
  if (!seconds || seconds < 60) return seconds ? `${seconds}s` : '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadPopup() {
  // Get current tracking status
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const currentDomain = document.getElementById('currentDomain');

  if (status.idle) {
    dot.className = 'status-dot idle';
    statusText.textContent = 'idle';
    currentDomain.textContent = 'User idle';
    currentDomain.className = 'current-domain none';
  } else if (status.inactive) {
    dot.className = 'status-dot idle';
    statusText.textContent = 'inactive';
    currentDomain.textContent = status.domain || 'No active tab';
    currentDomain.className = 'current-domain none';
  } else if (status.domain) {
    dot.className = status.audible ? 'status-dot active audible' : 'status-dot active';
    statusText.textContent = status.audible ? 'tracking ♪' : 'tracking';
    currentDomain.textContent = status.domain;
    currentDomain.className = 'current-domain';
  } else {
    dot.className = 'status-dot';
    statusText.textContent = 'paused';
    currentDomain.textContent = 'No active tab';
    currentDomain.className = 'current-domain none';
  }

  // Get today's data
  const today = todayKey();
  const allData = await chrome.storage.local.get(null);

  // Filter today's domain keys
  const prefix = `day:${today}:`;
  const todayDomains = [];
  let todayTotal = 0;

  for (const [key, value] of Object.entries(allData)) {
    if (key.startsWith(prefix)) {
      const domain = key.slice(prefix.length);
      if (domain === '__total__') {
        todayTotal = value;
      } else {
        todayDomains.push({ domain, seconds: value });
      }
    }
  }

  document.getElementById('todayTotal').textContent = formatTime(todayTotal);

  // Load limit section for the active domain
  const activeDomain = status.domain;
  if (activeDomain) {
    const activeTodaySecs = todayDomains.find(d => d.domain === activeDomain)?.seconds || 0;
    await loadLimitSection(activeDomain, activeTodaySecs);
  }

  // Sort and show top 7
  todayDomains.sort((a, b) => b.seconds - a.seconds);
  const top = todayDomains.slice(0, 7);
  const maxSec = top[0]?.seconds || 1;

  const list = document.getElementById('domainList');
  if (top.length === 0) {
    list.innerHTML = '<div class="empty">No data yet.<br>Start browsing to see stats.</div>';
    return;
  }

  list.innerHTML = top.map((item, i) => `
    <div class="domain-row">
      <div class="domain-rank">${i + 1}</div>
      <div class="domain-bar-wrap">
        <div class="domain-name">${item.domain}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${Math.round((item.seconds / maxSec) * 100)}%"></div>
        </div>
      </div>
      <div class="domain-time">${formatTime(item.seconds)}</div>
    </div>
  `).join('');
}

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// ─── Limit section for active domain ─────────────────────────────────────────

async function loadLimitSection(domain, todaySeconds) {
  if (!domain) return;

  const section = document.getElementById('limitSection');
  section.classList.add('visible');

  const result = await chrome.storage.local.get('limits');
  const limits = result.limits || {};
  const lim = limits[domain];

  const statusEl = document.getElementById('limitStatus');
  const limitInput = document.getElementById('limitInput');
  const snoozeInput = document.getElementById('snoozeInput');
  const removeBtn = document.getElementById('removeLimitBtn');

  if (lim) {
    limitInput.value = Math.round(lim.limitSecs / 60);
    snoozeInput.value = Math.round(lim.snoozeSecs / 60);
    removeBtn.style.display = 'block';
    if (todaySeconds >= lim.limitSecs) {
      statusEl.className = 'limit-status exceeded';
      statusEl.textContent = `⚠ Limit exceeded (${formatTime(todaySeconds)} of ${formatTime(lim.limitSecs)})`;
    } else {
      statusEl.className = 'limit-status set';
      statusEl.textContent = `${formatTime(todaySeconds)} of ${formatTime(lim.limitSecs)} used today`;
    }
  } else {
    statusEl.className = 'limit-status';
    statusEl.textContent = todaySeconds > 0
      ? `${formatTime(todaySeconds)} spent today — no daily limit set`
      : 'No time logged today — no daily limit set';
    removeBtn.style.display = 'none';
  }

  document.getElementById('saveLimitBtn').onclick = async () => {
    const limitMins = parseInt(limitInput.value);
    const snoozeMins = parseInt(snoozeInput.value);
    if (!limitMins || limitMins < 1 || !snoozeMins || snoozeMins < 1) return;
    limits[domain] = { limitSecs: limitMins * 60, snoozeSecs: snoozeMins * 60 };
    await chrome.storage.local.set({ limits });
    await loadLimitSection(domain, todaySeconds);
  };

  document.getElementById('removeLimitBtn').onclick = async () => {
    delete limits[domain];
    await chrome.storage.local.set({ limits });
    await loadLimitSection(domain, todaySeconds);
  };
}

loadPopup();
