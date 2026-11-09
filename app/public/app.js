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
  var timers = [];
  var every = function (fn, ms) { fn(); timers.push(setInterval(fn, ms)); };

  // ── Desk: find the person, whatever email they remember ────────────────
  function desk() {
    var deskId = localStorage.getItem('leadguard.desk') || 'desk-1';
    main.innerHTML = '<h2>Registration desk</h2>' +
      '<form class="search" role="search"><label class="sr-only" for="q">Name, any email, company, badge or order number</label>' +
      '<input id="q" type="search" placeholder="Name, any email, company, badge or order no." autocomplete="off" required>' +
      '<label class="sr-only" for="desk">Desk</label><select id="desk">' + ['desk-1', 'desk-2', 'desk-3'].map(function (d) { return '<option' + (d === deskId ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select>' +
      '<button class="primary">Find</button></form><div id="results"></div>';
    document.getElementById('desk').onchange = function (e) { localStorage.setItem('leadguard.desk', e.target.value); };
    main.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = document.getElementById('q').value.trim();
      api('/api/attendees/search?q=' + encodeURIComponent(q)).then(function (r) {
        window.rum.event('desk_search', { 'leadguard.search.results': r.results.length });
        document.getElementById('results').innerHTML = r.results.length ? r.results.map(person).join('') : '<p>No one found. Try their old work email, company, or order number.</p>';
        say(r.results.length + ' people found');
        bindPeople();
      }).catch(function (err) { document.getElementById('results').innerHTML = '<p class="full">' + esc(err.message) + '</p>'; });
    });
    document.getElementById('q').focus();
  }
  function person(p) {
    var risk = p.email_risk && p.email_risk.at_risk ? '<p class="busy">Ticket email problem: ' + esc(p.email_risk.reason) + '</p>' : '';
    return '<article class="card"><h3>' + esc(p.name) + '</h3><div class="meta">' + esc(p.company) + ' · ' + esc(p.badge_id) + ' · ' + esc(p.order_id) + ' · ' + esc(p.ticket_type) + (p.needs_assistance ? ' · needs assistance' : '') + '</div>' +
      '<div class="meta">' + p.emails.map(esc).join(', ') + '</div>' + risk +
      (p.checked_in_at ? '<p class="ok">Checked in at ' + time(p.checked_in_at) + '</p>' : '') +
      '<div class="row"><button class="primary" data-in="' + esc(p.badge_id) + '">' + (p.checked_in_at ? 'Check in again' : 'Check in') + '</button>' +
      '<label class="sr-only" for="e-' + esc(p.badge_id) + '">Add the email they use now</label><input id="e-' + esc(p.badge_id) + '" type="email" placeholder="Email they use now">' +
      '<button data-email="' + esc(p.badge_id) + '">Link email</button></div></article>';
  }
  function bindPeople() {
    main.querySelectorAll('[data-in]').forEach(function (b) {
      b.onclick = function () {
        post('/api/checkin', { badge_id: b.dataset.in, desk_id: document.getElementById('desk').value }).then(function (r) {
          window.rum.event('checkin', { 'leadguard.checkin.reentry': r.reentry }); say((r.reentry ? 'Re-entry: ' : 'Checked in: ') + r.name); b.textContent = 'Done ✓'; b.disabled = true;
        }).catch(function (err) { say('Check-in failed: ' + err.message); });
      };
    });
    main.querySelectorAll('[data-email]').forEach(function (b) {
      b.onclick = function () {
        var input = document.getElementById('e-' + b.dataset.email);
        post('/api/attendees/' + encodeURIComponent(b.dataset.email) + '/emails', { email: input.value }).then(function () { say('Email linked'); b.textContent = 'Linked ✓'; window.rum.event('email_linked', {}); })
          .catch(function (err) { say('Could not link: ' + err.message); });
      };
    });
  }

  // ── Booth scanner: works offline, syncs when the Wi-Fi comes back ──────
  var QKEY = 'leadguard.queue';
  function queue() { return JSON.parse(localStorage.getItem(QKEY) || '[]'); }
  function saveQueue(q) { localStorage.setItem(QKEY, JSON.stringify(q)); }
  function scanner() {
    var booth = localStorage.getItem('leadguard.booth') || '';
    var scannerId = localStorage.getItem('leadguard.scanner') || ('scanner-' + window.rum.device.slice(0, 8));
    localStorage.setItem('leadguard.scanner', scannerId);
    var wifiOff = localStorage.getItem('leadguard.wifiOff') === '1';
    api('/api/booths').then(function (r) {
      main.innerHTML = '<h2>Booth scanner</h2><div class="row"><label for="booth">Booth</label><select id="booth">' +
        r.booths.map(function (b) { return '<option value="' + esc(b.booth_id) + '"' + (b.booth_id === booth ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select>' +
        '<label><input type="checkbox" id="wifi"' + (wifiOff ? ' checked' : '') + '> Simulate Wi-Fi off</label></div>' +
        '<form id="scan" class="card"><label for="badge">Badge</label><input id="badge" placeholder="B10023" autocomplete="off" required>' +
        ('BarcodeDetector' in window ? ' <button type="button" id="cam">Scan with camera</button>' : '') +
        '<label><input type="checkbox" id="consent" checked> They agreed to share their contact details with this sponsor</label>' +
        '<label for="notes">Notes</label><input id="notes" placeholder="What they asked about"><p><button class="primary">Save lead</button></p></form>' +
        '<p id="qstat" class="meta"></p><video id="video" hidden playsinline></video>';
      if (!booth) { booth = r.booths[0].booth_id; localStorage.setItem('leadguard.booth', booth); }
      document.getElementById('booth').onchange = function (e) { booth = e.target.value; localStorage.setItem('leadguard.booth', booth); };
      document.getElementById('wifi').onchange = function (e) { localStorage.setItem('leadguard.wifiOff', e.target.checked ? '1' : '0'); window.rum.event('wifi_toggle', { off: e.target.checked }); };
      document.getElementById('scan').addEventListener('submit', function (e) {
        e.preventDefault();
        var q = queue();
        q.push({ scan_id: scannerId + '-' + Date.now(), badge_id: document.getElementById('badge').value.trim().toUpperCase(), scanned_at: new Date().toISOString(),
          consent: document.getElementById('consent').checked, notes: document.getElementById('notes').value.trim() });
        saveQueue(q); window.rum.event('scan', { 'leadguard.booth.id': booth });
        document.getElementById('badge').value = ''; document.getElementById('notes').value = ''; say('Lead saved on this device'); sync();
      });
      var cam = document.getElementById('cam');
      if (cam) cam.onclick = function () { camera(function (code) { document.getElementById('badge').value = code; }); };
      every(sync, 4000);
      every(beat, 15000);
    });
    function online() { return navigator.onLine && localStorage.getItem('leadguard.wifiOff') !== '1'; }
    function status(extra) {
      var q = queue(); var el = document.getElementById('qstat');
      if (el) el.innerHTML = (online() ? '<span class="pill ok">Online</span>' : '<span class="pill full">Offline</span>') + ' ' + q.length + ' scans waiting to sync' + (extra ? ' · ' + esc(extra) : '');
    }
    function sync() {
      var q = queue();
      if (!q.length || !online() || !booth) return status();
      var batch = q.slice(0, 200);
      post('/api/scans/batch', { booth_id: booth, scanner_id: scannerId, scans: batch }).then(function (r) {
        var stored = new Set(r.stored);
        saveQueue(queue().filter(function (s) { return !stored.has(s.scan_id); })); // only drop what the server confirmed
        status('synced ' + r.stored.length);
      }).catch(function (err) { status('sync failed: ' + err.message); });
    }
    function beat() {
      if (!online() || !booth) return status();
      post('/api/scanners/heartbeat', { scanner_id: scannerId, booth_id: booth, queue_depth: queue().length, app_version: 'web' }).catch(function () {});
      status();
    }
  }
  function camera(onCode) {
    var video = document.getElementById('video');
    var detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      video.hidden = false; video.srcObject = stream; video.play();
      var tick = function () {
        detector.detect(video).then(function (codes) {
          if (codes.length) { stream.getTracks().forEach(function (tr) { tr.stop(); }); video.hidden = true; onCode(codes[0].rawValue); say('Badge read'); }
          else requestAnimationFrame(tick);
        }).catch(function () { requestAnimationFrame(tick); });
      };
      tick();
    }).catch(function (err) { say('Camera unavailable: ' + err.message); });
  }

  // ── Organizer console ──────────────────────────────────────────────────
  function ops() {
    main.innerHTML = '<h2>Organizer</h2><div id="stats" class="row"></div><h3>Booths</h3><div id="booths" class="grid"></div><h3>Anomalies</h3><div id="anoms"></div><h3>Tickets at risk</h3><div id="risk"></div>';
    every(function () {
      api('/api/stats').then(function (s) {
        var last = s.checkins_per_min.slice(-5).reduce(function (a, b) { return a + b.n; }, 0);
        document.getElementById('stats').innerHTML = '<div class="card"><div class="big">' + s.checked_in + '</div>checked in</div><div class="card"><div class="big">' + last + '</div>check-ins, last 5 min</div><div class="card"><div class="big">' + s.scans + '</div>lead scans</div>';
      });
      api('/api/booths/health').then(function (r) {
        document.getElementById('booths').innerHTML = r.booths.map(function (b) {
          var queued = b.scanners.reduce(function (a, s) { return a + (s.queue_depth || 0); }, 0);
          var cls = b.open_anomalies ? 'full' : queued ? 'busy' : 'ok';
          var label = b.open_anomalies ? b.open_anomalies + ' open issue' + (b.open_anomalies > 1 ? 's' : '') : queued ? queued + ' scans queued' : 'Healthy';
          return '<div class="card"><h3>' + esc(b.name) + '</h3><p><span class="pill ' + cls + '">' + label + '</span></p><p class="meta">' + b.leads + ' leads (' + b.consented + ' consented) · last ' + time(b.last_lead) + ' · ' + b.scanners.length + ' scanner(s)</p><p><a href="#/leads/' + esc(b.booth_id) + '">Leads</a></p></div>';
        }).join('');
      });
      api('/api/anomalies').then(function (r) {
        document.getElementById('anoms').innerHTML = r.anomalies.length ? '<table><thead><tr><th>What</th><th>Where</th><th>Why it matters</th><th>Since</th></tr></thead><tbody>' + r.anomalies.map(function (a) {
          return '<tr><td><strong>' + esc(a.kind.replace(/_/g, ' ')) + '</strong>' + (a.badge_id ? '<div class="meta">' + esc(a.badge_id) + '</div>' : '') + '</td><td>' + esc(a.booth_id || '') + (a.scanner_id ? '<div class="meta">' + esc(a.scanner_id) + '</div>' : '') + '</td><td>' + esc(a.explain) + '</td><td>' + time(a.first_detected) + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p class="ok">No open anomalies.</p>';
      });
      api('/api/attendees/at-risk').then(function (r) {
        document.getElementById('risk').innerHTML = r.attendees.length ? '<p class="meta">Not checked in, and their ticket email may not have arrived. Reach them another way before they reach the desk.</p><table><tbody>' +
          r.attendees.slice(0, 25).map(function (a) { return '<tr><td>' + esc(a.name) + '<div class="meta">' + esc(a.company) + ' · ' + esc(a.badge_id) + '</div></td><td>' + esc(a.risk.reason) + '</td></tr>'; }).join('') + '</tbody></table>' + (r.attendees.length > 25 ? '<p class="meta">…and ' + (r.attendees.length - 25) + ' more</p>' : '') : '<p class="ok">Every ticket email arrived.</p>';
      });
    }, 10000);
  }

  // ── Sponsor leads ──────────────────────────────────────────────────────
  function leads(booth) {
    api('/api/booths').then(function (r) {
      booth = booth || r.booths[0].booth_id;
      main.innerHTML = '<h2>Sponsor leads</h2><div class="row"><label for="lb">Booth</label><select id="lb">' + r.booths.map(function (b) { return '<option value="' + esc(b.booth_id) + '"' + (b.booth_id === booth ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select>' +
        '<a href="/api/leads/export.csv?booth=' + encodeURIComponent(booth) + '">Export CSV (consented only)</a></div>' +
        '<form class="search" role="search"><label class="sr-only" for="lq">Search notes</label><input id="lq" type="search" placeholder="e.g. people evaluating OpenTelemetry"><button class="primary">Search</button></form><div id="lr"></div>';
      document.getElementById('lb').onchange = function (e) { location.hash = '#/leads/' + e.target.value; };
      var load = function (q) {
        api('/api/leads?booth=' + encodeURIComponent(booth) + (q ? '&q=' + encodeURIComponent(q) : '')).then(function (x) {
          document.getElementById('lr').innerHTML = x.leads.length ? '<table><thead><tr><th>Who</th><th>Notes</th><th>Scans</th></tr></thead><tbody>' + x.leads.map(function (l) {
            return '<tr><td>' + esc(l.name || '(no contact details)') + '<div class="meta">' + esc(l.company || '') + '</div></td><td>' + esc(l.notes) + '</td><td>' + l.scan_count + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p>No consented leads yet.</p>';
        });
      };
      main.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); load(document.getElementById('lq').value.trim()); });
      load('');
    });
  }

  function home() {
    main.innerHTML = '<h2>Who are you today?</h2><div class="grid"><a class="card" href="#/desk"><h3>Registration desk</h3><p class="meta">Find anyone, even with an old work email.</p></a>' +
      '<a class="card" href="#/scan"><h3>Booth scanner</h3><p class="meta">Scan badges. Keeps working without Wi-Fi.</p></a>' +
      '<a class="card" href="#/ops"><h3>Organizer</h3><p class="meta">Booth health, anomalies, tickets at risk.</p></a>' +
      '<a class="card" href="#/leads"><h3>Sponsor</h3><p class="meta">Your consented leads, searchable.</p></a></div>';
  }

  function route() {
    timers.forEach(clearInterval); timers = [];
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    window.rum.event('navigate', {});
    if (parts[0] === 'desk') desk();
    else if (parts[0] === 'scan') scanner();
    else if (parts[0] === 'ops') ops();
    else if (parts[0] === 'leads') leads(parts[1]);
    else home();
    main.focus();
  }
  api('/api/config').then(function (c) { cfg = c; document.getElementById('ver').textContent = 'v' + c.version + ' · times in ' + c.venue_tz; }).finally(route);
  addEventListener('hashchange', route);
})();
