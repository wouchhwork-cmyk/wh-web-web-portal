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

  /**
   * Sets, or clears, the name this business gives somebody.
   *
   * An empty answer is sent as null rather than skipped: "" and "leave it
   * alone" are different instructions, and only the first hands the customer
   * back to the platform. Cancelling sends nothing at all.
   */
  async function renameCustomer(customer) {
    const current = customer.displayName || '';
    const next = window.prompt(
      'What should this business call them?\n\n' +
        'Leave it empty to go back to the name ' +
        (customer.handle ? 'the platform gives them (@' + customer.handle + ')' : 'the platform gives them') +
        '.',
      current,
    );
    if (next === null) return;

    try {
      await window.api.request('/customers/' + encodeURIComponent(customer.refId), {
        method: 'PATCH',
        body: { displayName: next.trim() === '' ? null : next.trim() },
      });
      load(true);
    } catch (error) {
      handle(error, listMessage);
    }
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
     * platform user id, so a customer first seen that way has no name until the
     * thread's participants are read.
     */
    name.textContent = customer.displayName || 'Unnamed customer';
    left.appendChild(name);

    /*
     * The handle is shown only when it ADDS something. For an Instagram customer
     * the display name usually IS the handle, and printing
     * "testrestaurant_sd @testrestaurant_sd" is noise.
     */
    if (customer.handle && customer.handle !== customer.displayName) {
      const handle = document.createElement('span');
      handle.className = 'hint';
      handle.style.marginLeft = '8px';
      handle.textContent = '@' + customer.handle;
      left.appendChild(handle);
    }

    left.appendChild(document.createElement('br'));

    const meta = document.createElement('small');
    meta.className = 'hint';
    // The split name is shown only when it tells you something the display name
    // does not — a handle has no first name, and saying so would be noise.
    const parts = [];
    if (customer.firstName) {
      parts.push([customer.firstName, customer.lastName].filter(Boolean).join(' '));
    }
    parts.push(
      customer.firstSource
        ? 'first seen via ' + customer.firstSource.replace(/_/g, ' ')
        : 'source unknown',
    );
    parts.push('last seen ' + when(customer.lastSeenAt));
    meta.textContent = parts.join(' · ');
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');

    /*
     * THE NAME THIS BUSINESS GIVES THEM, which outranks the platform's.
     *
     * A customer's name resolves ours first and the platform's second, and
     * until this button existed nothing could write ours — so the fallback
     * was the whole of the answer. Clearing the box hands them back to
     * whatever Instagram calls them, which is what somebody who typed a name
     * by mistake actually wants.
     */
    const rename = document.createElement('button');
    rename.className = 'secondary';
    rename.textContent = 'Rename';
    rename.style.marginRight = '8px';
    rename.addEventListener('click', function () {
      renameCustomer(customer);
    });
    right.appendChild(rename);

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
