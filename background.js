const WEEK = 7 * 24 * 60 * 60 * 1000;

async function getState() {
  const s = await chrome.storage.local.get(['profiles', 'settings']);
  return { profiles: s.profiles || {}, settings: s.settings || {} };
}

function setup() {
  chrome.alarms.create('resetCheck', { periodInMinutes: 30 });
  refreshBadge();
}
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
