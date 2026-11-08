(() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const slugOf = (url) => {
    const m = url.match(/linkedin\.com\/in\/([^\/?#]+)/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  };
  // Works for floating menus too (offsetParent is null for position:fixed elements)
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  // LinkedIn renders some popups inside shadow roots (e.g. #interop-outlet). Search those too.
  function allRoots() {
    const out = [document];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { out.push(el.shadowRoot); walk(el.shadowRoot); }
      }
    };
    walk(document);
    return out;
  }
  const qsa = (sel) => allRoots().flatMap(r => [...r.querySelectorAll(sel)]);

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
        <button class="cl-primary" data-a="next" style="display:none">Next →</button>
        <button class="cl-primary" data-a="prep">Retry</button>
        <button class="cl-ghost" data-a="sent">Mark sent</button>
        <button class="cl-ghost" data-a="skip">Skip</button>
        <button class="cl-ghost" data-a="stop">Stop</button>
      </div>
      <div class="cl-status">Opening the invite with your note — you just click Send. The next profile opens automatically.</div>`;
    bar.querySelector('.cl-title').textContent =
      `Invite ${session.idx + 1} of ${session.ids.length} — ${p ? p.name : slug}`;
    barStatus = bar.querySelector('.cl-status');
    bar.addEventListener('click', async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'prep') prepareInvite(slug);
      if (a === 'next') markAndNext(slug, 'sent', 'confirmed');
      if (a === 'sent') markAndNext(slug, 'sent', 'manual');
      if (a === 'skip') markAndNext(slug, 'queued');
      if (a === 'stop') { await chrome.storage.local.remove('session'); removeUI(); render(true); }
    });
    document.body.appendChild(bar);
  }

  // ---------- LinkedIn controls ----------
  const labelOf = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim().toLowerCase();

  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [aria-label*="connect" i]';
  const inSidebar = (el) => !!el.closest('aside, .scaffold-layout__aside, [data-view-name*="right-rail" i]');
  const exactConnect = (el) => /^connect$/i.test((el.innerText || '').trim());
  const inviteLabel = (el) => /invite .* to connect/i.test(el.getAttribute('aria-label') || '');

  function openMenus() {
    return [...document.querySelectorAll('[role="menu"], .artdeco-dropdown__content, [aria-hidden="false"][class*="dropdown" i], [class*="popover" i]')]
      .filter(visible);
  }

  function findConnect(name) {
    const first = (name || '').split(/[\s,]+/)[0].toLowerCase();
    const all = qsa(CLICKABLE).filter(el => visible(el) && !inSidebar(el));

    // 1) "Invite <this person> to connect" anywhere on the page (top card or More menu)
    const named = first && all.find(el => inviteLabel(el) && (el.getAttribute('aria-label') || '').toLowerCase().includes(first));
    if (named) return named;

    const deepest = (els) => els.filter(el => !els.some(o => o !== el && el.contains(o)));
    const wrap = (el) => el.closest('[role="menuitem"], [role="button"], button, a, li') || el;

    // 2) An item reading exactly "Connect" inside an open More menu
    for (const menu of openMenus()) {
      const items = deepest([...menu.querySelectorAll('*')].filter(el => visible(el) && exactConnect(el)));
      if (items.length) return wrap(items[0]);
    }

    // 3) A Connect control in the profile's own header
    const card = topCard();
    const inCard = all.find(el => card.contains(el) && (inviteLabel(el) || exactConnect(el)));
    if (inCard) return inCard;

    // 4) A "Connect" item floating right next to the ⋯ More button (the open menu)
    const more = findMore();
    if (more) {
      const m = more.getBoundingClientRect();
      const near = deepest([...document.querySelectorAll('body *')].filter(el => {
        if (!exactConnect(el) || !visible(el) || inSidebar(el)) return false;
        const r = el.getBoundingClientRect();
        return Math.abs(r.left - m.left) < 450 && Math.abs(r.top - m.top) < 550;
      }));
      if (near.length) return wrap(near[0]);
    }
    return null;
  }
  function isPending() {
    return [...topCard().querySelectorAll('button, [role="button"]')]
      .some(b => visible(b) && /\bpending\b|withdraw invitation/.test(labelOf(b)));
  }
  function findMore() {
    return [...topCard().querySelectorAll('button')]
      .find(b => /more actions|^more$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()) && visible(b));
  }
  const limitHit = () => /weekly invitation limit|reached the weekly limit|invitation limit/i.test(document.body.innerText + ' ' + qsa('[role="dialog"], [role="alertdialog"], .artdeco-modal').map(x => x.innerText).join(' '));

  const sentToast = () => /invitation sent|invite sent|your invitation to .* was sent/i.test(
    qsa('[role="alert"], [aria-live], .artdeco-toast-item, [data-test-artdeco-toast-item-type]').map(x => x.innerText).join(' '));

  // After Send: wait for LinkedIn to confirm (button turns "Pending" or an "invitation sent" toast)
  async function verifySend() {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      await sleep(400);
      if (limitHit()) return 'limit';
      const dialogOpen = !!visibleTextarea() || !!visibleBtn(/send without a note|^send invitation/i);
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
  const MODAL_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .artdeco-modal, [class*="modal" i][class*="content" i]';
  function findModal() {
    const ms = qsa(MODAL_SEL).filter(visible);
    if (ms.length) return ms[ms.length - 1];
    // Fallback: the box holding LinkedIn's invite buttons
    const b = qsa('button').find(x => visible(x) && /send without a note|add a note|^send invitation$/i.test((x.innerText || '').trim()));
    return b ? (b.closest('section, [class*="modal" i], [class*="dialog" i]') || b.parentElement?.parentElement?.parentElement) : null;
  }
  const visibleBtn = (re) => qsa('button, [role="button"]')
    .find(b => visible(b) && !inSidebar(b) && re.test(((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim()));
  const visibleTextarea = () => qsa('textarea').filter(visible).pop() || null;
  const isSendBtn = (b) => {
    const t = ((b.innerText || '').trim() || (b.getAttribute('aria-label') || '').trim());
    return /^send( now| invitation| without a note)?$/i.test(t) || /^send invitation/i.test(b.getAttribute('aria-label') || '');
  };

  function findBtnIn(root, re) {
    return [...root.querySelectorAll('button')]
      .find(b => re.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
  }
  function setNative(ta, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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

    if (isPending()) { await markSent(slug, 'detected'); setStatus('Invite already pending — marked as sent. Click Next →'); return showNext(); }

    setStatus('Opening Connect…');
    let btn = findConnect(name);
    if (!btn) {
      const more = findMore();
      if (more) { more.click(); btn = await waitFor(() => findConnect(name), 2000); }
    }
    if (!btn) return setStatus('No Connect option found (maybe already connected or Follow-only). Click it yourself, or Skip.');
    btn.click();

    const outcome = await waitFor(() => {
      if (limitHit()) return 'limit';
      if (sentToast() || isPending()) return 'sent';
      if (findModal() || visibleBtn(/add a note|send without a note/i)) return 'popup';
      return null;
    }, 6000);
    if (outcome === 'limit') return handleLimit();
    if (outcome === 'sent') {
      await markSent(slug, 'confirmed');
      setStatus(`✓ LinkedIn sent this invite straight away (no note option for ${p ? p.name.split(' ')[0] : 'this person'}). Click Next →`);
      showNext();
      return;
    }
    if (!outcome) return setStatus('Invite popup did not open — click Retry, or Skip.');

    const note = p ? buildNote(p, settings) : '';
    if (!note) return setStatus('Ready — click Send.');

    let ta = visibleTextarea();
    if (!ta) {
      const add = await waitFor(() => visibleBtn(/^add a note$|add a note/i), 3000);
      if (!add) return setStatus('No note option on this one — click Send.');
      add.click();
      ta = await waitFor(visibleTextarea, 3000);
    }
    if (!ta) return setStatus('Note box unavailable (free accounts get a few notes a month) — click “Send without a note”, or Skip.');
    setNative(ta, note);
    if (ta.value !== note) { ta.focus(); document.execCommand && document.execCommand('insertText', false, note); }
    ta.focus();
    setStatus('Note filled — just click Send.');
  }

  async function handleLimit() {
    const s = await load();
    s.settings.limitHitAt = Date.now();
    s.settings.resetNotified = false;
    await chrome.storage.local.set({ settings: s.settings });
    await chrome.storage.local.remove('session');
    setStatus('Weekly limit reached — this invite was NOT sent and stays in your queue. Session paused; you’ll get a notification when it resets.');
    toast('Weekly limit reached — invite not sent', 5000);
  }

  function showNext() {
    const bar = document.getElementById('cl-bar');
    if (!bar) return;
    bar.querySelector('[data-a="next"]').style.display = '';
    ['prep', 'sent'].forEach(a => { const b = bar.querySelector(`[data-a="${a}"]`); if (b) b.style.display = 'none'; });
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
      await sleep(4000 + Math.random() * 4000);
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
    const b = e.composedPath().find(n => n instanceof Element && n.matches('button, [role="button"]'));
    if (!b || !isSendBtn(b) || inSidebar(b)) return;
    const slug = slugOf(location.href);
    const s = await load();
    const p = slug && s.profiles[slug];
    if (!p || p.status !== 'queued') return;
    const inSession = s.session && s.session.ids[s.session.idx] === slug;

    setStatus('Confirming with LinkedIn…');
    const result = await verifySend();

    if (result === 'limit') return handleLimit();
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
    // No limit message → Send means sent
    if (inSession) {
      setStatus('✓ Invite sent — opening next profile…');
      toast(`✓ Invite sent to ${p.name}`, 2500);
      return markAndNext(slug, 'sent', 'confirmed');
    }
    await markSent(slug, 'confirmed');
    toast(`✓ Invite sent to ${p.name} — moved to your Sent list`, 3500);
    return render(true);
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

  // ---------- Open to Work scanner ----------
  // On your Connections page (or a people search filtered to 1st connections), finds people who show
  // LinkedIn's green #OpenToWork photo frame or say "open to work" in their headline, and lists them
  // in the dashboard's "Open to work" tab. It only reads what is already on your screen; nothing is clicked or sent.
  const OTW_RE = /#?open[\s_-]?to[\s_-]?work/i;
  const HEADLINE_RE = /\bopen to (work|new (roles|opportunities)|opportunities)\b|\bactively (looking|seeking)\b|#opentowork|\bseeking (new )?(roles?|opportunities|job)\b/i;
  const scanPage = () => /^\/mynetwork\/invite-connect\/connections/.test(location.pathname) || /^\/search\/results\/people/.test(location.pathname);
  const isConnectionsPage = () => /^\/mynetwork\/invite-connect\/connections/.test(location.pathname);

  function cardOf(a) {
    return a.closest('li, [data-chameleon-result-urn], .entity-result, .mn-connection-card, [data-view-name*="search-entity" i], [data-view-name*="connection" i]')
      || a.parentElement?.parentElement?.parentElement || a;
  }
  function photoSignal(card) {
    for (const img of card.querySelectorAll('img')) {
      if (OTW_RE.test(img.getAttribute('alt') || '') || OTW_RE.test(img.getAttribute('src') || '') || OTW_RE.test(img.className || '')) return true;
    }
    return [...card.querySelectorAll('[class*="open-to-work" i], [class*="opentowork" i], [aria-label*="open to work" i], [title*="open to work" i]')].length > 0;
  }
  function cardText(card) { return (card.innerText || '').split('\n').map(x => x.trim()).filter(Boolean); }
  function cardHeadline(card, name) {
    const sel = card.querySelector('[class*="occupation" i], [class*="primary-subtitle" i], .entity-result__primary-subtitle, [class*="subtitle" i]');
    if (sel && sel.innerText.trim()) return sel.innerText.trim();
    const lines = cardText(card).filter(l => l !== name && !/^(message|connect|follow|remove|•|·|1st|2nd|3rd\+?|view .*profile|connected on .*)$/i.test(l) && !/^•?\s*1st$/i.test(l));
    return (lines.find(l => l.length > 12 && !l.startsWith(name)) || '').slice(0, 220);
  }
  function isFirstDegree(card) {
    if (isConnectionsPage()) return true;
    const t = card.innerText || '';
    return /[•·]\s*1st/.test(t) || /1st[\s-]degree/i.test(t + ' ' + card.innerHTML) || /(^|\n)\s*1st\s*($|\n)/.test(t);
  }

  let otwFound = 0, otwBtn = null, otwTimer = null;
  async function scanOTW(manual) {
    const seen = new Map();
    for (const a of (document.querySelector('main') || document).querySelectorAll('a[href*="/in/"]')) {
      const slug = slugOf(a.href); if (!slug) continue;
      const prev = seen.get(slug);
      if (prev && (prev.a.innerText || '').trim()) continue;          // keep the link that carries the name
      seen.set(slug, { a, card: prev ? prev.card : cardOf(a) });
    }
    const s = await chrome.storage.local.get(['otw']); const otw = s.otw || {};
    let added = 0;
    for (const [slug, { a, card }] of seen) {
      if (!isFirstDegree(card)) continue;
      const alt = [...card.querySelectorAll('img[alt]')].map(i => i.getAttribute('alt').replace(/,?\s*#?open[\s_-]?to[\s_-]?work.*$/i, '').trim()).find(x => x && x.length < 60 && !/photo|picture|image/i.test(x));
      const name = nameFromLink(a) || alt || cardText(card)[0] || slug;
      const headline = cardHeadline(card, name);
      const viaPhoto = photoSignal(card), viaHeadline = HEADLINE_RE.test(headline);
      if (!viaPhoto && !viaHeadline) continue;
      const ex = otw[slug];
      if (ex) { if (!ex.headline && headline) ex.headline = headline; continue; }
      otw[slug] = { id: slug, name: name.length > 60 ? slug : name, headline, url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
        signal: viaPhoto ? 'photo' : 'headline', foundAt: Date.now(), status: 'new' };
      added++;
    }
    if (added) await chrome.storage.local.set({ otw });
    otwFound += added;
    if (otwBtn) otwBtn.textContent = `🟢 Open to Work: +${otwFound} found · keep scrolling`;
    if (manual) toast(added ? `✓ ${added} new Open to Work connection${added > 1 ? 's' : ''} added` : `Checked ${seen.size} people on screen — no new Open to Work found. Scroll for more.`, 3000);
  }
  function otwUI() {
    if (!scanPage()) { otwBtn?.remove(); otwBtn = null; clearInterval(otwTimer); otwTimer = null; return; }
    if (otwBtn && document.body.contains(otwBtn)) return;
    otwBtn = document.createElement('button');
    otwBtn.id = 'lq-otw-btn'; otwFound = 0;
    otwBtn.textContent = '🟢 Open to Work scan: on · scroll your list';
    otwBtn.title = 'LinkQueue is listing connections who are Open to Work. Click to scan now. See them in the dashboard → Open to work tab.';
    otwBtn.onclick = () => scanOTW(true);
    document.body.appendChild(otwBtn);
    clearInterval(otwTimer); otwTimer = setInterval(() => { if (scanPage() && document.visibilityState === 'visible') scanOTW(false); }, 2000);
    scanOTW(false);
  }
  // On a connection's own profile: if the photo frame or headline says Open to Work, list them too.
  async function otwFromProfile(slug) {
    const card = topCard();
    const ct = card.innerText || '';
    const first = /[•·]\s*1st/.test(ct) || /1st[\s-]degree/i.test(ct + ' ' + card.innerHTML) || /(^|\n)\s*1st\s*($|\n)/.test(ct);
    if (!first) return;
    const { name, headline } = scrape();
    if (!photoSignal(card) && !HEADLINE_RE.test(headline) && !/\bopen to work\b/i.test(card.innerText || '')) return;
    const s = await chrome.storage.local.get(['otw']); const otw = s.otw || {};
    if (otw[slug]) return;
    otw[slug] = { id: slug, name: name || slug, headline, url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`, signal: photoSignal(card) ? 'photo' : 'profile', foundAt: Date.now(), status: 'new' };
    await chrome.storage.local.set({ otw });
  }
  setInterval(otwUI, 1000);

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
      otwFromProfile(slug).catch(() => {});
      injectSaveButton(slug, profiles[slug]);
      if (inSession) injectSessionBar(slug, profiles[slug], session);

      // Already invited outside LinkQueue? Detect "Pending" and stop a double send.
      if (p && p.status === 'queued') {
        await waitFor(() => findConnect(p.name) || isPending() || findMore(), 4000);
        if (isPending() && slugOf(location.href) === slug) {
          if (inSession) { await markSent(slug, 'detected'); setStatus('Invite already pending — marked as sent. Click Next →'); return showNext(); }
          await markSent(slug, 'detected');
          toast(`Invite to ${p.name} is already pending — marked as sent`, 3500);
          const btn = document.getElementById('cl-save-btn');
          if (btn) setSaveBtn(btn, { status: 'sent', sentAt: Date.now() });
          return;
        }
        // In a session: open Connect and fill the note automatically — you just click Send
        if (inSession && slugOf(location.href) === slug) {
          setStatus('Preparing invite…');
          await sleep(1200 + Math.random() * 1500);
          if (slugOf(location.href) === slug) prepareInvite(slug);
        }
      }
    } finally {
      rendering = false;
    }
  }
  setInterval(() => render(false), 1000);
  render(true);
})();
