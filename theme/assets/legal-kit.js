/* LegalKit: the "Privacy & Terms" page shared by every Arkvital app.
 *
 * Built from APP_MAKER/legal-kit (runtime/legal-kit.js + the app's generated content).
 * Edit it there and re-run build.py + install.py; don't edit the copies inside the apps.
 *
 * What it does:
 *   - LegalKit.open(tab)          shows the full-screen legal page (tabs: overview, privacy, terms, cookies)
 *   - LegalKit.setUser(state)     tells it who is signed in and what they accepted; shows a slim reminder
 *                                 bar if a signed-in person hasn't accepted the current version
 *   - LegalKit.consentField()     HTML for the "I'm 16+ and agree" tick box on sign-up forms
 *   - LegalKit.consentChecked(el) true when the tick box inside el is ticked
 *   - any element with data-lk-open="privacy|terms|cookies|overview" opens that tab when clicked
 *   - #legal or #legal/<tab> in the URL opens the page on load (for links from emails and stores)
 *   - LegalKit.setOpenHandler(fn)  inside an iframe: hand "open" to the host page instead
 *
 * The app connects it to its server with configure({...}) and setAcceptHandler(fn), where
 * fn(version, source) records the acceptance and returns {ok, accepted_version, accepted_at}
 * (or a Promise / JSON string of it).
 */
(function () {
  'use strict';
  if (window.LegalKit && window.LegalKit._runtime) { return; }

  var LK = window.LegalKit = window.LegalKit || {};
  LK._runtime = 1;

  var TABS = ['overview', 'privacy', 'terms', 'cookies'];
  var PENDING_KEY = 'lk.signupConsent';
  var LANG_KEY = 'lk.lang';
  var LATER_KEY = 'lk.later';
  var PENDING_DAYS = 7;

  var cfg = { theme: {}, mode: 'auto', lang: null, onChange: null };
  var acceptFn = null, openFn = null;
  var user = { signedIn: false };
  var page = null, banner = null, lastFocus = null, currentTab = 'overview', busy = false;

  // ------------------------------------------------------------------ small helpers
  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  function sget(k, kind) { try { var s = store(kind || 'localStorage'); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function sset(k, v, kind) { try { var s = store(kind || 'localStorage'); if (s) { if (v == null) s.removeItem(k); else s.setItem(k, v); } } catch (e) { /* private mode */ } }
  function parse(x) { if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return {}; } } return x || {}; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fill(s, vars) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? vars[k] : m; }); }
  function C() { return LK.content || { version: '', app: { name: '' }, operator: {}, langs: {} }; }
  function lang() {
    var langs = C().langs, l = cfg.lang || sget(LANG_KEY) || ((navigator.language || 'en').slice(0, 2).toLowerCase());
    return langs[l] ? l : 'en';
  }
  function L() { return C().langs[lang()] || C().langs.en || { tabs: [], ui: {} }; }
  function T(key, vars) {
    var ui = L().ui || {}, en = (C().langs.en || {}).ui || {};
    return fill(ui[key] != null ? ui[key] : (en[key] != null ? en[key] : key), Object.assign({ app: esc(C().app.name) }, vars || {}));
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    try { return d.toLocaleDateString(lang() === 'fr' ? 'fr-CA' : 'en-CA', { year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (e) { return d.toISOString().slice(0, 10); }
  }
  function accepted() { return !!(user.signedIn && user.accepted_version && user.accepted_version === C().version); }
  function needsConsent() { return !!(user.signedIn && !accepted()); }

  // Dark mode: follow the app. Explicit setting first, then the page's own background, then the OS.
  function isDark() {
    if (cfg.mode === 'dark') return true;
    if (cfg.mode === 'light') return false;
    var els = [document.body, document.documentElement];
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      var m = (getComputedStyle(els[i]).backgroundColor || '').match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) {
        return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 110;
      }
    }
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // ------------------------------------------------------------------ styles
  var CSS = [
    '#lk-root,#lk-bar{--lk-accent:#2f5bd3;--lk-accent-ink:#fff;--lk-bg:#fbfbf9;--lk-card:#fff;--lk-ink:#1d1f24;--lk-muted:#5d6370;--lk-line:rgba(20,24,32,.12);--lk-soft:rgba(20,24,32,.05);--lk-radius:14px;',
    '  font-family:var(--lk-font,inherit);color:var(--lk-ink);-webkit-font-smoothing:antialiased;box-sizing:border-box;line-height:1.55;letter-spacing:normal;text-transform:none}',
    '#lk-root.lk-dark,#lk-bar.lk-dark{--lk-bg:#15171c;--lk-card:#1d2027;--lk-ink:#eceef2;--lk-muted:#a4abb8;--lk-line:rgba(255,255,255,.13);--lk-soft:rgba(255,255,255,.06)}',
    '#lk-root *,#lk-bar *{box-sizing:border-box}',
    '#lk-root{position:fixed;inset:0;z-index:2147483000;background:var(--lk-bg);display:flex;flex-direction:column;font-size:16px;animation:lk-in .18s ease-out}',
    '@keyframes lk-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '#lk-root .lk-top{flex:none;border-bottom:1px solid var(--lk-line);background:var(--lk-card)}',
    '#lk-root .lk-topin{max-width:820px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:10px}',
    '#lk-root .lk-back{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--lk-ink);font:inherit;font-size:15px;font-weight:600;padding:8px 10px 8px 4px;border-radius:10px;cursor:pointer;min-height:40px}',
    '#lk-root .lk-back:hover{background:var(--lk-soft)}',
    '#lk-root .lk-back svg{width:20px;height:20px}',
    '#lk-root .lk-sp{flex:1}',
    '#lk-root .lk-ghost{border:1px solid var(--lk-line);background:transparent;color:var(--lk-ink);font:inherit;font-size:13px;font-weight:600;padding:7px 11px;border-radius:999px;cursor:pointer;min-height:34px}',
    '#lk-root .lk-ghost:hover{background:var(--lk-soft)}',
    '#lk-root .lk-tabs{max-width:820px;margin:0 auto;padding:0 12px;display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}',
    '#lk-root .lk-tabs::-webkit-scrollbar{display:none}',
    '#lk-root .lk-tab{flex:none;border:0;background:transparent;color:var(--lk-muted);font:inherit;font-size:14px;font-weight:600;padding:10px 12px 12px;cursor:pointer;border-bottom:2.5px solid transparent;white-space:nowrap}',
    '#lk-root .lk-tab[aria-selected=true]{color:var(--lk-ink);border-bottom-color:var(--lk-accent)}',
    '#lk-root .lk-scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '#lk-root .lk-doc{max-width:820px;margin:0 auto;padding:22px 20px 40px}',
    '#lk-root .lk-eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--lk-accent);margin:0 0 6px}',
    '#lk-root.lk-dark .lk-eyebrow{filter:brightness(1.5)}',
    '#lk-root h1:focus{outline:none}',
    '#lk-root h1{font-size:28px;line-height:1.2;margin:0 0 6px;font-family:var(--lk-head,inherit);color:var(--lk-ink)}',
    '#lk-root .lk-meta{color:var(--lk-muted);font-size:13px;margin:0 0 22px}',
    '#lk-root h2{font-size:19px;line-height:1.3;margin:28px 0 8px;font-family:var(--lk-head,inherit);color:var(--lk-ink)}',
    '#lk-root h3{font-size:16px;margin:20px 0 6px;color:var(--lk-ink)}',
    '#lk-root p,#lk-root li{font-size:15.5px;color:var(--lk-ink)}',
    '#lk-root p{margin:0 0 12px}',
    '#lk-root ul{margin:0 0 14px;padding-left:22px}',
    '#lk-root li{margin:0 0 6px}',
    '#lk-root a{color:var(--lk-accent);text-underline-offset:2px}',
    '#lk-root.lk-dark a{filter:brightness(1.45)}',
    '#lk-root .lk-card{background:var(--lk-card);border:1px solid var(--lk-line);border-radius:var(--lk-radius);padding:16px 18px;margin:0 0 14px}',
    '#lk-root .lk-key{list-style:none;padding:0;margin:0 0 18px}',
    '#lk-root .lk-key li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--lk-line);margin:0}',
    '#lk-root .lk-key li:last-child{border-bottom:0}',
    '#lk-root .lk-key .lk-ico{flex:none;width:30px;height:30px;border-radius:9px;background:var(--lk-soft);display:grid;place-items:center;font-size:16px}',
    '#lk-root .lk-actions{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 4px}',
    '#lk-root .lk-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--lk-line);background:var(--lk-card);color:var(--lk-ink);font:inherit;font-size:14px;font-weight:600;padding:9px 14px;border-radius:999px;cursor:pointer;text-decoration:none;min-height:40px}',
    '#lk-root .lk-btn:hover{background:var(--lk-soft)}',
    '#lk-root .lk-btn.lk-primary,#lk-bar .lk-primary{background:var(--lk-accent);border-color:var(--lk-accent);color:var(--lk-accent-ink)}',
    '#lk-root .lk-btn.lk-primary:hover{filter:brightness(1.08)}',
    '#lk-root .lk-btn[disabled]{opacity:.45;cursor:not-allowed}',
    '#lk-root .lk-foot{flex:none;border-top:1px solid var(--lk-line);background:var(--lk-card)}',
    '#lk-root .lk-footin{max-width:820px;margin:0 auto;padding:12px 16px calc(12px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
    '#lk-root .lk-footin p{margin:0;font-size:14px;flex:1;min-width:220px;color:var(--lk-muted)}',
    '#lk-root .lk-ok{color:var(--lk-ink)!important}',
    '#lk-root .lk-ok b{color:#2e8540}',
    '#lk-root.lk-dark .lk-ok b{color:#6fcf86}',
    '#lk-root .lk-err{color:#c0392b;font-size:13px;width:100%}',
    '.lk-consent{display:flex!important;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;text-align:left;cursor:pointer;margin:4px 0;font-weight:400}',
    '.lk-consent input{flex:none;width:18px;height:18px;margin:1px 0 0;accent-color:var(--lk-accent,currentColor);cursor:pointer}',
    '.lk-consent a{color:inherit;text-decoration:underline;text-underline-offset:2px;font-weight:600;cursor:pointer}',
    '.lk-consent.lk-shake{animation:lk-shake .35s}',
    '@keyframes lk-shake{20%,60%{transform:translateX(-5px)}40%,80%{transform:translateX(5px)}}',
    '.lk-consent-err{color:#c0392b;font-size:13px;margin:2px 0 0 28px}',
    '#lk-bar{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147482999;max-width:620px;margin:0 auto;background:var(--lk-card);border:1px solid var(--lk-line);border-radius:16px;box-shadow:0 10px 34px rgba(0,0,0,.18);padding:12px 12px 12px 16px;display:flex;align-items:center;gap:10px;font-size:14px;animation:lk-in .25s ease-out}',
    '#lk-bar p{margin:0;flex:1;color:var(--lk-ink);font-size:14px;line-height:1.4}',
    '#lk-bar button{border:1px solid var(--lk-line);background:transparent;color:var(--lk-ink);font:inherit;font-size:13.5px;font-weight:600;padding:8px 13px;border-radius:999px;cursor:pointer;white-space:nowrap;min-height:38px}',
    '#lk-bar .lk-later{border-color:transparent;color:var(--lk-muted)}',
    '@media (max-width:520px){#lk-bar{flex-wrap:wrap}#lk-bar p{flex-basis:100%}#lk-bar .lk-sp{flex:1}#lk-root h1{font-size:24px}#lk-root .lk-doc{padding:18px 16px 32px}}',
    '@media print{html.lk-open body>*:not(#lk-root){display:none!important}#lk-root{position:static;background:#fff;color:#000}#lk-root .lk-top,#lk-root .lk-foot,#lk-root .lk-noprint{display:none!important}#lk-root .lk-scroll{overflow:visible}}'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById('lk-style')) return;
    var st = document.createElement('style');
    st.id = 'lk-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function applyTheme(el) {
    var t = Object.assign({}, C().theme || {}, cfg.theme || {});
    var map = { accent: '--lk-accent', accentInk: '--lk-accent-ink', font: '--lk-font', headingFont: '--lk-head', radius: '--lk-radius' };
    Object.keys(map).forEach(function (k) { if (t[k]) el.style.setProperty(map[k], t[k]); });
    el.classList.toggle('lk-dark', isDark());
    if (isDark() && t.accentDark) el.style.setProperty('--lk-accent', t.accentDark);
  }

  // ------------------------------------------------------------------ the page
  var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';

  function tabData(id) {
    var tabs = L().tabs || [];
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) return tabs[i];
    return tabs[0] || { id: id, title: id, html: '' };
  }

  function mailto(kind) {
    var op = C().operator || {}, vars = { email: user.email || T('your_email') };
    var subject = T('mail_' + kind + '_subject', vars), body = T('mail_' + kind + '_body', vars);
    return 'mailto:' + encodeURIComponent(op.email || '') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function rightsHTML() {
    return '<div class="lk-actions lk-noprint">' +
      '<a class="lk-btn" href="' + esc(mailto('access')) + '">' + T('btn_access') + '</a>' +
      '<a class="lk-btn" href="' + esc(mailto('delete')) + '">' + T('btn_delete') + '</a>' +
      '<a class="lk-btn" href="' + esc(mailto('question')) + '">' + T('btn_question') + '</a></div>';
  }

  function docHTML(id) {
    var t = tabData(id), c = C();
    var html = String(t.html || '').replace('<!--lk:rights-->', rightsHTML());
    return '<p class="lk-eyebrow">' + esc(c.app.name) + '</p>' +
      '<h1 tabindex="-1">' + esc(t.heading || t.title) + '</h1>' +
      '<p class="lk-meta">' + T('effective', { date: esc(L().effective || c.version), version: esc(c.version) }) + '</p>' + html;
  }

  function footHTML() {
    if (!user.signedIn) return '<p>' + T('guest_note') + '</p>';
    if (accepted()) return '<p class="lk-ok"><b>&#10003;</b> ' + T('accepted_on', { date: fmtDate(user.accepted_at) }) + '</p>';
    return '<label class="lk-consent" style="flex:1;min-width:220px"><input type="checkbox" class="lk-agree-box"> <span>' + T('page_consent') + '</span></label>' +
      '<button type="button" class="lk-btn lk-primary lk-agree" disabled>' + T('agree') + '</button>' +
      '<div class="lk-err" hidden></div>';
  }

  function render() {
    if (!page) return;
    var tabs = (L().tabs || []).map(function (t) {
      return '<button type="button" role="tab" class="lk-tab" data-lk-tab="' + t.id + '" aria-selected="' + (t.id === currentTab) + '">' + esc(t.title) + '</button>';
    }).join('');
    var other = lang() === 'fr' ? 'en' : 'fr', hasOther = !!C().langs[other];
    page.innerHTML =
      '<div class="lk-top">' +
        '<div class="lk-topin">' +
          '<button type="button" class="lk-back" data-lk-close>' + ICON_BACK + '<span>' + T('back') + '</span></button>' +
          '<span class="lk-sp"></span>' +
          (hasOther ? '<button type="button" class="lk-ghost" data-lk-lang="' + other + '" lang="' + other + '">' + esc(C().langs[other].ui.lang_name) + '</button>' : '') +
          '<button type="button" class="lk-ghost" data-lk-print>' + T('print') + '</button>' +
        '</div>' +
        '<div class="lk-tabs" role="tablist" aria-label="' + T('title') + '">' + tabs + '</div>' +
      '</div>' +
      '<div class="lk-scroll"><article class="lk-doc" role="tabpanel">' + docHTML(currentTab) + '</article></div>' +
      '<div class="lk-foot"><div class="lk-footin">' + footHTML() + '</div></div>';
    page.setAttribute('lang', lang());
    applyTheme(page);
  }

  function onPageClick(e) {
    var el = e.target.closest ? e.target.closest('[data-lk-tab],[data-lk-close],[data-lk-lang],[data-lk-print],.lk-agree,[data-lk-goto]') : null;
    if (!el) return;
    if (el.hasAttribute('data-lk-tab')) { show(el.getAttribute('data-lk-tab')); }
    else if (el.hasAttribute('data-lk-goto')) { e.preventDefault(); show(el.getAttribute('data-lk-goto')); }
    else if (el.hasAttribute('data-lk-close')) { LK.close(); }
    else if (el.hasAttribute('data-lk-lang')) { sset(LANG_KEY, el.getAttribute('data-lk-lang')); cfg.lang = null; render(); }
    else if (el.hasAttribute('data-lk-print')) { window.print(); }
    else if (el.classList.contains('lk-agree')) { doAccept('page'); }
  }

  function onPageChange(e) {
    if (e.target.classList && e.target.classList.contains('lk-agree-box')) {
      var b = page.querySelector('.lk-agree');
      if (b) b.disabled = !e.target.checked;
    }
  }

  function show(tab) {
    currentTab = TABS.indexOf(tab) >= 0 ? tab : 'overview';
    render();
    var sc = page.querySelector('.lk-scroll');
    if (sc) sc.scrollTop = 0;
    var h = page.querySelector('h1');
    if (h) { try { h.focus({ preventScroll: true }); } catch (err) { h.focus(); } }
  }

  function onKey(e) { if (e.key === 'Escape' && page) LK.close(); }

  LK.open = function (tab) {
    if (openFn) { openFn(typeof tab === 'string' ? tab : 'overview'); return; }
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { LK.open(tab); }); return; }
    ensureStyle();
    if (!page) {
      lastFocus = document.activeElement;
      page = document.createElement('div');
      page.id = 'lk-root';
      page.setAttribute('role', 'dialog');
      page.setAttribute('aria-modal', 'true');
      page.setAttribute('aria-label', T('title'));
      page.addEventListener('click', onPageClick);
      page.addEventListener('change', onPageChange);
      document.body.appendChild(page);
      document.documentElement.classList.add('lk-open');
      page._overflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.addEventListener('keydown', onKey);
    }
    show(typeof tab === 'string' ? tab : 'overview');
    hideBar();
  };

  LK.close = function () {
    if (!page) return;
    document.removeEventListener('keydown', onKey);
    document.documentElement.style.overflow = page._overflow || '';
    document.documentElement.classList.remove('lk-open');
    page.remove();
    page = null;
    if (/^#legal(\/\w+)?$/.test(location.hash)) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (err) { /* ignore */ }
    }
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (err) { /* gone */ } }
    updateBar();
  };

  LK.isOpen = function () { return !!page; };

  // ------------------------------------------------------------------ accepting
  function doAccept(source) {
    if (busy || !acceptFn) return;
    busy = true;
    var btn = page && page.querySelector('.lk-agree'), err = page && page.querySelector('.lk-err');
    if (btn) { btn.disabled = true; btn.textContent = T('saving'); }
    var v = C().version;
    Promise.resolve().then(function () { return acceptFn(v, source); }).then(function (r) {
      r = parse(r);
      busy = false;
      if (r && r.ok) {
        user.accepted_version = r.accepted_version || v;
        user.accepted_at = r.accepted_at || new Date().toISOString();
        sset(PENDING_KEY, null);
        render();
        updateBar();
        if (cfg.onChange) { try { cfg.onChange(user); } catch (e) { /* app's problem */ } }
      } else { throw new Error((r && r.error) || 'failed'); }
    }).catch(function () {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = T('agree'); }
      if (err) { err.hidden = false; err.textContent = T('save_error'); }
    });
  }

  // A tick on the sign-up form is remembered for a few days, so it can be recorded as soon as the new
  // account is signed in (also when the app asks people to confirm their email first).
  function pendingSignup() {
    var p = parse(sget(PENDING_KEY));
    return !!(p && p.v === C().version && p.at && (Date.now() - p.at) < PENDING_DAYS * 864e5);
  }

  LK.markSignupConsent = function (on) {
    sset(PENDING_KEY, on === false ? null : JSON.stringify({ v: C().version, at: Date.now() }));
  };

  // ------------------------------------------------------------------ reminder bar
  function hideBar() { if (banner) { banner.remove(); banner = null; } }

  function updateBar() {
    if (page || !document.body) return;
    if (!needsConsent() || sget(LATER_KEY, 'sessionStorage') === C().version || cfg.bar === false) { hideBar(); return; }
    ensureStyle();
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'lk-bar';
      banner.setAttribute('role', 'region');
      banner.setAttribute('aria-label', T('title'));
      banner.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.classList.contains('lk-later')) { sset(LATER_KEY, C().version, 'sessionStorage'); hideBar(); }
        else LK.open('overview');
      });
      document.body.appendChild(banner);
    }
    banner.innerHTML = '<p>' + T(user.accepted_version ? 'bar_updated' : 'bar_new') + '</p><span class="lk-sp"></span>' +
      '<button type="button" class="lk-later">' + T('later') + '</button>' +
      '<button type="button" class="lk-primary">' + T('review') + '</button>';
    applyTheme(banner);
  }

  // ------------------------------------------------------------------ public API
  LK.load = function (content) { LK.content = parse(content); };

  LK.configure = function (opts) {
    opts = parse(opts);
    Object.keys(opts).forEach(function (k) { cfg[k] = opts[k]; });
    if (page) render();
    updateBar();
    return LK;
  };

  LK.setAcceptHandler = function (fn) { acceptFn = fn; return LK; };

  /* For a page inside an iframe: send "open" to the host page instead of drawing the page here. */
  LK.setOpenHandler = function (fn) { openFn = fn; return LK; };

  LK.setUser = function (state) {
    state = parse(state);
    user = {
      signedIn: !!state.signedIn,
      accepted_version: state.accepted_version || null,
      accepted_at: state.accepted_at || null,
      email: state.email || null
    };
    if (needsConsent() && pendingSignup()) { doAccept('signup'); }
    if (page) render();
    updateBar();
    return LK;
  };

  LK.state = function () { return JSON.stringify({ version: C().version, user: user, needsConsent: needsConsent() }); };
  LK.needsConsent = needsConsent;
  LK.version = function () { return C().version; };
  LK.t = function (key) { return T(key); };

  /* The tick box for sign-up forms. The box is required, so a normal <form> won't submit without it;
   * apps that submit from a click handler should also check LegalKit.consentChecked(form). */
  LK.consentField = function (opts) {
    ensureStyle();
    opts = parse(opts);
    var txt = T('signup_consent')
      .replace('[terms]', '<a role="button" tabindex="0" data-lk-open="terms">').replace('[/terms]', '</a>')
      .replace('[privacy]', '<a role="button" tabindex="0" data-lk-open="privacy">').replace('[/privacy]', '</a>');
    return '<label class="lk-consent' + (opts.className ? ' ' + esc(opts.className) : '') + '">' +
      '<input type="checkbox" name="lk_consent" class="lk-consent-box" required> <span>' + txt + '</span></label>';
  };

  /* True if the tick box inside root is ticked. If not, it shakes it and shows a short message. */
  LK.consentChecked = function (root, quiet) {
    root = root || document;
    var box = root.querySelector ? root.querySelector('.lk-consent-box') : null;
    if (!box) return true;
    if (box.checked) return true;
    if (!quiet) {
      var lab = box.closest('.lk-consent');
      if (lab) {
        lab.classList.remove('lk-shake'); void lab.offsetWidth; lab.classList.add('lk-shake');
        var next = lab.nextElementSibling;
        if (!next || !next.classList.contains('lk-consent-err')) {
          var m = document.createElement('div');
          m.className = 'lk-consent-err';
          m.setAttribute('role', 'alert');
          m.textContent = T('signup_required');
          lab.parentNode.insertBefore(m, lab.nextSibling);
        }
      }
      try { box.focus(); } catch (e) { /* ignore */ }
    }
    return false;
  };

  /* HTML for a small "Privacy & Terms" link, for footers and menus. */
  LK.linkHTML = function (opts) {
    opts = parse(opts);
    return '<a role="button" tabindex="0" data-lk-open="' + esc(opts.tab || 'overview') + '"' +
      (opts.className ? ' class="' + esc(opts.className) + '"' : '') + ' style="cursor:pointer">' + esc(opts.text || T('title')) + '</a>';
  };

  // ------------------------------------------------------------------ global listeners
  // Capture phase, so links inside app components (and inside <label>s) open the page and nothing else.
  function openFromEvent(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-lk-open]') : null;
    if (!el || (page && page.contains(el))) return;
    e.preventDefault();
    e.stopPropagation();
    LK.open(el.getAttribute('data-lk-open') || 'overview');
  }
  document.addEventListener('click', openFromEvent, true);
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('[data-lk-open]')) openFromEvent(e);
  }, true);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('lk-consent-box')) {
      LK.markSignupConsent(t.checked);
      var lab = t.closest('.lk-consent'), next = lab && lab.nextElementSibling;
      if (t.checked && next && next.classList.contains('lk-consent-err')) next.remove();
    }
  }, true);

  function fromHash() {
    var m = /^#legal(?:\/(\w+))?$/.exec(location.hash || '');
    if (m) LK.open(m[1] || 'overview');
  }
  window.addEventListener('hashchange', fromHash);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fromHash);
  else setTimeout(fromHash, 0);
})();

window.LegalKit.load({"version": "2026-10-26", "app": {"key": "mafiacamp", "name": "Mafia Camp", "url": "https://mafia-camp-game.anvil.app"}, "theme": {"accent": "#e0661c", "accentDark": "#ff8a3d"}, "operator": {"name": "Arkvital", "email": "arkvital@outlook.com"}, "langs": {"en": {"tabs": [{"id": "overview", "title": "Overview", "heading": "Privacy & Terms", "html": "<p>Mafia Camp is a video party game where 3 to 10 friends get secret roles, talk on a small group video call and vote to find the Mafia. It is run by Arkvital, based in Montréal, Québec, Canada. This page explains in plain words what we do with your information and the rules for using Mafia Camp. The full documents are in the other tabs.</p>\n<h2>The short version</h2>\n<ul class=\"lk-key\"><li><span class=\"lk-ico\" aria-hidden=\"true\">📋</span><span><b>What we collect:</b> the camp name you type, a random player key kept in your browser, and the game itself (roles, votes, night choices) for the camp you join. Your video and voice go straight to the other players and are never stored.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">👀</span><span><b>What others see:</b> the people in your camp: they see your camp name, your video and hear your voice, and see your role when the game rules reveal it.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🚫</span><span><b>Never sold.</b> No ads, no tracking, and your information is never used to train AI.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🔒</span><span><b>Stored securely</b> by our hosting provider, Anvil, with encrypted connections and hashed passwords.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🎂</span><span><b>16+ for accounts.</b></span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🎥</span><span><b>Your video and voice are never stored.</b> They go straight from your browser to the other players' browsers, encrypted.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🏕️</span><span><b>No account needed.</b> Camps and their game data are deleted about a day after the last game.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">✉️</span><span><b>Your data, your call.</b> Get a copy, fix it, or delete your account at any time by email.</span></li></ul>\n<h2>Your choices</h2>\n<p>You can ask for a copy of your data, ask us to correct it, or delete your account at any time. Email us at <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> and we'll reply within 30 days, free of charge.</p>\n<!--lk:rights-->\n<h2>The full documents</h2>\n<ul><li><a href=\"#\" data-lk-goto=\"privacy\">Privacy Policy</a>: what we collect, why, who helps us run Mafia Camp, and your rights.</li><li><a href=\"#\" data-lk-goto=\"terms\">Terms of Use</a>: the rules for using Mafia Camp.</li><li><a href=\"#\" data-lk-goto=\"cookies\">Cookies &amp; Storage</a>: what Mafia Camp keeps in your browser.</li></ul>"}, {"id": "privacy", "title": "Privacy Policy", "heading": "Privacy Policy", "html": "<p>This Privacy Policy explains how Arkvital (\"we\", \"us\") collects, uses, shares and protects personal information in Mafia Camp (https://mafia-camp-game.anvil.app), and the rights you have. We wrote it to meet Québec's <i>Act respecting the protection of personal information in the private sector</i> (Law 25), Canada's PIPEDA, and the EU and UK General Data Protection Regulation (GDPR).</p>\n<h2>1. Who is responsible</h2>\n<p>Mafia Camp is run by <b>Arkvital</b>, Montréal, Québec, Canada. We are responsible for the personal information described here.</p>\n<p>Our person in charge of the protection of personal information can be reached at <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>.</p>\n<h2>2. What this policy covers</h2>\n<p>This policy covers Mafia Camp and the information you give us or that we collect when you use it.</p>\n<h2>3. What we collect</h2>\n<p><b>Information you give us</b></p>\n<ul><li><b>No account:</b> you play without signing up. Your browser makes a random player key and keeps it in local storage so you keep your seat if you reload.</li><li><b>Your camp name:</b> the name you type when you start or join a camp (up to 16 characters).</li><li><b>Game data:</b> the camp code, your seat, whether you are present, whether your mic and camera are on, your role, your night choices and your votes, and the story of the game (who was out and when).</li><li><b>Connection ID:</b> a random ID from PeerJS that lets the other players' browsers call yours. It changes every time you open the page.</li></ul>\n<p><b>Information collected automatically</b></p>\n<ul><li><b>Sign-in information:</b> when you signed up and last signed in, and failed sign-in attempts (to protect your account).</li><li><b>Technical logs:</b> our hosting provider records technical details such as IP addresses, browser type and error messages, to keep the service secure and working.</li></ul>\n<p>We don't collect more than we need. We don't ask for, and you shouldn't add, sensitive information such as health details, government ID numbers or financial account numbers (your video shows whatever your camera sees, so choose what is in the picture).</p>\n<h2>4. Why we use it, and our legal bases</h2>\n<ul><li><b>To provide Mafia Camp:</b> create and run your account and the features you use. <i>Basis: needed to provide the service you asked for (contract).</i></li><li><b>To keep Mafia Camp safe and working:</b> prevent abuse and fraud, fix problems, make backups. <i>Basis: our legitimate interest in a secure, reliable service.</i></li><li><b>To contact you about your account:</b> for example password resets. <i>Basis: needed to provide the service. You can switch off optional notifications.</i></li><li><b>For optional features</b> that need your permission, listed in section 6. <i>Basis: your consent, which you can withdraw at any time.</i></li><li><b>To meet legal obligations</b> and respond to lawful requests. <i>Basis: legal obligation.</i></li></ul>\n<p>We do <b>not</b> sell your personal information, show ads, build advertising profiles, or use your information to train AI models.</p>\n<h2>5. What other people can see</h2>\n<ul><li><b>The people in your camp</b> (up to 10) see your camp name, your video and your mic/camera status, and hear your voice. The game hides your video and voice when the rules say so (for example at night). Your role is shown to the others only when the rules reveal it: to your Mafia partners, to players who are out, or at the end of the game.</li><li><b>Anyone with your camp's 4-letter code or invite link</b> can join while there is room. Share it only with the people you want to play with.</li></ul>\n<p>Everything else stays private between you and us.</p>\n<h2>6. Device permissions and optional features</h2>\n<ul><li><b>Camera and microphone:</b> asked for when you start or join a camp. Your video (small, about 320 by 240 pixels) and voice are sent directly, encrypted, from your browser to the other players' browsers. When two browsers can't connect directly, PeerJS's relay server passes the encrypted stream along. We never receive, record or store your video or voice. You can mute your mic or turn your camera off at any time, or refuse both and still play.</li><li><b>Sound:</b> short chimes when the game changes phase. You can switch them off.</li><li><b>Sharing:</b> when you share an invite link, your device's own share sheet or clipboard is used.</li></ul>\n<p>Your browser asks before any of these is used, and you can turn them off at any time in your browser or device settings.</p>\n<h2>7. Video calls are peer to peer</h2>\n<p>Mafia Camp's servers never see or hear the call. They only pass on each player's connection ID so the browsers can find each other, and they run the game (roles, timers, votes). The video and voice travel directly between the players' browsers, encrypted with the standard WebRTC protocols, or through PeerJS's relay when a direct connection isn't possible. Like any video call, the other players could record their screen without the app knowing, so play with people you trust.</p>\n<h2>8. Who helps us run Mafia Camp</h2>\n<p>We share personal information only with service providers who help us run Mafia Camp, and only what they need:</p>\n<ul><li><b>Anvil</b> (Anvil Works Ltd, United Kingdom): hosts Mafia Camp, its database and sign-in.</li><li><b>Google Fonts</b> (Google LLC, United States): delivers the typefaces. Your browser sends your IP address and browser details to Google when a page loads.</li><li><b>PeerJS</b> (the open-source PeerJS project, servers in Europe and the United States): its PeerServer passes the short connection set-up messages between players' browsers, and its relay servers carry the encrypted audio and video only when two browsers can't connect directly. They see your IP address and a random connection ID, not your name or role, and don't record the call.</li><li><b>Google STUN</b> (Google LLC, United States): tells your browser its public network address so it can connect directly to the other players. It receives your IP address, nothing else.</li></ul>\n<p>These providers process information on our behalf, or deliver content directly to your browser, under their own privacy commitments. We may also disclose information when the law requires it, to protect someone's safety, or as part of a sale or reorganisation of our business (the new owner would have to respect this policy).</p>\n<h2>9. Where your information is stored</h2>\n<p>Our hosting provider stores your information on servers that may be outside Québec and Canada, including in the United Kingdom and the European Union. Before sending information outside Québec, we assessed that it will be adequately protected. The UK and the EU are recognised as giving adequate protection, and Canada has an EU adequacy decision for commercial organisations. Where a provider is in the United States, it relies on the EU–US Data Privacy Framework or standard contractual clauses.</p>\n<h2>10. How long we keep it</h2>\n<ul><li><b>Camps</b> (the camp name you used, the game data and the connection ID) are deleted automatically about 24 hours after the camp was last used. When you leave a camp before the game starts, your seat is deleted straight away.</li><li><b>Your account and what you add:</b> for as long as your account is open.</li><li><b>When you delete your account</b> (or ask us to): we delete or anonymise your personal information within 30 days. Copies in our hosting provider's backups disappear as those backups are replaced.</li><li>If the law requires us to keep something longer, we keep only that, and only for as long as required.</li></ul>\n<h2>11. How we protect it</h2>\n<p>Connections to Mafia Camp are encrypted (HTTPS). Passwords are stored only as secure hashes, so we can't read them. Only the people who run Mafia Camp can access the data, and only when they need to. No system is perfectly secure. If a security incident creates a risk of serious harm to you, we'll tell you and the relevant authorities as the law requires, and keep a record of it.</p>\n<h2>12. Your rights</h2>\n<p>Wherever you live, you can ask us to:</p>\n<ul><li><b>access</b> the personal information we hold about you, and get a copy;</li><li><b>correct</b> information that is wrong or incomplete;</li><li><b>delete</b> your account and personal information;</li><li><b>move</b> your information: we'll give it to you in a common, structured format;</li><li><b>withdraw your consent</b> to optional uses at any time;</li><li><b>object to or restrict</b> some uses, if you're in the EU or the UK;</li><li><b>stop the dissemination</b> of your information, or have a link to it de-indexed, if you're in Québec and the legal conditions are met.</li></ul>\n<p>To use these rights, email <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> from the address linked to your account (or tell us how to confirm it's you). It's free. We reply within 30 days.</p>\n<!--lk:rights-->\n<p>If you're not satisfied with our answer, you can complain to the Commission d'accès à l'information du Québec (cai.gouv.qc.ca), the Office of the Privacy Commissioner of Canada (priv.gc.ca), or, in the EU or the UK, your local data protection authority.</p>\n<h2>13. Children</h2>\n<p>Mafia Camp accounts are for people <b>16 and older</b>. We don't knowingly collect personal information from children under 16. If you think a child under 16 has created an account, tell us and we'll delete it.</p>\n<h2>14. Automated decisions</h2>\n<p>We don't make decisions about you based only on automated processing that have legal or similarly significant effects on you.</p>\n<h2>15. Cookies and browser storage</h2>\n<p>Mafia Camp uses only the cookies and browser storage it needs to work: no advertising or tracking. See <a href=\"#\" data-lk-goto=\"cookies\">Cookies &amp; Storage</a>.</p>\n<h2>16. Changes to this policy</h2>\n<p>Every version is dated. If we make a change that matters, we'll tell you in Mafia Camp before it applies and ask you to review it.</p>\n<h2>17. Contact</h2>\n<p>Questions, requests or complaints: <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>. Our person in charge of the protection of personal information: Arkvital, Montréal, Québec, Canada.</p>"}, {"id": "terms", "title": "Terms of Use", "heading": "Terms of Use", "html": "<p>These Terms of Use are an agreement between you and <b>Arkvital</b> (\"we\", \"us\"), Montréal, Québec, Canada, the operator of Mafia Camp (https://mafia-camp-game.anvil.app). By creating an account or using Mafia Camp, you agree to them. If you don't agree, please don't use Mafia Camp.</p>\n<h2>1. What Mafia Camp is</h2>\n<p>Mafia Camp is a video party game where 3 to 10 friends get secret roles, talk on a small group video call and vote to find the Mafia. Our <a href=\"#\" data-lk-goto=\"privacy\">Privacy Policy</a> explains how we handle your personal information and is part of these terms.</p>\n<h2>2. Who can use Mafia Camp</h2>\n<ul><li>You must be <b>16 or older</b> to create an account.</li><li>If you use Mafia Camp for a business or organisation, you confirm that you're allowed to accept these terms for it, and \"you\" includes that business.</li><li>You may not use Mafia Camp if we've suspended your account before, or if the law doesn't allow you to.</li></ul>\n<h2>3. Your account</h2>\n<ul><li>Give accurate information and keep it up to date.</li><li>Keep your password secret. You're responsible for what happens in your account. Tell us right away at <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> if you think someone else has used it.</li><li>One person per account. Don't share your account or create one for someone else without their permission.</li></ul>\n<h2>4. Your content</h2>\n<p>\"Your content\" means anything you add to Mafia Camp: your camp name.</p>\n<ul><li><b>You keep ownership</b> of your content.</li><li><b>You give us permission</b> (a worldwide, non-exclusive, royalty-free licence) to store, copy, display, adapt the format of and share your content, but only to run, show and improve Mafia Camp, and only to the people your settings allow. This permission ends when you delete the content or your account, except for copies other people have already received, and backups until they're replaced.</li><li><b>You're responsible</b> for your content. You confirm that you have the rights to post it, that it's accurate to the best of your knowledge, and that it follows these terms and the law.</li><li>If you think content on Mafia Camp infringes your rights, email <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> with a link to it and an explanation. We'll look into it promptly.</li></ul>\n<h2>5. Acceptable use</h2>\n<p>When you use Mafia Camp, don't:</p>\n<ul><li>break the law, or help anyone else break it;</li><li>harass, threaten, bully, discriminate against or impersonate anyone;</li><li>post content that is hateful, sexually explicit, violent, misleading, or that infringes someone else's rights (including copyright, trademarks and privacy);</li><li>share other people's personal information without their permission;</li><li>send spam or advertising that people didn't ask for;</li><li>try to get into accounts or data that aren't yours, test or break our security, or disrupt the service;</li><li>copy the service, or collect data from it with bots or scrapers, without our written permission;</li><li>upload viruses or harmful code.</li></ul>\n<h2>6. Moderation and enforcement</h2>\n<p>We may review, hide or remove content, and limit, suspend or close accounts, if we reasonably believe someone has broken these terms or the law, or to protect people or Mafia Camp. Where it's reasonable, we'll tell you why. If you think we got it wrong, email <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> and we'll take another look.</p>\n<h2>7. Points, rewards and virtual items</h2>\n<p>Roles, wins and other game results have <b>no cash value</b>. You can't sell, trade or exchange them for money, and they don't belong to you as property: they're part of how Mafia Camp works. We may change, rebalance or reset them, for example to fix a bug or keep things fair. They're lost if your account is deleted.</p>\n<h2>8. Playing on camera</h2>\n<p>You're on a live video call with the people in your camp. Be kind: the accusing and lying are part of the game, harassment isn't. Don't show anything on camera that you wouldn't show everyone in the camp, and don't record other players without their permission. The host can send a player home, and we may remove camps that break these Terms.</p>\n<h2>9. Our rights in Mafia Camp</h2>\n<p>Mafia Camp's software, design, text, graphics and other content we provide belong to us or to those who licensed them to us. We give you a personal, non-exclusive, non-transferable, revocable right to use Mafia Camp as these terms allow. If you send us ideas or feedback, we may use them freely, without owing you anything.</p>\n<h2>10. Other services and links</h2>\n<p>Mafia Camp relies on services run by others (listed in the Privacy Policy) and may link to other websites. We aren't responsible for their content or how they work, and your use of them is governed by their own terms.</p>\n<h2>11. Changes and availability</h2>\n<p>We're always improving Mafia Camp, so features may change. We may also suspend or stop part or all of Mafia Camp. We'll try to give reasonable notice of important changes, and before closing Mafia Camp we'll give you a way to get a copy of your information. We don't promise that Mafia Camp will always be available or free of errors.</p>\n<h2>12. Disclaimers</h2>\n<p>Mafia Camp is provided <b>\"as is\" and \"as available\"</b>. To the extent the law allows, we make no promises or warranties beyond those in these terms, including about fitness for a particular purpose or that content (ours or other users') is accurate.</p>\n<h2>13. Limitation of liability</h2>\n<p>To the extent the law allows, we are not liable for indirect, incidental or consequential losses, such as lost profits, lost data or lost opportunities, and our total liability to you for any claim about Mafia Camp is limited to the greater of the amount you paid us for Mafia Camp in the 12 months before the claim, or CAD $100.</p>\n<p>Nothing in these terms limits liability that can't be limited by law, including for bodily or moral injury, or for intentional or gross fault, and nothing takes away rights you have as a consumer under the law where you live (for example, under Québec's <i>Consumer Protection Act</i>).</p>\n<h2>14. Ending your use</h2>\n<p>You can stop using Mafia Camp at any time and ask us to delete your account at <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>. We may suspend or close your account as described in section 6. Sections that by their nature should continue (for example 9, 12, 13 and 16) continue after your account ends.</p>\n<h2>15. Changes to these terms</h2>\n<p>We may update these terms. Every version is dated. If a change matters, we'll tell you in Mafia Camp before it applies and ask you to accept it. If you don't accept the new terms, you can stop using Mafia Camp and delete your account.</p>\n<h2>16. Law and disputes</h2>\n<p>These terms are governed by the laws of Québec and the federal laws of Canada that apply there. Any dispute will be heard by the courts of the judicial district of Montréal, Québec, unless the law where you live gives you the right to go to your local courts. Before going to court, please contact us at <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>: most problems can be solved quickly.</p>\n<h2>17. Language</h2>\n<p>These terms are available in French and in English. The French version was made available to you first, and you have chosen to use the version in the language you're reading. <i>Ces conditions sont offertes en français et en anglais.</i></p>\n<h2>18. Contact</h2>\n<p>Arkvital, Montréal, Québec, Canada. Email: <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>.</p>"}, {"id": "cookies", "title": "Cookies & Storage", "heading": "Cookies & Storage", "html": "<p>This page explains the cookies and browser storage Mafia Camp uses. In short: <b>only what Mafia Camp needs to work</b>. There are no advertising, analytics or tracking cookies, and we don't follow you around the web. That's why there is no cookie banner.</p>\n<h2>What Mafia Camp stores in your browser</h2>\n<ul><li><b>Sign-in session</b> (cookie, set by our hosting provider Anvil): keeps you signed in while you use Mafia Camp and protects against forged requests. It's deleted when you close the browser or sign out.</li><li><b>\"Remember me\"</b> (only if you choose it when signing in): keeps you signed in on this device for a limited time.</li><li><b>Player key and preferences</b> (local storage): your random player key, the last camp name you used, the last camp code, and whether your mic, camera and sounds are on or off.</li><li><b>Privacy &amp; Terms preferences</b> (local storage): your language on this page, that you ticked the agreement box while signing up, and whether you chose \"Later\" on the reminder. Nothing personal.</li></ul>\n<p>All of these are strictly necessary to provide the service you asked for, so the law doesn't require us to ask for consent first. We'll ask before we ever add anything that isn't, such as analytics.</p>\n<h2>Content loaded from other services</h2>\n<p>To show Mafia Camp, your browser fetches a few things directly from other services. When it does, they receive your IP address and basic browser information, as with any website:</p>\n<ul><li><b>Google Fonts</b> (Google LLC, United States): delivers the typefaces. Your browser sends your IP address and browser details to Google when a page loads.</li><li><b>PeerJS</b> (the open-source PeerJS project, servers in Europe and the United States): its PeerServer passes the short connection set-up messages between players' browsers, and its relay servers carry the encrypted audio and video only when two browsers can't connect directly. They see your IP address and a random connection ID, not your name or role, and don't record the call.</li><li><b>Google STUN</b> (Google LLC, United States): tells your browser its public network address so it can connect directly to the other players. It receives your IP address, nothing else.</li></ul>\n<p>They don't receive your account information from us.</p>\n<h2>Your control</h2>\n<p>You can delete cookies and site data at any time in your browser settings. If you do, you'll be signed out. You can also block cookies, but then you won't be able to sign in.</p>\n<p>Questions: <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>.</p>"}], "ui": {"lang_name": "English", "title": "Privacy & Terms", "back": "Back to {app}", "print": "Print", "effective": "In effect since {date} · Version {version}", "guest_note": "Nothing to accept while you're not signed in. We'll ask when you create an account.", "accepted_on": "You accepted the Terms of Use and Privacy Policy on {date}.", "page_consent": "I'm 16 or older, I agree to the Terms of Use, and I have read the Privacy Policy.", "agree": "I agree", "saving": "Saving…", "save_error": "Couldn't save your answer. Please check your connection and try again.", "bar_new": "{app} now has a Privacy Policy and Terms of Use. Please take a moment to review them.", "bar_updated": "We've updated the Terms of Use and Privacy Policy for {app}. Please review them.", "later": "Later", "review": "Review", "btn_access": "Request a copy of my data", "btn_delete": "Delete my account", "btn_question": "Ask a privacy question", "your_email": "(the email address of my account)", "mail_access_subject": "{app}: request for a copy of my data", "mail_access_body": "Hello,\n\nPlease send me a copy of the personal information {app} holds about me.\n\nAccount email: {email}\n\nThank you.", "mail_delete_subject": "{app}: please delete my account", "mail_delete_body": "Hello,\n\nPlease delete my {app} account and the personal information linked to it.\n\nAccount email: {email}\n\nThank you.", "mail_question_subject": "{app}: privacy question", "mail_question_body": "Hello,\n\n", "signup_consent": "I'm 16 or older and I agree to the [terms]Terms of Use[/terms] and the [privacy]Privacy Policy[/privacy].", "signup_required": "Please tick the box to continue.", "link": "Privacy & Terms"}, "effective": "October 26, 2026"}, "fr": {"tabs": [{"id": "overview", "title": "Aperçu", "heading": "Confidentialité et conditions", "html": "<p>Mafia Camp est un jeu de société vidéo où 3 à 10 amis reçoivent des rôles secrets, discutent en petit appel vidéo de groupe et votent pour démasquer la Mafia. L'application est exploitée par Arkvital, à Montréal (Québec), Canada. Cette page explique simplement ce que nous faisons de vos renseignements et les règles d'utilisation de Mafia Camp. Les documents complets se trouvent dans les autres onglets.</p>\n<h2>L'essentiel</h2>\n<ul class=\"lk-key\"><li><span class=\"lk-ico\" aria-hidden=\"true\">📋</span><span><b>Ce que nous recueillons :</b> le nom de camp que vous tapez, une clé de joueur aléatoire conservée dans votre navigateur, et la partie elle-même (rôles, votes, choix de nuit) pour le camp que vous rejoignez. Votre vidéo et votre voix vont directement aux autres joueurs et ne sont jamais enregistrées.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">👀</span><span><b>Ce que les autres voient :</b> les personnes de votre camp : elles voient votre nom de camp et votre vidéo, entendent votre voix, et voient votre rôle quand les règles du jeu le révèlent.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🚫</span><span><b>Jamais vendus.</b> Aucune publicité, aucun pistage, et vos renseignements ne servent jamais à entraîner une IA.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🔒</span><span><b>Conservés en sécurité</b> par notre hébergeur, Anvil, avec des connexions chiffrées et des mots de passe hachés.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🎂</span><span><b>Comptes réservés aux 16 ans et plus.</b></span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🎥</span><span><b>Votre vidéo et votre voix ne sont jamais enregistrées.</b> Elles vont directement de votre navigateur à ceux des autres joueurs, chiffrées.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">🏕️</span><span><b>Aucun compte nécessaire.</b> Les camps et leurs données de jeu sont supprimés environ un jour après la dernière partie.</span></li><li><span class=\"lk-ico\" aria-hidden=\"true\">✉️</span><span><b>Vos données, votre choix.</b> Obtenez-en une copie, corrigez-les ou supprimez votre compte en tout temps, par courriel.</span></li></ul>\n<h2>Vos choix</h2>\n<p>Vous pouvez en tout temps demander une copie de vos données, les faire corriger ou supprimer votre compte. Écrivez-nous à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> : nous répondons dans un délai de 30 jours, sans frais.</p>\n<!--lk:rights-->\n<h2>Les documents complets</h2>\n<ul><li><a href=\"#\" data-lk-goto=\"privacy\">Politique de confidentialité</a> : ce que nous recueillons, pourquoi, qui nous aide à faire fonctionner Mafia Camp et vos droits.</li><li><a href=\"#\" data-lk-goto=\"terms\">Conditions d'utilisation</a> : les règles d'utilisation de Mafia Camp.</li><li><a href=\"#\" data-lk-goto=\"cookies\">Témoins et stockage</a> : ce que Mafia Camp conserve dans votre navigateur.</li></ul>"}, {"id": "privacy", "title": "Confidentialité", "heading": "Politique de confidentialité", "html": "<p>La présente politique de confidentialité explique comment Arkvital (« nous ») recueille, utilise, communique et protège les renseignements personnels dans Mafia Camp (https://mafia-camp-game.anvil.app), ainsi que les droits dont vous disposez. Elle a été rédigée pour respecter la <i>Loi sur la protection des renseignements personnels dans le secteur privé</i> du Québec (Loi 25), la LPRPDE du Canada et le Règlement général sur la protection des données (RGPD) de l'Union européenne et du Royaume-Uni.</p>\n<h2>1. Qui est responsable</h2>\n<p>Mafia Camp est exploitée par <b>Arkvital</b>, Montréal (Québec), Canada. Nous sommes responsables des renseignements personnels décrits ici.</p>\n<p>Vous pouvez joindre notre responsable de la protection des renseignements personnels à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>.</p>\n<h2>2. Portée de cette politique</h2>\n<p>Cette politique s'applique à Mafia Camp et aux renseignements que vous nous fournissez ou que nous recueillons lorsque vous l'utilisez.</p>\n<h2>3. Ce que nous recueillons</h2>\n<p><b>Les renseignements que vous nous fournissez</b></p>\n<ul><li><b>Aucun compte :</b> vous jouez sans vous inscrire. Votre navigateur crée une clé de joueur aléatoire et la garde dans le stockage local pour que vous gardiez votre place si vous rechargez la page.</li><li><b>Votre nom de camp :</b> le nom que vous tapez pour lancer ou rejoindre un camp (16 caractères au plus).</li><li><b>Données de jeu :</b> le code du camp, votre place, votre présence, si votre micro et votre caméra sont allumés, votre rôle, vos choix de nuit et vos votes, et l'histoire de la partie (qui est sorti et quand).</li><li><b>Identifiant de connexion :</b> un identifiant aléatoire fourni par PeerJS qui permet aux navigateurs des autres joueurs d'appeler le vôtre. Il change chaque fois que vous ouvrez la page.</li></ul>\n<p><b>Les renseignements recueillis automatiquement</b></p>\n<ul><li><b>Renseignements de connexion :</b> la date de votre inscription et de votre dernière connexion, ainsi que les tentatives de connexion échouées (pour protéger votre compte).</li><li><b>Journaux techniques :</b> notre hébergeur enregistre des détails techniques comme les adresses IP, le type de navigateur et les messages d'erreur, afin d'assurer la sécurité et le bon fonctionnement du service.</li></ul>\n<p>Nous ne recueillons que ce qui est nécessaire. Nous ne demandons pas, et vous ne devriez pas ajouter, de renseignements sensibles comme des renseignements de santé, des numéros de pièces d'identité ou des numéros de comptes financiers (votre vidéo montre tout ce que voit votre caméra : choisissez ce qui apparaît à l'image).</p>\n<h2>4. Pourquoi nous les utilisons et sur quelles bases</h2>\n<ul><li><b>Pour fournir Mafia Camp :</b> créer et gérer votre compte et les fonctions que vous utilisez. <i>Base : nécessaire pour fournir le service demandé (contrat).</i></li><li><b>Pour assurer la sécurité et le bon fonctionnement de Mafia Camp :</b> prévenir les abus et la fraude, corriger les problèmes, faire des sauvegardes. <i>Base : notre intérêt légitime à offrir un service sûr et fiable.</i></li><li><b>Pour communiquer avec vous au sujet de votre compte :</b> par exemple pour réinitialiser votre mot de passe. <i>Base : nécessaire pour fournir le service. Vous pouvez désactiver les avis facultatifs.</i></li><li><b>Pour les fonctions facultatives</b> qui nécessitent votre permission, énumérées à la section 6. <i>Base : votre consentement, que vous pouvez retirer en tout temps.</i></li><li><b>Pour respecter nos obligations légales</b> et répondre aux demandes légitimes des autorités. <i>Base : obligation légale.</i></li></ul>\n<p>Nous ne <b>vendons pas</b> vos renseignements personnels, n'affichons pas de publicité, ne créons pas de profils publicitaires et n'utilisons pas vos renseignements pour entraîner des modèles d'IA.</p>\n<h2>5. Ce que les autres peuvent voir</h2>\n<ul><li><b>Les personnes de votre camp</b> (jusqu'à 10) voient votre nom de camp, votre vidéo et l'état de votre micro et de votre caméra, et entendent votre voix. Le jeu masque votre vidéo et votre voix quand les règles l'exigent (la nuit, par exemple). Votre rôle n'est montré aux autres que lorsque les règles le révèlent : à vos partenaires de la Mafia, aux joueurs éliminés ou à la fin de la partie.</li><li><b>Toute personne qui a le code de 4 lettres ou le lien d'invitation de votre camp</b> peut le rejoindre tant qu'il reste de la place. Ne le partagez qu'avec les personnes avec qui vous voulez jouer.</li></ul>\n<p>Tout le reste demeure confidentiel entre vous et nous.</p>\n<h2>6. Autorisations de l'appareil et fonctions facultatives</h2>\n<ul><li><b>Caméra et micro :</b> demandés quand vous lancez ou rejoignez un camp. Votre vidéo (petite, environ 320 sur 240 pixels) et votre voix sont envoyées directement, chiffrées, de votre navigateur à ceux des autres joueurs. Quand deux navigateurs ne peuvent pas se connecter directement, le serveur relais de PeerJS transmet le flux chiffré. Nous ne recevons, n'enregistrons et ne conservons jamais votre vidéo ni votre voix. Vous pouvez couper votre micro ou votre caméra à tout moment, ou refuser les deux et jouer quand même.</li><li><b>Son :</b> de courts carillons quand la partie change de phase. Vous pouvez les désactiver.</li><li><b>Partage :</b> quand vous partagez un lien d'invitation, la feuille de partage ou le presse-papiers de votre appareil est utilisé.</li></ul>\n<p>Votre navigateur vous demande la permission avant toute utilisation, et vous pouvez la retirer en tout temps dans les réglages de votre navigateur ou de votre appareil.</p>\n<h2>7. Les appels vidéo sont pair à pair</h2>\n<p>Les serveurs de Mafia Camp ne voient ni n'entendent jamais l'appel. Ils transmettent seulement l'identifiant de connexion de chaque joueur pour que les navigateurs se trouvent, et ils font tourner la partie (rôles, minuteries, votes). La vidéo et la voix circulent directement entre les navigateurs des joueurs, chiffrées selon les protocoles WebRTC standard, ou par le relais de PeerJS quand une connexion directe est impossible. Comme pour tout appel vidéo, les autres joueurs pourraient enregistrer leur écran à l'insu de l'application : jouez avec des personnes de confiance.</p>\n<h2>8. Qui nous aide à faire fonctionner Mafia Camp</h2>\n<p>Nous communiquons des renseignements personnels uniquement aux fournisseurs de services qui nous aident à faire fonctionner Mafia Camp, et seulement ce dont ils ont besoin :</p>\n<ul><li><b>Anvil</b> (Anvil Works Ltd, Royaume-Uni) : héberge Mafia Camp, sa base de données et la connexion.</li><li><b>Google Fonts</b> (Google LLC, États-Unis) : fournit les polices de caractères. Votre navigateur transmet votre adresse IP et des détails sur le navigateur à Google au chargement d'une page.</li><li><b>PeerJS</b> (le projet libre PeerJS, serveurs en Europe et aux États-Unis) : son PeerServer transmet les courts messages de mise en relation entre les navigateurs des joueurs, et ses serveurs relais acheminent l'audio et la vidéo chiffrés seulement quand deux navigateurs ne peuvent pas se connecter directement. Ils voient votre adresse IP et un identifiant de connexion aléatoire, pas votre nom ni votre rôle, et n'enregistrent pas l'appel.</li><li><b>Google STUN</b> (Google LLC, États-Unis) : indique à votre navigateur son adresse réseau publique pour qu'il se connecte directement aux autres joueurs. Il reçoit votre adresse IP, rien d'autre.</li></ul>\n<p>Ces fournisseurs traitent les renseignements pour notre compte, ou transmettent du contenu directement à votre navigateur, selon leurs propres engagements en matière de confidentialité. Nous pouvons aussi communiquer des renseignements lorsque la loi l'exige, pour protéger la sécurité d'une personne, ou dans le cadre d'une vente ou d'une réorganisation de notre entreprise (le nouvel exploitant devra respecter cette politique).</p>\n<h2>9. Où vos renseignements sont conservés</h2>\n<p>Notre hébergeur conserve vos renseignements sur des serveurs qui peuvent se trouver à l'extérieur du Québec et du Canada, notamment au Royaume-Uni et dans l'Union européenne. Avant de communiquer des renseignements à l'extérieur du Québec, nous avons évalué qu'ils y bénéficieront d'une protection adéquate. Le Royaume-Uni et l'Union européenne sont reconnus comme offrant une protection adéquate, et le Canada bénéficie d'une décision d'adéquation de l'UE pour les organisations commerciales. Lorsqu'un fournisseur est situé aux États-Unis, il s'appuie sur le cadre de protection des données UE–États-Unis ou sur des clauses contractuelles types.</p>\n<h2>10. Combien de temps nous les conservons</h2>\n<ul><li><b>Les camps</b> (le nom de camp utilisé, les données de jeu et l'identifiant de connexion) sont supprimés automatiquement environ 24 heures après la dernière utilisation du camp. Si vous quittez un camp avant le début de la partie, votre place est supprimée immédiatement.</li><li><b>Votre compte et ce que vous y ajoutez :</b> tant que votre compte est ouvert.</li><li><b>Lorsque vous supprimez votre compte</b> (ou nous le demandez) : nous supprimons ou anonymisons vos renseignements personnels dans un délai de 30 jours. Les copies dans les sauvegardes de notre hébergeur disparaissent à mesure que ces sauvegardes sont remplacées.</li><li>Si la loi nous oblige à conserver un renseignement plus longtemps, nous ne conservons que celui-ci, et seulement le temps requis.</li></ul>\n<h2>11. Comment nous les protégeons</h2>\n<p>Les connexions à Mafia Camp sont chiffrées (HTTPS). Les mots de passe sont conservés uniquement sous forme de hachages sécurisés : nous ne pouvons pas les lire. Seules les personnes qui exploitent Mafia Camp peuvent accéder aux données, et seulement lorsque c'est nécessaire. Aucun système n'est parfaitement sûr. Si un incident de confidentialité présente un risque de préjudice sérieux pour vous, nous vous en aviserons, ainsi que les autorités concernées, comme la loi l'exige, et nous le consignerons dans un registre.</p>\n<h2>12. Vos droits</h2>\n<p>Où que vous viviez, vous pouvez nous demander :</p>\n<ul><li>d'<b>accéder</b> aux renseignements personnels que nous détenons sur vous et d'en obtenir une copie;</li><li>de <b>rectifier</b> des renseignements inexacts ou incomplets;</li><li>de <b>supprimer</b> votre compte et vos renseignements personnels;</li><li>de <b>transférer</b> vos renseignements : nous vous les remettrons dans un format structuré et couramment utilisé;</li><li>de <b>retirer votre consentement</b> aux utilisations facultatives, en tout temps;</li><li>de vous <b>opposer à certaines utilisations ou de les limiter</b>, si vous êtes dans l'UE ou au Royaume-Uni;</li><li>de <b>cesser la diffusion</b> de vos renseignements ou de <b>désindexer</b> un hyperlien qui y mène, si vous êtes au Québec et que les conditions prévues par la loi sont remplies.</li></ul>\n<p>Pour exercer ces droits, écrivez à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> depuis l'adresse liée à votre compte (ou indiquez-nous comment confirmer votre identité). C'est gratuit. Nous répondons dans un délai de 30 jours.</p>\n<!--lk:rights-->\n<p>Si vous n'êtes pas satisfait de notre réponse, vous pouvez porter plainte auprès de la Commission d'accès à l'information du Québec (cai.gouv.qc.ca), du Commissariat à la protection de la vie privée du Canada (priv.gc.ca) ou, dans l'UE ou au Royaume-Uni, de votre autorité locale de protection des données.</p>\n<h2>13. Enfants</h2>\n<p>Les comptes Mafia Camp sont réservés aux personnes de <b>16 ans et plus</b>. Nous ne recueillons pas sciemment de renseignements personnels auprès d'enfants de moins de 16 ans. Si vous pensez qu'un enfant de moins de 16 ans a créé un compte, dites-le-nous et nous le supprimerons.</p>\n<h2>14. Décisions automatisées</h2>\n<p>Nous ne prenons pas de décisions à votre sujet fondées exclusivement sur un traitement automatisé qui produisent des effets juridiques ou des effets importants similaires.</p>\n<h2>15. Témoins et stockage dans le navigateur</h2>\n<p>Mafia Camp n'utilise que les témoins et le stockage dont l'application a besoin pour fonctionner : aucune publicité, aucun pistage. Voir <a href=\"#\" data-lk-goto=\"cookies\">Témoins et stockage</a>.</p>\n<h2>16. Modifications de cette politique</h2>\n<p>Chaque version est datée. Si nous apportons un changement important, nous vous en informerons dans Mafia Camp avant son entrée en vigueur et vous demanderons d'en prendre connaissance.</p>\n<h2>17. Nous joindre</h2>\n<p>Questions, demandes ou plaintes : <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>. Notre responsable de la protection des renseignements personnels : Arkvital, Montréal (Québec), Canada.</p>"}, {"id": "terms", "title": "Conditions", "heading": "Conditions d'utilisation", "html": "<p>Les présentes conditions d'utilisation constituent une entente entre vous et <b>Arkvital</b> (« nous »), Montréal (Québec), Canada, exploitant de Mafia Camp (https://mafia-camp-game.anvil.app). En créant un compte ou en utilisant Mafia Camp, vous les acceptez. Si vous ne les acceptez pas, veuillez ne pas utiliser Mafia Camp.</p>\n<h2>1. Ce qu'est Mafia Camp</h2>\n<p>Mafia Camp est un jeu de société vidéo où 3 à 10 amis reçoivent des rôles secrets, discutent en petit appel vidéo de groupe et votent pour démasquer la Mafia. Notre <a href=\"#\" data-lk-goto=\"privacy\">politique de confidentialité</a> explique comment nous traitons vos renseignements personnels et fait partie des présentes conditions.</p>\n<h2>2. Qui peut utiliser Mafia Camp</h2>\n<ul><li>Vous devez avoir <b>16 ans ou plus</b> pour créer un compte.</li><li>Si vous utilisez Mafia Camp pour une entreprise ou une organisation, vous confirmez être autorisé à accepter ces conditions en son nom, et « vous » inclut alors cette entreprise.</li><li>Vous ne pouvez pas utiliser Mafia Camp si nous avons déjà suspendu votre compte, ou si la loi vous l'interdit.</li></ul>\n<h2>3. Votre compte</h2>\n<ul><li>Fournissez des renseignements exacts et tenez-les à jour.</li><li>Gardez votre mot de passe secret. Vous êtes responsable de ce qui se passe dans votre compte. Prévenez-nous sans délai à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> si vous pensez que quelqu'un d'autre l'a utilisé.</li><li>Un compte par personne. Ne partagez pas votre compte et n'en créez pas pour quelqu'un d'autre sans sa permission.</li></ul>\n<h2>4. Votre contenu</h2>\n<p>« Votre contenu » désigne tout ce que vous ajoutez à Mafia Camp : votre nom de camp.</p>\n<ul><li><b>Vous demeurez propriétaire</b> de votre contenu.</li><li><b>Vous nous donnez la permission</b> (une licence mondiale, non exclusive et gratuite) de conserver, copier, afficher, adapter le format et partager votre contenu, mais uniquement pour faire fonctionner, présenter et améliorer Mafia Camp, et uniquement auprès des personnes que vos réglages autorisent. Cette permission prend fin lorsque vous supprimez le contenu ou votre compte, sauf pour les copies que d'autres personnes ont déjà reçues et pour les sauvegardes jusqu'à leur remplacement.</li><li><b>Vous êtes responsable</b> de votre contenu. Vous confirmez détenir les droits nécessaires pour le publier, qu'il est exact au meilleur de votre connaissance et qu'il respecte ces conditions et la loi.</li><li>Si vous pensez qu'un contenu sur Mafia Camp porte atteinte à vos droits, écrivez à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> en indiquant le lien et vos explications. Nous examinerons la situation rapidement.</li></ul>\n<h2>5. Utilisation acceptable</h2>\n<p>Lorsque vous utilisez Mafia Camp, vous ne devez pas :</p>\n<ul><li>enfreindre la loi ou aider quelqu'un à l'enfreindre;</li><li>harceler, menacer, intimider, discriminer ou usurper l'identité de quiconque;</li><li>publier du contenu haineux, sexuellement explicite, violent, trompeur ou qui porte atteinte aux droits d'autrui (notamment le droit d'auteur, les marques de commerce et la vie privée);</li><li>communiquer les renseignements personnels d'autres personnes sans leur permission;</li><li>envoyer des pourriels ou de la publicité non sollicitée;</li><li>tenter d'accéder à des comptes ou à des données qui ne sont pas les vôtres, tester ou contourner notre sécurité, ou perturber le service;</li><li>copier le service ou en extraire des données au moyen de robots ou d'outils de moissonnage sans notre permission écrite;</li><li>téléverser des virus ou du code malveillant.</li></ul>\n<h2>6. Modération et application des règles</h2>\n<p>Nous pouvons examiner, masquer ou retirer du contenu, et restreindre, suspendre ou fermer des comptes, si nous croyons raisonnablement qu'une personne a enfreint ces conditions ou la loi, ou pour protéger des personnes ou Mafia Camp. Lorsque c'est raisonnable, nous vous en expliquerons la raison. Si vous pensez que nous avons fait erreur, écrivez à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> et nous réexaminerons la situation.</p>\n<h2>7. Points, récompenses et objets virtuels</h2>\n<p>Les rôles, victoires et autres résultats de jeu n'ont <b>aucune valeur monétaire</b>. Vous ne pouvez pas les vendre, les échanger ni les convertir en argent, et ils ne vous appartiennent pas en propriété : ils font partie du fonctionnement de Mafia Camp. Nous pouvons les modifier, les rééquilibrer ou les réinitialiser, par exemple pour corriger une erreur ou préserver l'équité. Ils sont perdus si votre compte est supprimé.</p>\n<h2>8. Jouer devant la caméra</h2>\n<p>Vous êtes en appel vidéo en direct avec les personnes de votre camp. Soyez bienveillants : accuser et mentir font partie du jeu, le harcèlement non. Ne montrez rien à la caméra que vous ne montreriez pas à tout le camp, et n'enregistrez pas les autres joueurs sans leur permission. L'hôte peut renvoyer un joueur chez lui, et nous pouvons supprimer les camps qui enfreignent ces Conditions.</p>\n<h2>9. Nos droits sur Mafia Camp</h2>\n<p>Le logiciel, le design, les textes, les illustrations et les autres contenus que nous fournissons dans Mafia Camp nous appartiennent ou appartiennent à ceux qui nous ont accordé une licence. Nous vous accordons un droit personnel, non exclusif, non transférable et révocable d'utiliser Mafia Camp conformément à ces conditions. Si vous nous transmettez des idées ou des commentaires, nous pouvons les utiliser librement, sans rien vous devoir.</p>\n<h2>10. Autres services et liens</h2>\n<p>Mafia Camp s'appuie sur des services exploités par des tiers (énumérés dans la politique de confidentialité) et peut contenir des liens vers d'autres sites. Nous ne sommes pas responsables de leur contenu ni de leur fonctionnement, et leur utilisation est régie par leurs propres conditions.</p>\n<h2>11. Changements et disponibilité</h2>\n<p>Nous améliorons constamment Mafia Camp : les fonctions peuvent donc changer. Nous pouvons aussi suspendre ou cesser tout ou partie de Mafia Camp. Nous tenterons de donner un préavis raisonnable des changements importants et, avant de fermer Mafia Camp, nous vous offrirons un moyen d'obtenir une copie de vos renseignements. Nous ne garantissons pas que Mafia Camp sera toujours disponible ou exempte d'erreurs.</p>\n<h2>12. Avis de non-responsabilité</h2>\n<p>Mafia Camp est fournie <b>« telle quelle » et « selon sa disponibilité »</b>. Dans la mesure permise par la loi, nous ne donnons aucune garantie autre que celles prévues dans ces conditions, notamment quant à l'adaptation à un usage particulier ou à l'exactitude du contenu (le nôtre ou celui des autres utilisateurs).</p>\n<h2>13. Limitation de responsabilité</h2>\n<p>Dans la mesure permise par la loi, nous ne sommes pas responsables des pertes indirectes, accessoires ou consécutives, comme une perte de profits, de données ou d'occasions, et notre responsabilité totale envers vous pour toute réclamation liée à Mafia Camp est limitée au plus élevé des montants suivants : la somme que vous nous avez versée pour Mafia Camp au cours des 12 mois précédant la réclamation, ou 100 $ CA.</p>\n<p>Rien dans ces conditions ne limite une responsabilité qui ne peut l'être en vertu de la loi, notamment pour un préjudice corporel ou moral, ou pour une faute intentionnelle ou lourde, et rien ne vous prive des droits que vous accorde, en tant que consommateur, la loi de l'endroit où vous vivez (par exemple, la <i>Loi sur la protection du consommateur</i> du Québec).</p>\n<h2>14. Fin de l'utilisation</h2>\n<p>Vous pouvez cesser d'utiliser Mafia Camp en tout temps et nous demander de supprimer votre compte à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>. Nous pouvons suspendre ou fermer votre compte comme décrit à la section 6. Les sections qui, par leur nature, doivent survivre (par exemple les sections 9, 12, 13 et 16) demeurent en vigueur après la fermeture de votre compte.</p>\n<h2>15. Modifications de ces conditions</h2>\n<p>Nous pouvons mettre à jour ces conditions. Chaque version est datée. Si un changement est important, nous vous en informerons dans Mafia Camp avant son entrée en vigueur et vous demanderons de l'accepter. Si vous n'acceptez pas les nouvelles conditions, vous pouvez cesser d'utiliser Mafia Camp et supprimer votre compte.</p>\n<h2>16. Droit applicable et différends</h2>\n<p>Ces conditions sont régies par les lois du Québec et les lois fédérales du Canada qui s'y appliquent. Tout différend sera soumis aux tribunaux du district judiciaire de Montréal (Québec), sauf si la loi de l'endroit où vous vivez vous permet de vous adresser aux tribunaux de votre région. Avant de vous adresser aux tribunaux, veuillez nous écrire à <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a> : la plupart des problèmes se règlent rapidement.</p>\n<h2>17. Langue</h2>\n<p>Ces conditions sont offertes en français et en anglais. La version française vous a d'abord été présentée, et vous avez choisi d'utiliser la version dans la langue que vous lisez. <i>These terms are available in French and in English.</i></p>\n<h2>18. Nous joindre</h2>\n<p>Arkvital, Montréal (Québec), Canada. Courriel : <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>.</p>"}, {"id": "cookies", "title": "Témoins", "heading": "Témoins et stockage", "html": "<p>Cette page explique les témoins (cookies) et le stockage dans le navigateur qu'utilise Mafia Camp. En bref : <b>uniquement ce dont Mafia Camp a besoin pour fonctionner</b>. Aucun témoin publicitaire, analytique ou de pistage, et nous ne vous suivons pas sur le Web. C'est pourquoi il n'y a pas de bandeau sur les témoins.</p>\n<h2>Ce que Mafia Camp conserve dans votre navigateur</h2>\n<ul><li><b>Session de connexion</b> (témoin déposé par notre hébergeur Anvil) : vous garde connecté pendant que vous utilisez Mafia Camp et protège contre les requêtes falsifiées. Il est supprimé lorsque vous fermez le navigateur ou vous déconnectez.</li><li><b>« Se souvenir de moi »</b> (seulement si vous le choisissez à la connexion) : vous garde connecté sur cet appareil pendant une durée limitée.</li><li><b>Clé de joueur et préférences</b> (stockage local) : votre clé de joueur aléatoire, le dernier nom de camp utilisé, le dernier code de camp, et si votre micro, votre caméra et les sons sont activés ou non.</li><li><b>Préférences de la page Confidentialité et conditions</b> (stockage local) : votre langue sur cette page, le fait que vous avez coché la case d'acceptation à l'inscription, et si vous avez choisi « Plus tard » dans le rappel. Rien de personnel.</li></ul>\n<p>Tous ces éléments sont strictement nécessaires pour fournir le service demandé : la loi n'exige donc pas votre consentement préalable. Nous vous le demanderons avant d'ajouter quoi que ce soit qui ne l'est pas, comme des outils d'analyse.</p>\n<h2>Contenu chargé depuis d'autres services</h2>\n<p>Pour afficher Mafia Camp, votre navigateur récupère quelques éléments directement auprès d'autres services. Ceux-ci reçoivent alors votre adresse IP et des renseignements de base sur votre navigateur, comme pour tout site Web :</p>\n<ul><li><b>Google Fonts</b> (Google LLC, États-Unis) : fournit les polices de caractères. Votre navigateur transmet votre adresse IP et des détails sur le navigateur à Google au chargement d'une page.</li><li><b>PeerJS</b> (le projet libre PeerJS, serveurs en Europe et aux États-Unis) : son PeerServer transmet les courts messages de mise en relation entre les navigateurs des joueurs, et ses serveurs relais acheminent l'audio et la vidéo chiffrés seulement quand deux navigateurs ne peuvent pas se connecter directement. Ils voient votre adresse IP et un identifiant de connexion aléatoire, pas votre nom ni votre rôle, et n'enregistrent pas l'appel.</li><li><b>Google STUN</b> (Google LLC, États-Unis) : indique à votre navigateur son adresse réseau publique pour qu'il se connecte directement aux autres joueurs. Il reçoit votre adresse IP, rien d'autre.</li></ul>\n<p>Ils ne reçoivent pas de notre part les renseignements de votre compte.</p>\n<h2>Vos choix</h2>\n<p>Vous pouvez supprimer les témoins et les données du site en tout temps dans les réglages de votre navigateur. Vous serez alors déconnecté. Vous pouvez aussi bloquer les témoins, mais vous ne pourrez plus vous connecter.</p>\n<p>Questions : <a href=\"mailto:arkvital@outlook.com\">arkvital@outlook.com</a>.</p>"}], "ui": {"lang_name": "Français", "title": "Confidentialité et conditions", "back": "Retour à {app}", "print": "Imprimer", "effective": "En vigueur depuis le {date} · Version {version}", "guest_note": "Rien à accepter tant que vous n'êtes pas connecté. Nous vous le demanderons à la création de votre compte.", "accepted_on": "Vous avez accepté les conditions d'utilisation et la politique de confidentialité le {date}.", "page_consent": "J'ai 16 ans ou plus, j'accepte les conditions d'utilisation et j'ai lu la politique de confidentialité.", "agree": "J'accepte", "saving": "Enregistrement…", "save_error": "Impossible d'enregistrer votre réponse. Vérifiez votre connexion et réessayez.", "bar_new": "{app} a maintenant une politique de confidentialité et des conditions d'utilisation. Prenez un moment pour les consulter.", "bar_updated": "Nous avons mis à jour les conditions d'utilisation et la politique de confidentialité de {app}. Veuillez les consulter.", "later": "Plus tard", "review": "Consulter", "btn_access": "Obtenir une copie de mes données", "btn_delete": "Supprimer mon compte", "btn_question": "Poser une question", "your_email": "(l'adresse courriel de mon compte)", "mail_access_subject": "{app} : demande de copie de mes données", "mail_access_body": "Bonjour,\n\nVeuillez m'envoyer une copie des renseignements personnels que {app} détient à mon sujet.\n\nCourriel du compte : {email}\n\nMerci.", "mail_delete_subject": "{app} : suppression de mon compte", "mail_delete_body": "Bonjour,\n\nVeuillez supprimer mon compte {app} et les renseignements personnels qui y sont liés.\n\nCourriel du compte : {email}\n\nMerci.", "mail_question_subject": "{app} : question sur la confidentialité", "mail_question_body": "Bonjour,\n\n", "signup_consent": "J'ai 16 ans ou plus et j'accepte les [terms]conditions d'utilisation[/terms] et la [privacy]politique de confidentialité[/privacy].", "signup_required": "Veuillez cocher la case pour continuer.", "link": "Confidentialité et conditions"}, "effective": "26 octobre 2026"}}});
