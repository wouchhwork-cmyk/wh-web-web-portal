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

  /**
   * Everything held about one customer, with where each fact came from.
   *
   * THE POINT IS THE PROVENANCE, not the values. A name and a phone number
   * are easy to show; what nobody could see until now is whether the name
   * was typed by a colleague or copied off Instagram, and whether the
   * number was confirmed by somebody or taken from a sentence a customer
   * typed into a chat. Those are the same strings and not the same facts,
   * and the assistant can now write the second kind — so the difference
   * had to become visible before it could be trusted.
   */
  async function showCustomer(customer) {
    const dialog = document.getElementById('customerDialog');
    const title = document.getElementById('customerTitle');
    const body = document.getElementById('customerBody');

    title.textContent = customer.displayName || customer.handle || 'Customer';
    body.textContent = 'Reading…';
    if (!dialog.open) dialog.showModal();

    try {
      const result = await window.api.request(
        '/customers/' + encodeURIComponent(customer.refId),
        { method: 'GET' },
      );
      const detail = result.data;
      body.textContent = '';

      const names = detail.names || {};
      body.appendChild(
        section('Names', [
          ['this business records', full(names.business)],
          ['their platform profile', full(names.platform)],
          ['answered in', detail.preferredLanguage],
        ]),
      );

      const signals = detail.platformSignals || {};
      body.appendChild(
        section('On the platform', [
          ['follows this business', yesNo(signals.followsUs)],
          ['this business follows them', yesNo(signals.weFollowThem)],
          ['verified account', yesNo(signals.isVerified)],
          ['followers', signals.followerCount],
          ['profile last read', signals.fetchedAt ? when(signals.fetchedAt) : null],
        ]),
      );

      body.appendChild(
        section('History', [
          ['conversations', detail.conversationCount],
          ['first seen', detail.firstSeenAt ? when(detail.firstSeenAt) : null],
          ['last seen', detail.lastSeenAt ? when(detail.lastSeenAt) : null],
          ['first reached us by', (detail.firstSource || '').replace(/_/g, ' ')],
        ]),
      );

      body.appendChild(identifiers(detail.identifiers || []));
      body.appendChild(contactEditor(customer, detail.identifiers || []));
    } catch (error) {
      body.textContent = (error && error.message) || 'That record could not be read.';
    }
  }

  /** A titled block of label/value rows, skipping anything we do not hold. */
  function section(heading, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-section';

    const head = document.createElement('h4');
    head.textContent = heading;
    wrap.appendChild(head);

    let shown = 0;
    rows.forEach(function (entry) {
      const value = entry[1];
      if (value === null || value === undefined || value === '') return;
      shown += 1;

      const line = document.createElement('div');
      line.className = 'detail-row';

      const label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = entry[0];
      line.appendChild(label);

      const text = document.createElement('span');
      text.textContent = String(value);
      line.appendChild(text);
      wrap.appendChild(line);
    });

    if (shown === 0) {
      const none = document.createElement('div');
      none.className = 'hint';
      /* Said rather than left blank: "we hold none of this" is an answer,
       * and an empty block is a page that looks broken. */
      none.textContent = 'nothing recorded';
      wrap.appendChild(none);
    }
    return wrap;
  }

  /**
   * Every way they are known, with who says so.
   *
   * THE VERIFIED FLAG IS THE WHOLE POINT. A number a colleague confirmed
   * and one the assistant took from a sentence in a chat are the same
   * digits, and only one of them is something to act on.
   */
  function identifiers(rows) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-section';

    const head = document.createElement('h4');
    head.textContent = 'How they are known';
    wrap.appendChild(head);

    if (rows.length === 0) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = 'nothing recorded';
      wrap.appendChild(none);
      return wrap;
    }

    rows.forEach(function (row) {
      const line = document.createElement('div');
      line.className = 'detail-row';

      const label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = (row.kind || '').replace(/_/g, ' ');
      line.appendChild(label);

      const value = document.createElement('span');
      value.textContent = row.value;
      line.appendChild(value);

      line.appendChild(
        pill(
          row.verified ? 'verified' : row.verificationStatus || 'unverified',
          row.verified ? 'active' : 'none',
        ),
      );

      /* Where it came from, because "they told us" and "we saw it on the
       * platform" are different kinds of evidence for the same string. */
      const src = document.createElement('small');
      src.className = 'hint';
      src.style.marginLeft = '8px';
      src.textContent = (row.source || '').replace(/_/g, ' ');
      line.appendChild(src);

      wrap.appendChild(line);
    });
    return wrap;
  }

  /**
   * Which identifier kinds a person may type in.
   *
   * THREE, NOT EVERY KIND. The others are platform scoped ids and handles —
   * how a conversation is addressed, not a detail anybody types — and a form
   * that could rewrite one could re-point a thread at the wrong person.
   */
  const CONTACT_KINDS = [
    { value: 'mobile', label: 'Mobile' },
    { value: 'whatsapp_number', label: 'WhatsApp' },
    { value: 'email', label: 'Email' },
  ];

  const CONTACT_KIND_VALUES = CONTACT_KINDS.map(function (kind) {
    return kind.value;
  });

  /**
   * Adding, correcting and removing the ways to reach somebody.
   *
   * SEPARATE FROM THE LIST ABOVE, which shows every identifier including the
   * platform ones and is a record of what is known. This is the part a
   * colleague can change, and keeping them apart means the read-only half
   * cannot be mistaken for something editable.
   *
   * THE SERVER CLEANS, NOT THIS. A number typed here goes up as typed and
   * comes back in full international form, because the one place that knows
   * what a phone number is must be the same one the assistant uses — two
   * opinions about it is how the same person becomes two records.
   */
  function contactEditor(customer, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-section';

    const head = document.createElement('h4');
    head.textContent = 'Phone and email';
    wrap.appendChild(head);

    const message = document.createElement('div');
    message.className = 'hint';
    wrap.appendChild(message);

    const contacts = rows.filter(function (row) {
      return CONTACT_KIND_VALUES.indexOf(row.kind) !== -1;
    });

    if (contacts.length === 0) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = 'no phone number or email address on this record yet';
      wrap.appendChild(none);
    }

    contacts.forEach(function (row) {
      wrap.appendChild(contactRow(customer, row, message));
    });

    wrap.appendChild(contactForm(customer, message));
    return wrap;
  }

  /** One existing contact, with the two things that can be done to it. */
  function contactRow(customer, row, message) {
    const line = document.createElement('div');
    line.className = 'detail-row';

    const label = document.createElement('span');
    label.className = 'detail-label';
    label.textContent = (row.kind || '').replace(/_/g, ' ');
    line.appendChild(label);

    const value = document.createElement('span');
    value.textContent = row.value;
    line.appendChild(value);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'linklike';
    edit.style.marginLeft = '8px';
    edit.textContent = 'edit';
    edit.addEventListener('click', function () {
      /*
       * REPLACES RATHER THAN ADDS. The old value goes up with the new one so
       * the server releases it in the same call — a correction that added
       * without removing would leave a record carrying a number already
       * known to be wrong.
       */
      const next = window.prompt('Change this ' + row.kind.replace(/_/g, ' ') + ':', row.value);
      if (next === null || next.trim() === '' || next.trim() === row.value) return;
      saveContact(customer, { kind: row.kind, value: next.trim(), replaces: row.value }, message);
    });
    line.appendChild(edit);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'linklike';
    remove.style.marginLeft = '8px';
    remove.textContent = 'remove';
    remove.addEventListener('click', function () {
      if (!window.confirm('Take ' + row.value + ' off this record?')) return;
      sendContact(
        customer,
        '/contacts/remove',
        { kind: row.kind, value: row.value },
        message,
      );
    });
    line.appendChild(remove);

    return line;
  }

  /**
   * The add form.
   *
   * NO COUNTRY FIELD UNTIL ONE IS NEEDED. The business states its own
   * country, and that settles what a bare number is without anybody being
   * asked — which is the ordinary case and should cost nothing. The field
   * appears only when the server says it genuinely cannot tell, which is
   * also the only time an answer would mean anything.
   */
  function contactForm(customer, message) {
    const form = document.createElement('div');
    form.className = 'detail-row';
    form.style.marginTop = '10px';

    const kind = document.createElement('select');
    CONTACT_KINDS.forEach(function (option) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      kind.appendChild(node);
    });
    form.appendChild(kind);

    const value = document.createElement('input');
    value.type = 'text';
    value.placeholder = 'number or email address';
    value.style.marginLeft = '8px';
    form.appendChild(value);

    const country = document.createElement('input');
    country.type = 'text';
    country.maxLength = 2;
    country.placeholder = 'country';
    country.title = 'Two-letter country code, e.g. IN or GB';
    country.style.marginLeft = '8px';
    country.style.width = '70px';
    country.hidden = true;
    form.appendChild(country);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'secondary';
    add.style.marginLeft = '8px';
    add.textContent = 'Add';
    add.addEventListener('click', function () {
      const typed = value.value.trim();
      if (!typed) return;
      const body = { kind: kind.value, value: typed };
      if (!country.hidden && country.value.trim()) body.country = country.value.trim();
      saveContact(customer, body, message, country);
    });
    form.appendChild(add);

    return form;
  }

  function saveContact(customer, body, message, countryField) {
    sendContact(customer, '/contacts', body, message, countryField);
  }

  /**
   * One write, and a refresh so the dialog shows what is actually stored.
   *
   * RE-READ RATHER THAN PATCHED IN PLACE. What comes back from the server is
   * cleaned — "8888 8888 88" becomes "+918888888888" — and a list updated
   * from what was typed would show a value that is not the one on the
   * record.
   */
  async function sendContact(customer, path, body, message, countryField) {
    message.className = 'hint';
    message.textContent = 'Saving…';

    try {
      await window.api.request(
        '/customers/' + encodeURIComponent(customer.refId) + path,
        { method: 'POST', body: body },
      );
      await showCustomer(customer);
    } catch (error) {
      message.className = 'hint prompt-drifted';
      message.textContent = (error && error.message) || 'That could not be saved.';
      /*
       * THE ONE ERROR THAT ASKS FOR SOMETHING. Everything else is "look at
       * it again"; this one is a question with an answer, so the field to
       * answer it with appears.
       */
      if (error && error.code === 'CONTACT_NEEDS_COUNTRY' && countryField) {
        countryField.hidden = false;
        countryField.focus();
      }
    }
  }

  /** A name from its parts, or null when we hold none of them. */
  function full(name) {
    if (!name) return null;
    const joined =
      name.displayName || [name.firstName, name.lastName].filter(Boolean).join(' ');
    return joined || null;
  }

  /** Yes, no, or nothing at all — absent is not the same as false. */
  function yesNo(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return null;
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
    /*
     * WHAT IS ACTUALLY HELD ABOUT THEM, which the row cannot show.
     *
     * A row resolves one name because a list needs one. The record behind
     * it has three — what a colleague typed, what the platform says, and
     * what the assistant recorded from something the customer said — plus
     * every way of reaching them and whether anybody checked it. That is
     * the thing somebody verifying a record came here to read.
     */
    const details = document.createElement('button');
    details.className = 'secondary';
    details.textContent = 'Details';
    details.style.marginRight = '8px';
    details.addEventListener('click', function () {
      showCustomer(customer);
    });
    right.appendChild(details);

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
    /*
     * THE ONE THING ON THIS LIST SOMEBODY HAS TO ACT ON, so it goes first.
     * A flag you have to open thirty records to find is a flag nobody acts
     * on, and at the end of this one there is a customer waiting.
     */
    if (customer.needsHuman) right.appendChild(pill('needs a person', 'warning'));
    /* A pause nobody can see is a pause nobody lifts. */
    if (customer.automationPaused) right.appendChild(pill('assistant paused', 'none'));
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
