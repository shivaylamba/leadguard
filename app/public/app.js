// Overflow UI: hash routes, no build step. Every dynamic value goes through esc().
(function () {
  var main = document.getElementById('main');
  var live = document.getElementById('live');
  var device = window.rum.device;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var time = function (iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  var api = function (p, opts) { return fetch(p, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); }); };
  var say = function (msg) { live.textContent = msg; };
  var prefs = JSON.parse(localStorage.getItem('overflow.prefs') || '{}');
  document.body.classList.toggle('large', Boolean(prefs.large_text));
  var timer;

  function loadClass(load) { return load >= 0.95 ? 'full' : load >= 0.8 ? 'busy' : 'ok'; }
  function loadText(load) { return load >= 0.95 ? 'Full' : load >= 0.8 ? 'Filling up' : 'Seats free'; }

  function sessionCard(s, extra) {
    return '<article class="card"><h3><a href="#/session/' + esc(s.session_id) + '">' + esc(s.title) + '</a></h3>' +
      '<div class="meta">' + time(s.start) + ' · ' + esc(s.room_id) + ' · ' + esc((s.speakers || []).join(', ')) + '</div>' +
      '<div>' + (s.captions ? '<span class="badge">captions</span>' : '') + (s.recorded ? '<span class="badge">recorded</span>' : '') +
      (s.tags || []).slice(0, 3).map(function (t) { return '<span class="badge">' + esc(t) + '</span>'; }).join('') + '</div>' + (extra || '') + '</article>';
  }

  function search() {
    main.innerHTML = '<h2>Find a talk</h2>' +
      '<form class="search" role="search"><label class="sr-only" for="q">Search talks</label>' +
      '<input id="q" type="search" placeholder="Try: ebpf security, or in your language" autocomplete="off" required>' +
      '<label class="sr-only" for="mode">Search mode</label><select id="mode"><option value="hybrid">Hybrid</option><option value="keyword">Keyword</option><option value="semantic">Semantic</option></select>' +
      '<button class="primary">Search</button></form><div id="results"></div>';
    var form = main.querySelector('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = document.getElementById('q').value.trim();
      var mode = document.getElementById('mode').value;
      if (!q) return;
      api('/api/search?q=' + encodeURIComponent(q) + '&mode=' + mode + (prefs.captions ? '&captions=true' : '')).then(function (r) {
        window.rum.event('search', { 'search.mode': r.mode, 'search.results.count': r.results.length, 'search.zero_results': r.results.length === 0 });
        document.getElementById('results').innerHTML = r.results.length ? r.results.map(function (s) { return sessionCard(s); }).join('') :
          '<p>No talks matched. Try different words.</p>';
        say(r.results.length + ' talks found');
      }).catch(function (err) { document.getElementById('results').innerHTML = '<p class="full">Search failed: ' + esc(err.message) + '</p>'; });
    });
    document.getElementById('q').focus();
  }

  function session(id) {
    api('/api/overflow?session=' + encodeURIComponent(id) + '&device=' + encodeURIComponent(device)).then(function (r) {
      var s = r.session, room = r.room || {};
      var load = room.capacity ? r.inside / room.capacity : 0;
      var recs = r.recommendations.map(function (x) { return sessionCard(x.session, '<p class="ok">' + esc(x.reasons.join(' · ')) + '</p>'); }).join('');
      main.innerHTML = '<h2>' + esc(s.title) + '</h2><p class="meta">' + time(s.start) + '–' + time(s.end) + ' · ' + esc(room.name || s.room_id) + '</p>' +
        '<p>' + esc(s.abstract) + '</p>' +
        '<p class="' + loadClass(load) + '">' + loadText(load) + ': ' + r.inside + ' / ' + (room.capacity || '?') + '</p>' +
        '<div class="bar ' + loadClass(load) + '" role="img" aria-label="Room ' + Math.round(load * 100) + ' percent full"><span style="width:' + Math.min(100, Math.round(load * 100)) + '%"></span></div>' +
        '<p><button class="primary" id="in">I\'m in this room</button> <button id="out">I left</button></p>' +
        (r.full ? '<h3 class="full">This room is full. Similar talks with seats:</h3>' : '<h3>If it fills up, try:</h3>') + (recs || '<p>No similar talks with seats right now.</p>');
      if (r.full) { say('This room is full. ' + r.recommendations.length + ' similar talks have seats.'); window.rum.event('overflow_shown', { 'conference.session.id': s.session_id, 'overflow.recommendations.count': r.recommendations.length }); }
      var check = function (dir) {
        api('/api/checkin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room_id: s.room_id, direction: dir, device_id: device }) })
          .then(function () { window.rum.event('checkin', { 'conference.room.id': s.room_id, direction: dir }); say(dir === 'in' ? 'Checked in' : 'Checked out'); session(id); })
          .catch(function (err) { say('Check-in failed: ' + err.message); });
      };
      document.getElementById('in').onclick = function () { check('in'); };
      document.getElementById('out').onclick = function () { check('out'); };
    }).catch(function (err) { main.innerHTML = '<p class="full">' + esc(err.message) + '</p>'; });
  }

  function prefsView() {
    var box = function (k, label) { return '<label><input type="checkbox" id="' + k + '"' + (prefs[k] ? ' checked' : '') + '> ' + label + '</label>'; };
    main.innerHTML = '<h2>My needs</h2><p>Recommendations only suggest rooms and talks that fit. Nothing here identifies you.</p><form id="p">' +
      box('step_free', 'Step-free route only') + box('captions', 'Talks with captions') + box('sensory_friendly', 'Avoid crowded rooms (under 70% full)') +
      box('large_text', 'Large text') + '<button class="primary">Save</button></form>';
    document.getElementById('p').addEventListener('submit', function (e) {
      e.preventDefault();
      ['step_free', 'captions', 'sensory_friendly', 'large_text'].forEach(function (k) { prefs[k] = document.getElementById(k).checked; });
      localStorage.setItem('overflow.prefs', JSON.stringify(prefs));
      document.body.classList.toggle('large', Boolean(prefs.large_text));
      api('/api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ device_id: device, language: navigator.language }, prefs)) })
        .then(function () { say('Saved'); window.rum.event('prefs_saved', {}); });
    });
  }

  function ops() {
    var draw = function () {
      api('/api/rooms/occupancy').then(function (r) {
        main.innerHTML = '<h2>Organizer: rooms right now</h2><p class="meta">Check-ins over the last ' + r.window_min + ' minutes. Refreshes every 10 s.</p><div class="grid">' +
          r.rooms.map(function (x) {
            return '<div class="card"><h3>' + esc(x.name) + '</h3><p class="' + loadClass(x.load) + '">' + loadText(x.load) + '</p><p class="meta">' + x.inside + ' / ' + x.capacity +
              (x.step_free ? ' · step-free' : '') + (x.quiet_room ? ' · quiet room' : '') + '</p><div class="bar ' + loadClass(x.load) + '"><span style="width:' + Math.min(100, Math.round(x.load * 100)) + '%"></span></div></div>';
          }).join('') + '</div>';
      }).catch(function (err) { main.innerHTML = '<p class="full">' + esc(err.message) + '</p>'; });
    };
    draw();
    timer = setInterval(draw, 10000);
  }

  function route() {
    clearInterval(timer);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    window.rum.event('navigate', {});
    if (parts[0] === 'session' && parts[1]) session(parts[1]);
    else if (parts[0] === 'prefs') prefsView();
    else if (parts[0] === 'ops') ops();
    else search();
    main.focus();
  }
  api('/api/config').then(function (c) { document.getElementById('ver').textContent = 'v' + c.version + (c.semantic ? ' · semantic search on' : ' · keyword search (semantic not configured)'); });
  addEventListener('hashchange', route);
  route();
})();
