(function () {
  if (!window.api.requireSession()) return;

  const rows = document.getElementById('rows');
  const detail = document.getElementById('detail');
  const listMessage = document.getElementById('listMessage');
  const more = document.getElementById('more');

  let nextCursor = null;
  let openRefId = null;

  function show(target, kind, text, code) {
    target.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'message ' + kind;
    box.textContent = text;
    if (code) {
      const small = document.createElement('span');
      small.className = 'code';
      small.textContent = code;
      box.appendChild(small);
    }
    target.appendChild(box);
  }

  function pill(status) {
    const span = document.createElement('span');
    span.className = 'pill ' + (status || 'none');
    span.textContent = status ? status.replace(/_/g, ' ') : 'not granted';
    return span;
  }

  function date(value) {
    return value ? new Date(value).toLocaleString() : '—';
  }

  /** A 401 means the token expired while the tab sat open. Send them back. */
  function handle(error, target) {
    if (error.status === 401) {
      window.api.clearSession();
      window.location.href = 'index.html';
      return;
    }
    show(target, 'error', error.message, error.code);
  }

  async function loadHeader() {
    try {
      const me = (await window.api.request('/auth/me')).data;
      if (!me.isPlatformAdmin) {
        // Not ours to show. A non-admin reaching this page is a wrong turn, not
        // an attack — the API would refuse every call on it anyway.
        window.location.href = 'portal.html';
        return;
      }
      document.getElementById('who').textContent = 'Signed in as platform admin';
    } catch (error) {
      handle(error, listMessage);
    }
  }

  async function loadOverview() {
    try {
      const data = (await window.api.request('/platform/overview')).data;
      const tiles = [
        ['Businesses', data.enterprisesTotal],
        ['Pending', data.enterprisesPending],
        ['Active', data.enterprisesActive],
        ['Suspended', data.enterprisesSuspended],
        ['Customers', data.customersTotal],
        ['Channels', data.channelsTotal],
        ['Conversations', data.conversationsTotal],
        ['Feature requests', data.featureRequestsPending],
      ];

      const container = document.getElementById('tiles');
      container.innerHTML = '';
      tiles.forEach(function (tile) {
        const box = document.createElement('div');
        box.className = 'tile';
        box.innerHTML = '<div class="n"></div><div class="k"></div>';
        box.querySelector('.n').textContent = tile[1];
        box.querySelector('.k').textContent = tile[0];
        container.appendChild(box);
      });
    } catch (error) {
      handle(error, listMessage);
    }
  }

  async function loadList(append) {
    const params = new URLSearchParams();
    const search = document.getElementById('search').value.trim();
    const status = document.getElementById('status').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    params.set('limit', '20');
    if (append && nextCursor) params.set('cursor', nextCursor);

    try {
      const result = await window.api.request('/platform/enterprises?' + params.toString());
      if (!append) rows.innerHTML = '';

      if (result.data.length === 0 && !append) {
        rows.innerHTML = '<tr><td colspan="8">No businesses match.</td></tr>';
      }

      result.data.forEach(function (enterprise) {
        const tr = document.createElement('tr');

        const name = document.createElement('td');
        name.innerHTML = '<strong></strong><br><small></small>';
        name.querySelector('strong').textContent = enterprise.name;
        name.querySelector('small').textContent = enterprise.email;

        const statusCell = document.createElement('td');
        statusCell.appendChild(pill(enterprise.status));

        tr.appendChild(name);
        tr.appendChild(statusCell);
        [
          enterprise.counts.members,
          enterprise.counts.channels,
          enterprise.counts.customers,
          enterprise.counts.conversations,
        ].forEach(function (n) {
          const td = document.createElement('td');
          td.textContent = n;
          tr.appendChild(td);
        });

        const features = document.createElement('td');
        features.textContent =
          enterprise.counts.activeFeatures +
          ' on' +
          (enterprise.counts.pendingFeatures ? ' · ' + enterprise.counts.pendingFeatures + ' asked' : '');
        tr.appendChild(features);

        const created = document.createElement('td');
        created.textContent = new Date(enterprise.createdAt).toLocaleDateString();
        tr.appendChild(created);

        tr.addEventListener('click', function () { openDetail(enterprise.refId); });
        rows.appendChild(tr);
      });

      nextCursor = result.meta.pagination.nextCursor;
      more.hidden = !result.meta.pagination.hasMore;
    } catch (error) {
      handle(error, listMessage);
    }
  }

  async function openDetail(refId) {
    openRefId = refId;
    detail.hidden = false;
    detail.innerHTML = '<p class="hint">Loading…</p>';
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const data = (await window.api.request('/platform/enterprises/' + refId)).data;
      renderDetail(data);
    } catch (error) {
      handle(error, detail);
    }
  }

  function renderDetail(data) {
    detail.innerHTML = '';

    const heading = document.createElement('h2');
    heading.textContent = data.name;
    detail.appendChild(heading);

    const sub = document.createElement('p');
    sub.className = 'hint';
    sub.textContent = data.slug + ' · ' + (data.city ? data.city + ', ' : '') + data.country +
      ' · ' + data.timezone;
    detail.appendChild(sub);

    // --- what they are and what they have ---------------------------------
    const kv = document.createElement('dl');
    kv.className = 'kv';
    const owner = data.owner;
    [
      ['Status', null, data.status],
      ['Signed up', date(data.createdAt)],
      ['Business email', data.email],
      ['Business mobile', data.mobile || '—'],
      ['Owner', owner ? owner.name : '—'],
      ['Owner email', owner ? (owner.email || '—') + (owner.emailVerified ? ' (verified)' : '') : '—'],
      ['Owner mobile', owner ? (owner.mobile || '—') + (owner.mobileVerified ? ' (verified)' : '') : '—'],
      ['Owner last signed in', owner ? date(owner.lastLoginAt) : '—'],
      ['Members', String(data.counts.members)],
      ['Customers', String(data.counts.customers)],
      ['Conversations', String(data.counts.conversations)],
      ['Connections', String(data.counts.connections)],
    ].forEach(function (pair) {
      const dt = document.createElement('dt');
      dt.textContent = pair[0];
      const dd = document.createElement('dd');
      if (pair[2]) dd.appendChild(pill(pair[2])); else dd.textContent = pair[1];
      kv.appendChild(dt);
      kv.appendChild(dd);
    });
    detail.appendChild(kv);

    // --- activate / suspend ----------------------------------------------
    const actions = document.createElement('div');
    actions.className = 'actions';

    if (data.status !== 'active') {
      const activate = document.createElement('button');
      activate.textContent = 'Activate this business';
      activate.addEventListener('click', function () { setStatus(data.refId, 'active', null); });
      actions.appendChild(activate);
    }

    if (data.status !== 'suspended') {
      const suspend = document.createElement('button');
      suspend.className = 'danger';
      suspend.textContent = 'Suspend';
      suspend.addEventListener('click', function () {
        // The API requires a reason and records it in the audit trail, so ask
        // rather than sending a placeholder.
        const reason = window.prompt('Why is this business being suspended?');
        if (!reason) return;
        setStatus(data.refId, 'suspended', reason);
      });
      actions.appendChild(suspend);
    }

    detail.appendChild(actions);
    const statusMessage = document.createElement('div');
    detail.appendChild(statusMessage);
    detail.dataset.messageTarget = '1';

    // --- features ---------------------------------------------------------
    const featuresHeading = document.createElement('h2');
    featuresHeading.style.marginTop = '22px';
    featuresHeading.textContent = 'Features';
    detail.appendChild(featuresHeading);

    const featuresHint = document.createElement('p');
    featuresHint.className = 'hint';
    featuresHint.textContent =
      'What this business is entitled to. Granting a feature is what makes its actions available ' +
      'to their staff at all — a role cannot grant what the business does not have.';
    detail.appendChild(featuresHint);

    data.features.forEach(function (feature) {
      const row = document.createElement('div');
      row.className = 'feature';

      const name = document.createElement('div');
      name.className = 'name';
      name.innerHTML = '<strong></strong><small></small>';
      name.querySelector('strong').textContent = feature.featureName;
      name.querySelector('small').textContent = feature.description || '';

      row.appendChild(name);
      row.appendChild(pill(feature.status));

      // Only offer moves the API will accept, so a button never produces a 409.
      const offer = [];
      if (feature.status === null) offer.push(['Grant', 'active'], ['Decline', 'declined']);
      else if (feature.status === 'access_requested') offer.push(['Grant', 'active'], ['Decline', 'declined']);
      else if (feature.status === 'active') offer.push(['Disable', 'disabled'], ['Revoke', 'revoked']);
      else if (feature.status === 'disabled' || feature.status === 'expired') offer.push(['Enable', 'active']);
      else if (feature.status === 'declined') offer.push(['Reopen request', 'access_requested']);

      offer.forEach(function (option) {
        // 'access_requested' is the business's move, not ours: the API rejects
        // it from an admin, so it is not offered as a button.
        if (option[1] === 'access_requested') return;
        const button = document.createElement('button');
        button.className = option[1] === 'active' ? '' : 'secondary';
        button.textContent = option[0];
        button.addEventListener('click', function () {
          let reason = null;
          if (option[1] === 'declined' || option[1] === 'revoked') {
            reason = window.prompt('Reason for "' + option[0].toLowerCase() + '"?');
            if (!reason) return;
          }
          decideFeature(data.refId, feature.featureKey, option[1], reason, statusMessage);
        });
        row.appendChild(button);
      });

      detail.appendChild(row);
    });

    // --- channels ---------------------------------------------------------
    const channelsHeading = document.createElement('h2');
    channelsHeading.style.marginTop = '22px';
    channelsHeading.textContent = 'Connected channels';
    detail.appendChild(channelsHeading);

    if (data.channels.length === 0) {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent = 'Nothing connected yet.';
      detail.appendChild(none);
    } else {
      data.channels.forEach(function (channel) {
        const row = document.createElement('div');
        row.className = 'feature';
        const name = document.createElement('div');
        name.className = 'name';
        name.innerHTML = '<strong></strong><small></small>';
        name.querySelector('strong').textContent =
          (channel.displayName || channel.platformChannelId) + ' · ' + channel.platform;
        name.querySelector('small').textContent =
          channel.channelKind + ' · connected ' + date(channel.connectedAt);
        row.appendChild(name);
        row.appendChild(pill(channel.channelStatus));
        detail.appendChild(row);
      });
    }
  }

  async function setStatus(refId, status, reason) {
    const body = { status: status };
    if (reason) body.reason = reason;
    try {
      await window.api.request('/platform/enterprises/' + refId + '/status', {
        method: 'POST',
        body: body,
      });
      await Promise.all([loadOverview(), loadList(false)]);
      await openDetail(refId);
    } catch (error) {
      handle(error, detail);
    }
  }

  async function decideFeature(refId, featureKey, status, reason, target) {
    const body = { status: status };
    if (reason) body.reason = reason;
    try {
      await window.api.request(
        '/platform/enterprises/' + refId + '/features/' + featureKey,
        { method: 'POST', body: body },
      );
      await Promise.all([loadOverview(), loadList(false)]);
      await openDetail(refId);
    } catch (error) {
      handle(error, target || detail);
    }
  }

  document.getElementById('apply').addEventListener('click', function () {
    nextCursor = null;
    loadList(false);
  });
  document.getElementById('search').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { nextCursor = null; loadList(false); }
  });
  more.addEventListener('click', function () { loadList(true); });
  document.getElementById('signOut').addEventListener('click', async function () {
    try { await window.api.request('/auth/logout', { method: 'POST' }); } catch (_) { /* leaving anyway */ }
    window.api.clearSession();
    window.location.href = 'index.html';
  });

  loadHeader();
  loadOverview();
  loadList(false);
})();
