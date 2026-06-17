/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  setupSyncAlarm();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  setupSyncAlarm();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Click listener ──────────────────────────────────────────────────────────

// Open index.html when the extension icon is clicked
chrome.action.onClicked.addListener(async () => {
  const extensionId = chrome.runtime.id;
  const indexUrl = `chrome-extension://${extensionId}/index.html`;

  // Check if any Tab Out page is already open
  const tabs = await chrome.tabs.query({});
  const tabOutTabs = tabs.filter(t => t.url === indexUrl);

  if (tabOutTabs.length > 0) {
    // If we have existing tabs, keep the first one and focus it
    const keep = tabOutTabs[0];
    await chrome.tabs.update(keep.id, { active: true });
    
    // If it's in a different window, focus that window too
    await chrome.windows.update(keep.windowId, { focused: true });

    // Close any other Tab Out tabs if there are more than one
    if (tabOutTabs.length > 1) {
      const toClose = tabOutTabs.slice(1).map(t => t.id);
      await chrome.tabs.remove(toClose);
    }
  } else {
    // No existing Tab Out page, open a new one
    chrome.tabs.create({ url: 'index.html' });
  }
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();


/* ================================================================================
   VISIT TRACKING — Record URL visits for "Hot Sites" feature

   Tracks which domains the user visits and how often.
   Data is stored in chrome.storage.local under the "visitHistory" key.

   Data shape:
   {
     visits: {
       "github.com": {
         count: 42,
         lastVisit: "2026-06-16T10:00:00.000Z",
         dailyCounts: {
           "2026-06-16": 5,
           "2026-06-15": 8,
           ...
         }
       },
       ...
     },
     hotSyncServer: "",   // Configured server URL for team hot sites
     hotSyncUserId: "",    // Unique user ID for syncing
     hotSyncInterval: 30   // Sync interval in minutes
   }
   ================================================================================ */

// Domains to ignore (browser internals, extension pages, etc.)
const IGNORED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'about:',
  'edge://',
  'brave://',
  'file://',
  'devtools://',
];

// Domains that are too generic to track
const IGNORED_DOMAINS = new Set([
  'newtab',
  'localhost',
  '127.0.0.1',
]);

/**
 * normalizeDomain(hostname)
 *
 * Standardizes a hostname for deduplication:
 *  - Lowercase
 *  - Remove trailing dot
 *  - Strip leading "www."
 * This ensures "www.github.com" and "github.com" are counted as the same site.
 */
function normalizeDomain(hostname) {
  let domain = (hostname || '').toLowerCase().trim();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (domain.startsWith('www.')) domain = domain.slice(4);
  return domain;
}

/**
 * isTrackableUrl(url)
 *
 * Returns true if the URL should be tracked as a visit.
 */
function isTrackableUrl(url) {
  if (!url) return false;
  for (const prefix of IGNORED_URL_PREFIXES) {
    if (url.startsWith(prefix)) return false;
  }
  try {
    const u = new URL(url);
    if (IGNORED_DOMAINS.has(u.hostname)) return false;
    if (!u.hostname.includes('.')) return false; // skip bare hostnames
  } catch {
    return false;
  }
  return true;
}

/**
 * recordVisit(url)
 *
 * Records a visit to the given URL in chrome.storage.local.
 * Only increments the count once per tab activation (not on every navigation within a page).
 * Prunes daily counts older than 30 days.
 */
async function recordVisit(url) {
  if (!isTrackableUrl(url)) return;

  let domain;
  try {
    domain = normalizeDomain(new URL(url).hostname);
  } catch { return; }
  if (!domain) return;

  try {
    const data = await chrome.storage.local.get('visitHistory');
    const history = data.visitHistory || { visits: {} };
    if (!history.visits) history.visits = {};

    const today = new Date().toISOString().slice(0, 10); // "2026-06-16"
    const now = new Date().toISOString();

    if (!history.visits[domain]) {
      history.visits[domain] = {
        count: 0,
        lastVisit: now,
        dailyCounts: {},
      };
    }

    const entry = history.visits[domain];
    entry.count += 1;
    entry.lastVisit = now;
    entry.dailyCounts[today] = (entry.dailyCounts[today] || 0) + 1;

    // Prune daily counts older than 30 days (needed for weighted score calculation)
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    const cutoff = monthAgo.toISOString().slice(0, 10);
    for (const date of Object.keys(entry.dailyCounts)) {
      if (date < cutoff) delete entry.dailyCounts[date];
    }

    await chrome.storage.local.set({ visitHistory: history });
  } catch (err) {
    console.warn('[tab-out] Failed to record visit:', err);
  }
}

// Track the last recorded URL per tab to avoid double-counting navigations
const lastRecordedUrlPerTab = new Map();

// ─── Visit tracking event listeners ──────────────────────────────────────────

// Record when a tab finishes loading a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Only record if this is a different URL than what we last recorded for this tab
    const lastUrl = lastRecordedUrlPerTab.get(tabId);
    if (lastUrl !== tab.url) {
      lastRecordedUrlPerTab.set(tabId, tab.url);
      recordVisit(tab.url);
    }
  }
});

// Record when user switches to a tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && isTrackableUrl(tab.url)) {
      const lastUrl = lastRecordedUrlPerTab.get(activeInfo.tabId);
      if (lastUrl !== tab.url) {
        lastRecordedUrlPerTab.set(activeInfo.tabId, tab.url);
        recordVisit(tab.url);
      }
    }
  } catch {}
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  lastRecordedUrlPerTab.delete(tabId);
});


/* ================================================================================
   HOT SITES SYNC — Periodic sync with shared server

   When a sync server URL is configured, the extension:
   1. POSTs its local visit data to the server
   2. GETs the aggregated team hot sites from the server

   Server API (expected):
   POST /api/visits  — body: { userId, visits: { domain: { count, lastVisit, dailyCounts } } }
   GET  /api/hot     — returns: { sites: [{ domain, totalVisits, uniqueUsers, lastVisit }] }
   ================================================================================ */

let syncAlarmName = 'tab-out-hot-sync';

/**
 * getOrCreateUserId()
 *
 * Returns a unique user ID for this extension instance.
 * Generated on first use and stored in chrome.storage.local.
 */
async function getOrCreateUserId() {
  const data = await chrome.storage.local.get('visitHistory');
  const history = data.visitHistory || {};
  if (history.hotSyncUserId) return history.hotSyncUserId;

  // Generate a simple unique ID
  const userId = 'user-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  history.hotSyncUserId = userId;
  if (!history.visits) history.visits = {};
  await chrome.storage.local.set({ visitHistory: history });
  return userId;
}

/**
 * syncHotSites()
 *
 * Sends local visit data to the configured server and retrieves
 * aggregated hot sites data. Stores the result in chrome.storage.local.
 */
async function syncHotSites() {
  const data = await chrome.storage.local.get('visitHistory');
  const history = data.visitHistory || {};
  const serverUrl = history.hotSyncServer;

  if (!serverUrl) return; // No server configured, skip sync

  const userId = await getOrCreateUserId();

  try {
    // POST local visits to server
    const payload = {
      userId,
      visits: history.visits || {},
      syncedAt: new Date().toISOString(),
    };

    await fetch(`${serverUrl}/api/visits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // GET aggregated hot sites from server
    const response = await fetch(`${serverUrl}/api/hot?days=30`);
    if (response.ok) {
      const result = await response.json();
      history.hotSitesData = result.sites || [];
      history.hotSitesLastSync = new Date().toISOString();
      await chrome.storage.local.set({ visitHistory: history });
    }
  } catch (err) {
    console.warn('[tab-out] Hot sites sync failed:', err);
  }
}

/**
 * setupSyncAlarm()
 *
 * Sets up a periodic alarm for syncing hot sites data.
 * Only runs if a server URL is configured.
 */
async function setupSyncAlarm() {
  const data = await chrome.storage.local.get('visitHistory');
  const history = data.visitHistory || {};
  const intervalMinutes = history.hotSyncInterval || 30;

  // Clear existing alarm
  chrome.alarms.clear(syncAlarmName);

  // Only set alarm if server is configured
  if (history.hotSyncServer) {
    chrome.alarms.create(syncAlarmName, { periodInMinutes: intervalMinutes });
  }
}

// Listen for sync alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === syncAlarmName) {
    syncHotSites();
  }
});

// Set up alarm on install/startup (handled above in onInstalled/onStartup)

// Also listen for messages from the popup to trigger sync or update config
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sync-hot-sites') {
    syncHotSites().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // Keep the message channel open for async response
  }
  if (message.action === 'update-sync-config') {
    setupSyncAlarm().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
