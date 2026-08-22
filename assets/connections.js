(function () {
  if (!window.api.requireSession()) return;

  const outcome = document.getElementById('outcome');
  const connectMessage = document.getElementById('connectMessage');
  const listMessage = document.getElementById('listMessage');
  const consent = document.getElementById('consent');
  const connect = document.getElementById('connect');

  let permissions = [];

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

  function handle(error, target) {
    if (error.status === 401) {
      window.api.clearSession();
      window.location.href = 'index.html';
      return;
    }
    // The API's own message is written for a person; prefer it to anything
    // invented here.
    show(target, 'error', error.message, error.code);
  }

  function pill(text) {
    const span = document.createElement('span');
    span.className = 'pill ' + String(text || 'none');
    span.textContent = String(text || '—').replace(/_/g, ' ');
    return span;
  }

  /*
   * What the OAuth callback left in the query string.
   *
   * Read for the headline only, and then thrown away — the tables below are
   * filled from the API, because a query string is whatever the last redirect
   * happened to say and the database is what is actually true.
   */
  function reportCallbackOutcome() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    if (!status) return;

    if (status === 'success') {
      const pages = params.get('pageCount') || '0';
      const instagram = params.get('instagramCount') || '0';
      const errors = params.get('errorCount');
      const summary =
        `Connected. ${pages} Page(s) and ${instagram} Instagram account(s).` +
        // Partial failures are stated, not hidden behind a green tick.
        (errors ? ` ${errors} could not be set up — see the channel list below.` : '');
      show(outcome, errors ? 'info' : 'ok', summary);
    } else if (status === 'cancelled') {
      show(outcome, 'info', 'Connection cancelled — nothing was changed.');
    } else {
      show(
        outcome,
        'error',
        'Facebook connection failed. Nothing was changed.',
        params.get('reason') || undefined,
      );
    }

    // Clear the query string so a refresh does not re-announce a stale result.
    window.history.replaceState({}, '', window.location.pathname);
  }

  async function loadHeader() {
    try {
      const me = (await window.api.request('/auth/me')).data;
      permissions = me.permissions || [];
      document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : '';

      // Do not offer a button whose every press would be a 403.
      if (permissions.indexOf('channels.connect') === -1) {
        document.getElementById('connectPanel').hidden = true;
      }
    } catch (error) {
      handle(error, listMessage);
    }
  }

  async function loadConnections() {
    const rows = document.getElementById('connectionRows');
    try {
      const data = (await window.api.request('/connections')).data;
      rows.innerHTML = '';
      if (data.length === 0) {
        rows.innerHTML = '<tr><td colspan="4">Nothing connected yet.</td></tr>';
        return;
      }
      data.forEach(function (connection) {
        const tr = document.createElement('tr');
        const cells = [
          document.createTextNode(connection.provider),
          document.createTextNode(connection.providerUserName || '—'),
          null,
          document.createTextNode(
            connection.tokenExpiresAt
              ? new Date(connection.tokenExpiresAt).toLocaleDateString()
              : 'no expiry recorded',
          ),
        ];
        cells.forEach(function (content, index) {
          const td = document.createElement('td');
          if (index === 2) {
            td.appendChild(pill(connection.status));
            // Worth saying loudly: a connection needing re-auth is one that has
            // silently stopped working.
            if (connection.reauthRequired) {
              const warn = document.createElement('div');
              warn.className = 'message error';
              warn.style.marginTop = '6px';
              warn.textContent = 'Needs reconnecting.';
              td.appendChild(warn);
            }
          } else {
            td.appendChild(content);
          }
          tr.appendChild(td);
        });
        rows.appendChild(tr);
      });
    } catch (error) {
      rows.innerHTML = '';
      handle(error, listMessage);
    }
  }

  async function loadChannels() {
    const rows = document.getElementById('channelRows');
    try {
      const data = (await window.api.request('/connections/channels')).data;
      rows.innerHTML = '';
      if (data.length === 0) {
        rows.innerHTML = '<tr><td colspan="5">No channels yet.</td></tr>';
        return;
      }

      const nameByRefId = {};
      data.forEach(function (channel) {
        nameByRefId[channel.refId] = channel.name || channel.username || channel.refId;
      });

      data.forEach(function (channel) {
        const tr = document.createElement('tr');

        const name = document.createElement('td');
        name.innerHTML = '<strong></strong><br><small></small>';
        name.querySelector('strong').textContent = channel.name || '(unnamed)';
        name.querySelector('small').textContent = channel.username ? '@' + channel.username : '';

        const platform = document.createElement('td');
        platform.textContent = channel.platform;

        const kind = document.createElement('td');
        kind.textContent = String(channel.channelKind).replace(/_/g, ' ');

        const parent = document.createElement('td');
        parent.textContent = channel.parentChannelRefId
          ? nameByRefId[channel.parentChannelRefId] || '—'
          : '—';

        const status = document.createElement('td');
        status.appendChild(pill(channel.status));
        if (channel.reauthRequired) {
          const warn = document.createElement('div');
          warn.className = 'message error';
          warn.style.marginTop = '6px';
          warn.textContent = 'Needs reconnecting.';
          status.appendChild(warn);
        }
        if (channel.isManaged === false) {
          const note = document.createElement('small');
          note.textContent = 'not managed';
          status.appendChild(note);
        }

        [name, platform, kind, parent, status].forEach(function (cell) {
          tr.appendChild(cell);
        });
        rows.appendChild(tr);
      });
    } catch (error) {
      rows.innerHTML = '';
      handle(error, listMessage);
    }
  }

  consent.addEventListener('change', function () {
    connect.disabled = !consent.checked;
  });

  connect.addEventListener('click', async function () {
    if (connect.disabled) return;
    const original = connect.textContent;
    connect.disabled = true;
    connect.textContent = 'Taking you to Facebook…';
    connectMessage.innerHTML = '';

    try {
      /*
       * The backend builds the authorization URL, and it is the only thing that
       * can: the `state` parameter is signed and recorded server-side, bound to
       * this business and the person clicking. Nothing here chooses an identity,
       * which is exactly why there is no key for the frontend to hold.
       */
      const result = await window.api.request('/connections/meta/connect');

      /*
       * SAME TAB, not a popup.
       *
       * A popup would land the callback in a window with no sessionStorage of
       * ours, so it could not read the result — which is why the old build had
       * to poll a backend session and work around Facebook's COOP severing
       * window.opener. Navigating this tab keeps the token, so on return the
       * page simply asks the API what happened.
       */
      window.location.href = result.data.authorizationUrl;
    } catch (error) {
      connect.disabled = false;
      connect.textContent = original;
      consent.checked = false;
      connect.disabled = true;

      if (error.code === 'META_NOT_CONFIGURED') {
        show(
          connectMessage,
          'info',
          'Facebook is not configured on this environment yet, so the connection cannot be ' +
            'started. This is a server setting, not something wrong with your account.',
          error.code,
        );
        return;
      }
      handle(error, connectMessage);
    }
  });

  document.getElementById('signOut').addEventListener('click', async function () {
    try { await window.api.request('/auth/logout', { method: 'POST' }); } catch (_) { /* leaving anyway */ }
    window.api.clearSession();
    window.location.href = 'index.html';
  });

  reportCallbackOutcome();
  loadHeader().then(function () {
    return Promise.all([loadConnections(), loadChannels()]);
  });
})();
