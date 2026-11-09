// Real-user telemetry with no SDK: events become OTLP/JSON log records, posted
// to /otlp/v1/logs (the web role forwards them to the in-cluster Collector).
// Pattern from eKuG/backstage-demo-na26 (OtlpAnalytics.ts). Ids are random per device, never personal.
(function () {
  var key = 'overflow.device';
  var device = localStorage.getItem(key) || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  localStorage.setItem(key, device);
  var session = sessionStorage.getItem('overflow.session') || String(Date.now()) + Math.random().toString(16).slice(2, 8);
  sessionStorage.setItem('overflow.session', session);
  var queue = [];
  function val(v) { return typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) }; }
  window.rum = {
    device: device,
    event: function (action, attrs) {
      attrs = attrs || {};
      attrs['overflow.ui.action'] = action; attrs['session.id'] = session; attrs['url.path'] = location.hash || '#/';
      queue.push({ timeUnixNano: Date.now() + '000000', severityNumber: 9, severityText: 'INFO', body: { stringValue: action },
        attributes: Object.keys(attrs).map(function (k) { return { key: k, value: val(attrs[k]) }; }) });
    },
  };
  function flush() {
    if (!queue.length) return;
    var logRecords = queue; queue = [];
    var body = JSON.stringify({ resourceLogs: [{ resource: { attributes: [
      { key: 'service.name', value: { stringValue: 'overflow-browser' } },
      { key: 'service.namespace', value: { stringValue: 'overflow' } },
      { key: 'browser.language', value: { stringValue: navigator.language } }] },
      scopeLogs: [{ scope: { name: 'overflow.rum' }, logRecords: logRecords }] }] });
    try { navigator.sendBeacon ? navigator.sendBeacon('/otlp/v1/logs', new Blob([body], { type: 'application/json' })) : fetch('/otlp/v1/logs', { method: 'POST', body: body, headers: { 'content-type': 'application/json' }, keepalive: true }); } catch (e) {}
  }
  setInterval(flush, 3000);
  addEventListener('pagehide', flush);
})();
