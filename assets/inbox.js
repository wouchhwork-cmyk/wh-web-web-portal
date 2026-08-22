/**
 * The shared inbox.
 *
 * Every list is cursor-paginated by the API, so this holds the cursor rather
 * than a page number — the feed changes while somebody reads it, and offsets
 * would repeat or skip conversations.
 */
(function () {
  if (!window.api.requireSession()) return;

  const rows = document.getElementById('rows');
  const listMessage = document.getElementById('listMessage');
  const threadPanel = document.getElementById('threadPanel');
  const threadTitle = document.getElementById('threadTitle');
  const threadMeta = document.getElementById('threadMeta');
  const messages = document.getElementById('messages');
  const threadMessage = document.getElementById('threadMessage');
  const replyBox = document.getElementById('replyBox');
  const loadMore = document.getElementById('loadMore');

  let permissions = [];
  let cursor = null;
  let openRefId = null;
  let openConversation = null;

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
    show(target, 'error', error.message, error.code);
  }

  function pill(text, kind) {
    const span = document.createElement('span');
    span.className = 'pill ' + (kind || 'none');
    span.textContent = String(text).replace(/_/g, ' ');
    return span;
  }

  function when(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function rowFor(conversation) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    /*
     * The PERSON leads, not the kind. A name is not always known — a direct
     * message carries only a platform id until the thread's participants are
     * read — so the kind is the fallback rather than the headline.
     */
    const customer = conversation.customer;
    title.textContent =
      (customer && customer.displayName) ||
      (customer ? 'Unnamed customer' : conversation.conversationKind.replace(/_/g, ' '));
    left.appendChild(title);
    left.appendChild(document.createElement('br'));
    const meta = document.createElement('small');
    meta.className = 'hint';
    meta.textContent =
      conversation.conversationKind.replace(/_/g, ' ') +
      ' · ' + conversation.messageCount +
      ' message' + (conversation.messageCount === 1 ? '' : 's') +
      ' · last ' + when(conversation.lastMessageAt);
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(pill(conversation.status, conversation.status));
    if (conversation.unreadCount > 0) {
      right.appendChild(pill(conversation.unreadCount + ' unread', 'pending'));
    }
    // Visible in the list, so an agent picking work knows before opening it.
    if (conversation.canReply === false) {
      right.appendChild(pill('reply closed', 'suspended'));
    }
    const open = document.createElement('button');
    open.className = 'secondary';
    open.style.marginLeft = '8px';
    open.textContent = 'Open';
    open.addEventListener('click', function () { openThread(conversation.refId); });
    right.appendChild(open);
    row.appendChild(right);

    return row;
  }

  async function load(reset) {
    if (reset) {
      rows.innerHTML = '';
      cursor = null;
    }

    const status = document.getElementById('statusFilter').value;
    const mine = document.getElementById('mineOnly').checked;

    const query = ['limit=20'];
    if (status) query.push('status=' + encodeURIComponent(status));
    if (mine) query.push('assignedToMe=true');
    if (cursor) query.push('cursor=' + encodeURIComponent(cursor));

    try {
      const result = await window.api.request('/conversations?' + query.join('&'));
      const items = result.data || [];
      const pagination = (result.meta && result.meta.pagination) || {};

      if (items.length === 0 && rows.children.length === 0) {
        show(
          listMessage,
          'info',
          'Nothing here yet. Conversations appear once a customer messages or comments, or once a ' +
            'backfill has run for a connected account.',
        );
      } else {
        listMessage.innerHTML = '';
      }

      items.forEach(function (conversation) { rows.appendChild(rowFor(conversation)); });

      cursor = pagination.nextCursor || null;
      loadMore.hidden = !pagination.hasMore;
    } catch (error) {
      handle(error, listMessage);
    }
  }

  function messageRow(message) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const body = document.createElement('div');
    // Customer words: set as text, never as HTML.
    body.textContent = message.body || '(no text)';
    left.appendChild(body);
    const meta = document.createElement('small');
    meta.className = 'hint';
    meta.textContent =
      (message.direction || message.messageKind || '') + ' · ' + when(message.platformSentAt || message.createdAt);
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    if (message.status) right.appendChild(pill(message.status, message.status));
    row.appendChild(right);
    return row;
  }

  async function openThread(refId) {
    openRefId = refId;
    threadPanel.hidden = false;
    threadMessage.innerHTML = '';
    messages.innerHTML = '<p class="hint">Loading…</p>';

    try {
      const result = await window.api.request('/conversations/' + encodeURIComponent(refId));
      const data = result.data || {};
      const conversation = data.conversation || {};

      const person = conversation.customer;
      threadTitle.textContent =
        (person && person.displayName) ||
        (conversation.conversationKind || 'Conversation').replace(/_/g, ' ');
      threadMeta.textContent =
        (conversation.conversationKind || '').replace(/_/g, ' ') +
        ' · ' + (conversation.platform || '') +
        ' · ' + (conversation.status || '') +
        ' · ' + (conversation.messageCount || 0) + ' messages';

      messages.innerHTML = '';
      const list = data.messages || [];
      if (list.length === 0) {
        messages.appendChild(Object.assign(document.createElement('p'), {
          className: 'hint',
          textContent: 'No messages in this thread.',
        }));
      }
      list.forEach(function (message) { messages.appendChild(messageRow(message)); });

      openConversation = conversation;

      /*
       * The reply box follows the API's OWN answer rather than a rule
       * reimplemented here. `canReply` depends on when the customer last wrote,
       * which the client cannot work out from the thread alone — and duplicating
       * a 24-hour rule in two places is how the two drift apart.
       */
      const canReply = permissions.indexOf('conversations.reply') !== -1;
      replyBox.hidden = !canReply;

      const blocked = conversation.canReply === false;
      const send = document.getElementById('sendReply');
      const note = document.getElementById('internalNote');
      const body = document.getElementById('replyBody');

      if (canReply && blocked) {
        // An internal note never reaches the platform, so it stays available —
        // and becomes the only thing this box can do.
        note.checked = true;
        note.disabled = true;
        body.placeholder = 'Add an internal note…';
        send.textContent = 'Save note';
        show(
          threadMessage,
          'info',
          conversation.replyBlockedReason ||
            'The platform will not accept a reply on this conversation right now.',
        );
      } else if (canReply) {
        note.disabled = false;
        body.placeholder = 'Type a reply…';
        send.textContent = 'Send';
      }

      // Reading a thread marks it read; failing that is not worth an error.
      try {
        await window.api.request('/conversations/' + encodeURIComponent(refId) + '/read', {
          method: 'POST',
        });
      } catch (_) { /* the unread badge is cosmetic */ }
    } catch (error) {
      messages.innerHTML = '';
      handle(error, threadMessage);
    }
  }

  async function sendReply() {
    if (!openRefId) return;
    const body = document.getElementById('replyBody').value.trim();
    if (!body) {
      show(threadMessage, 'error', 'A reply needs some text.');
      return;
    }

    const button = document.getElementById('sendReply');
    button.disabled = true;
    try {
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + '/reply', {
        method: 'POST',
        body: {
          body: body,
          internalNote: document.getElementById('internalNote').checked,
          // Client-supplied so a double click cannot post twice. The API backs
          // this with a unique index, not a cache.
          idempotencyKey: 'reply-' + openRefId + '-' + Date.now(),
        },
      });
      document.getElementById('replyBody').value = '';
      show(threadMessage, 'ok', 'Queued for delivery.');
      await openThread(openRefId);
    } catch (error) {
      // The window can close between opening the thread and pressing send, so
      // this is a normal outcome rather than a fault: explain it and keep what
      // they typed.
      if (error.code === 'MESSAGING_WINDOW_CLOSED') {
        show(threadMessage, 'info', error.message);
        if (openConversation) openConversation.canReply = false;
        document.getElementById('internalNote').checked = true;
        document.getElementById('internalNote').disabled = true;
      } else {
        handle(error, threadMessage);
      }
    } finally {
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Live updates
   *
   * fetch + ReadableStream rather than EventSource, because EventSource
   * cannot set an Authorization header — the alternatives are a token in
   * the query string, which lands in access logs, or a one-time ticket
   * endpoint. Streaming by hand costs a few lines and avoids both.
   *
   * The stream is an OPTIMISATION. A slow poll runs regardless, so a
   * dropped connection, a hostile proxy or an old browser costs latency
   * and nothing else.
   * ------------------------------------------------------------------ */
  const POLL_MS = 30000;
  const STREAM_RETRY_BASE_MS = 2000;
  const STREAM_RETRY_MAX_MS = 60000;

  let streamAbort = null;
  let streamAttempt = 0;
  let pollTimer = null;

  function onInboxChanged(change) {
    // Refresh the list, and the open thread when it is the one that moved.
    load(true);
    if (openRefId && change && change.conversationRefId === openRefId) {
      openThread(openRefId);
    }
  }

  /** Parses the SSE frames out of a byte stream. */
  async function consume(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Frames are separated by a blank line; anything after the last one is
      // a partial frame and stays in the buffer.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      frames.forEach(function (frame) {
        let event = 'message';
        let data = '';
        frame.split('\n').forEach(function (line) {
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          // A line starting with ':' is a heartbeat comment: ignored, but it
          // kept the connection open, which was its whole job.
        });

        if (event !== 'inbox' || !data) return;
        try {
          onInboxChanged(JSON.parse(data));
        } catch (_) { /* a malformed frame is not worth tearing the stream down */ }
      });
    }
  }

  async function openStream() {
    const session = window.api.readSession();
    if (!session || !session.accessToken) return;

    streamAbort = new AbortController();
    try {
      const response = await fetch(window.WOUCHH_CONFIG.apiBaseUrl + '/conversations/stream', {
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + session.accessToken },
        credentials: 'include',
        signal: streamAbort.signal,
      });

      if (!response.ok || !response.body) throw new Error('stream rejected: ' + response.status);

      streamAttempt = 0;
      await consume(response);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }

    // Ended or failed: back off and try again. The poll is still running, so
    // nothing is lost in the meantime.
    streamAttempt += 1;
    const delay = Math.min(STREAM_RETRY_BASE_MS * 2 ** (streamAttempt - 1), STREAM_RETRY_MAX_MS);
    setTimeout(function () {
      if (!document.hidden) void openStream();
    }, delay);
  }

  function startLiveUpdates() {
    // The floor: even with no stream at all, the list stays roughly current.
    pollTimer = setInterval(function () {
      if (!document.hidden) load(true);
    }, POLL_MS);

    void openStream();

    // A backgrounded tab is not worth a connection; reopening on return also
    // catches anything missed while it was hidden.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (streamAbort) streamAbort.abort();
        return;
      }
      load(true);
      void openStream();
    });

    window.addEventListener('beforeunload', function () {
      if (pollTimer) clearInterval(pollTimer);
      if (streamAbort) streamAbort.abort();
    });
  }

  async function start() {
    try {
      const me = (await window.api.request('/auth/me')).data;
      permissions = me.permissions || [];
      document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : '';
    } catch (error) {
      handle(error, listMessage);
      return;
    }

    if (permissions.indexOf('conversations.view') === -1) {
      show(
        listMessage,
        'error',
        'You do not have access to the inbox. It needs the unified inbox feature and a role that ' +
          'grants conversations.view.',
      );
      return;
    }

    document.getElementById('statusFilter').addEventListener('change', function () { load(true); });
    document.getElementById('mineOnly').addEventListener('change', function () { load(true); });
    loadMore.addEventListener('click', function () { load(false); });
    document.getElementById('sendReply').addEventListener('click', sendReply);

    load(true);
    startLiveUpdates();
  }

  start();
})();
