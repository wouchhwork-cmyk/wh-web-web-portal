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
  /** This agent's own employee ref, so "assign to me" has something to send. */
  let myEmployeeRefId = null;
  /** Colleagues, loaded once and only when this agent may see them. */
  let team = null;
  /** Older messages in the open thread; null once the whole thread is loaded. */
  let threadCursor = null;
  /*
   * Minted per COMPOSED MESSAGE, not per attempt.
   *
   * It used to be `Date.now()` at send time, which meant every retry carried a
   * NEW key — so the mechanism protected against nothing except a double click
   * inside the same millisecond. The key is now issued once for what the agent
   * typed and reused for every attempt at sending it, which is the only shape
   * that makes a retry after a timeout safe.
   */
  let replyKey = null;

  function newReplyKey() {
    const random =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : String(Date.now()) + '-' + String(Math.random()).slice(2);
    return 'reply-' + random;
  }

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
    /*
     * WHO HAS IT. The whole point of a shared inbox: without this, two agents
     * pick up the same conversation and the customer gets two answers.
     */
    if (conversation.assignedTo) {
      const mine = conversation.assignedTo.refId === myEmployeeRefId;
      right.appendChild(
        pill(mine ? 'you' : conversation.assignedTo.name || 'assigned', mine ? 'active' : 'none'),
      );
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

  /*
   * One attachment.
   *
   * The URL is the PLATFORM's CDN link, used directly: Meta's terms forbid
   * storing or caching the media on our side, so there is nothing of ours to
   * serve. A link with `expires` dies with the content — about 24 hours for a
   * story — so a failure to load is expected rather than broken, and says so.
   */
  function attachmentNode(attachment, messageKind) {
    var wrap = document.createElement('div');
    wrap.className = 'attachment';

    if (!attachment.url) {
      wrap.textContent = '(' + (attachment.mediaKind || 'attachment') + ', no link)';
      return wrap;
    }

    var isStory = messageKind === 'story_reply';
    if (isStory) {
      var tag = document.createElement('small');
      tag.className = 'hint';
      tag.textContent = 'mentioned you in their story';
      wrap.appendChild(tag);
    }

    if (attachment.mediaKind === 'video') {
      var video = document.createElement('video');
      video.src = attachment.url;
      video.controls = true;
      video.preload = 'metadata';
      video.style.maxWidth = '260px';
      video.style.borderRadius = '8px';
      video.addEventListener('error', function () {
        wrap.replaceChildren(gone(attachment));
      });
      wrap.appendChild(video);
      return wrap;
    }

    if (attachment.mediaKind === 'audio') {
      var audio = document.createElement('audio');
      audio.src = attachment.url;
      audio.controls = true;
      wrap.appendChild(audio);
      return wrap;
    }

    // image, gif, sticker — and anything unrecognised, which is far more useful
    // rendered as a link than swallowed.
    if (attachment.mediaKind === 'document') {
      var link = document.createElement('a');
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = attachment.platformType || 'attachment';
      wrap.appendChild(link);
      return wrap;
    }

    var image = document.createElement('img');
    image.src = attachment.url;
    image.alt = isStory ? 'story mention' : attachment.mediaKind || 'attachment';
    image.loading = 'lazy';
    image.style.maxWidth = '220px';
    image.style.borderRadius = '8px';
    image.addEventListener('error', function () {
      wrap.replaceChildren(gone(attachment));
    });
    wrap.appendChild(image);
    return wrap;
  }

  /** What to show once a platform link has expired. */
  function gone(attachment) {
    var note = document.createElement('small');
    note.className = 'hint';
    note.textContent = attachment.expires
      ? 'this ' + (attachment.mediaKind || 'attachment') + ' is no longer available on the platform'
      : 'this ' + (attachment.mediaKind || 'attachment') + ' could not be loaded';
    return note;
  }

  function messageRow(message) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const body = document.createElement('div');
    // Customer words: set as text, never as HTML.
    const attachments = message.attachments || [];
    body.textContent = message.body || (attachments.length ? '' : '(no text)');
    left.appendChild(body);

    // Media, where there is any. Before this the thread showed "(no text)" for
    // a photo, a GIF, a video or a story mention — which is every message whose
    // whole content is the attachment.
    attachments.forEach(function (attachment) {
      left.appendChild(attachmentNode(attachment, message.messageKind));
    });
    const meta = document.createElement('small');
    meta.className = 'hint';
    // WHO sent it, where the API knows: a shared inbox needs to show which
    // colleague answered, and the thread used to say only "outbound".
    const parts = [message.direction || message.messageKind || ''];
    if (message.sentBy) parts.push(message.sentBy.name || 'a colleague');
    if (message.isInternalNote) parts.push('internal note');
    parts.push(when(message.platformSentAt || message.createdAt));
    meta.textContent = parts.filter(Boolean).join(' · ');
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    if (message.status) right.appendChild(pill(message.status, message.status));
    row.appendChild(right);
    return row;
  }


  /* ------------------------------------------------------------------ *
   * Assignment and status
   *
   * Both endpoints existed from the first commit and nothing ever called
   * them, so every conversation was open and unassigned forever.
   *
   * "Assign to me" needs no employee list, so it works for an agent who
   * cannot see the team. The picker appears only when this agent holds
   * employees.view — otherwise handing work to a NAMED colleague would
   * require a list they are not allowed to read.
   * ------------------------------------------------------------------ */

  async function loadTeam() {
    if (team !== null) return team;
    if (permissions.indexOf('employees.view') === -1) {
      team = [];
      return team;
    }
    try {
      // No query: the schema is strict, and an unknown parameter is a 400.
      const result = await window.api.request('/employees');
      team = (result.data || []).filter(function (person) {
        // Only somebody who can actually pick the work up.
        return person.status === 'active';
      });
    } catch (_) {
      // Not fatal: assign-to-me still works, which is the common case anyway.
      team = [];
    }
    return team;
  }

  function renderThreadControls(conversation) {
    const controls = document.getElementById('threadControls');
    const assignedLabel = document.getElementById('assignedTo');
    const assignWrap = document.getElementById('assignControls');
    const statusWrap = document.getElementById('statusControls');
    const picker = document.getElementById('assignPicker');
    const assignMe = document.getElementById('assignMe');
    const unassign = document.getElementById('unassign');
    const statusPicker = document.getElementById('statusPicker');

    const canAssign = permissions.indexOf('conversations.assign') !== -1;
    const canManage = permissions.indexOf('conversations.manage') !== -1;

    controls.hidden = !canAssign && !canManage;
    assignWrap.hidden = !canAssign;
    statusWrap.hidden = !canManage;

    /*
     * Only a message thread can be re-read from the platform, so the button is
     * hidden rather than shown and then refused: the API answers 422 for a
     * comment thread, and a control that only ever errors is worse than none.
     */
    const resyncWrap = document.getElementById('resyncControls');
    const kind = conversation.conversationKind;
    resyncWrap.hidden = !canManage || (kind !== 'direct_message' && kind !== 'story_reply');
    document.getElementById('resyncNote').textContent = '';

    const holder = conversation.assignedTo;
    const mine = holder && holder.refId === myEmployeeRefId;
    assignedLabel.textContent = holder
      ? mine
        ? 'Assigned to you'
        : 'Assigned to ' + (holder.name || 'a colleague')
      : 'Unassigned';

    assignMe.hidden = Boolean(mine) || !myEmployeeRefId;
    unassign.hidden = !holder;
    statusPicker.value = conversation.status || 'open';

    if (canAssign) {
      void loadTeam().then(function (people) {
        if (people.length === 0) {
          picker.hidden = true;
          return;
        }
        picker.hidden = false;
        picker.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'Assign to…';
        picker.appendChild(none);
        people.forEach(function (person) {
          const option = document.createElement('option');
          option.value = person.refId;
          // The employees list returns a single joined `name`, not parts.
          option.textContent = person.name || 'Unnamed colleague';
          picker.appendChild(option);
        });
        picker.value = holder ? holder.refId : '';
      });
    }
  }

  async function setAssignee(employeeRefId) {
    if (!openRefId) return;
    try {
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + '/assign', {
        method: 'POST',
        body: { employeeRefId: employeeRefId },
      });
      // Re-read rather than patching local state: the API is the authority on
      // who holds it, and a colleague may have taken it in the meantime.
      await openThread(openRefId);
      await load(true);
    } catch (error) {
      handle(error, threadMessage);
    }
  }

  async function setStatus(status) {
    if (!openRefId) return;
    try {
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + '/status', {
        method: 'POST',
        body: { status: status },
      });
      await openThread(openRefId);
      await load(true);
    } catch (error) {
      handle(error, threadMessage);
    }
  }

  async function openThread(refId, appendOlder) {
    const older = Boolean(appendOlder);
    openRefId = refId;
    threadPanel.hidden = false;
    threadMessage.innerHTML = '';
    if (!older) {
      threadCursor = null;
      messages.innerHTML = '<p class="hint">Loading…</p>';
    }

    try {
      // A long thread arrives one page at a time. Before this the endpoint had no
      // pagination surface at all, so a conversation simply stopped at the
      // newest fifty messages with nothing to say there were more.
      const query = older && threadCursor ? '?cursor=' + encodeURIComponent(threadCursor) : '';
      const result = await window.api.request(
        '/conversations/' + encodeURIComponent(refId) + query,
      );
      const data = result.data || {};
      const conversation = data.conversation || {};
      // In meta, like every other list on this API.
      const pagination = (result.meta && result.meta.pagination) || {};

      const person = conversation.customer;
      threadTitle.textContent =
        (person && person.displayName) ||
        (conversation.conversationKind || 'Conversation').replace(/_/g, ' ');
      threadMeta.textContent =
        (conversation.conversationKind || '').replace(/_/g, ' ') +
        ' · ' + (conversation.platform || '') +
        ' · ' + (conversation.status || '') +
        ' · ' + (conversation.messageCount || 0) + ' messages';

      if (!older) messages.innerHTML = '';
      const list = data.messages || [];
      if (list.length === 0 && !older) {
        messages.appendChild(Object.assign(document.createElement('p'), {
          className: 'hint',
          textContent: 'No messages in this thread.',
        }));
      }
      list.forEach(function (message) { messages.appendChild(messageRow(message)); });

      threadCursor = pagination.nextCursor || null;
      document.getElementById('loadOlder').hidden = !pagination.hasMore;

      openConversation = conversation;
      renderThreadControls(conversation);

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

    // Minted here, once, and kept until this message is actually accepted.
    if (!replyKey) replyKey = newReplyKey();

    const button = document.getElementById('sendReply');
    button.disabled = true;
    try {
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + '/reply', {
        method: 'POST',
        body: {
          body: body,
          internalNote: document.getElementById('internalNote').checked,
          // The SAME key for every attempt at this message, so a retry after a
          // timeout returns the original rather than sending a second copy.
          idempotencyKey: replyKey,
        },
      });
      document.getElementById('replyBody').value = '';
      // Delivered, so the next thing typed is a different message and gets its
      // own key. Only ever reset on SUCCESS.
      replyKey = null;
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
    // Refresh the list, and the open thread when it is the one that moved. An
    // 'assigned' or 'status' event is exactly the case worth reacting to: it is
    // a COLLEAGUE's action, and seeing it late is how two people answer the
    // same customer.
    load(true);
    if (openRefId && change && change.conversationRefId === openRefId) {
      void openThread(openRefId);
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

        /*
         * The server CAPS a stream's lifetime, because an open stream is an
         * authorisation with no expiry otherwise. It says so before closing, and
         * reconnecting immediately keeps that invisible instead of waiting out
         * the reconnect backoff for something that is not a failure.
         */
        if (event === 'expired') {
          streamAttempt = 0;
          return;
        }

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
      // Needed to offer "assign to me" and to render "assigned to you": the API
      // speaks in refIds, so a client has to know its own.
      myEmployeeRefId = me.employeeRefId || null;
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

    document.getElementById('resync').addEventListener('click', function () {
      var button = this;
      var note = document.getElementById('resyncNote');
      if (!openRefId) return;
      button.disabled = true;
      note.textContent = 'asking Instagram…';

      window.api
        .request('/conversations/' + encodeURIComponent(openRefId) + '/resync', {
          method: 'POST',
        })
        .then(function (result) {
          /*
           * queued:false is a success, not a failure: a repair for this thread
           * is already running and a second would do the same work twice.
           */
          note.textContent = (result.data || {}).queued
            ? 'checking — new messages appear here as they arrive'
            : 'already checking';
        })
        .catch(function (error) {
          note.textContent = 'could not start: ' + (error.message || 'unknown error');
        })
        .finally(function () {
          button.disabled = false;
        });
    });

    document.getElementById('assignMe').addEventListener('click', function () {
      void setAssignee(myEmployeeRefId);
    });
    document.getElementById('unassign').addEventListener('click', function () {
      void setAssignee(null);
    });
    document.getElementById('assignPicker').addEventListener('change', function (event) {
      const value = event.target.value;
      void setAssignee(value || null);
    });
    document.getElementById('statusPicker').addEventListener('change', function (event) {
      void setStatus(event.target.value);
    });
    document.getElementById('loadOlder').addEventListener('click', function () {
      void openThread(openRefId, true);
    });

    load(true);
    startLiveUpdates();
  }

  start();
})();
