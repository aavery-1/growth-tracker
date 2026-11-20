/* Causeway sign-in (public). The app code is not on this site: after a KIPP account signs in,
   it downloads from private database storage that only signed-in accounts can read. */
(function () {
  'use strict';
  var SB_URL = 'https://cwjmlunqfhaioyuijhkk.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3am1sdW5xZmhhaW95dWlqaGtrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNjk3OTcsImV4cCI6MjEwMjc0NTc5N30.1OeHzNFoeCu7ezocqyqxvvpOinjYnnocGuwBGVbKynU';   // publishable key: public by design; the database rules decide access
  var BUCKET = 'app-code';
  var VER = window.GH_VERSION || '';
  window.__CW_AUTH_HASH = location.hash || '';   // invite and reset links, saved before the client reads them

  var css = [
    'html.cw-wait body > *:not(#cwSignin){display:none !important}',
    '#cwSignin{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:#f4f4f4;font-family:"IBM Plex Sans","Helvetica Neue",Arial,sans-serif;color:#161616;overflow:auto}',
    '#cwSignin *{box-sizing:border-box}',
    '#cwSignin .cw-card{width:100%;max-width:400px;background:#fff;padding:32px 16px 16px;text-align:left}',
    '#cwSignin .cw-logo{display:block;height:20px;margin:0 auto}',
    '#cwSignin .cw-hero{display:flex;flex-direction:column;align-items:center;gap:12px;margin:24px 0}',
    '#cwSignin .cw-hero-name{font-size:20px;line-height:28px;font-weight:600}',
    '#cwSignin p.cw-intro{margin:0 0 16px;font-size:14px;line-height:20px}',
    '#cwSignin form{display:flex;flex-direction:column;gap:16px}',
    '#cwSignin .cw-field label{display:block;margin-bottom:8px;font-size:12px;line-height:16px;letter-spacing:.32px;color:#525252}',
    '#cwSignin input[type=email],#cwSignin input[type=password],#cwSignin input[type=text]{width:100%;height:40px;padding:0 16px;font:inherit;font-size:14px;color:#161616;background:#f4f4f4;border:0;border-bottom:1px solid #8d8d8d;border-radius:0}',
    '#cwSignin input:focus{outline:2px solid #0f62fe;outline-offset:-2px}',
    '#cwSignin .cw-check{display:flex;align-items:center;gap:8px;font-size:14px}',
    '#cwSignin .cw-check input{width:16px;height:16px;margin:0}',
    '#cwSignin button.cw-btn{height:48px;padding:0 16px;margin-top:8px;font:inherit;font-size:14px;text-align:left;color:#fff;background:#0f62fe;border:1px solid transparent;border-radius:0;cursor:pointer}',
    '#cwSignin button.cw-btn:hover{background:#0050e6}',
    '#cwSignin button.cw-btn:focus-visible{outline:2px solid #0f62fe;outline-offset:2px;box-shadow:inset 0 0 0 1px #fff}',
    '#cwSignin button.cw-btn:disabled{background:#8d8d8d;cursor:wait}',
    '#cwSignin .cw-foot{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:8px;font-size:12px;line-height:16px;color:#525252}',
    '#cwSignin .cw-link{padding:0;font:inherit;font-size:14px;line-height:24px;color:#0f62fe;background:none;border:0;cursor:pointer}',
    '#cwSignin .cw-link:hover{text-decoration:underline}',
    '#cwSignin .cw-err{margin-top:16px;font-size:12px;line-height:16px;letter-spacing:.32px;color:#da1e28}',
    '#cwSignin .cw-info{margin-top:16px;padding:12px 16px;font-size:14px;line-height:20px;background:#edf5ff;border-left:3px solid #0043ce}',
    '#cwSignin .cw-wave{animation:cwFlow 3s cubic-bezier(.2,0,.38,.9) both,cwDrift 4s linear 3s infinite}',
    '#cwSignin.cw-loading .cw-form-wrap{display:none}',
    '@keyframes cwFlow{from{transform:translateX(-19.2px)}to{transform:translateX(0)}}',
    '@keyframes cwDrift{from{transform:translateX(-9.6px)}to{transform:translateX(0)}}',
    '@media (prefers-reduced-motion:reduce){#cwSignin .cw-wave{animation:none}}'
  ].join('\n');
  var st = document.createElement('style'); st.id = 'cwSigninCss'; st.textContent = css; document.head.appendChild(st);
  document.documentElement.classList.add('cw-wait');

  var MARK = '<svg class="cw-mark" viewBox="0 0 32 32" width="64" height="64" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="16" fill="#001d6c"/><path fill="#fff" transform="translate(6.5 8.5) scale(.73) translate(-3 -10.5)" d="M3 10.5H29V20H27.5A3.333 3.333 0 0 0 20.833 20H19.333A3.333 3.333 0 0 0 12.667 20H11.167A3.333 3.333 0 0 0 4.5 20H3Z"/><rect x="6.5" y="9.96" width="19" height=".66" fill="#001d6c"/><svg x="5" y="18.4" width="22" height="6" viewBox="0 0 22 6"><path class="cw-wave" fill="none" stroke="#72c1ea" stroke-width="1.5" stroke-linecap="round" d="M-19.2 3 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0"/></svg></svg>';
  var root = document.createElement('div'); root.id = 'cwSignin'; root.className = 'cw-loading';
  document.body.appendChild(root);
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function render(mode, err, info, email) {
    root.className = '';
    var signin = mode !== 'forgot';
    root.innerHTML = '<main class="cw-card" aria-labelledby="cwTitle">' +
      '<img class="cw-logo" src="assets/logo-two-tone.png" alt="KIPP Team &amp; Family">' +
      '<div class="cw-hero">' + MARK + '<h1 class="cw-hero-name" id="cwTitle" style="margin:0">Causeway</h1></div>' +
      '<div class="cw-form-wrap">' +
      (signin ? '' : '<p class="cw-intro">We\'ll email you a reset link.</p>') +
      '<form id="cwForm" autocomplete="on" novalidate>' +
      '<div class="cw-field"><label for="cwEmail">Work email</label><input id="cwEmail" type="email" autocomplete="username" required value="' + esc(email || '') + '"></div>' +
      (signin ? '<div class="cw-field"><label for="cwPw">Password</label><input id="cwPw" type="password" autocomplete="current-password" required></div>' +
        '<label class="cw-check"><input type="checkbox" id="cwShow"> Show password</label>' : '') +
      '<button type="submit" class="cw-btn" id="cwSubmit">' + (signin ? 'Sign in' : 'Send reset link') + '</button></form>' +
      (err ? '<div class="cw-err" role="alert">' + esc(err) + '</div>' : '') +
      (info ? '<div class="cw-info" role="status">' + esc(info) + '</div>' : '') +
      '<div class="cw-foot">' + (signin ? '<button type="button" class="cw-link" data-mode="forgot">Forgot password?</button><div>No account? Ask your admin.</div>'
        : '<button type="button" class="cw-link" data-mode="signin">Back to sign in</button>') + '</div></div></main>';
    var f = root.querySelector('#cwForm'), sub = root.querySelector('#cwSubmit'), show = root.querySelector('#cwShow');
    if (show) show.addEventListener('change', function () { root.querySelector('#cwPw').type = show.checked ? 'text' : 'password'; });
    root.querySelectorAll('[data-mode]').forEach(function (b) { b.addEventListener('click', function () { render(b.getAttribute('data-mode'), null, null, root.querySelector('#cwEmail').value); }); });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var em = root.querySelector('#cwEmail').value.trim();
      if (!em) return render(mode, 'Enter your work email.', null, em);
      sub.disabled = true; sub.textContent = 'One moment…';
      if (!signin) {
        client.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname }).then(function () {
          render('signin', null, 'If that email has an account, a reset link is on its way. Check your inbox.', em);
        }, function () { render('forgot', 'Could not send the link. Try again.', null, em); });
        return;
      }
      client.auth.signInWithPassword({ email: em, password: root.querySelector('#cwPw').value }).then(function (r) {
        if (r.error) {
          var m = String(r.error.message || r.error.code || '');
          render('signin', /invalid login|invalid_credentials/i.test(m) ? "That email and password don't match. Check them and try again."
            : /not confirmed/i.test(m) ? "Your account isn't active yet. Ask your admin."
            : /rate|too many/i.test(m) ? 'Too many tries. Wait a minute, then try again.' : 'Could not sign in. Try again.', null, em);
          setTimeout(function () { var p = root.querySelector('#cwPw'); if (p) p.focus(); }, 30);
          return;
        }
        boot();
      }, function () { render('signin', "Can't reach the database. Check your connection and try again.", null, em); });
    });
    setTimeout(function () { var i = root.querySelector(email ? '#cwPw' : '#cwEmail'); if (i) i.focus(); }, 30);
  }

  function getText(path) {   // private copy first (signed-in only); public files only until they are removed
    return client.storage.from(BUCKET).download(VER + '/' + path).then(function (r) {
      if (r.error || !r.data) throw r.error || new Error('missing');
      return r.data.text();
    }).catch(function () {
      return fetch(path + '?v=' + encodeURIComponent(VER), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('missing'); return r.text(); });
    });
  }

  function boot() {
    root.className = 'cw-loading';
    Promise.all([getText('styles.css'), getText('app.js')]).then(function (t) {
      var s = document.createElement('style'); s.id = 'cwAppCss'; s.textContent = t[0]; document.head.appendChild(s);
      var j = document.createElement('script'); j.textContent = t[1]; document.body.appendChild(j);
      root.remove(); st.remove(); document.documentElement.classList.remove('cw-wait');
    }, function () {
      render('signin', "Couldn't load Causeway. Refresh the page, or ask your admin if it keeps happening.");
    });
  }

  if (!window.supabase || !window.supabase.createClient) { render('signin', "Can't reach the database. Refresh the page."); return; }
  var client = window.supabase.createClient(SB_URL, SB_KEY);
  window.__CW_CLIENT = client;
  client.auth.getSession().then(function (r) {
    if (r && r.data && r.data.session) boot(); else render('signin');
  }, function () { render('signin'); });
})();
