(() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const slugOf = (url) => {
    const m = url.match(/linkedin\.com\/in\/([^\/?#]+)/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  };
  const visible = (el) => el && el.offsetParent !== null;

  async function load() {
    const s = await chrome.storage.local.get(['profiles', 'settings', 'session']);
    return { profiles: s.profiles || {}, settings: s.settings || {}, session: s.session || null };
  }

  async function waitFor(fn, timeout = 5000, step = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // ---------- page scraping ----------
  function scrape() {
    const name = (document.querySelector('main h1')?.innerText || '').trim();
    const headline = (document.querySelector('main .text-body-medium.break-words')?.innerText || '').trim();
    return { name, headline };
  }

  // ---------- UI ----------
  function removeUI() {
    document.getElementById('cl-save-btn')?.remove();
    document.getElementById('cl-bar')?.remove();
  }

  function toast(msg, ms = 4000) {
    document.getElementById('cl-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'cl-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function setSaveBtn(btn, p) {
    btn.className = '';
    if (!p) { btn.textContent = '＋ Connect Later'; }
    else if (p.status === 'sent') { btn.textContent = '✓ Invite sent'; btn.className = 'sent'; }
    else { btn.textContent = '✓ Queued (click to remove)'; btn.className = 'queued'; }
  }

  function injectSaveButton(slug, p) {
    const btn = document.createElement('button');
    btn.id = 'cl-save-btn';
    setSaveBtn(btn, p);
    btn.onclick = async () => {
      const s = await load();
      const cur = s.profiles[slug];
      if (cur && cur.status === 'queued') {
        delete s.profiles[slug];
      } else if (!cur || cur.status !== 'sent') {
        const { name, headline } = scrape();
        s.profiles[slug] = {
          id: slug, name: name || slug, headline,
          url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
          note: '', addedAt: Date.now(), status: 'queued'
        };
      }
      await chrome.storage.local.set({ profiles: s.profiles });
      setSaveBtn(btn, s.profiles[slug]);
    };
    document.body.appendChild(btn);
  }

  let barStatus = null;
  const setStatus = (t) => { if (barStatus) barStatus.textContent = t; };

  function injectSessionBar(slug, p, session) {
    const bar = document.createElement('div');
    bar.id = 'cl-bar';
    bar.innerHTML = `
      <div class="cl-top">
        <span class="cl-title"></span>
        <button class="cl-primary" data-a="prep">Prepare invite</button>
        <button class="cl-ghost" data-a="sent">Mark sent</button>
        <button class="cl-ghost" data-a="skip">Skip</button>
        <button class="cl-ghost" data-a="stop">Stop</button>
      </div>
      <div class="cl-status">Click “Prepare invite”, review, then click LinkedIn’s Send. The next profile opens automatically.</div>`;
    bar.querySelector('.cl-title').textContent =
      `Invite ${session.idx + 1} of ${session.ids.length} — ${p ? p.name : slug}`;
    barStatus = bar.querySelector('.cl-status');
    bar.addEventListener('click', async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'prep') prepareInvite(slug);
      if (a === 'sent') markAndNext(slug, 'sent');
      if (a === 'skip') markAndNext(slug, 'queued');
      if (a === 'stop') { await chrome.storage.local.remove('session'); removeUI(); render(true); }
    });
    document.body.appendChild(bar);
  }

  // ---------- LinkedIn controls ----------
  function findConnect(name) {
    const n = name.toLowerCase();
    return [...document.querySelectorAll('button, [role="button"]')].find(b => {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      return /invite .* to connect/.test(l) && l.includes(n) && visible(b);
    });
  }
  function isPending(name) {
    const n = name.toLowerCase();
    return [...document.querySelectorAll('main button')].some(b => {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      return l.includes('pending') && l.includes(n);
    });
  }
  function findMore() {
    return [...document.querySelectorAll('main button')]
      .find(b => /more actions/i.test(b.getAttribute('aria-label') || '') && visible(b));
  }
  function findBtnIn(root, re) {
    return [...root.querySelectorAll('button')]
      .find(b => re.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
  }
  function setNative(ta, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function buildNote(p, settings) {
    const DEFAULT_NOTE = "Hi {firstName}, I'd like to connect with you here on LinkedIn. I'd appreciate it if you could accept my invitation. Regards, {myName}";
    const raw = (p.note || (settings.template ?? DEFAULT_NOTE)).trim();
    if (!raw) return '';
    const first = (p.name || '').split(' ')[0];
    const max = Number(settings.maxLen) || 200;
    const me = (settings.myName || '').trim();
    return raw
      .replace(/\{firstName\}/g, first)
      .replace(/\{name\}/g, p.name || '')
      .replace(/[,\s]*Regards,\s*\{myName\}/g, me ? ` Regards, ${me}` : '')
      .replace(/\{myName\}/g, me)
      .trim()
      .slice(0, max);
  }

  async function prepareInvite(slug) {
    const { profiles, settings } = await load();
    const p = profiles[slug];
    const name = (p && p.name) || scrape().name;
    if (!name) return setStatus('Could not read the name on this page. Click Connect yourself, or Skip.');

    if (isPending(name)) { setStatus('Invite already pending — moving on.'); await sleep(1200); return markAndNext(slug, 'sent'); }

    setStatus('Opening Connect…');
    let btn = findConnect(name);
    if (!btn) {
      const more = findMore();
      if (more) { more.click(); btn = await waitFor(() => findConnect(name), 2000); }
    }
    if (!btn) return setStatus('No Connect option found (maybe already connected or Follow-only). Click it yourself, or Skip.');
    btn.click();

    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000);
    if (!dialog) return setStatus('Invite dialog did not open — try again or click Connect yourself.');

    const note = p ? buildNote(p, settings) : '';
    if (!note) return setStatus('Dialog open — click Send.');
    const add = await waitFor(() => findBtnIn(dialog, /add a note/i), 2500);
    if (!add) return setStatus('No “Add a note” option here — click Send.');
    add.click();
    const ta = await waitFor(() => document.querySelector('[role="dialog"] textarea'), 3000);
    if (!ta) return setStatus('Note box unavailable (free accounts get limited notes) — send without a note, or Skip.');
    setNative(ta, note);
    ta.focus();
    setStatus('Note filled — review it and click Send.');
  }

  async function markAndNext(slug, status) {
    const s = await load();
    if (!s.session) return;
    const p = s.profiles[slug];
    if (p && status === 'sent') { p.status = 'sent'; p.sentAt = Date.now(); }
    const session = s.session;
    let next = null;
    session.idx++;
    while (session.idx < session.ids.length) {
      const n = s.profiles[session.ids[session.idx]];
      if (n && n.status === 'queued') { next = n; break; }
      session.idx++;
    }
    if (next) {
      await chrome.storage.local.set({ profiles: s.profiles, session });
      await sleep(800 + Math.random() * 1500);
      location.href = next.url;
    } else {
      await chrome.storage.local.set({ profiles: s.profiles });
      await chrome.storage.local.remove('session');
      removeUI();
      toast('All done — invite session complete 🎉', 6000);
      render(true);
    }
  }

  // Detect LinkedIn's own Send click inside the invite dialog
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !b.closest('[role="dialog"]')) return;
    const t = (b.getAttribute('aria-label') || b.innerText || '').trim();
    if (!/^send/i.test(t)) return;
    const slug = slugOf(location.href);
    const s = await load();
    if (!s.session || s.session.ids[s.session.idx] !== slug) return;

    setStatus('Checking…');
    await sleep(2000);
    const body = document.body.innerText;
    if (/weekly invitation limit|reached the weekly limit|invitation limit/i.test(body)) {
      s.settings.limitHitAt = Date.now();
      s.settings.resetNotified = false;
      await chrome.storage.local.set({ settings: s.settings });
      await chrome.storage.local.remove('session');
      setStatus('Weekly limit reached — session paused. You’ll get a notification when it resets.');
      return;
    }
    markAndNext(slug, 'sent');
  }, true);

  // ---------- render loop (LinkedIn is a single-page app) ----------
  let lastUrl = '';
  let rendering = false;
  async function render(force = false) {
    if (rendering) return;
    if (!force && location.href === lastUrl) return;
    lastUrl = location.href;
    rendering = true;
    try {
      removeUI();
      const slug = slugOf(location.href);
      if (!slug) return;
      await waitFor(() => document.querySelector('main h1'), 8000);
      if (slugOf(location.href) !== slug) return;
      const { profiles, session } = await load();
      injectSaveButton(slug, profiles[slug]);
      if (session && session.ids[session.idx] === slug) injectSessionBar(slug, profiles[slug], session);
    } finally {
      rendering = false;
    }
  }
  setInterval(() => render(false), 1000);
  render(true);
})();
