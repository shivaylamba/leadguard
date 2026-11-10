// LeadGuard UI: hash routes, no build step. Every dynamic value goes through esc().
(function () {
  var main = document.getElementById('main');
  var live = document.getElementById('live');
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var cfg = { venue_tz: 'America/Denver' };
  // Times are stored in UTC and always shown in the venue's zone (.gitar/review/time.md).
  var time = function (iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: cfg.venue_tz }) : '—'; };
  var api = function (p, opts) { return fetch(p, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); }); };
  var post = function (p, body) { return api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); };
  var say = function (msg) { live.textContent = msg; };
  // Just enough markdown for the assistant's answers: escape first, then **bold** and `code`.
  var md = function (text) { return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>'); };
  var timers = [];
  var every = function (fn, ms) { fn(); timers.push(setInterval(fn, ms)); };
  var store = { get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  var initials = function (name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); };
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };

  // Icons: decorative, so aria-hidden; every button that has one also has text or an aria-label.
  var P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    desk: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    badge: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="2.6"/><path d="M8.5 16.5c1-1.6 2.2-2.3 3.5-2.3s2.5.7 3.5 2.3"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>',
    pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    leads: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
    wifi: '<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
    wifioff: '<path d="M3 3l18 18M8.5 15.5a5 5 0 0 1 5.5-1M5 12a10 10 0 0 1 4-2.4M14.8 9.5A10 10 0 0 1 19 12M2 8.5A15 15 0 0 1 6.3 5.7M10.8 4.6A15 15 0 0 1 22 8.5"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6Z"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    print: '<path d="M7 9V4h10v5M7 17H5v-6h14v6h-2M8 14h8v6H8z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  };
  var icon = function (name) { return '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + '</svg>'; };

  // ── Shell: tabs and theme ─────────────────────────────────────────────
  var TABS = [['desk', 'Desk', 'desk'], ['badges', 'Badges', 'badge'], ['scan', 'Scanner', 'scan'], ['ops', 'Organizer', 'pulse'], ['leads', 'Leads', 'leads']];
  document.getElementById('tabs').innerHTML = TABS.map(function (t) { return '<a href="#/' + t[0] + '" data-tab="' + t[0] + '">' + icon(t[2]) + '<span>' + t[1] + '</span></a>'; }).join('');
  function markTab(name) {
    document.querySelectorAll('#tabs a').forEach(function (a) { if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  var themeBtn = document.getElementById('theme');
  function currentTheme() { return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); }
  function paintTheme() { var t = currentTheme(); themeBtn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); themeBtn.setAttribute('aria-label', 'Switch to ' + (t === 'dark' ? 'light' : 'dark') + ' theme'); }
  themeBtn.onclick = function () { var next = currentTheme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; store.set('leadguard.theme', next); paintTheme(); };
  paintTheme();

  function head(eyebrow, title, lede, right) {
    return '<div class="page-head"><div><p class="eyebrow">' + eyebrow + '</p><h1 class="title">' + title + '</h1>' + (lede ? '<p class="lede">' + lede + '</p>' : '') + '</div>' + (right || '') + '</div>';
  }

  // ── Home: who are you today? ──────────────────────────────────────────
  function home() {
    markTab('');
    main.innerHTML = '<div class="hero"><div>' +
      '<p class="eyebrow">' + icon('shield') + ' Check-in and lead integrity</p>' +
      '<h1 class="display">Every badge.<br>Every lead.<br>Accounted for.</h1>' +
      '<p class="lede">Find anyone at the desk, even with an old work email. Scan leads at booths that keep working without Wi-Fi. See trouble before a sponsor does.</p>' +
      '<div class="live-strip" id="homestats" aria-label="Right now"></div>' +
      '<ol class="how"><li><span class="num">1</span><span><b>Desk</b> finds people by any name or email they remember.</span></li>' +
      '<li><span class="num">2</span><span><b>Booths</b> scan offline; every scan syncs exactly once.</span></li>' +
      '<li><span class="num">3</span><span><b>Organizers</b> see anomalies within 30 seconds, and can ask the AI SRE what happened.</span></li></ol>' +
      '</div><div><h2 class="h">Who’s working today?</h2><nav class="choices" aria-label="Choose your role">' +
      choice('#/desk', 'desk', 'Registration desk', 'Find and check in attendees, link the email they use now.') +
      choice('#/scan', 'scan', 'Booth staff', 'Scan badges for your sponsor. Works without Wi-Fi.') +
      choice('#/ops', 'pulse', 'Organizer', 'Booth health, anomalies, tickets at risk, Ask ops.') +
      choice('#/leads', 'leads', 'Sponsor', 'Your consented leads, searchable by meaning, as CSV.') +
      choice('#/badges', 'badge', 'Walk-ups', 'Register someone on the spot and print their badge.') +
      '</nav></div></div>';
    api('/api/stats').then(function (s) {
      var last = s.checkins_per_min.slice(-5).reduce(function (a, b) { return a + b.n; }, 0);
      var el = document.getElementById('homestats');
      if (el) el.innerHTML = tile(s.checked_in, 'checked in') + tile(last, 'in the last 5 min') + tile(s.scans, 'lead scans');
    }).catch(function () {});
  }
  function choice(href, ic, title, desc) { return '<a class="choice" href="' + href + '"><span class="ico">' + icon(ic) + '</span><span><span class="ct">' + title + '</span><span class="cd" style="display:block">' + desc + '</span></span><span class="go">' + icon('arrow') + '</span></a>'; }
  function tile(n, l, cls) { return '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="n">' + esc(n) + '</div><div class="l">' + l + '</div></div>'; }

  // ── Desk: find the person, whatever email they remember ────────────────
  function desk() {
    markTab('desk');
    var deskId = store.get('leadguard.desk', 'desk-1');
    main.innerHTML = head('Registration desk', 'Who’s at the desk?', 'Search by any name, email, company, badge or order number. Typos and old work emails still match.',
      '<div style="min-width:170px"><label class="lbl" for="desk">This desk</label><select id="desk" class="field">' + ['desk-1', 'desk-2', 'desk-3'].map(function (d) { return '<option' + (d === deskId ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></div>') +
      '<form class="searchbar" role="search">' + icon('search') + '<label class="sr-only" for="q">Name, any email, company, badge or order number</label>' +
      '<input id="q" type="search" placeholder="e.g. Mira Novak, mira@oldjob.com, B10004" autocomplete="off" required>' +
      '<button type="button" class="btn" id="dcam">' + icon('camera') + '<span>Scan</span></button><button class="btn primary">Find</button></form>' +
      '<div class="chips" aria-label="Examples"><span>Try</span>' + ['Mira', 'Kenji Silva', 'B10004'].map(function (c) { return '<button type="button" class="chip" data-try="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
      '<video id="video" hidden playsinline muted></video><div id="results"></div>';
    document.getElementById('desk').onchange = function (e) { store.set('leadguard.desk', e.target.value); };
    var form = main.querySelector('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = document.getElementById('q').value.trim();
      var out = document.getElementById('results');
      api('/api/attendees/search?q=' + encodeURIComponent(q)).then(function (r) {
        window.rum.event('desk_search', { 'leadguard.search.results': r.results.length });
        out.innerHTML = r.results.length ? r.results.map(person).join('') : '<div class="empty">No one found for “' + esc(q) + '”. Try an old work email, the company, or the order number from their receipt.</div>';
        say(plural(r.results.length, 'person', 'people') + ' found');
        bindPeople();
      }).catch(function (err) { out.innerHTML = '<div class="note bad">' + esc(err.message) + '</div>'; });
    });
    main.querySelectorAll('[data-try]').forEach(function (b) { b.onclick = function () { document.getElementById('q').value = b.dataset.try; form.requestSubmit(); }; });
    document.getElementById('dcam').onclick = function () {
      camera(function (code) { document.getElementById('q').value = code; form.requestSubmit(); });
    };
    document.getElementById('q').focus();
  }
  function person(p) {
    var risk = p.email_risk && p.email_risk.at_risk ? '<div class="note warn">' + icon('mail') + '<span><b>Ticket email problem:</b> ' + esc(p.email_risk.reason) + '. Confirm the email they use now.</span></div>' : '';
    var tags = '<span class="tag mono">' + esc(p.badge_id) + '</span><span class="tag mono">' + esc(p.order_id) + '</span><span class="tag">' + esc(p.ticket_type) + '</span>' +
      (p.needs_assistance ? '<span class="pill warn">Needs assistance</span>' : '') +
      (p.checked_in_at ? '<span class="pill ok">Checked in ' + time(p.checked_in_at) + '</span>' : '<span class="pill">Not checked in</span>');
    return '<article class="panel person"><div class="avatar" aria-hidden="true">' + esc(initials(p.name)) + '</div>' +
      '<div><h2 class="name">' + esc(p.name) + '</h2><div class="sub">' + esc(p.company) + ' · ' + p.emails.map(esc).join(', ') + '</div><div class="tags">' + tags + '</div></div>' +
      '<div class="act"><button class="btn primary big" data-in="' + esc(p.badge_id) + '">' + icon('check') + '<span>' + (p.checked_in_at ? 'Check in again' : 'Check in') + '</span></button></div>' +
      '<div class="more">' + risk + '<div class="linkrow"><label class="sr-only" for="e-' + esc(p.badge_id) + '">Add the email they use now</label><input class="field" id="e-' + esc(p.badge_id) + '" type="email" placeholder="Email they use now">' +
      '<button class="btn" data-email="' + esc(p.badge_id) + '">Link email</button></div></div></article>';
  }
  function bindPeople() {
    main.querySelectorAll('[data-in]').forEach(function (b) {
      b.onclick = function () {
        post('/api/checkin', { badge_id: b.dataset.in, desk_id: document.getElementById('desk').value }).then(function (r) {
          window.rum.event('checkin', { 'leadguard.checkin.reentry': r.reentry }); say((r.reentry ? 'Re-entry: ' : 'Checked in: ') + r.name);
          b.innerHTML = icon('check') + '<span>' + (r.reentry ? 'Re-entry recorded' : 'Checked in') + '</span>'; b.classList.remove('primary'); b.classList.add('done'); b.disabled = true;
        }).catch(function (err) { say('Check-in failed: ' + err.message); });
      };
    });
    main.querySelectorAll('[data-email]').forEach(function (b) {
      b.onclick = function () {
        var input = document.getElementById('e-' + b.dataset.email);
        post('/api/attendees/' + encodeURIComponent(b.dataset.email) + '/emails', { email: input.value }).then(function () { say('Email linked'); b.innerHTML = icon('check') + '<span>Linked</span>'; b.classList.add('done'); window.rum.event('email_linked', {}); })
          .catch(function (err) { say('Could not link: ' + err.message); });
      };
    });
  }

  // ── Booth scanner: works offline, syncs when the Wi-Fi comes back ──────
  var QKEY = 'leadguard.queue';
  function queue() { return JSON.parse(store.get(QKEY, '[]')); }
  function saveQueue(q) { store.set(QKEY, JSON.stringify(q)); }
  function scanner() {
    markTab('scan');
    var booth = store.get('leadguard.booth', '');
    var scannerId = store.get('leadguard.scanner', '') || ('scanner-' + window.rum.device.slice(0, 8));
    store.set('leadguard.scanner', scannerId);
    var wifiOff = store.get('leadguard.wifiOff', '0') === '1';
    var lastSaved = '';
    api('/api/booths').then(function (r) {
      main.innerHTML = '<div class="scan-wrap">' + head('Booth scanner', 'Scan a badge', '') +
        '<div id="qstat" class="netbar on" aria-live="off"></div>' +
        '<div class="stack"><div><label class="lbl" for="booth">Your booth</label><select id="booth" class="field">' +
        r.booths.map(function (b) { return '<option value="' + esc(b.booth_id) + '"' + (b.booth_id === booth ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select></div>' +
        '<form id="scan" class="stack">' +
        '<button type="button" id="cam" class="camera-btn">' + icon('camera') + '<span>Scan with camera</span><span class="meta">Point it at the QR code on the badge</span></button>' +
        '<video id="video" hidden playsinline muted></video>' +
        '<div class="or">or type it</div>' +
        '<div><label class="lbl" for="badge">Badge number</label><input id="badge" class="field mono" placeholder="B10023" autocomplete="off" autocapitalize="characters" required></div>' +
        '<label class="consent" for="consent"><input type="checkbox" id="consent" checked><span><b>They agreed</b> to share their contact details with this sponsor.<span class="meta" style="display:block">Without consent the scan is kept, but no contact details reach the sponsor.</span></span></label>' +
        '<div><label class="lbl" for="notes">Notes</label><input id="notes" class="field" placeholder="What they asked about"></div>' +
        '<button class="btn primary big block">' + icon('check') + '<span>Save lead</span></button>' +
        '<p class="last" id="lastsaved"></p></form>' +
        '<label class="switch" for="wifi"><span>' + icon('wifioff') + ' Demo: simulate Wi-Fi off</span><input type="checkbox" id="wifi"' + (wifiOff ? ' checked' : '') + '></label>' +
        '</div></div>';
      if (!booth) { booth = r.booths[0].booth_id; store.set('leadguard.booth', booth); }
      document.getElementById('booth').onchange = function (e) { booth = e.target.value; store.set('leadguard.booth', booth); status(); };
      document.getElementById('wifi').onchange = function (e) { store.set('leadguard.wifiOff', e.target.checked ? '1' : '0'); window.rum.event('wifi_toggle', { off: e.target.checked }); say(e.target.checked ? 'Wi-Fi off: scans stay on this phone' : 'Wi-Fi back on'); sync(); status(); };
      document.getElementById('scan').addEventListener('submit', function (e) {
        e.preventDefault();
        var badge = document.getElementById('badge').value.trim().toUpperCase();
        var q = queue();
        q.push({ scan_id: scannerId + '-' + Date.now(), badge_id: badge, scanned_at: new Date().toISOString(),
          consent: document.getElementById('consent').checked, notes: document.getElementById('notes').value.trim() });
        saveQueue(q); window.rum.event('scan', { 'leadguard.booth.id': booth });
        lastSaved = badge + ' · ' + time(new Date().toISOString());
        document.getElementById('badge').value = ''; document.getElementById('notes').value = ''; say('Lead saved on this device');
        document.getElementById('lastsaved').innerHTML = icon('check') + ' Saved ' + esc(lastSaved);
        sync(); document.getElementById('badge').focus();
      });
      var cam = document.getElementById('cam');
      if (cam) cam.onclick = function () { camera(function (code) { document.getElementById('badge').value = code; document.getElementById('notes').focus(); }); };
      every(sync, 4000);
      every(beat, 15000);
    });
    function online() { return navigator.onLine && store.get('leadguard.wifiOff', '0') !== '1'; }
    function status(extra) {
      var q = queue(); var el = document.getElementById('qstat'); if (!el) return;
      var on = online();
      el.className = 'netbar ' + (on ? 'on' : 'off');
      el.innerHTML = icon(on ? 'wifi' : 'wifioff') + '<span>' + (on ? 'Online' : 'Offline. Scans are safe on this phone') + '<span class="sub" style="display:block">' + (extra ? esc(extra) : (on ? 'Every scan syncs exactly once' : 'They sync on their own when Wi-Fi returns')) + '</span></span>' +
        '<span style="margin-left:auto"><span class="q">' + q.length + '</span><span class="qs">waiting</span></span>';
    }
    function sync() {
      var q = queue();
      if (!q.length || !online() || !booth) return status();
      var batch = q.slice(0, 200);
      post('/api/scans/batch', { booth_id: booth, scanner_id: scannerId, scans: batch }).then(function (r) {
        var stored = new Set(r.stored);
        saveQueue(queue().filter(function (s) { return !stored.has(s.scan_id); })); // only drop what the server confirmed
        status('Synced ' + plural(r.stored.length, 'scan'));
      }).catch(function (err) { status('Sync failed: ' + err.message + '. Will retry.'); });
    }
    function beat() {
      if (!online() || !booth) return status();
      post('/api/scanners/heartbeat', { scanner_id: scannerId, booth_id: booth, queue_depth: queue().length, app_version: 'web' }).catch(function () {});
      status();
    }
  }
  // Read a QR/barcode with the phone camera: the browser's BarcodeDetector where it exists
  // (Chrome on Android), otherwise jsQR on video frames (iPhone Safari, Firefox).
  function camera(onCode) {
    var video = document.getElementById('video');
    var detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] }) : null;
    var canvas = document.createElement('canvas'); var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var stop = function (stream) { stream.getTracks().forEach(function (tr) { tr.stop(); }); video.hidden = true; };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      video.hidden = false; video.srcObject = stream; video.play(); say('Point the camera at the badge');
      var started = Date.now();
      var found = function (code) { stop(stream); onCode(String(code).trim().toUpperCase()); say('Badge read'); window.rum.event('camera_scan', { decoder: detector ? 'native' : 'jsqr' }); };
      var tick = function () {
        if (Date.now() - started > 30000) { stop(stream); say('No badge found. Type the badge number instead.'); return; }
        if (video.readyState < 2) { requestAnimationFrame(tick); return; }
        if (detector) {
          detector.detect(video).then(function (codes) { if (codes.length) found(codes[0].rawValue); else requestAnimationFrame(tick); }).catch(function () { requestAnimationFrame(tick); });
        } else {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight; ctx.drawImage(video, 0, 0);
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var code = window.jsQR && window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code && code.data) found(code.data); else requestAnimationFrame(tick);
        }
      };
      tick();
    }).catch(function (err) { say('Camera unavailable: ' + err.message); });
  }

  // ── Walk-ups and printable badges ───────────────────────────────────────
  function qrSvg(text) {
    var qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'QR code for badge ' + text });
  }
  function badges() {
    markTab('badges');
    main.innerHTML = head('Walk-ups', 'Register and print a badge', 'For people who arrive without a ticket. They get a badge number and a QR code that every booth can scan.',
      '<button type="button" class="btn" id="print">' + icon('print') + '<span>Print badges</span></button>') +
      '<form id="walk" class="panel"><div class="form-grid">' +
      '<div><label class="lbl" for="wn">Name</label><input id="wn" class="field" placeholder="Full name" required></div>' +
      '<div><label class="lbl" for="we">Email</label><input id="we" class="field" type="email" placeholder="name@example.com" required></div>' +
      '<div><label class="lbl" for="wc">Company</label><input id="wc" class="field" placeholder="Optional"></div></div>' +
      '<div class="row" style="margin-top:18px"><button class="btn primary big">' + icon('badge') + '<span>Register and make badge</span></button></div></form>' +
      '<section class="block"><h2 class="h">Walk-up badges</h2><div id="badgegrid" class="badges"></div></section>';
    var draw = function () {
      var ids = (location.hash.split('?ids=')[1] || '');
      api('/api/badges' + (ids ? '?ids=' + encodeURIComponent(ids) : '')).then(function (r) {
        document.getElementById('badgegrid').innerHTML = r.badges.length ? r.badges.map(function (b) {
          return '<div class="badge-card"><div class="qr">' + qrSvg(b.badge_id) + '</div><div><div class="bname">' + esc(b.name) + '</div><div class="meta">' + esc(b.company || '') + '</div><div class="bid">' + esc(b.badge_id) + '</div></div></div>';
        }).join('') : '<div class="empty">No walk-ups yet. Registered people get a badge here.</div>';
      });
    };
    document.getElementById('walk').addEventListener('submit', function (e) {
      e.preventDefault();
      post('/api/attendees', { name: document.getElementById('wn').value, email: document.getElementById('we').value, company: document.getElementById('wc').value })
        .then(function (r) { say('Registered ' + r.name + ', badge ' + r.badge_id); window.rum.event('walkup', {}); e.target.reset(); draw(); })
        .catch(function (err) { say('Could not register: ' + err.message); });
    });
    document.getElementById('print').onclick = function () { window.print(); };
    draw();
  }

  // ── Organizer console ──────────────────────────────────────────────────
  var ASK_EXAMPLES = ['Were any leads lost at the Radar booth in the last hour?', 'Which booth needs attention right now?', 'Is check-in slow right now?'];
  function ops() {
    markTab('ops');
    main.innerHTML = head('Organizer · live', 'Event control', 'Everything that needs a human, in one place. Updates every 10 seconds.', '<span class="pill ok" id="updated">Live</span>') +
      '<div id="stats" class="tiles"></div>' +
      '<form id="ask" class="ask"><h2 class="h">' + icon('spark') + '<label for="aq">Ask ops</label></h2><p class="meta">The AI SRE (AURA on Kimi K3.1 Pro) answers from LeadGuard and Dash0 evidence. It drafts sponsor notes; you approve them.</p>' +
      '<div class="searchbar"><input id="aq" placeholder="What happened at the Radar booth in the last hour?" autocomplete="off"><button class="btn primary">Ask</button></div>' +
      '<div class="chips">' + ASK_EXAMPLES.map(function (q) { return '<button type="button" class="chip" data-ask="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>' +
      '<p id="asking" class="meta" aria-hidden="true"></p><div id="answer"></div></form><div id="drafts"></div>' +
      '<section class="block"><h2 class="h">Booths</h2><div id="booths" class="booths"></div></section>' +
      '<section class="block grid-2"><div><h2 class="h">Anomalies</h2><div id="anoms" class="feed"></div></div><div><h2 class="h">Tickets at risk</h2><div id="risk" class="feed"></div></div></section>' +
      '<section class="block"><h2 class="h">' + icon('shield') + ' Check-in kiosk security</h2><p class="meta" style="margin:-6px 0 14px">eBPF on the kiosks (OBI network flows and CPU profiles). No detection rules: anything new is flagged.</p><div id="sigs" class="feed"></div></section>';
    var form = document.getElementById('ask');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = document.getElementById('aq').value.trim(); if (!q) return;
      // The answer takes up to a minute or two: start the job, then poll for it. Screen readers hear
      // "Investigating" once and the outcome once (via #live); the ticking counter is aria-hidden.
      var out = document.getElementById('answer'), asking = document.getElementById('asking');
      out.textContent = ''; asking.innerHTML = '<span class="spinner"></span>Investigating…'; say('Investigating your question');
      var started = Date.now();
      var poll = function (id) {
        return api('/api/ops/ask/' + encodeURIComponent(id)).then(function (r) {
          if (r.status === 'answered') { asking.textContent = ''; out.innerHTML = md(r.answer); say('Answer ready'); window.rum.event('ops_ask', {}); drafts(); return; }
          if (r.status === 'failed') throw new Error(r.error || 'failed');
          if (Date.now() - started > 240000) throw new Error('no answer after 4 minutes');
          asking.innerHTML = '<span class="spinner"></span>Investigating… ' + Math.round((Date.now() - started) / 1000) + ' s';
          return new Promise(function (ok) { setTimeout(ok, 2500); }).then(function () { return poll(id); });
        });
      };
      post('/api/ops/ask', { question: q }).then(function (r) { return poll(r.id); })
        .catch(function (err) { asking.textContent = ''; out.textContent = 'The assistant is unavailable: ' + err.message; say('The assistant is unavailable'); });
    });
    main.querySelectorAll('[data-ask]').forEach(function (b) { b.onclick = function () { document.getElementById('aq').value = b.dataset.ask; form.requestSubmit(); }; });
    function drafts() {
      api('/api/ops/drafts').then(function (r) {
        var pending = r.drafts.filter(function (d) { return d.status === 'awaiting_approval'; });
        document.getElementById('drafts').innerHTML = pending.length ? '<section class="block"><h2 class="h">' + icon('mail') + ' Waiting for your approval</h2>' + pending.map(function (d) {
          return '<article class="panel draft"><h3 class="h" style="font-size:20px;margin-bottom:6px">' + esc(d.subject) + '</h3><p class="meta" style="margin:0 0 12px">To the ' + esc(d.booth_id) + ' sponsor · drafted by ' + esc(d.author) + ' at ' + time(d.created_at) + '</p><div style="white-space:pre-wrap">' + esc(d.body) + '</div><div class="row" style="margin-top:16px"><button class="btn primary" data-approve="' + esc(d.id) + '">' + icon('check') + '<span>Approve</span></button><span class="meta">Nothing is sent until you approve.</span></div></article>';
        }).join('') + '</section>' : '';
        main.querySelectorAll('[data-approve]').forEach(function (b) { b.onclick = function () { post('/api/ops/drafts/' + encodeURIComponent(b.dataset.approve) + '/approve', {}).then(function () { say('Approved'); drafts(); }); }; });
      }).catch(function () {});
    }
    drafts();
    var anomalyCount = 0;
    every(function () {
      api('/api/stats').then(function (s) {
        var last = s.checkins_per_min.slice(-5).reduce(function (a, b) { return a + b.n; }, 0);
        document.getElementById('stats').innerHTML = tile(s.checked_in, 'checked in') + tile(last, 'check-ins, last 5 min') + tile(s.scans, 'lead scans') + tile(anomalyCount, 'open anomalies', anomalyCount ? 'alert' : '');
        var u = document.getElementById('updated'); if (u) u.textContent = 'Live · ' + time(new Date().toISOString());
      });
      api('/api/booths/health').then(function (r) {
        document.getElementById('booths').innerHTML = r.booths.map(function (b) {
          var queued = b.scanners.reduce(function (a, s) { return a + (s.queue_depth || 0); }, 0);
          var cls = b.open_anomalies ? 'full' : queued ? 'busy' : 'ok';
          var label = b.open_anomalies ? plural(b.open_anomalies, 'open issue') : queued ? queued + ' scans queued' : 'Healthy';
          return '<div class="booth card"><div class="row" style="justify-content:space-between"><h3 class="bn">' + esc(b.name) + '</h3><span class="pill ' + cls + '">' + label + '</span></div>' +
            '<div class="nums"><div><b>' + b.leads + '</b><span>leads</span></div><div><b>' + b.consented + '</b><span>consented</span></div><div><b>' + b.scanners.length + '</b><span>scanners</span></div></div>' +
            '<p class="meta" style="margin:0">Last lead ' + time(b.last_lead) + '</p><a href="#/leads/' + esc(b.booth_id) + '">Open leads ' + icon('arrow') + '</a></div>';
        }).join('');
      });
      api('/api/anomalies').then(function (r) {
        anomalyCount = r.anomalies.length;
        var tiles = document.querySelectorAll('#stats .tile');
        if (tiles[3]) { tiles[3].querySelector('.n').textContent = anomalyCount; tiles[3].classList.toggle('alert', anomalyCount > 0); }
        var shown = r.anomalies.slice(0, 12);
        document.getElementById('anoms').innerHTML = shown.length ? shown.map(function (a) {
          var bad = a.kind === 'never_checked_in' || a.kind === 'impossible_travel' || a.kind === 'scans_not_syncing';
          return '<div class="item"><span class="sev' + (bad ? ' bad' : '') + '" aria-hidden="true"></span><div><div class="k">' + esc(a.kind.replace(/_/g, ' ')) + '</div><div class="w">' + esc(a.explain) + '</div>' +
            '<div class="tags" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' + (a.booth_id ? '<span class="tag">' + esc(a.booth_id) + '</span>' : '') + (a.badge_id ? '<span class="tag mono">' + esc(a.badge_id) + '</span>' : '') + (a.scanner_id ? '<span class="tag mono">' + esc(a.scanner_id) + '</span>' : '') + '</div></div>' +
            '<div class="t">since ' + time(a.first_detected) + '</div></div>';
        }).join('') + (r.anomalies.length > shown.length ? '<p class="more-link">…and ' + (r.anomalies.length - shown.length) + ' more</p>' : '') : '<div class="note ok">' + icon('check') + ' No open anomalies.</div>';
      });
      api('/api/signals').then(function (r) {
        document.getElementById('sigs').innerHTML = r.signals.length ? r.signals.slice(0, 6).map(function (x) {
          return '<div class="item"><span class="sev bad" aria-hidden="true"></span><div><div class="k">' + esc(x.kind.replace(/_/g, ' ')) + (x.port ? ' · port ' + esc(x.port) : '') + '</div>' +
            '<div class="w">' + esc(x.kiosk_id) + (x.peer ? ' · from ' + esc(x.peer) : '') + (x.process ? ' · process ' + esc(x.process) + (x.cpu_cores ? ', ' + esc(x.cpu_cores) + ' cores' : '') + (x.top_function ? ', hot: ' + esc(x.top_function) : '') : '') + '</div></div>' +
            '<div class="t">' + time(x['@timestamp']) + '</div></div>';
        }).join('') : '<div class="note ok">' + icon('check') + ' Nothing new on the kiosks.</div>';
      });
      api('/api/attendees/at-risk').then(function (r) {
        var shown = r.attendees.slice(0, 8);
        document.getElementById('risk').innerHTML = shown.length ? '<p class="meta" style="margin:-6px 0 4px">Not checked in, and their ticket email may not have arrived. Reach them another way.</p>' +
          shown.map(function (a) { return '<div class="item"><span class="sev" aria-hidden="true"></span><div><div class="k" style="text-transform:none">' + esc(a.name) + '</div><div class="w">' + esc(a.company) + ' · <span class="mono">' + esc(a.badge_id) + '</span></div></div><div class="t">' + esc(a.risk.reason) + '</div></div>'; }).join('') +
          (r.attendees.length > shown.length ? '<p class="more-link">…and ' + (r.attendees.length - shown.length) + ' more</p>' : '') : '<div class="note ok">' + icon('check') + ' Every ticket email arrived.</div>';
      });
    }, 10000);
  }

  // ── Sponsor leads ──────────────────────────────────────────────────────
  function leads(booth) {
    markTab('leads');
    api('/api/booths').then(function (r) {
      booth = booth || r.booths[0].booth_id;
      var name = (r.booths.filter(function (b) { return b.booth_id === booth; })[0] || {}).name || booth;
      main.innerHTML = head('Sponsor leads', esc(name), 'Consented leads only. Search your notes by meaning, not just keywords.',
        '<div class="row"><div style="min-width:200px"><label class="lbl" for="lb">Booth</label><select id="lb" class="field">' + r.booths.map(function (b) { return '<option value="' + esc(b.booth_id) + '"' + (b.booth_id === booth ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select></div>' +
        '<a class="btn" style="align-self:flex-end" href="/api/leads/export.csv?booth=' + encodeURIComponent(booth) + '">' + icon('download') + '<span>Export CSV</span></a></div>') +
        '<form class="searchbar" role="search">' + icon('search') + '<label class="sr-only" for="lq">Search notes</label><input id="lq" type="search" placeholder="e.g. people evaluating OpenTelemetry"><button class="btn primary">Search</button></form>' +
        '<div id="lr" style="margin-top:22px"></div>';
      document.getElementById('lb').onchange = function (e) { location.hash = '#/leads/' + e.target.value; };
      var load = function (q) {
        api('/api/leads?booth=' + encodeURIComponent(booth) + (q ? '&q=' + encodeURIComponent(q) : '')).then(function (x) {
          document.getElementById('lr').innerHTML = x.leads.length ? '<p class="meta" style="margin:0 0 10px">' + plural(x.leads.length, 'lead') + (q ? ' matching “' + esc(q) + '”' : '') + '</p><div class="table-wrap"><table><thead><tr><th>Who</th><th>Notes</th><th>Scans</th></tr></thead><tbody>' + x.leads.map(function (l) {
            return '<tr><td><b>' + esc(l.name || '(no contact details)') + '</b><div class="meta">' + esc(l.company || '') + '</div></td><td>' + (esc(l.notes) || '<span class="meta">—</span>') + '</td><td>' + l.scan_count + '</td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">No consented leads yet' + (q ? ' matching “' + esc(q) + '”' : '') + '.</div>';
        });
      };
      main.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); load(document.getElementById('lq').value.trim()); });
      load('');
    });
  }

  function route() {
    timers.forEach(clearInterval); timers = [];
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    window.rum.event('navigate', {});
    if (parts[0] === 'desk') desk();
    else if (parts[0].indexOf('badges') === 0) badges();
    else if (parts[0] === 'scan') scanner();
    else if (parts[0] === 'ops') ops();
    else if (parts[0] === 'leads') leads(parts[1]);
    else home();
    main.focus();
    scrollTo(0, 0);
  }
  api('/api/config').then(function (c) { cfg = c; document.getElementById('ver').textContent = 'v' + c.version + ' · times in ' + c.venue_tz; }).finally(route);
  addEventListener('hashchange', route);
})();
