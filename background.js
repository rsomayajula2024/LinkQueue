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

// ---------- Open to Work ring check ----------
// The content script sends the URL of a "framed" profile photo. We look at the ring around the edge:
// LinkedIn's #OPENTOWORK ring is green, the #HIRING ring is purple.
const frameKinds = {};
async function classifyFrame(url) {
  if (frameKinds[url]) return frameKinds[url];
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bmp = await createImageBitmap(await res.blob());
  const w = 100, h = 100, c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let green = 0, purple = 0, n = 0;
  for (let a = 0; a < 360; a += 3) {
    for (const rf of [0.40, 0.43, 0.46]) {
      const x = Math.round(50 + rf * 100 * Math.cos(a * Math.PI / 180)), y = Math.round(50 + rf * 100 * Math.sin(a * Math.PI / 180));
      const i = (y * w + x) * 4, r = d[i], gr = d[i + 1], b = d[i + 2]; n++;
      if (gr > 90 && gr > r + 30 && gr > b + 15) green++;
      else if (b > 90 && b > gr + 35 && r > gr + 10) purple++;
    }
  }
  const kind = green / n > 0.2 && green > purple * 1.5 ? 'otw' : purple / n > 0.2 ? 'hiring' : 'none';
  frameKinds[url] = kind;
  return kind;
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'lq-frame' || !/^https:\/\/media\.licdn\.com\//.test(msg.url || '')) return;
  classifyFrame(msg.url).then((kind) => reply({ kind }), () => reply({ kind: 'unknown' }));
  return true;
});
