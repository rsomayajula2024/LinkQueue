const DEFAULT_NOTE = "Hi {firstName}, I'd like to connect with you here on LinkedIn. I'd appreciate it if you could accept my invitation. Regards, {myName}";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const $ = (id) => document.getElementById(id);
let state = { profiles: {}, settings: {} };
let tab = 'queued';
const selected = new Set();

const fmt = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const s = await chrome.storage.local.get(['profiles', 'settings']);
  state.profiles = s.profiles || {};
  state.settings = s.settings || {};
}
const saveProfiles = () => chrome.storage.local.set({ profiles: state.profiles });
const saveSettings = () => chrome.storage.local.set({ settings: state.settings });

function limitReady() {
  const t = state.settings.limitHitAt;
  return !t || Date.now() >= t + WEEK;
}

function renderLimit() {
  const t = state.settings.limitHitAt;
  const pill = $('limitPill');
  if (limitReady()) {
    pill.textContent = 'Ready to send'; pill.className = 'pill ready';
    $('limitText').textContent = t ? `(limit was hit ${fmt(t)})` : '';
  } else {
    pill.textContent = 'Limit reached'; pill.className = 'pill wait';
    $('limitText').textContent = `Hit ${fmt(t)} · resets around ${fmt(t + WEEK)}`;
  }
}

function renderTemplate() {
  $('template').value = state.settings.template ?? DEFAULT_NOTE;
  $('myName').value = state.settings.myName || '';
  $('maxLen').value = state.settings.maxLen || 200;
  updateCount();
}
function updateCount() {
  const max = Number($('maxLen').value) || 200;
  const len = $('template').value.length;
  $('tplCount').textContent = `${len}/${max}`;
  $('tplCount').style.color = len > max ? '#a00' : '';
}

function renderList() {
  const all = Object.values(state.profiles);
  const queued = all.filter(p => p.status === 'queued').sort((a, b) => a.addedAt - b.addedAt);
  const sent = all.filter(p => p.status === 'sent').sort((a, b) => b.sentAt - a.sentAt);
  $('cQueued').textContent = `(${queued.length})`;
  $('cSent').textContent = `(${sent.length})`;
  $('queueActions').style.display = tab === 'queued' ? 'flex' : 'none';
  $('sentActions').style.display = tab === 'sent' ? 'flex' : 'none';

  for (const id of [...selected]) if (!state.profiles[id] || state.profiles[id].status !== 'queued') selected.delete(id);
  $('start').textContent = `Start invites for selected (${selected.size})`;
  $('start').disabled = selected.size === 0;

  const rows = tab === 'queued' ? queued : sent;
  if (!rows.length) {
    $('list').innerHTML = `<div class="empty">${tab === 'queued'
      ? 'Nothing queued. On any LinkedIn profile, click the blue “＋ LinkQueue” button.'
      : 'No invites sent through LinkQueue yet.'}</div>`;
    return;
  }

  if (tab === 'queued') {
    $('list').innerHTML = `<table><thead><tr>
      <th></th><th>Name</th><th>Headline</th><th style="width:30%">Personal note (optional)</th><th>Added</th></tr></thead><tbody>
      ${rows.map(p => `<tr>
        <td><input type="checkbox" data-id="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''}></td>
        <td><a href="${esc(p.url)}" target="_blank">${esc(p.name)}</a></td>
        <td class="head">${esc(p.headline)}</td>
        <td><input type="text" class="note" data-note="${esc(p.id)}" value="${esc(p.note)}" placeholder="Uses default note"></td>
        <td class="muted">${fmt(p.addedAt)}</td></tr>`).join('')}
      </tbody></table>`;
  } else {
    $('list').innerHTML = `<table><thead><tr><th>Name</th><th>Headline</th><th>Sent</th><th>Status</th></tr></thead><tbody>
      ${rows.map(p => `<tr>
        <td><a href="${esc(p.url)}" target="_blank">${esc(p.name)}</a></td>
        <td class="head">${esc(p.headline)}</td>
        <td class="muted">${p.sentAt ? fmt(p.sentAt) : ''}</td>
        <td>${{ confirmed: '✓ Confirmed by LinkedIn', detected: '✓ Was already pending', manual: 'Marked sent by you' }[p.sentHow] || '✓ Sent'}</td></tr>`).join('')}
      </tbody></table>`;
  }
}

function renderAll() { renderLimit(); renderList(); }

// ---------- events ----------
$('list').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[type=checkbox][data-id]');
  if (cb) { cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id); renderList(); return; }
  const note = e.target.closest('input[data-note]');
  if (note) { state.profiles[note.dataset.note].note = note.value.trim(); await saveProfiles(); }
});

document.querySelectorAll('.tabs button[data-tab]').forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tabs button[data-tab]').forEach(x => x.classList.toggle('active', x === b));
  renderList();
});

$('selAll').onclick = () => {
  Object.values(state.profiles).filter(p => p.status === 'queued').forEach(p => selected.add(p.id));
  renderList();
};
$('selNone').onclick = () => { selected.clear(); renderList(); };

$('removeSel').onclick = async () => {
  if (!selected.size || !confirm(`Remove ${selected.size} profile(s) from the queue?`)) return;
  selected.forEach(id => delete state.profiles[id]);
  selected.clear();
  await saveProfiles(); renderList();
};

$('start').onclick = async () => {
  if (!selected.size) return;
  if (!limitReady() && !confirm('Your weekly limit may not have reset yet. Start anyway?')) return;
  const ids = [...selected]
    .map(id => state.profiles[id])
    .filter(p => p && p.status === 'queued')
    .sort((a, b) => a.addedAt - b.addedAt)
    .map(p => p.id);
  if (!ids.length) return;
  await chrome.storage.local.set({ session: { ids, idx: 0, startedAt: Date.now() } });
  chrome.tabs.create({ url: state.profiles[ids[0]].url });
};

$('hitToday').onclick = async () => {
  state.settings.limitHitAt = Date.now();
  state.settings.resetNotified = false;
  await saveSettings(); renderLimit();
};
$('clearLimit').onclick = async () => {
  delete state.settings.limitHitAt;
  delete state.settings.resetNotified;
  await saveSettings(); renderLimit();
};

$('template').addEventListener('input', updateCount);
$('maxLen').addEventListener('input', updateCount);
$('saveTpl').onclick = async () => {
  state.settings.template = $('template').value.trim();
  state.settings.myName = $('myName').value.trim();
  state.settings.maxLen = Number($('maxLen').value) || 200;
  await saveSettings();
  $('saveTpl').textContent = 'Saved ✓';
  setTimeout(() => $('saveTpl').textContent = 'Save', 1500);
};

$('addBtn').onclick = async () => {
  const m = $('addUrl').value.match(/linkedin\.com\/in\/([^\/?#\s]+)/i);
  if (!m) return alert('Paste a profile URL like https://www.linkedin.com/in/someone/');
  const slug = decodeURIComponent(m[1]).toLowerCase();
  if (state.profiles[slug]) return alert('Already in your list.');
  state.profiles[slug] = {
    id: slug, name: slug, headline: '(added by URL — name fills in when you visit)',
    url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
    note: '', addedAt: Date.now(), status: 'queued'
  };
  $('addUrl').value = '';
  await saveProfiles(); renderList();
};

$('exportCsv').onclick = () => {
  const cell = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [['Name', 'Headline', 'URL', 'Status', 'Added', 'Sent', 'Note'].join(',')];
  Object.values(state.profiles).forEach(p => lines.push([
    p.name, p.headline, p.url, p.status,
    new Date(p.addedAt).toISOString(), p.sentAt ? new Date(p.sentAt).toISOString() : '', p.note
  ].map(cell).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `linkqueue-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};
$('clearSent').onclick = async () => {
  if (!confirm('Clear the sent list? (Export first if you want a record.)')) return;
  Object.values(state.profiles).filter(p => p.status === 'sent').forEach(p => delete state.profiles[p.id]);
  await saveProfiles(); renderList();
};

chrome.storage.onChanged.addListener(async () => { await load(); renderAll(); });

(async () => { await load(); renderTemplate(); renderAll(); })();
