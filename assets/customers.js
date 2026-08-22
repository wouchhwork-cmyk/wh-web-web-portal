(function () {
  if (!window.api.requireSession()) return;

  const rows = document.getElementById('rows');
  const listMessage = document.getElementById('listMessage');
  const loadMore = document.getElementById('loadMore');
  const search = document.getElementById('search');

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
    if (!value) return 'never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString();
  }

  function rowFor(customer) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const name = document.createElement('strong');
    /*
     * A blank name is normal, not a bug: a direct message carries only a
     * platform user id, so a customer first seen that way has no name until they
     * comment, where the handle is included.
     */
    name.textContent = customer.displayName || 'Unnamed customer';
    left.appendChild(name);
    left.appendChild(document.createElement('br'));

    const meta = document.createElement('small');
    meta.className = 'hint';
    meta.textContent =
      (customer.firstSource ? 'first seen via ' + customer.firstSource.replace(/_/g, ' ') : 'source unknown') +
      ' · last seen ' + when(customer.lastSeenAt);
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(
      pill(
        customer.conversationCount + ' conversation' + (customer.conversationCount === 1 ? '' : 's'),
        customer.conversationCount > 0 ? 'active' : 'none',
      ),
    );
    if (customer.isBlocked) right.appendChild(pill('blocked', 'suspended'));
    row.appendChild(right);
    return row;
  }

  async function load(reset) {
    if (reset) {
      rows.innerHTML = '';
      cursor = null;
    }

    const query = ['limit=25'];
    const term = search.value.trim();
    if (term) query.push('search=' + encodeURIComponent(term));
    if (cursor) query.push('cursor=' + encodeURIComponent(cursor));

    try {
      const result = await window.api.request('/customers?' + query.join('&'));
      const items = result.data || [];
      const pagination = (result.meta && result.meta.pagination) || {};

      if (items.length === 0 && rows.children.length === 0) {
        show(
          listMessage,
          'info',
          term
            ? 'Nobody matches that name.'
            : 'No customers yet. They appear the first time somebody messages or comments.',
        );
      } else {
        listMessage.innerHTML = '';
      }

      items.forEach(function (customer) { rows.appendChild(rowFor(customer)); });
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
      if ((me.permissions || []).indexOf('customers.view') === -1) {
        show(
          listMessage,
          'error',
          'You do not have access to the customer directory. It needs the customer directory ' +
            'feature and a role that grants customers.view.',
        );
        return;
      }
    } catch (error) {
      handle(error, listMessage);
      return;
    }

    document.getElementById('searchGo').addEventListener('click', function () { load(true); });
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') load(true);
    });
    loadMore.addEventListener('click', function () { load(false); });
    load(true);
  }

  start();
})();
