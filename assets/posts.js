(function () {
  if (!window.api.requireSession()) return;

  const rows = document.getElementById('rows');
  const listMessage = document.getElementById('listMessage');
  const loadMore = document.getElementById('loadMore');
  const channelFilter = document.getElementById('channelFilter');

  let cursor = null;

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
    if (!value) return 'no publish date';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'no publish date' : date.toLocaleDateString();
  }

  function rowFor(post) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const caption = document.createElement('div');
    // The caption is the business's own text, but set as text regardless.
    const text = post.caption || '(no caption)';
    caption.textContent = text.length > 160 ? text.slice(0, 160) + '…' : text;
    left.appendChild(caption);

    const meta = document.createElement('small');
    meta.className = 'hint';
    meta.textContent =
      post.platform + ' · ' + post.postKind +
      ' · ' + when(post.publishedAt) +
      (post.channelName ? ' · ' + post.channelName : '');
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(pill(post.commentCount + ' comments', post.commentCount > 0 ? 'active' : 'none'));
    if (post.permalinkUrl) {
      const link = document.createElement('a');
      link.href = post.permalinkUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.marginLeft = '8px';
      link.textContent = 'View';
      right.appendChild(link);
    }
    row.appendChild(right);
    return row;
  }

  async function loadChannels() {
    try {
      const result = await window.api.request('/connections/channels');
      (result.data || []).forEach(function (channel) {
        const option = document.createElement('option');
        option.value = channel.refId;
        option.textContent = (channel.name || channel.platform) + ' · ' + channel.platform;
        channelFilter.appendChild(option);
      });
    } catch (_) {
      // The filter is a convenience; the list works without it.
    }
  }

  async function load(reset) {
    if (reset) {
      rows.innerHTML = '';
      cursor = null;
    }

    const query = ['limit=20'];
    if (channelFilter.value) query.push('channelRefId=' + encodeURIComponent(channelFilter.value));
    if (cursor) query.push('cursor=' + encodeURIComponent(cursor));

    try {
      const result = await window.api.request('/posts?' + query.join('&'));
      const items = result.data || [];
      const pagination = (result.meta && result.meta.pagination) || {};

      if (items.length === 0 && rows.children.length === 0) {
        show(listMessage, 'info', 'No posts yet. They arrive when a backfill runs for a connected account.');
      } else {
        listMessage.innerHTML = '';
      }

      items.forEach(function (post) { rows.appendChild(rowFor(post)); });
      cursor = pagination.nextCursor || null;
      loadMore.hidden = !pagination.hasMore;
    } catch (error) {
      handle(error, listMessage);
    }
  }

  async function start() {
    try {
      const me = (await window.api.request('/auth/me')).data;
      document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : '';
      if ((me.permissions || []).indexOf('posts.view') === -1) {
        show(
          listMessage,
          'error',
          'You do not have access to posts. It needs the post insights feature and a role that ' +
            'grants posts.view.',
        );
        return;
      }
    } catch (error) {
      handle(error, listMessage);
      return;
    }

    channelFilter.addEventListener('change', function () { load(true); });
    loadMore.addEventListener('click', function () { load(false); });
    await loadChannels();
    load(true);
  }

  start();
})();
