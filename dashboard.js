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

// Returns the last 8 weeks as objects { label, isoMonday, isCurrentWeek }
// Each week runs Mon–Sun; the last entry is the current (possibly incomplete) week.
function last8Weeks() {
  const today = new Date();
  const day = today.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  // Find this week's Monday
  const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysFromMonday);
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const monday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - i * 7);
    const isoMonday = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const label = `${monday.getMonth() + 1}/${monday.getDate()}`;
    weeks.push({ label, isoMonday, isCurrentWeek: i === 0 });
  }
  return weeks;
}

// Convert M/D/YYYY → YYYY-MM-DD for matching against ISO keys
function displayDateToISO(dateStr) {
  const [m, d, y] = dateStr.split('/');
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Chart tooltip ────────────────────────────────────────────────────────────

let tooltipTimer = null;

function attachTooltips(selector) {
  const tooltip = document.getElementById('chartTooltip');
  document.querySelectorAll(selector).forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      clearTimeout(tooltipTimer);
      tooltipTimer = setTimeout(() => {
        // Chart bars: tip pre-built in data-tip
        // Table rows: compute stats lazily on first hover, then cache in data-tip
        let tip = el.dataset.tip;
        if (!tip && el.classList.contains('table-row') && el.dataset.domain) {
          const stats = getDomainStats(el.dataset.domain);
          if (stats) {
            tip = [
              `First visited: ${stats.firstDate}  •  Last visited: ${stats.lastDate}`,
              `Total visits: ${stats.totalVisits}  •  Active days: ${stats.activeDays}`,
              `Avg per active day: ${formatTime(stats.avgPerDay)}  •  Avg per visit: ${formatTime(stats.avgPerVisit)}`,
              `Longest day: ${stats.longestDate} — ${formatTime(stats.longestSecs)}`,
              `Current streak: ${stats.streak} day${stats.streak !== 1 ? 's' : ''}`,
              `Longest streak: ${stats.longestStreak} day${stats.longestStreak !== 1 ? 's' : ''}`,
            ].join('|');
            el.dataset.tip = tip; // cache for subsequent hovers
          }
        }
        if (!tip) return;
        tooltip.innerHTML = tip.split('|').map(l => `<div>${l}</div>`).join('');
        tooltip.classList.add('visible');
        positionTooltip(e);
      }, 300);
    });
    el.addEventListener('mousemove', positionTooltip);
    el.addEventListener('mouseleave', () => {
      clearTimeout(tooltipTimer);
      tooltip.classList.remove('visible');
    });
  });
}

function attachChartTooltips() {
  attachTooltips('.chart-bar[data-tip]');
}

function positionTooltip(e) {
  const tooltip = document.getElementById('chartTooltip');
  const margin = 12;
  let x = e.clientX + margin;
  let y = e.clientY - tooltip.offsetHeight - margin;
  if (x + tooltip.offsetWidth > window.innerWidth) x = e.clientX - tooltip.offsetWidth - margin;
  if (y < 0) y = e.clientY + margin;
  tooltip.style.left = `${x}px`;
  tooltip.style.top  = `${y}px`;
}

let currentPeriod = 'day';
let allData = {};
let limits = {}; // { [domain]: { limitSecs, snoozeSecs } }
let mergeDomains = false;
let searchQuery = '';

// ─── Two-part TLD detection ──────────────────────────────────────────────────
// We use a heuristic rather than the full Mozilla Public Suffix List
// (https://publicsuffix.org) to keep the implementation short and dependency-free.
// The heuristic: if the TLD is a 2-character country code AND the label before it
// is one of the well-known second-level registry labels used across country TLDs,
// treat the pair as a two-part TLD (e.g. co.uk, com.au, gov.in, ac.jp).
const TWO_PART_TLD_LABELS = new Set([
  'co','com','gov','ac','edu','net','org','sch','ltd','plc','or','ne','ad','govt'
]);

function getRootDomain(domain) {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  // Two-part TLD: 2-char country code + known registry label (e.g. co.uk, com.au)
  if (tld.length === 2 && TWO_PART_TLD_LABELS.has(sld)) {
    return parts.slice(-3).join('.');
  }
  // Default: last two parts (e.g. github.com, forge-vtt.com)
  return parts.slice(-2).join('.');
}

function mergeDomainsByRoot(domains) {
  if (!mergeDomains) return domains;
  const groups = {};
  for (const item of domains) {
    const root = getRootDomain(item.domain);
    if (!groups[root]) {
      groups[root] = { domain: root, seconds: 0, favicon: item.favicon, subdomains: [] };
    }
    groups[root].seconds += item.seconds;
    groups[root].subdomains.push(item);
    // Prefer favicon from exact root domain match
    if (item.domain === root) groups[root].favicon = item.favicon;
  }
  return Object.values(groups).sort((a, b) => b.seconds - a.seconds);
}

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
  mergeDomains = settings.mergeDomains || false;
  const mergeToggle = document.getElementById('mergeDomainsToggle');
  if (mergeToggle) mergeToggle.checked = mergeDomains;
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

// Returns the earliest M/D/YYYY date string across all site entries,
// converted to a human-readable string like "Mar 15, 2024"
function getEarliestDate() {
  let earliest = null;
  for (const [key, value] of Object.entries(allData)) {
    if (!key.startsWith('site:')) continue;
    for (const day of (value.days || [])) {
      if (!day.date) continue;
      const [m, d, y] = day.date.split('/').map(Number);
      const ts = new Date(y, m - 1, d).getTime();
      if (earliest === null || ts < earliest) earliest = ts;
    }
  }
  if (!earliest) return null;
  return new Date(earliest).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Domain stats for All Time tooltip ───────────────────────────────────────

function parseDayDate(dateStr) {
  // M/D/YYYY → Date object at local noon
  const [m, d, y] = dateStr.split('/').map(Number);
  return new Date(y, m - 1, d);
}

function isoFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getDomainStats(domain) {
  // Collect stats from site: entry for this domain (or merged subdomains)
  // When merge is on, always aggregate all subdomains whose root matches —
  // even if there's a direct site: entry for the root domain itself.
  const domains = (mergeDomains && getRootDomain(domain) === domain)
    ? Object.keys(allData).filter(k => k.startsWith('site:') && getRootDomain(k.slice(5)) === domain).map(k => k.slice(5))
    : [domain];

  let allDays = [];
  let totalVisits = 0;

  for (const d of domains) {
    const entry = allData[`site:${d}`];
    if (!entry) continue;
    totalVisits += entry.counter || 0;
    for (const day of (entry.days || [])) {
      if (!day.date) continue;
      const existing = allDays.find(x => x.date === day.date);
      if (existing) {
        existing.summary += day.summary || 0;
        existing.counter += day.counter || 0;
      } else {
        allDays.push({ date: day.date, summary: day.summary || 0, counter: day.counter || 0 });
      }
    }
  }

  if (allDays.length === 0) return null;

  // Sort by date
  allDays.sort((a, b) => parseDayDate(a.date) - parseDayDate(b.date));

  const firstDate = parseDayDate(allDays[0].date);
  const lastDate  = parseDayDate(allDays[allDays.length - 1].date);
  const activeDays = allDays.length;
  const totalSecs = allDays.reduce((s, d) => s + d.summary, 0);
  const avgPerDay = activeDays > 0 ? Math.round(totalSecs / activeDays) : 0;
  const avgPerVisit = totalVisits > 0 ? Math.round(totalSecs / totalVisits) : 0;

  // Longest day
  const longest = allDays.reduce((best, d) => d.summary > best.summary ? d : best, allDays[0]);
  const longestDate = parseDayDate(longest.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Current streak — consecutive days up to and including today
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const daySet = new Set(allDays.map(d => isoFromDate(parseDayDate(d.date))));
  let streak = 0;
  const cursor = new Date(todayDate);
  while (daySet.has(isoFromDate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // Longest streak — max consecutive calendar days anywhere in history
  let longestStreak = 0;
  let currentRun = 1;
  for (let i = 1; i < allDays.length; i++) {
    const prev = parseDayDate(allDays[i - 1].date);
    const curr = parseDayDate(allDays[i].date);
    const diffDays = Math.round((curr - prev) / 86400000);
    if (diffDays === 1) {
      currentRun++;
      if (currentRun > longestStreak) longestStreak = currentRun;
    } else {
      currentRun = 1;
    }
  }
  if (longestStreak === 0 && allDays.length > 0) longestStreak = 1;

  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return {
    firstDate: fmt(firstDate),
    lastDate:  fmt(lastDate),
    totalVisits,
    activeDays,
    avgPerDay,
    avgPerVisit,
    longestDate,
    longestSecs: longest.summary,
    streak,
    longestStreak,
  };
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  // Don't rebuild the table while a limit editor is open — it would close it
  if (document.querySelector('.limit-editor.open')) return;
  const now = new Date();
  document.getElementById('headerDate').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const { domains: rawDomains, total } = getDomainsForPeriod(currentPeriod);
  const merged = mergeDomainsByRoot(rawDomains);
  const domains = searchQuery
    ? merged.filter(d => d.domain.toLowerCase().includes(searchQuery))
    : merged;

  document.getElementById('statTotal').textContent = formatTime(total);
  if (currentPeriod === 'all') {
    const since = getEarliestDate();
    document.getElementById('statTotalSub').textContent = since ? `since ${since}` : 'all time';
  } else {
    document.getElementById('statTotalSub').textContent = { day: 'today', week: 'this week' }[currentPeriod];
  }
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
  const todayIso = isoLocalDate(0);

  function buildLimitBadge(item) {
    const subs = item.subdomains || [item]; // use subdomains if merged, else self
    const totalLimitSecs = subs.reduce((s, d) => s + (limits[d.domain]?.limitSecs || 0), 0);
    const totalTodaySecs = subs.reduce((s, d) => s + (allData[`day:${todayIso}:${d.domain}`] || 0), 0);
    const anyExceeded = subs.some(d => {
      const lim = limits[d.domain];
      return lim && (allData[`day:${todayIso}:${d.domain}`] || 0) >= lim.limitSecs;
    });
    const allExceeded = totalLimitSecs > 0 && totalTodaySecs >= totalLimitSecs;
    const hasLimit = totalLimitSecs > 0;
    const label = hasLimit ? `⏱ ${formatTime(totalLimitSecs)}` : `+ limit`;
    const cls = hasLimit
      ? (allExceeded ? 'limit-badge set exceeded' : anyExceeded ? 'limit-badge set partial' : 'limit-badge set')
      : 'limit-badge';
    return { label, cls, hasLimit };
  }

  function buildLimitEditor(item, i) {
    const subs = item.subdomains || [item];
    if (subs.length === 1) {
      // Single domain — original editor
      const lim = limits[subs[0].domain];
      const limitInputVal = lim ? Math.round(lim.limitSecs / 60) : '';
      const snoozeInputVal = lim ? Math.round(lim.snoozeSecs / 60) : 15;
      return `
        <div class="limit-editor" id="limit-editor-${i}" data-domain="${subs[0].domain}">
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
    }
    // Merged domain — show each subdomain separately
    const subsHtml = subs.map(sub => {
      const lim = limits[sub.domain];
      const limitVal = lim ? Math.round(lim.limitSecs / 60) : '';
      const snoozeVal = lim ? Math.round(lim.snoozeSecs / 60) : 15;
      const todaySecs = allData[`day:${todayIso}:${sub.domain}`] || 0;
      return `
        <div class="merged-subdomain-row" data-domain="${sub.domain}">
          <span class="merged-subdomain-name">${sub.domain}</span>
          <span class="merged-subdomain-time">${formatTime(todaySecs)}</span>
          <div class="limit-field" style="flex-shrink:0">
            <input type="number" min="1" class="sub-limit-input" placeholder="limit" value="${limitVal}" style="width:65px" title="Daily limit (minutes)">
          </div>
          <div class="limit-field" style="flex-shrink:0">
            <input type="number" min="1" class="sub-snooze-input" placeholder="snooze" value="${snoozeVal}" style="width:65px" title="Snooze (minutes)">
          </div>
          <button class="limit-save" style="padding:4px 10px;font-size:10px" data-subdomain="${sub.domain}">Save</button>
          <button class="limit-remove" style="padding:4px 10px;font-size:10px" data-subdomain="${sub.domain}">✕</button>
        </div>`;
    }).join('');
    return `
      <div class="limit-editor" id="limit-editor-${i}" data-merged="true">
        <div class="merged-subdomains">${subsHtml}</div>
      </div>`;
  }

  tbody.innerHTML = domains.map((item, i) => {
    const pct = total > 0 ? ((item.seconds / total) * 100).toFixed(1) : '0.0';
    const barWidth = Math.round((item.seconds / maxSec) * 100);
    const faviconHtml = `<img src="${faviconUrl(item.domain)}" class="favicon" data-fallback>`;
    const { label: limitLabel, cls: badgeClass } = buildLimitBadge(item);


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
      ${buildLimitEditor(item, i)}`;
  }).join('');

  // Hide broken favicon images
  tbody.querySelectorAll('img.favicon[data-fallback]').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });

  // Attach row tooltips — stats computed lazily on first hover
  attachTooltips('.table-row[data-domain]');

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

  // Save limit — handles both single and merged subdomain rows
  tbody.querySelectorAll('.limit-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const editor = btn.closest('.limit-editor');
      if (editor.dataset.merged) {
        // Merged subdomain row
        const row = btn.closest('.merged-subdomain-row');
        const domain = row.dataset.domain;
        const limitMins = parseInt(row.querySelector('.sub-limit-input').value);
        const snoozeMins = parseInt(row.querySelector('.sub-snooze-input').value);
        if (!limitMins || limitMins < 1) { showToast('Enter a valid limit in minutes', 'error'); return; }
        if (!snoozeMins || snoozeMins < 1) { showToast('Enter a valid snooze period in minutes', 'error'); return; }
        limits[domain] = { limitSecs: limitMins * 60, snoozeSecs: snoozeMins * 60 };
        await chrome.storage.local.set({ limits });
        showToast(`Limit set for ${domain}`);
        render();
      } else {
        // Single domain row
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
      }
    });
  });

  // Remove limit — handles both single and merged subdomain rows
  tbody.querySelectorAll('.limit-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const editor = btn.closest('.limit-editor');
      if (editor.dataset.merged) {
        const row = btn.closest('.merged-subdomain-row');
        const domain = row.dataset.domain;
        delete limits[domain];
        await chrome.storage.local.set({ limits });
        showToast(`Limit removed for ${domain}`);
        render();
      } else {
        const domain = editor.dataset.domain;
        delete limits[domain];
        await chrome.storage.local.set({ limits });
        editor.classList.remove('open');
        showToast(`Limit removed for ${domain}`);
        render();
      }
    });
  });
}

function renderChart(period) {
  if (period === 'week') {
    renderWeeklyChart();
  } else {
    renderDailyChart();
  }
}

function renderDailyChart() {
  document.getElementById('chartTitle').textContent = 'Daily breakdown — last 7 days';
  const days = last7Days();
  const todayStr = isoLocalDate(0);
  const maxVal = Math.max(1, ...days.map(d => allData[`day:${d}:__total__`] || 0));
  document.getElementById('chartBars').innerHTML = days.map(dateStr => {
    const val = allData[`day:${dateStr}:__total__`] || 0;
    const heightPct = Math.max(2, Math.round((val / maxVal) * 100));
    const d = new Date(dateStr + 'T12:00:00');
    const isToday = dateStr === todayStr;
    return `
      <div class="chart-col">
        <div class="chart-bar ${isToday ? 'today' : val > 0 ? 'has-data' : ''}" style="height:${heightPct}%" data-tip="${DAY_NAMES[d.getDay()]}: ${formatTime(val)}"></div>
        <div class="chart-day-label ${isToday ? 'today' : ''}">${DAY_NAMES[d.getDay()]}</div>
      </div>`;
  }).join('');
  attachChartTooltips();
}

function renderWeeklyChart() {
  document.getElementById('chartTitle').textContent = 'Weekly breakdown — last 8 weeks';
  const weeks = last8Weeks();
  // Sum daily totals for each week
  const weekTotals = weeks.map(({ label, isoMonday, isCurrentWeek }) => {
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(isoMonday + 'T12:00:00');
      d.setDate(d.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      total += allData[`day:${iso}:__total__`] || 0;
    }
    return { label, isoMonday, isCurrentWeek, total };
  });
  const maxVal = Math.max(1, ...weekTotals.map(w => w.total));
  document.getElementById('chartBars').innerHTML = weekTotals.map(({ label, total, isCurrentWeek }) => {
    const heightPct = Math.max(2, Math.round((total / maxVal) * 100));
    const opacity = isCurrentWeek ? '0.5' : '1';
    const barClass = total > 0 ? 'has-data' : '';
    const tip = isCurrentWeek ? `w/c ${label} (current): ${formatTime(total)}` : `w/c ${label}: ${formatTime(total)}`;
    return `
      <div class="chart-col">
        <div class="chart-bar ${barClass}" style="height:${heightPct}%;opacity:${opacity}" data-tip="${tip}"></div>
        <div class="chart-day-label ${isCurrentWeek ? 'today' : ''}">${label}</div>
      </div>`;
  }).join('');
  attachChartTooltips();
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

// Table search
document.getElementById('tableSearch').addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase().trim();
  document.getElementById('searchClear').classList.toggle('visible', searchQuery.length > 0);
  render();
});

document.getElementById('searchClear').addEventListener('click', () => {
  document.getElementById('tableSearch').value = '';
  searchQuery = '';
  document.getElementById('searchClear').classList.remove('visible');
  render();
});

// Merge subdomains toggle
document.getElementById('mergeDomainsToggle').addEventListener('change', async (e) => {
  mergeDomains = e.target.checked;
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || {};
  settings.mergeDomains = mergeDomains;
  await chrome.storage.local.set({ settings });
  render();
});

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
