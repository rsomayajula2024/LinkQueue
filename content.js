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
    let name = (document.querySelector('main h1')?.innerText || document.querySelector('h1')?.innerText || '').trim();
    if (!name) {
      // Page title looks like "(3) Jane Doe | LinkedIn"
      const t = document.title.replace(/^\(\d+\+?\)\s*/, '').split('|')[0].trim();
      if (t && !/^linkedin$/i.test(t) && !/feed|notifications|messaging|search/i.test(t)) name = t;
    }
    if (!name) {
      name = (document.querySelector('meta[property="og:title"]')?.content || '').split('|')[0].trim();
    }
    const hSel = ['main .text-body-medium.break-words', 'main [data-generated-suggestion-target]', 'main h1 ~ div .text-body-medium'];
    let headline = '';
    for (const s of hSel) { headline = (document.querySelector(s)?.innerText || '').trim(); if (headline) break; }
    return { name: name.length > 80 ? '' : name, headline };
  }

  // The profile's top card (header section), so we don't touch "People also viewed" buttons
  function topCard() {
    const h1 = document.querySelector('main h1');
    return h1?.closest('section') || document.querySelector('main section') || document.querySelector('main') || document.body;
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
    if (!p) { btn.textContent = '＋ LinkQueue'; }
    else if (p.status === 'sent') {
      const d = p.sentAt ? ' · ' + new Date(p.sentAt).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
      btn.textContent = `✓ Invite sent${d}`; btn.className = 'sent'; btn.title = 'Already invited — no need to send again';
    }
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
      if (a === 'sent') markAndNext(slug, 'sent', 'manual');
      if (a === 'skip') markAndNext(slug, 'queued');
      if (a === 'stop') { await chrome.storage.local.remove('session'); removeUI(); render(true); }
    });
    document.body.appendChild(bar);
  }

  // ---------- LinkedIn controls ----------
  const labelOf = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim().toLowerCase();

  function findConnect(name) {
    const n = (name || '').toLowerCase();
    const isConnect = (b) => /invite .* to connect/.test(labelOf(b)) && visible(b);
    const all = [...document.querySelectorAll('button, [role="button"]')];
    // 1) a Connect control naming this person anywhere (covers the "More" dropdown)
    const named = n && all.find(b => isConnect(b) && labelOf(b).includes(n));
    if (named) return named;
    // 2) otherwise the first Connect control in the profile's own header
    const card = topCard();
    return [...card.querySelectorAll('button, [role="button"]')].find(isConnect) || null;
  }
  function isPending() {
    return [...topCard().querySelectorAll('button, [role="button"]')]
      .some(b => visible(b) && /\bpending\b|withdraw invitation/.test(labelOf(b)));
  }
  function findMore() {
    return [...topCard().querySelectorAll('button')]
      .find(b => /more actions|^more$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()) && visible(b));
  }
  const limitHit = () => /weekly invitation limit|reached the weekly limit|invitation limit/i.test(document.body.innerText);

  // After Send: wait for LinkedIn to confirm (button turns "Pending" or an "invitation sent" toast)
  async function verifySend() {
    const end = Date.now() + 7000;
    while (Date.now() < end) {
      await sleep(400);
      if (limitHit()) return 'limit';
      const dialogOpen = !!document.querySelector('[role="dialog"] textarea, [role="dialog"] button[aria-label*="Send" i]');
      if (!dialogOpen && isPending()) return 'sent';
      if (/invitation sent|invite sent|your invitation to .* was sent/i.test(
        [...document.querySelectorAll('[role="alert"], .artdeco-toast-item, [data-test-artdeco-toast-item-type]')].map(x => x.innerText).join(' ')
      )) return 'sent';
    }
    return 'unknown';
  }

  async function markSent(slug, how) {
    const s = await load();
    const p = s.profiles[slug];
    if (!p) return;
    p.status = 'sent'; p.sentAt = Date.now(); p.sentHow = how;
    await chrome.storage.local.set({ profiles: s.profiles });
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
    const name = scrape().name || (p && p.name !== slug ? p.name : '');

    if (isPending()) { setStatus('Invite already pending — marked as sent, moving on.'); await sleep(1200); return markAndNext(slug, 'sent', 'detected'); }

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

  async function markAndNext(slug, status, how = 'confirmed') {
    const s = await load();
    if (!s.session) return;
    const p = s.profiles[slug];
    if (p && status === 'sent' && p.status !== 'sent') { p.status = 'sent'; p.sentAt = Date.now(); p.sentHow = how; }
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
    const p = slug && s.profiles[slug];
    if (!p || p.status !== 'queued') return;
    const inSession = s.session && s.session.ids[s.session.idx] === slug;

    setStatus('Confirming with LinkedIn…');
    const result = await verifySend();

    if (result === 'limit') {
      s.settings.limitHitAt = Date.now();
      s.settings.resetNotified = false;
      await chrome.storage.local.set({ settings: s.settings });
      await chrome.storage.local.remove('session');
      setStatus('Weekly limit reached — this invite was NOT sent and stays in your queue. Session paused; you’ll get a notification when it resets.');
      toast('Weekly limit reached — invite not sent', 5000);
      return;
    }
    if (result === 'sent') {
      if (inSession) {
        setStatus('✓ Invite sent — opening next profile…');
        toast(`✓ Invite sent to ${p.name}`, 2500);
        return markAndNext(slug, 'sent', 'confirmed');
      }
      await markSent(slug, 'confirmed');
      toast(`✓ Invite sent to ${p.name} — moved to your Sent list`, 3500);
      return render(true);
    }
    // Could not confirm
    setStatus('⚠ Couldn’t confirm the invite went through. Check the profile: if it shows “Pending”, click Mark sent; otherwise click Prepare invite to try again.');
    if (!inSession) toast('Couldn’t confirm the invite — check the profile', 4000);
  }, true);

  // ---------- right-click "Add to LinkQueue" ----------
  let lastLink = null;
  document.addEventListener('contextmenu', (e) => {
    lastLink = e.target.closest && e.target.closest('a[href*="/in/"]');
  }, true);

  function nameFromLink(a) {
    if (!a) return '';
    const hidden = a.querySelector('[aria-hidden="true"]');
    const text = (hidden?.innerText || a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
    let n = text[0] || '';
    n = n.replace(/^View\s+/i, '').replace(/[’']s\s+profile.*$/i, '').trim();
    return n.length > 60 ? '' : n;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'lq-add') return;
    (async () => {
      const slug = slugOf(msg.url);
      if (!slug) return reply({ ok: false });
      const s = await load();
      const ex = s.profiles[slug];
      if (ex) {
        toast(ex.status === 'sent' ? `Already invited: ${ex.name}` : `Already queued: ${ex.name}`, 2500);
        return reply({ ok: true });
      }
      const name = nameFromLink(lastLink);
      s.profiles[slug] = {
        id: slug, name: name || slug,
        headline: name ? '' : '(added by URL — name fills in when you visit)',
        url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
        note: '', addedAt: Date.now(), status: 'queued'
      };
      await chrome.storage.local.set({ profiles: s.profiles });
      toast(`✓ Added to LinkQueue: ${name || slug}`, 2500);
      if (slugOf(location.href) === slug) render(true);
      reply({ ok: true });
    })();
    return true;
  });

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
      await waitFor(() => scrape().name, 8000);
      if (slugOf(location.href) !== slug) return;
      const { profiles, session } = await load();
      const p = profiles[slug];
      if (p && (p.name === slug || !p.headline || p.headline.startsWith('(added by URL'))) {
        const { name, headline } = scrape();
        if (name) { p.name = name; p.headline = headline || p.headline.replace(/^\(added by URL.*\)$/, ''); await chrome.storage.local.set({ profiles }); }
      }
      const inSession = session && session.ids[session.idx] === slug;
      injectSaveButton(slug, profiles[slug]);
      if (inSession) injectSessionBar(slug, profiles[slug], session);

      // Already invited outside LinkQueue? Detect "Pending" and stop a double send.
      if (p && p.status === 'queued') {
        await waitFor(() => findConnect(p.name) || isPending() || findMore(), 4000);
        if (isPending() && slugOf(location.href) === slug) {
          if (inSession) { setStatus('Invite already pending — marked as sent, moving on.'); await sleep(1200); return markAndNext(slug, 'sent', 'detected'); }
          await markSent(slug, 'detected');
          toast(`Invite to ${p.name} is already pending — marked as sent`, 3500);
          const btn = document.getElementById('cl-save-btn');
          if (btn) setSaveBtn(btn, { status: 'sent', sentAt: Date.now() });
        }
      }
    } finally {
      rendering = false;
    }
  }
  setInterval(() => render(false), 1000);
  render(true);
})();
