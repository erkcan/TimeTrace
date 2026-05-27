// background.js — TimeTrace service worker

const IDLE_THRESHOLD_SEC = 60;
const DEFAULT_INACTIVITY_TIMEOUT_SEC = 300; // 5 minutes

let activeTabId = null;
let activeWindowId = null;
let activeDomain = null;
let activeFavicon = null;
let activeTabAudible = false;
let lastTickTime = null;
let lastInteractionTime = null;
let isIdle = false;
let inactivityTimeoutSec = DEFAULT_INACTIVITY_TIMEOUT_SEC;
let keepAwakeActive = false;

function requestKeepAwake() {
  if (keepAwakeActive) return;
  chrome.power.requestKeepAwake('display');
  keepAwakeActive = true;
  dbg('power', 'requestKeepAwake(display) — audible tab active');
}

function releaseKeepAwake() {
  if (!keepAwakeActive) return;
  chrome.power.releaseKeepAwake();
  keepAwakeActive = false;
  dbg('power', 'releaseKeepAwake() — tab silent or inactive');
}

const debugLog = []; // ring buffer
const DEBUG_MAX = 1000;

async function loadSettings() {
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || {};
  inactivityTimeoutSec = (settings.inactivityTimeoutMins || DEFAULT_INACTIVITY_TIMEOUT_SEC / 60) * 60;

}

function dbg(type, msg) {
  const entry = { time: new Date().toISOString(), type, msg };
  debugLog.push(entry);
  if (debugLog.length > DEBUG_MAX) debugLog.shift();
}

// ─── Limit state (in-memory, resets each browser session) ────────────────────
// { [domain]: { notifiedAt: epochMs|null, snoozedUntil: epochMs|null } }
let limitState = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDomain(url) {
  try {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return null;
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function sanitiseFavicon(url) {
  if (!url) return '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return '';
  return url;
}

function todayDateString() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoWeekMonday() {
  const d = new Date();
  const day = d.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysFromMonday);
  return `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
}

function formatMinutes(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Core data model ──────────────────────────────────────────────────────────
//
//  "site:{domain}"  → { url, favicon, summaryTime, counter, days: [...] }
//  "day:{YYYY-MM-DD}:{domain}"  → seconds
//  "day:{YYYY-MM-DD}:__total__" → seconds
//  "week:week-{YYYY-MM-DD}:{domain}" → seconds
//  "week:week-{YYYY-MM-DD}:__total__" → seconds
//  "all:{domain}"    → seconds
//  "all:__total__"   → seconds
//  "limits"          → { [domain]: { limitSecs: number, snoozeSecs: number } }

// Records a visit only if today has no counter entry yet for this domain.
// Used on tab switches to count "first visit today" without inflating
// the counter for back-and-forth switching between open tabs.
async function recordVisitIfFirstToday(domain, favicon) {
  if (!domain) return;
  const key = `site:${domain}`;
  const result = await chrome.storage.local.get(key);
  const entry = result[key] || { url: domain, favicon: favicon || '', summaryTime: 0, counter: 0, days: [] };
  const today = todayDateString();
  const dayEntry = entry.days.find(d => d.date === today);
  // Only count if today has no visit yet
  if (dayEntry && (dayEntry.counter || 0) > 0) return;
  // Delegate to recordVisit which handles all the incrementing correctly
  await recordVisit(domain, favicon);
}

async function recordVisit(domain, favicon) {
  if (!domain) return;
  const key = `site:${domain}`;
  const result = await chrome.storage.local.get(key);
  const entry = result[key] || { url: domain, favicon: favicon || '', summaryTime: 0, counter: 0, days: [] };

  if (favicon && !entry.favicon) entry.favicon = favicon;
  entry.counter = (entry.counter || 0) + 1;

  const today = todayDateString();
  const dayEntry = entry.days.find(d => d.date === today);
  if (dayEntry) {
    dayEntry.counter = (dayEntry.counter || 0) + 1;
  } else {
    entry.days.push({ date: today, summary: 0, counter: 1 });
  }

  await chrome.storage.local.set({ [key]: entry });
}

async function addTime(domain, seconds) {
  if (!domain || seconds <= 0) return;

  const today = isoToday();
  const todayDisplay = todayDateString();
  const week = `week-${isoWeekMonday()}`;

  const aggKeys = [
    `day:${today}:${domain}`,
    `week:${week}:${domain}`,
    `all:${domain}`,
    `day:${today}:__total__`,
    `week:${week}:__total__`,
    `all:__total__`
  ];
  const existing = await chrome.storage.local.get(aggKeys);
  const updates = {};
  for (const k of aggKeys) updates[k] = (existing[k] || 0) + seconds;

  const key = `site:${domain}`;
  const siteResult = await chrome.storage.local.get(key);
  const entry = siteResult[key] || { url: domain, favicon: activeFavicon || '', summaryTime: 0, counter: 0, days: [] };

  entry.summaryTime = (entry.summaryTime || 0) + seconds;
  if (activeFavicon && !entry.favicon) entry.favicon = activeFavicon;

  const dayEntry = entry.days.find(d => d.date === todayDisplay);
  if (dayEntry) {
    dayEntry.summary = (dayEntry.summary || 0) + seconds;
  } else {
    entry.days.push({ date: todayDisplay, summary: seconds, counter: 0 });
  }

  updates[key] = entry;
  await chrome.storage.local.set(updates);

  // Check limits after saving
  await checkLimit(domain, updates[`day:${today}:${domain}`]);
}

// ─── Limit checking ───────────────────────────────────────────────────────────

async function checkLimit(domain, todaySeconds) {
  const result = await chrome.storage.local.get('limits');
  const limits = result.limits || {};
  const limit = limits[domain];
  if (!limit) return;

  const { limitSecs, snoozeSecs } = limit;
  if (todaySeconds < limitSecs) {
    // Reset state if we're back under the limit (e.g. after data clear)
    limitState[domain] = null;
    return;
  }

  const now = Date.now();
  const state = limitState[domain];

  // If snoozed, check if snooze has expired
  if (state?.snoozedUntil && now < state.snoozedUntil) return;

  // Fire notification
  const overBy = todaySeconds - limitSecs;
  dbg('limit', `${domain} exceeded limit: ${todaySeconds}s / ${limitSecs}s, over by ${overBy}s, snooze=${snoozeSecs}s`);
  chrome.notifications.create(`limit-${domain}-${now}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `Time limit reached — ${domain}`,
    message: `You've spent ${formatMinutes(todaySeconds)} today (limit: ${formatMinutes(limitSecs)}, over by ${formatMinutes(overBy)}).`,
    buttons: [{ title: `Snooze ${formatMinutes(snoozeSecs)}` }],
    requireInteraction: false,
  });

  limitState[domain] = { snoozedUntil: now + snoozeSecs * 1000 };
}

chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
  if (btnIndex === 0 && notifId.startsWith('limit-')) {
    const domain = notifId.split('-')[1];
    chrome.storage.local.get('limits', (result) => {
      const limits = result.limits || {};
      const snoozeSecs = limits[domain]?.snoozeSecs || 300;
      limitState[domain] = { snoozedUntil: Date.now() + snoozeSecs * 1000 };
    });
    chrome.notifications.clear(notifId);
  }
});

// ─── Tick ─────────────────────────────────────────────────────────────────────

async function tick() {
  if (isIdle) {
    dbg('tick', `skipping tick — system idle | activeDomain=${activeDomain} | lastTickTime=${lastTickTime ? 'set' : 'null'}`);
    // Do NOT reset lastTickTime here — we need it intact for creditAudibleGap
    return;
  }
  if (!activeDomain) {
    dbg('tick', 'skipping tick — no active domain');
    lastTickTime = Date.now();
    return;
  }

  // Re-read the active tab's audible state on every tick.
  // Chrome MV3 service workers can be suspended and miss onUpdated events,
  // so we can't rely on event-driven audible state alone.
  if (activeTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      const freshAudible = tab.audible || false;
      if (freshAudible !== activeTabAudible) {
        activeTabAudible = freshAudible;
        if (freshAudible) {
          lastInteractionTime = Date.now();
          requestKeepAwake();
        } else {
          releaseKeepAwake();
        }
        dbg('audible', `${activeDomain} audible re-read → ${freshAudible} (corrected from event state)`);
      }
    } catch { /* tab may have closed */ }
  }

  const now = Date.now();

  // Pause if tab has been silent and inactive for too long
  if (!activeTabAudible && lastInteractionTime !== null) {
    const silentSec = Math.round((now - lastInteractionTime) / 1000);
    if (silentSec > inactivityTimeoutSec) {
      dbg('pause', `${activeDomain} — silent & inactive for ${silentSec}s (threshold: ${inactivityTimeoutSec}s), not counting`);
      lastTickTime = now;
      return;
    }
  }

  if (lastTickTime) {
    const capped = Math.min(Math.round((now - lastTickTime) / 1000), 10);
    if (capped > 0) {
      dbg('track', `${activeDomain} +${capped}s | audible=${activeTabAudible} | inactiveSec=${lastInteractionTime ? Math.round((now - lastInteractionTime)/1000) : 'n/a'}`);
      await addTime(activeDomain, capped);
    }
  }
  lastTickTime = now;
}

// ─── Tab / window tracking ───────────────────────────────────────────────────

// Credit any gap since lastTickTime to the previous domain if it was audible.
// Called before switching away from a tab so suspended-worker time isn't lost.
function creditAudibleGap(reason) {
  dbg('credit', `creditAudibleGap(${reason}) — activeTabAudible=${activeTabAudible} activeDomain=${activeDomain} lastTickTime=${lastTickTime ? 'set' : 'null'}`);
  if (!activeTabAudible || !activeDomain || !lastTickTime) {
    dbg('credit', `creditAudibleGap bailed — guards failed`);
    return;
  }
  const gapSec = Math.round((Date.now() - lastTickTime) / 1000);
  dbg('credit', `creditAudibleGap gapSec=${gapSec}`);
  if (gapSec > 10) {
    dbg('credit', `Adding ${gapSec}s (${formatMinutes(gapSec)}) for ${activeDomain} [reason: ${reason}]`);
    addTime(activeDomain, gapSec);
  }
}

async function updateActiveTab(tabId, windowId) {
  try {
    creditAudibleGap('tab switch');
    const tab = await chrome.tabs.get(tabId);
    const newDomain = getDomain(tab.url);
    // Count as a visit if this is the first time today switching to this domain
    if (newDomain && newDomain !== activeDomain) {
      recordVisitIfFirstToday(newDomain, sanitiseFavicon(tab.favIconUrl));
    }
    activeDomain = newDomain;
    activeFavicon = sanitiseFavicon(tab.favIconUrl);
    activeTabAudible = tab.audible || false;
    activeTabId = tabId;
    activeWindowId = windowId;
    lastTickTime = Date.now();
    lastInteractionTime = Date.now();
    if (activeTabAudible) requestKeepAwake(); else releaseKeepAwake();
    dbg('tab', `switched to ${activeDomain || 'none'} | audible=${activeTabAudible}`);
  } catch { activeDomain = null; activeFavicon = null; activeTabAudible = false; releaseKeepAwake(); }
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => updateActiveTab(tabId, windowId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== activeTabId) return;
  const newDomain = changeInfo.url ? getDomain(changeInfo.url) : activeDomain;
  const isNewDomain = newDomain && newDomain !== activeDomain;
  if (changeInfo.url) {
    activeDomain = newDomain;
    lastTickTime = Date.now();
    lastInteractionTime = Date.now();
  }
  if (tab.favIconUrl) activeFavicon = sanitiseFavicon(tab.favIconUrl);
  if ('audible' in changeInfo) {
    if (!changeInfo.audible) creditAudibleGap('audio stopped');
    activeTabAudible = changeInfo.audible;
    if (changeInfo.audible) {
      lastInteractionTime = Date.now();
      requestKeepAwake();
    } else {
      releaseKeepAwake();
    }
    dbg('audible', `${activeDomain} audible changed → ${changeInfo.audible}`);
  }
  if (isNewDomain) recordVisit(newDomain, tab.favIconUrl || activeFavicon);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    creditAudibleGap('window focus lost');
    activeDomain = null; activeFavicon = null; lastTickTime = null;
    dbg('focus', 'window lost focus (WINDOW_ID_NONE) — releasing wake lock');
    releaseKeepAwake();
  } else {
    dbg('focus', `window focus changed to windowId=${windowId}`);
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (tabs[0]) updateActiveTab(tabs[0].id, windowId);
    });
  }
});

// ─── Idle ────────────────────────────────────────────────────────────────────

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SEC);
chrome.idle.onStateChanged.addListener((state) => {
  isIdle = state !== 'active';
  dbg('idle', `system idle state changed → ${state} | activeTabAudible=${activeTabAudible}`);
  if (!isIdle) {
    if (activeTabAudible && activeDomain && lastTickTime) {
      // Credit the idle gap immediately while we know the full extent of it.
      // After this, normal 5s ticks resume from a fresh lastTickTime.
      const gapSec = Math.round((Date.now() - lastTickTime) / 1000);
      if (gapSec > 10) {
        dbg('credit', `Adding ${gapSec}s (${formatMinutes(gapSec)}) for ${activeDomain} [reason: returning from idle]`);
        addTime(activeDomain, gapSec);
      }
    }
    lastTickTime = Date.now();
    lastInteractionTime = Date.now();
    if (activeTabAudible) requestKeepAwake();
  } else {
    // Only release the wake lock if the tab is not playing audio.
    // If audio is playing, the user is passively engaged (watching a video)
    // and we should keep the worker alive regardless of input inactivity.
    if (!activeTabAudible) releaseKeepAwake();
    else dbg('idle', 'system idle but tab is audible — keeping wake lock');
  }
});

// ─── Alarm tick ──────────────────────────────────────────────────────────────

chrome.alarms.create('tick', { periodInMinutes: 1 / 12 });
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') tick();
  if (alarm.name === 'heartbeat') {
    const entry = {
      time: new Date().toISOString(),
      activeDomain,
      activeTabAudible,
      lastTickTime: lastTickTime ? new Date(lastTickTime).toISOString() : null,
      isIdle,
    };
    chrome.storage.local.set({ lastHeartbeat: entry });
    dbg('worker', `heartbeat — domain=${activeDomain} audible=${activeTabAudible} idle=${isIdle}`);
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

function initActiveTab() {
  loadSettings().then(() => {
    dbg('worker', `service worker started/restarted`);
  });
  // Write restart timestamp to storage so it survives the in-memory log wipe
  chrome.storage.local.get('workerRestarts', (result) => {
    const restarts = result.workerRestarts || [];
    restarts.push(new Date().toISOString());
    if (restarts.length > 50) restarts.shift(); // keep last 50
    chrome.storage.local.set({ workerRestarts: restarts });
  });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) updateActiveTab(tabs[0].id, tabs[0].windowId);
  });
}
chrome.runtime.onStartup.addListener(initActiveTab);
chrome.runtime.onInstalled.addListener(initActiveTab);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) loadSettings();
});

// ─── Messages ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATUS') {
    const inactiveSec = lastInteractionTime ? Math.round((Date.now() - lastInteractionTime) / 1000) : 0;
    const isInactive = !activeTabAudible && inactiveSec > inactivityTimeoutSec;
    sendResponse({ domain: activeDomain, idle: isIdle, audible: activeTabAudible, inactive: isInactive, inactiveSec });
  }
  if (msg.type === 'GET_DEBUG_LOG') {
    sendResponse({ log: debugLog });
    return true;
  }
  if (msg.type === 'GET_LIMITS') {
    chrome.storage.local.get('limits', (result) => {
      sendResponse({ limits: result.limits || {} });
    });
    return true;
  }
  if (msg.type === 'SET_LIMITS') {
    chrome.storage.local.set({ limits: msg.limits }, () => sendResponse({ ok: true }));
    return true;
  }
  return true;
});
