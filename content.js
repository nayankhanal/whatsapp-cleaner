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
    el.scrollIntoView?.({ block: 'center' });
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

  async function deleteContact(pane) {
    const editBtn = pane.querySelector('[aria-label="Edit" i], [aria-label^="Edit" i], [data-icon*="pencil"], [data-icon*="edit"]');
    if (!editBtn) return 'not a saved contact (no edit button)';
    realClick(clickable(editBtn));

    const editTitle = await waitFor(() => findText([/^edit contact$/i]), 6000);
    if (!editTitle) return 'Edit contact panel did not open';
    await sleep(500);
    const editPane = paneFrom(editTitle);

    const del = editPane.querySelector('[aria-label*="delete" i], [title*="delete" i], [data-icon*="delete"], [data-icon*="trash"]');
    if (!del) { pressEscape(); return 'delete button not found in Edit contact'; }
    realClick(clickable(del));

    const confirmMsg = /^this contact will be deleted/i;
    const confirmTitle = await waitFor(() => findText([confirmMsg], dialogRoot()), 6000);
    if (!confirmTitle) return 'Delete contact confirmation did not appear';
    const btn = await waitFor(() => findText([/^delete$/i], dialogRoot()), 4000);
    if (!btn) return 'Delete button in confirmation not found';
    realClick(clickable(btn));
    await waitFor(() => !findText([confirmMsg]), 6000);
    return 'ok';
  }

  async function deleteChat() {
    const header = await waitFor(() => document.querySelector('#main header'), 5000);
    if (!header) return 'chat is not open';
    const menu = header.querySelector('[aria-label="Menu" i], [title="Menu" i], [data-icon="menu"], [data-icon*="more"]');
    if (!menu) return 'chat menu (⋮) not found';
    realClick(clickable(menu));

    const item = await waitFor(() => findText([/^delete chat$/i]) || findText([/^clear chat$/i]), 4000);
    if (!item) { pressEscape(); return '"Delete chat" not in menu'; }
    const isClear = /clear/i.test(item.innerText || item.getAttribute('aria-label') || '');
    realClick(clickable(item));
    await sleep(700);

    const confirm = await waitFor(
      () => findText(isClear ? [/^clear chat$/i, /^clear$/i] : [/^delete chat$/i, /^delete$/i], dialogRoot()),
      5000
    );
    if (!confirm) { pressEscape(); return 'confirmation button not found'; }
    realClick(clickable(confirm));
    await sleep(1500);
    return isClear ? 'ok (cleared — Delete chat was not offered)' : 'ok';
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
            res.contact = await deleteContact(pane);
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
      <label>Delay between numbers (ms) <input type="number" class="wc-delay" value="1500" min="500" step="250"></label>
      <div class="wc-status"></div>
      <button class="wc-start">Start</button><button class="wc-stop">Stop</button><button class="wc-sec wc-export">Copy report</button>
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
    const nums = [...new Set($('.wc-nums').value.split(/[\n,;]+/).map(digits).filter((n) => n.length >= 7))];
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
