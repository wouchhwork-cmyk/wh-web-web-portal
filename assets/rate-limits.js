/*
 * The Meta rate-limit monitor, on the platform admin page.
 *
 * WHAT THIS SCREEN HAS TO GET ACROSS, because none of it is obvious from the
 * numbers alone:
 *
 *   - Meta meters in PERCENTAGES of an allowance it never states. "78%" is how
 *     close a pool is to being refused; it says nothing about how many calls
 *     that was. Our own call count is shown beside it and is a different kind
 *     of number.
 *   - A pool's allowance scales with that business's own audience
 *     (4800 x impressions, 200 x engaged users). A quiet account has the
 *     SMALLEST allowance, so the business making the fewest calls can be the
 *     one closest to throttling. Sorting by percentage rather than by volume is
 *     the whole point.
 *   - "unknown" is not "fine". Meta omits the header on some responses, and a
 *     pool we cannot see is worth flagging rather than painting green.
 *
 * Polling, not streaming: the backend folds readings into one-minute rows, so
 * there is nothing to stream that a poll would miss.
 */
(function () {
  if (!window.api || !document.getElementById('rateLimitPanel')) return;

  /*
   * Faster than the minute the data moves in, so the page feels live, and slow
   * enough that leaving the tab open is not itself a load. The backend flushes
   * every 15s, so anything shorter would mostly re-read the same row.
   */
  var REFRESH_MS = 20000;

  var body = document.getElementById('rlBody');
  var appTiles = document.getElementById('rlAppTiles');
  var attention = document.getElementById('rlAttention');
  var updated = document.getElementById('rlUpdated');
  var message = document.getElementById('rlMessage');
  var auto = document.getElementById('rlAuto');
  var timer = null;
  var lastLoadedAt = null;
  var tickTimer = null;
  /*
   * One request at a time.
   *
   * `setInterval` does not wait for the previous call, so a slow response lets
   * requests stack — and an OLDER answer can then render after a newer one
   * while `lastLoadedAt` is refreshed, so the screen shows stale figures
   * labelled "updated just now". On a monitor, a wrong number presented
   * confidently is worse than a late one.
   */
  var inFlight = false;

  function text(value) {
    var node = document.createElement('span');
    node.textContent = value;
    return node.innerHTML;
  }

  function pct(value) {
    return value === null || value === undefined ? '—' : value + '%';
  }

  function number(value) {
    return (value || 0).toLocaleString();
  }

  /** A pool's window, said the way a person would say it. */
  /*
   * Used attributively — "the 24-hour allowance" — so it is hyphenated and
   * singular. It read "the 24 hours allowance" before.
   */
  function windowLabel(minutes) {
    if (minutes % 1440 === 0) {
      var days = minutes / 1440;
      return days === 1 ? '24-hour' : days + '-day';
    }
    if (minutes % 60 === 0) {
      var hours = minutes / 60;
      return hours === 1 ? 'hourly' : hours + '-hour';
    }
    return minutes + '-minute';
  }

  function statusLabel(status) {
    if (status === 'throttled') return 'throttled';
    if (status === 'warning') return 'getting close';
    if (status === 'unknown') return 'unknown';
    return 'ok';
  }

  /*
   * The bar is drawn from `usedPercent`, which is the HIGHEST of Meta's three
   * figures — calls, CPU time and total time are metered separately and any one
   * of them reaching 100 throttles the pool. Showing only the call count would
   * paint a pool green while its CPU allowance was the thing about to run out.
   */
  function meterBar(pool) {
    if (pool.usedPercent === null || pool.usedPercent === undefined) {
      return '<div class="meter unknown"><span style="width:100%"></span></div>';
    }
    var width = Math.min(100, Math.max(1, pool.usedPercent));
    return (
      '<div class="meter ' +
      text(pool.status) +
      '"><span style="width:' +
      width +
      '%"></span></div>'
    );
  }

  /*
   * A call that came back with no usage header at all — a timeout, a reset, or
   * one of the responses Meta documents as carrying none. It is grouped with
   * the unattributed pools because it belongs to no pool, and it needs its own
   * wording: it has no Meta id, because Meta never answered.
   */
  function isHeaderless(pool) {
    return pool.meter === 'unknown';
  }

  /*
   * The provider is shown on every pool because the table holds more than one.
   * `meta` is the only one today; a row that did not say whose quota it was
   * would become ambiguous the moment a second appears, and by then the screen
   * is somebody's habit.
   */
  function providerTag(pool) {
    return '<span class="pill none">' + text(pool.provider) + '</span> ';
  }

  function poolTitle(pool) {
    if (isHeaderless(pool)) return 'Calls with no usage header';
    if (pool.channel && pool.channel.name) return pool.channel.name;
    // No channel: this is the provider's own business-level pool, which is a
    // real pool that really throttles and is nobody's single account.
    if (pool.product) return 'Business-level ' + pool.product + ' pool';
    return pool.scopeKey;
  }

  function poolSubtitle(pool) {
    if (isHeaderless(pool)) {
      return 'Timed out or came back without one — counted, but they tell us nothing about any pool';
    }

    /*
     * EACH TERM IS LABELLED, because two of them are the word "instagram" and
     * they mean different things. `product` is the PROVIDER's name for the pool;
     * `channel.platform` is which of our surfaces the channel is. A Facebook
     * Page really does report against Meta's `instagram` pool once an Instagram
     * account is linked to it, so "Ai automation · instagram / facebook" read
     * like a contradiction when it was simply two unlabelled facts.
     */
    var parts = [];
    if (pool.channel) {
      // The title is the channel's name, so the subtitle names the POOL it
      // meters against and the platform it is — the two facts that differ.
      if (pool.product) parts.push(pool.product + ' pool');
      parts.push(pool.allowanceFormula);
      if (pool.channel.platform) parts.push(pool.channel.platform + ' channel');
    } else {
      // The title already says which pool; don't say it twice.
      parts.push(pool.allowanceFormula);
      // Said plainly, because an unattributed row otherwise looks like a bug.
      parts.push(pool.provider + ' id ' + pool.providerScopeId + ' — not one of our channels');
    }
    return parts.join(' · ');
  }

  function poolRow(pool) {
    var throttleNote = '';
    if (pool.throttledUntil) {
      throttleNote =
        '<div class="rl-note bad">Meta is refusing calls until ' +
        text(new Date(pool.throttledUntil).toLocaleTimeString()) +
        '. Calling again before then makes the block longer.</div>';
    } else if (pool.throttledCallsInWindow > 0) {
      throttleNote =
        '<div class="rl-note bad">' +
        number(pool.throttledCallsInWindow) +
        ' call(s) refused in this window.</div>';
    } else if (pool.failedCallsInWindow > 0) {
      // Worth saying, and worth distinguishing from a refusal: these did not
      // cost quota, they just did not work.
      throttleNote =
        '<div class="rl-note muted">' +
        number(pool.failedCallsInWindow) +
        ' call(s) failed for other reasons.</div>';
    }

    var estimate = pool.estimatedAllowanceCalls
      ? '<small class="muted"> · pool looks like ~' +
        number(pool.estimatedAllowanceCalls) +
        ' calls</small>'
      : '';

    return (
      '<tr>' +
      '<td>' +
      providerTag(pool) +
      '<strong>' +
      text(poolTitle(pool)) +
      '</strong><br /><small class="muted">' +
      text(poolSubtitle(pool)) +
      '</small>' +
      throttleNote +
      '</td>' +
      '<td style="min-width:170px">' +
      meterBar(pool) +
      '<small class="muted">' +
      pct(pool.usedPercent) +
      ' used of the ' +
      text(windowLabel(pool.windowMinutes)) +
      ' allowance</small></td>' +
      '<td>' +
      (pool.remainingPercent === null ? '—' : pct(pool.remainingPercent)) +
      '</td>' +
      '<td>' +
      number(pool.callsInWindow) +
      estimate +
      '</td>' +
      '<td><span class="pill ' +
      text(pool.status) +
      '">' +
      text(statusLabel(pool.status)) +
      '</span></td>' +
      '</tr>'
    );
  }

  function poolTable(pools) {
    return (
      '<table class="rl-table">' +
      '<thead><tr><th>Pool</th><th>Used</th><th>Left</th><th>Our calls</th><th></th></tr></thead>' +
      '<tbody>' +
      pools.map(poolRow).join('') +
      '</tbody></table>'
    );
  }

  function renderApp(app) {
    if (!app) {
      /*
       * The ordinary state, and worth saying rather than leaving blank: the app
       * pool is only touched by the OAuth and token paths, so an idle hour with
       * nobody connecting shows nothing at all.
       */
      appTiles.innerHTML =
        '<div class="tile" style="flex:1 1 100%"><div class="k">App pool</div>' +
        '<div class="n" style="font-size:16px">No calls yet</div>' +
        '<small class="muted">Nothing has drawn on the app-wide allowance recently. ' +
        'Only connecting an account and refreshing a token do — the inbox is metered ' +
        'per business instead.</small></div>';
      return;
    }

    appTiles.innerHTML =
      '<div class="tile"><div class="k">App pool used</div><div class="n">' +
      pct(app.usedPercent) +
      '</div><small class="muted">of ' +
      text(app.allowanceFormula) +
      '</small></div>' +
      '<div class="tile"><div class="k">Left</div><div class="n">' +
      (app.remainingPercent === null ? '—' : pct(app.remainingPercent)) +
      '</div><small class="muted">throttling starts at 100%</small></div>' +
      '<div class="tile"><div class="k">Our calls this hour</div><div class="n">' +
      number(app.callsInWindow) +
      '</div><small class="muted">' +
      (app.estimatedAllowanceCalls
        ? 'pool looks like ~' + number(app.estimatedAllowanceCalls) + ' calls'
        : 'shared by every business') +
      '</small></div>' +
      '<div class="tile"><div class="k">Refused</div><div class="n">' +
      number(app.throttledCallsInWindow) +
      '</div><small class="muted">' +
      (app.throttledCallsInWindow > 0 ? 'calling again extends the block' : 'none') +
      '</small></div>' +
      /*
       * FAILED IS NOT REFUSED, and hiding it was misleading: a pool reading
       * "2 calls, 0 refused" looked healthy while both of those calls had
       * failed for some other reason — a timeout, a dead token, a 500.
       */
      '<div class="tile"><div class="k">Failed</div><div class="n">' +
      number(app.failedCallsInWindow) +
      '</div><small class="muted">' +
      (app.failedCallsInWindow > 0 ? 'not rate limits — timeouts, tokens, 5xx' : 'none') +
      '</small></div>';
  }

  function renderAttention(pools) {
    if (!pools.length) {
      attention.innerHTML = '';
      return;
    }
    attention.innerHTML =
      '<div class="message ' +
      (pools.some(function (pool) { return pool.status === 'throttled'; }) ? 'error' : 'info') +
      '"><strong>' +
      pools.length +
      ' pool(s) need attention.</strong> ' +
      text(
        pools
          .map(function (pool) {
            return poolTitle(pool) + ' at ' + pct(pool.usedPercent);
          })
          .join('; '),
      ) +
      '</div>';
  }

  function render(data) {
    renderApp(data.app);
    renderAttention(data.attention || []);

    var html = '';

    (data.enterprises || []).forEach(function (enterprise) {
      html +=
        '<h3 class="rl-heading">' +
        text(enterprise.enterpriseName) +
        ' <span class="pill ' +
        text(enterprise.status) +
        '">' +
        text(statusLabel(enterprise.status)) +
        '</span></h3>' +
        poolTable(enterprise.pools);
    });

    if ((data.unattributed || []).length) {
      html +=
        '<h3 class="rl-heading">Not tied to one business</h3>' +
        '<p class="hint">Either Meta named these under an id that is not one of our channels — ' +
        'usually a Meta Business account whose assets span more than one of our tenants, so the ' +
        'quota really is shared — or the call came back with no usage header at all and belongs ' +
        'to no pool.</p>' +
        poolTable(data.unattributed);
    }

    if (!html) {
      html =
        '<p class="hint">No Meta calls recorded in the last 24 hours. This fills in as soon as ' +
        'anything talks to Meta — an inbox refresh, a backfill, or a new connection.</p>';
    }

    body.innerHTML = html;
  }

  function showAge() {
    if (!lastLoadedAt) return;
    var seconds = Math.round((Date.now() - lastLoadedAt) / 1000);
    updated.textContent = seconds < 2 ? 'updated just now' : 'updated ' + seconds + 's ago';
  }

  async function load() {
    if (inFlight) return;
    inFlight = true;
    try {
      var result = await window.api.request('/platform/rate-limits');
      message.innerHTML = '';
      render(result.data);
      lastLoadedAt = Date.now();
      showAge();
    } catch (error) {
      /*
       * The panel keeps whatever it last drew rather than blanking. A monitor
       * that empties itself when its own request fails is indistinguishable
       * from one reporting that everything has stopped.
       */
      message.innerHTML =
        '<div class="message error">Could not refresh the rate-limit view. ' +
        'The figures below are from the last successful read.' +
        '<span class="code">' +
        text((error && error.message) || 'request failed') +
        '</span></div>';
    } finally {
      inFlight = false;
    }
  }

  function startAuto() {
    if (timer) clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }

  function stopAuto() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  document.getElementById('rlRefresh').addEventListener('click', function () {
    void load();
  });

  auto.addEventListener('change', function () {
    if (auto.checked) startAuto();
    else stopAuto();
  });

  // Polling a hidden tab is pure waste, and coming back to a stale number is
  // worse than waiting one beat for a fresh one.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopAuto();
      // The age ticker goes with it. Polling was deliberately paused, so there
      // is nothing to re-time once a second on a tab nobody is looking at.
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    } else {
      /*
       * The ticker restarts whatever the checkbox says. It was inside the
       * auto-refresh branch, so with auto-refresh OFF, hiding and re-showing
       * the tab killed "updated Ns ago" permanently — the label froze at
       * whatever it last said and never moved again.
       */
      if (!tickTimer) tickTimer = setInterval(showAge, 1000);
      if (auto.checked) {
        void load();
        startAuto();
      }
    }
  });

  tickTimer = setInterval(showAge, 1000);
  void load();
  // Honours the checkbox rather than assuming it ships checked, so the control
  // and the timer cannot disagree if that default ever changes.
  if (auto.checked) startAuto();
})();
