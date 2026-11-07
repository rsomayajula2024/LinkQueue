const WEEK = 7 * 24 * 60 * 60 * 1000;

async function getState() {
  const s = await chrome.storage.local.get(['profiles', 'settings']);
  return { profiles: s.profiles || {}, settings: s.settings || {} };
}

function setup() {
  chrome.alarms.create('resetCheck', { periodInMinutes: 30 });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'lq-add',
      title: 'Add to LinkQueue',
      contexts: ['link'],
      targetUrlPatterns: ['https://www.linkedin.com/in/*', 'https://linkedin.com/in/*']
    });
  });
  refreshBadge();
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'lq-add' || !info.linkUrl) return;
  try {
    // Content script saves it with the visible name and shows a toast
    await chrome.tabs.sendMessage(tab.id, { type: 'lq-add', url: info.linkUrl });
  } catch {
    // Fallback: save with the URL slug; the name fills in on first visit
    const m = info.linkUrl.match(/linkedin\.com\/in\/([^\/?#]+)/i);
    if (!m) return;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    const { profiles } = await getState();
    if (profiles[slug]) return;
    profiles[slug] = {
      id: slug, name: slug, headline: '(added by URL — name fills in when you visit)',
      url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
      note: '', addedAt: Date.now(), status: 'queued'
    };
    await chrome.storage.local.set({ profiles });
  }
});
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
}
chrome.action.onClicked.addListener(openDashboard);
chrome.notifications.onClicked.addListener(openDashboard);

async function refreshBadge() {
  const { profiles, settings } = await getState();
  const queued = Object.values(profiles).filter(p => p.status === 'queued').length;
  const ready = !settings.limitHitAt || Date.now() >= settings.limitHitAt + WEEK;
  chrome.action.setBadgeText({ text: queued ? String(queued) : '' });
  chrome.action.setBadgeBackgroundColor({ color: ready ? '#0a8f3c' : '#b26b00' });
}
chrome.storage.onChanged.addListener(refreshBadge);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'resetCheck') return;
  refreshBadge();
  const { profiles, settings } = await getState();
  if (!settings.limitHitAt || settings.resetNotified) return;
  if (Date.now() < settings.limitHitAt + WEEK) return;
  settings.resetNotified = true;
  await chrome.storage.local.set({ settings });
  const queued = Object.values(profiles).filter(p => p.status === 'queued').length;
  if (queued) {
    chrome.notifications.create('reset', {
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'LinkedIn invite limit has reset',
      message: `${queued} saved profile${queued > 1 ? 's are' : ' is'} waiting. Click to open your queue.`
    });
  }
});
