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

  /* ------------------------------------------------------------------ *
   * How media is described.
   *
   * The instruction and the model behind every description, and the state of
   * the queue that produces them. Both fields matter for different reasons:
   * the prompt decides what every description SAYS, the model decides what
   * every description COSTS.
   * ------------------------------------------------------------------ */
  const mediaMessage = document.getElementById('mediaMessage');

  /** The statuses, in the order a reader follows them through the pipeline. */
  const QUEUE_STATUSES = ['pending', 'in_flight', 'done', 'failed', 'unavailable'];

  function renderMediaTiles(data) {
    const byStatus = data.queue.byStatus || {};
    const tiles = [
      ['Media seen', data.queue.total],
      ['Described', byStatus.done || 0],
      ['Waiting', (byStatus.pending || 0) + (byStatus.failed || 0)],
      ['In flight', byStatus.in_flight || 0],
      ['Given up', byStatus.unavailable || 0],
      ['Tokens used', data.spend.totalTokens],
    ];

    const container = document.getElementById('mediaTiles');
    container.innerHTML = '';
    tiles.forEach(function (tile) {
      const box = document.createElement('div');
      box.className = 'tile';
      box.innerHTML = '<div class="n"></div><div class="k"></div>';
      box.querySelector('.n').textContent = tile[1];
      box.querySelector('.k').textContent = tile[0];
      container.appendChild(box);
    });
  }

  /** One row per media kind, so a format that always fails is visible as one. */
  function renderMediaQueue(data) {
    const body = document.getElementById('mediaQueueRows');
    body.innerHTML = '';

    const byKind = {};
    (data.queue.byKind || []).forEach(function (row) {
      byKind[row.kind] = byKind[row.kind] || {};
      byKind[row.kind][row.status] = row.count;
    });

    const kinds = Object.keys(byKind).sort();
    if (kinds.length === 0) {
      const empty = document.createElement('tr');
      empty.innerHTML = '<td colspan="6">No media has been queued yet.</td>';
      body.appendChild(empty);
      return;
    }

    kinds.forEach(function (kind) {
      const tr = document.createElement('tr');
      const cells = [kind].concat(
        QUEUE_STATUSES.map(function (status) {
          return String(byKind[kind][status] || 0);
        }),
      );
      cells.forEach(function (text) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function renderMediaAnalysis(data) {
    document.getElementById('mediaModel').value = data.model || '';
    document.getElementById('mediaPrompt').value = data.prompt || '';
    document.getElementById('mediaVersion').value = String(data.promptVersion);
    renderMediaTiles(data);
    renderMediaQueue(data);

    /*
     * An idle queue has two very different explanations, and only one of them
     * is a problem. Saying which costs a line and saves an investigation.
     */
    if (!data.enabled) {
      show(
        mediaMessage,
        'info',
        'Gemini is switched off in this environment, so nothing is being described. ' +
          'The queue keeps collecting and will run once it is enabled.',
      );
    }
  }

  async function loadMediaAnalysis() {
    try {
      renderMediaAnalysis((await window.api.request('/platform/media-analysis')).data);
    } catch (error) {
      handle(error, mediaMessage);
    }
  }

  async function saveMediaAnalysis() {
    const button = document.getElementById('mediaSave');
    button.disabled = true;
    try {
      const result = await window.api.request('/platform/media-analysis', {
        method: 'PUT',
        body: {
          model: document.getElementById('mediaModel').value.trim(),
          prompt: document.getElementById('mediaPrompt').value.trim(),
        },
      });
      renderMediaAnalysis(result.data);
      show(
        mediaMessage,
        'ok',
        'Saved. Media described from now on uses this; descriptions already made are untouched.',
      );
    } catch (error) {
      handle(error, mediaMessage);
    } finally {
      button.disabled = false;
    }
  }

  document.getElementById('mediaSave').addEventListener('click', saveMediaAnalysis);

  /* ------------------------------------------------------------------ *
   * How the assistant replies.
   *
   * Three fields, and the first two are a pair: a model id belongs to the
   * provider that serves it, so changing provider without changing model is
   * a save that looks fine here and fails on the next draft.
   * ------------------------------------------------------------------ */
  const chatMessage = document.getElementById('chatMessage');

  /** Every provider the API knows, labelled with whether it can run here. */
  function renderProviders(data) {
    const select = document.getElementById('chatProvider');
    const available = data.availableProviders || [];
    const known = [['openai', 'OpenAI'], ['gemini', 'Gemini']];

    select.innerHTML = '';
    known.forEach(function (entry) {
      const option = document.createElement('option');
      option.value = entry[0];
      option.textContent =
        available.indexOf(entry[0]) === -1 ? entry[1] + ' (no key in this environment)' : entry[1];
      select.appendChild(option);
    });
    select.value = data.provider;
  }

  /**
   * Where each key comes from, since the key itself never arrives here.
   *
   * The last four characters of a console-held key are enough to answer "is
   * the one I pasted still in there?" without the page ever holding a
   * credential that a screenshot could leak.
   */
  function renderKeyNotes(data) {
    const keys = data.keys || {};
    [['openai', 'OpenAI'], ['gemini', 'Gemini']].forEach(function (entry) {
      const note = document.getElementById(
        'chatKey' + entry[0].charAt(0).toUpperCase() + entry[0].slice(1) + 'Note',
      );
      const state = keys[entry[0]] || { source: 'none', hint: null };
      if (state.source === 'console') {
        note.textContent = 'A key is stored here, ending ' + (state.hint || '????') + '.';
      } else if (state.source === 'environment') {
        note.textContent = 'Using the key from this environment. Paste one here to override it.';
      } else {
        note.textContent = 'No key anywhere — ' + entry[1] + ' cannot answer.';
      }
    });
  }

  function renderChatSettings(data) {
    renderProviders(data);
    document.getElementById('chatAutoReply').checked = data.autoReply === true;
    document.getElementById('chatModelOpenai').value = (data.models && data.models.openai) || '';
    document.getElementById('chatModelGemini').value = (data.models && data.models.gemini) || '';
    renderKeyNotes(data);
    document.getElementById('chatFallback').value = data.fallbackMessage || '';
    document.getElementById('chatHold').value = data.mediaHoldMessage || '';
    document.getElementById('chatPrompt').value = data.prompt || '';
    document.getElementById('chatVersion').value = String(data.promptVersion);

    /*
     * A silent assistant has two very different explanations and only one is
     * a problem. Saying which costs a line and saves an investigation.
     */
    if (!data.enabled) {
      show(
        chatMessage,
        'info',
        'The chosen provider has no key in this environment, so no draft will be written. ' +
          'The setting is saved either way.',
      );
    }
  }

  async function loadChatSettings() {
    try {
      renderChatSettings((await window.api.request('/platform/chat')).data);
    } catch (error) {
      handle(error, chatMessage);
    }
  }

  async function saveChatSettings() {
    const button = document.getElementById('chatSave');
    button.disabled = true;
    try {
      const result = await window.api.request('/platform/chat', {
        method: 'PUT',
        body: {
          provider: document.getElementById('chatProvider').value,
          models: {
            openai: document.getElementById('chatModelOpenai').value.trim(),
            gemini: document.getElementById('chatModelGemini').value.trim(),
          },
          /*
           * Only when there is something to say. A blank box means "leave the
           * stored key alone" — the page cannot put one back, so sending a
           * blank would wipe a working key on every save of the prompt. The
           * tick-box is the only way to remove one, and sends null.
           */
          apiKeys: collectKeys(),
          autoReply: document.getElementById('chatAutoReply').checked,
          fallbackMessage: document.getElementById('chatFallback').value.trim(),
          mediaHoldMessage: document.getElementById('chatHold').value.trim(),
          prompt: document.getElementById('chatPrompt').value.trim(),
        },
      });
      renderChatSettings(result.data);
      ['Openai', 'Gemini'].forEach(function (name) {
        document.getElementById('chatKey' + name).value = '';
        document.getElementById('chatKey' + name + 'Clear').checked = false;
      });
      show(chatMessage, 'ok', 'Saved. Replies written from now on use this.');
    } catch (error) {
      handle(error, chatMessage);
    } finally {
      button.disabled = false;
    }
  }

  /** Absent, null or a new key — the three states the API keeps apart. */
  function collectKeys() {
    const keys = {};
    [['openai', 'Openai'], ['gemini', 'Gemini']].forEach(function (entry) {
      const typed = document.getElementById('chatKey' + entry[1]).value.trim();
      const clear = document.getElementById('chatKey' + entry[1] + 'Clear').checked;
      if (clear) keys[entry[0]] = null;
      else if (typed) keys[entry[0]] = typed;
    });
    return keys;
  }

  document.getElementById('chatSave').addEventListener('click', saveChatSettings);

  loadHeader();
  loadOverview();
  loadList(false);
  loadMediaAnalysis();
  loadChatSettings();
})();
