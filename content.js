// WhatsApp Chat & Contact Cleaner
// Automates: open chat -> Contact info -> Edit -> Delete contact -> chat menu -> Delete chat.
// WhatsApp Web has no API for this, so everything is done by finding and clicking UI elements.
// Assumes WhatsApp Web is in ENGLISH.

(() => {
  if (window.__waCleanerLoaded) return;
  window.__waCleanerLoaded = true;

  const STATE_KEY = 'waCleanerState';
  const DRAFT_KEY = 'waCleanerDraft';

  // ---------- small utils ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const digits = (s) => (s || '').replace(/\D/g, '');
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const inPanel = (el) => !!el.closest('#wa-cleaner-panel');

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || null; } catch { return null; }
  }
  function saveState(s) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch {}
  }

  let state = loadState() || { running: false, queue: [], i: 0, opts: {}, urlOpened: null, results: [] };

  async function waitFor(fn, timeout = 8000, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) throw new Error('Stopped by user');
      const r = fn();
      if (r) return r;
      await sleep(interval);
    }
    return null;
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  const clickable = (el) => el.closest('button, [role="button"], [role="menuitem"], li, a') || el;

  // Find a visible element whose aria-label / title / text exactly matches one of the regexes.
  function findText(patterns, root = document) {
    const els = root.querySelectorAll('[aria-label], [title], button, [role="button"], [role="menuitem"], li, span, div');
    for (const el of els) {
      if (inPanel(el) || !isVisible(el)) continue;
      const label = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const text = (el.innerText || '').trim();
      if (patterns.some((p) => p.test(label) || p.test(title) || p.test(text))) return el;
    }
    return null;
  }

  // Walk up from a pane's title until we reach the full-height drawer.
  function paneFrom(titleEl) {
    let el = titleEl;
    while (el.parentElement && el.getBoundingClientRect().height < window.innerHeight * 0.6) el = el.parentElement;
    return el;
  }

  function dialogRoot() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => isVisible(d) && !inPanel(d));
    return dialogs[dialogs.length - 1] || document;
  }

  function pressEscape() {
    const o = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', o));
    document.dispatchEvent(new KeyboardEvent('keydown', o));
  }

  // ---------- WhatsApp steps ----------
  function searchBox() {
    return document.querySelector(
      '#side [contenteditable="true"], #side input[type="text"], #side [role="textbox"], [aria-label="Search input textbox"]'
    );
  }

  async function typeInto(el, text) {
    el.focus();
    await sleep(100);
    if (el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
    }
  }

  async function clearSearch() {
    const box = searchBox();
    if (box) await typeInto(box, '');
  }

  async function openViaSearch(num) {
    const box = searchBox();
    if (!box) return false;
    const query = num.length > 10 ? num.slice(-10) : num; // local part matches regardless of formatting
    await typeInto(box, query);
    await sleep(1800);

    const side = document.querySelector('#side')?.parentElement || document;
    const rows = [...side.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"], [role="listitem"], [role="row"]')]
      .filter((r) => isVisible(r) && !inPanel(r) && !r.contains(box) && r.getBoundingClientRect().left < window.innerWidth * 0.45);
    if (!rows.length) { await clearSearch(); return false; }

    realClick(rows[0].querySelector('[role="gridcell"]') || rows[0]);
    const main = await waitFor(() => document.querySelector('#main header'), 6000);
    await clearSearch();
    return !!main;
  }

  async function openedViaUrl() {
    const result = await waitFor(() => {
      const bad = findText([/invalid/i, /isn.t on whatsapp/i, /not on whatsapp/i], dialogRoot());
      if (bad) return 'invalid';
      if (document.querySelector('#main header')) return 'ok';
      return null;
    }, 30000, 400);
    if (result === 'invalid') {
      const ok = findText([/^ok$/i, /^close$/i], dialogRoot());
      if (ok) realClick(clickable(ok));
      return false;
    }
    return result === 'ok';
  }

  // Opens "Contact info" for the current chat and confirms it really is this number.
  async function openContactInfo(num) {
    let title = findText([/^contact info$/i]);
    if (!title) {
      const header = document.querySelector('#main header');
      if (!header) return null;
      const target = header.querySelector('span[dir="auto"], img') || header;
      realClick(target);
      title = await waitFor(() => findText([/^contact info$/i]), 6000);
    }
    if (!title) return null;
    await sleep(600);
    const pane = paneFrom(title);
    const tail = num.slice(-Math.min(9, num.length));
    if (!digits(pane.innerText).includes(tail)) {
      log(`  ⚠ Contact info doesn't show ${num}, wrong chat was opened`);
      return null;
    }
    return pane;
  }

  // All visible clickable icons/buttons (used by the Debug dump).
  function allButtons() {
    const set = new Set();
    for (const el of document.querySelectorAll('button, [role="button"], [data-icon], svg')) {
      if (inPanel(el) || !isVisible(el)) continue;
      set.add(el.matches('svg, [data-icon]') ? clickable(el) : el);
    }
    return [...set];
  }

  // True when the element is actually the topmost thing on screen at its centre (not hidden behind a popup).
  function onTop(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const h = document.elementFromPoint(x, y);
    if (!h || inPanel(h)) return false;
    if (el === h || el.contains(h)) return true;
    const hr = h.getBoundingClientRect();
    return h.contains(el) && hr.width < 700 && hr.height < 200; // e.g. a button wrapping the text
  }

  const depth = (el) => { let d = 0; while ((el = el.parentElement)) d++; return d; };

  // Deepest visible, on-top element whose text/label exactly matches. scroll=true scrolls it into view first.
  async function findOnTop(patterns, { scroll = false, exclude = null } = {}) {
    const cands = [];
    for (const el of document.querySelectorAll('body *')) {
      if (inPanel(el) || el === exclude || (exclude && exclude.contains(el))) continue;
      const label = el.getAttribute('aria-label') || '';
      const tc = el.textContent || '';
      if (tc.length > 80 && !label) continue; // cheap pre-filter, avoids layout on big containers
      const text = el.children.length > 4 || tc.length > 80 ? '' : (el.innerText || '').trim();
      if (patterns.some((p) => p.test(text) || p.test(label)) && isVisible(el)) cands.push(el);
    }
    cands.sort((a, b) => depth(b) - depth(a));
    for (const el of cands) {
      if (scroll) {
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) { el.scrollIntoView({ block: 'center' }); await sleep(400); }
      }
      if (onTop(el)) return el;
    }
    return null;
  }

  async function waitOnTop(patterns, timeout = 6000, opts = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) throw new Error('Stopped by user');
      const el = await findOnTop(patterns, opts);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  // Scan from the right edge leftwards along a row and return the first small, icon-sized element.
  // Works whether the icon is an <svg>, <img>, <span data-icon> or a CSS background.
  // Used for ✏️ (Contact info), 🗑 (Edit contact) and ⋮ (chat header).
  function iconInRow(rowEl, minX, maxX = window.innerWidth - 2) {
    const r = rowEl.getBoundingClientRect();
    const y = r.top + r.height / 2;
    for (let x = maxX; x > minX; x -= 3) {
      const h = document.elementFromPoint(x, y);
      if (!h || inPanel(h)) continue;
      let found = null;
      for (let el = h, i = 0; el && el !== document.body && i < 7; el = el.parentElement, i++) {
        if (el.contains(rowEl)) break;
        const b = el.getBoundingClientRect();
        if (b.width >= 12 && b.width <= 72 && b.height >= 12 && b.height <= 72) found = el; // keep the largest icon-sized ancestor
        else if (b.width > 72 || b.height > 72) break;
      }
      if (found) {
        const btn = found.closest('button, [role="button"]');
        return btn && !btn.contains(rowEl) && btn.getBoundingClientRect().width <= 72 ? btn : found;
      }
    }
    return null;
  }

  const describe = (el) =>
    el ? `<${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? ` label="${el.getAttribute('aria-label')}"` : ''}${
      el.querySelector?.('[data-icon]') ? ` icon="${el.querySelector('[data-icon]').getAttribute('data-icon')}"` : ''
    }> at ${Math.round(el.getBoundingClientRect().left)},${Math.round(el.getBoundingClientRect().top)}` : 'none';

  // A pane title like "Contact info" / "Edit contact": visible text only (not aria-labels), short single-line element.
  async function findTitle(re, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) throw new Error('Stopped by user');
      const hits = [...document.querySelectorAll('body *')].filter((el) => {
        if (inPanel(el) || el.children.length > 2) return false;
        const tc = el.textContent || '';
        if (tc.length > 30 || !re.test(tc.trim())) return false;
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.height < 60 && onTop(el);
      });
      if (hits.length) return hits.sort((a, b) => depth(b) - depth(a))[0];
      await sleep(250);
    }
    return null;
  }

  // Icon-sized elements on the same row as the title and to its right, rightmost first.
  function iconsRightOf(titleEl) {
    const t = titleEl.getBoundingClientRect();
    const cy = t.top + t.height / 2;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (inPanel(el) || el.contains(titleEl)) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 12 || b.width > 72 || b.height < 12 || b.height > 72) continue;
      if (b.left < t.right || Math.abs(b.top + b.height / 2 - cy) > 25) continue;
      out.push(el);
    }
    // Collapse nested matches to the outermost icon-sized element, prefer real buttons.
    const outer = out.filter((el) => !out.some((o) => o !== el && o.contains(el)));
    return outer
      .map((el) => el.closest('button, [role="button"]') && el.closest('button, [role="button"]').getBoundingClientRect().width <= 72 ? el.closest('button, [role="button"]') : el)
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
  }

  // Click icons right of `title` (rightmost first) until `nextTitle` appears.
  async function clickIconUntil(title, nextRe, name) {
    const icons = iconsRightOf(title);
    log(`  ${name}: ${icons.length} icon(s) right of "${title.textContent.trim()}"`);
    for (const ic of icons.slice(0, 3)) {
      log(`  ${name} clicking ${describe(ic)}`);
      realClick(ic);
      const next = await findTitle(nextRe, 3000);
      if (next) return next;
    }
    return null;
  }

  // WhatsApp's own test ids (from the page's HTML).
  const SEL = {
    infoDrawer: '[data-testid="chat-info-drawer"]',
    editBtn: 'header button[aria-label="Edit"], header [data-icon^="pencil"]',
    editDrawer: '[data-testid="save-contact-drawer"]',
    deleteContactBtn: '[data-testid="btn-delete-contact"], [aria-label="Delete contact"]',
    deleteChatItem: '[data-testid="li-delete-chat"]',
  };

  async function deleteContact() {
    const drawer = await waitFor(() => document.querySelector(SEL.infoDrawer), 5000);
    if (!drawer) return 'Contact info panel not open';
    await sleep(400);
    const edit = drawer.querySelector(SEL.editBtn);
    if (!edit) return 'not a saved contact (no ✏️ Edit button)';
    const editBtn = edit.closest('button, [role="button"]') || edit;
    log(`  ✏️ clicking ${describe(editBtn)}`);
    realClick(editBtn);

    const editDrawer = await waitFor(() => document.querySelector(SEL.editDrawer), 6000);
    if (!editDrawer) return 'Edit contact panel did not open after clicking ✏️';
    const del = await waitFor(() => editDrawer.querySelector(SEL.deleteContactBtn), 4000);
    if (!del) return '🗑 Delete contact button not found';
    await sleep(500);
    log(`  🗑 clicking ${describe(del)}`);
    realClick(del);

    const msg = await waitOnTop([/^this contact will be deleted/i], 6000);
    if (!msg) return 'Delete contact popup did not appear after clicking 🗑';
    await sleep(300);
    const btn = await waitOnTop([/^delete$/i], 4000);
    log(`  popup clicking ${describe(btn)}`);
    if (!btn) return '"Delete" button in popup not found';
    realClick(btn);
    await waitFor(() => !/This contact will be deleted/i.test(document.body.innerText), 6000);
    await sleep(1000);
    return 'ok';
  }

  async function ensureContactInfoOpen() {
    if (document.querySelector(SEL.infoDrawer) || (await findOnTop([/^contact info$/i]))) return true;
    const header = document.querySelector('#main header');
    if (!header) return false;
    realClick(header.querySelector('span[dir="auto"]') || header);
    return !!(await waitFor(() => document.querySelector(SEL.infoDrawer), 5000));
  }

  async function confirmPopup(itemEl, patterns) {
    // The menu/drawer item we clicked has the same text, so exclude it.
    await sleep(900);
    const btn = await waitOnTop(patterns, 5000, { exclude: itemEl });
    if (!btn) { pressEscape(); return false; }
    realClick(btn);
    await sleep(1500);
    return true;
  }

  async function deleteChat() {
    if (!document.querySelector('#main header')) return 'chat is not open';

    // 1) "Delete chat" at the bottom of the Contact info panel.
    if (await ensureContactInfoOpen()) {
      const item = document.querySelector(SEL.deleteChatItem) || (await findOnTop([/^delete chat$/i], { scroll: true }));
      if (item) {
        realClick(item);
        return (await confirmPopup(item, [/^delete chat$/i, /^delete$/i])) ? 'ok' : 'Delete chat popup button not found';
      }
    }

    // 2) Fallback: ⋮ menu in the chat header.
    const header = document.querySelector('#main header');
    const hb = header.getBoundingClientRect();
    const menu = iconInRow(header, hb.left + hb.width / 2, hb.right - 2);
    if (!menu) return 'chat menu (⋮) not found';
    realClick(menu);
    let item = await waitOnTop([/^delete chat$/i], 3000);
    let isClear = false;
    if (!item) { item = await findOnTop([/^clear chat$/i]); isClear = !!item; }
    if (!item) { pressEscape(); return '"Delete chat" not in menu'; }
    realClick(item);
    const ok = await confirmPopup(item, isClear ? [/^clear chat$/i, /^clear$/i] : [/^delete chat$/i, /^delete$/i]);
    if (!ok) return 'popup confirm button not found';
    return isClear ? 'ok (cleared — Delete chat was not offered)' : 'ok';
  }

  // Copies a description of the visible buttons, to diagnose when WhatsApp changes its layout.
  function debugDump() {
    const rows = allButtons().map((b) => {
      const r = b.getBoundingClientRect();
      const icon = b.querySelector('[data-icon]')?.getAttribute('data-icon') || b.getAttribute('data-icon') || '';
      return `${Math.round(r.left)},${Math.round(r.top)}\t${b.tagName.toLowerCase()}\tlabel="${b.getAttribute('aria-label') || ''}"\ticon="${icon}"\ttext="${(b.innerText || '').trim().slice(0, 30)}"`;
    });
    return rows.join('\n');
  }

  // ---------- runner ----------
  async function run() {
    renderStatus();
    while (state.running && state.i < state.queue.length) {
      const num = state.queue[state.i];
      log(`#${state.i + 1}/${state.queue.length}  ${num}`);
      const viaUrl = state.urlOpened === num;
      const res = { num, contact: '-', chat: '-' };
      try {
        let opened = viaUrl ? await openedViaUrl() : await openViaSearch(num);
        let pane = opened ? await openContactInfo(num) : null;

        if (!pane && !viaUrl && state.opts.urlFallback) {
          log('  search did not find it, opening via link (page reloads)…');
          state.urlOpened = num;
          saveState(state);
          location.href = `https://web.whatsapp.com/send?phone=${num}`;
          return; // resumes after reload
        }

        if (!pane) {
          res.contact = res.chat = 'skipped: chat not found';
          log('  ✗ skipped, could not open this chat');
        } else {
          if (state.opts.deleteContact) {
            res.contact = await deleteContact();
            log(`  contact: ${res.contact}`);
            await sleep(800);
          }
          if (state.opts.deleteChat) {
            res.chat = await deleteChat();
            log(`  chat: ${res.chat}`);
          }
        }
      } catch (e) {
        log(`  ✗ error: ${e.message}`);
        res.chat = res.chat === '-' ? 'error: ' + e.message : res.chat;
        pressEscape();
      }
      if (!state.running) break;
      state.results.push(res);
      state.urlOpened = null;
      state.i++;
      saveState(state);
      renderStatus();
      await sleep(Number(state.opts.delay) || 1500);
    }
    if (state.i >= state.queue.length) log('✅ Done.');
    state.running = false;
    saveState(state);
    renderStatus();
  }

  // ---------- floating panel ----------
  const panel = document.createElement('div');
  panel.id = 'wa-cleaner-panel';
  panel.innerHTML = `
    <style>
      #wa-cleaner-panel{position:fixed;bottom:16px;left:16px;z-index:999999;width:320px;background:#1f2c33;color:#e9edef;
        font:13px/1.4 system-ui,sans-serif;border:1px solid #3b4a54;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
      #wa-cleaner-panel.min .wc-body{display:none}
      #wa-cleaner-panel .wc-head{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;cursor:pointer;font-weight:600}
      #wa-cleaner-panel .wc-body{padding:0 12px 12px}
      #wa-cleaner-panel textarea{width:100%;height:90px;box-sizing:border-box;background:#111b21;color:#e9edef;border:1px solid #3b4a54;border-radius:6px;padding:6px;font:12px monospace}
      #wa-cleaner-panel label{display:block;margin:4px 0}
      #wa-cleaner-panel input[type=number]{width:70px;background:#111b21;color:#e9edef;border:1px solid #3b4a54;border-radius:4px}
      #wa-cleaner-panel button{border:0;border-radius:16px;padding:6px 14px;font-weight:600;cursor:pointer;margin-right:6px}
      #wa-cleaner-panel .wc-start{background:#21c063;color:#111b21}
      #wa-cleaner-panel .wc-stop{background:#f15c6d;color:#111b21}
      #wa-cleaner-panel .wc-sec{background:#3b4a54;color:#e9edef}
      #wa-cleaner-panel .wc-log{margin-top:8px;height:140px;overflow:auto;background:#111b21;border-radius:6px;padding:6px;font:11px monospace;white-space:pre-wrap}
      #wa-cleaner-panel .wc-status{margin:6px 0;color:#8696a0}
    </style>
    <div class="wc-head"><span>🧹 Chat & Contact Cleaner</span><span class="wc-toggle">–</span></div>
    <div class="wc-body">
      <div style="margin-bottom:4px;color:#8696a0">One number per line, <b>with country code</b> (e.g. 19059667456)</div>
      <textarea class="wc-nums" placeholder="19059667456&#10;9779812345678"></textarea>
      <label><input type="checkbox" class="wc-contact" checked> Delete saved contact</label>
      <label><input type="checkbox" class="wc-chat" checked> Delete chat</label>
      <label><input type="checkbox" class="wc-url" checked> If search fails, open via link (reloads page)</label>
      <label>Default country code (added to 10-digit numbers) <input type="number" class="wc-cc" value="1" min="1"></label>
      <label>Delay between numbers (ms) <input type="number" class="wc-delay" value="1500" min="500" step="250"></label>
      <div class="wc-status"></div>
      <button class="wc-start">Start</button><button class="wc-stop">Stop</button><button class="wc-sec wc-export">Copy report</button><button class="wc-sec wc-debug">Debug</button>
      <div class="wc-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (s) => panel.querySelector(s);
  const logBox = $('.wc-log');

  function log(msg) {
    logBox.textContent += msg + '\n';
    logBox.scrollTop = logBox.scrollHeight;
    console.log('[WA Cleaner]', msg);
  }

  function renderStatus() {
    const total = state.queue.length;
    $('.wc-status').textContent = state.running
      ? `Running… ${state.i}/${total} done`
      : total ? `Idle. Last run: ${state.i}/${total} processed.` : 'Idle.';
    $('.wc-start').disabled = state.running;
  }

  try { $('.wc-nums').value = localStorage.getItem(DRAFT_KEY) || ''; } catch {}
  $('.wc-nums').addEventListener('input', (e) => { try { localStorage.setItem(DRAFT_KEY, e.target.value); } catch {} });
  $('.wc-head').addEventListener('click', () => {
    panel.classList.toggle('min');
    $('.wc-toggle').textContent = panel.classList.contains('min') ? '+' : '–';
  });

  $('.wc-start').addEventListener('click', () => {
    const cc = digits($('.wc-cc').value);
    const nums = [...new Set($('.wc-nums').value.split(/[\n,;]+/).map(digits).filter((n) => n.length >= 7)
      .map((n) => (n.length === 10 && cc ? cc + n : n)))];
    if (!nums.length) return alert('Add at least one phone number (with country code).');
    const opts = {
      deleteContact: $('.wc-contact').checked,
      deleteChat: $('.wc-chat').checked,
      urlFallback: $('.wc-url').checked,
      delay: $('.wc-delay').value,
    };
    if (!opts.deleteContact && !opts.deleteChat) return alert('Pick at least one action.');
    const what = [opts.deleteContact && 'contact', opts.deleteChat && 'chat'].filter(Boolean).join(' + ');
    if (!confirm(`Delete ${what} for ${nums.length} number(s)?\n\nThis can't be undone.`)) return;
    logBox.textContent = '';
    state = { running: true, queue: nums, i: 0, opts, urlOpened: null, results: [] };
    saveState(state);
    run();
  });

  $('.wc-stop').addEventListener('click', () => {
    state.running = false;
    saveState(state);
    log('⏹ Stopped.');
    renderStatus();
  });

  $('.wc-export').addEventListener('click', async () => {
    const lines = ['number\tcontact\tchat', ...(state.results || []).map((r) => `${r.num}\t${r.contact}\t${r.chat}`)];
    await navigator.clipboard.writeText(lines.join('\n'));
    log('📋 Report copied to clipboard (tab-separated, paste into Sheets/Excel).');
  });

  $('.wc-debug').addEventListener('click', async () => {
    await navigator.clipboard.writeText(debugDump());
    log('🐞 Button list copied to clipboard. Paste it to Claude.');
  });

  // Resume after a reload triggered by the link fallback.
  (async () => {
    renderStatus();
    if (!state.running) return;
    $('.wc-nums').value = state.queue.join('\n');
    log(`Resuming at #${state.i + 1}…`);
    const ready = await waitFor(() => document.querySelector('#side'), 60000, 500).catch(() => null);
    if (ready) { await sleep(1500); run(); }
  })();
})();
