(function () {
  if (!window.api.requireSession()) return;

  const el = (id) => document.getElementById(id);
  const message = el('settingsMessage');

  let permissions = [];

  function show(target, kind, text, code) {
    target.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'message ' + kind;
    box.textContent = text;
    if (code) {
      const small = document.createElement('span');
      small.className = 'muted';
      small.textContent = ' (' + code + ')';
      box.appendChild(small);
    }
    target.appendChild(box);
  }

  function handle(error, target) {
    if (error.code === 'AUTH_TOKEN_INVALID' || error.code === 'AUTH_SESSION_REVOKED') {
      window.api.clearSession();
      window.location.href = 'index.html';
      return;
    }
    show(target, 'error', error.message, error.code);
  }

  /**
   * Fills a select from the server's own list.
   *
   * THE OPTIONS COME FROM THE API, never from a list hardcoded here. The set
   * somebody can choose is then literally the set the server validates
   * against, so the two cannot drift — and the first time the runtime's
   * timezone database updates, this picks it up with no change to the portal.
   */
  function fill(select, values, selected, emptyLabel) {
    select.innerHTML = '';
    if (emptyLabel) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = emptyLabel;
      select.appendChild(none);
    }
    values.forEach(function (value) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      if (value === selected) option.selected = true;
      select.appendChild(option);
    });
    if (!selected && emptyLabel) select.value = '';
  }


  /* ---------------------------------------------------------------- *
   * The public profile: what customers see.
   *
   * Links and contacts are LISTS THE BUSINESS GROWS, with the same +/−
   * shape the reward form uses, for the same reason — the number of rows is
   * the business's answer, not ours.
   *
   * NOTHING HERE IS THE VALIDATOR. The server parses every URL with the same
   * parser the browser uses, refuses a label that is really an address, and
   * insists a phone number carries its country code. What these do is tell
   * somebody BEFORE they press Save, so a refusal is not the first time they
   * hear about it. Where the two could drift, the server wins: the checks
   * below are deliberately the same rules, written once more in the place
   * that can show them immediately.
   * ---------------------------------------------------------------- */

  /** A row of fields plus the minus that removes it. */
  function pairRow(className, fields, onRemove) {
    const row = document.createElement('div');
    row.className = 'pair-row ' + className;
    fields.forEach(function (field) {
      row.appendChild(field);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary pair-remove';
    remove.textContent = '−';
    remove.title = 'Remove this row';
    remove.addEventListener('click', function () {
      row.remove();
      onRemove();
    });
    row.appendChild(remove);
    return row;
  }

  function field(cls, labelText, control, note) {
    const box = document.createElement('div');
    box.className = cls;
    const label = document.createElement('label');
    label.textContent = labelText;
    box.appendChild(label);
    box.appendChild(control);
    if (note) {
      const hint = document.createElement('span');
      hint.className = 'field-note';
      hint.textContent = note;
      box.appendChild(hint);
    }
    return box;
  }

  function textInput(cls, placeholder, maxLength, list) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = cls;
    input.placeholder = placeholder;
    if (maxLength) input.maxLength = maxLength;
    /* The suggestions are a datalist, not a select: the server accepts any
     * name, so the control must too. A select would make ten suggestions
     * look like the only ten answers. */
    if (list) input.setAttribute('list', list);
    return input;
  }

  function linkRow(link) {
    const label = textInput('linkLabel', 'Order online', 40, 'linkLabelOptions');
    const url = textInput('linkUrl', 'https://example.com/order', 2048);
    label.value = (link && link.label) || '';
    url.value = (link && link.url) || '';
    return pairRow(
      'link-row',
      [
        field('pair-label', 'Name', label, 'What the customer reads'),
        field('pair-value', 'Address', url, 'Starts with https://'),
      ],
      syncLinks,
    );
  }

  function contactRow(contact) {
    const label = textInput('contactLabel', 'India', 40);
    const phone = textInput('contactPhone', '+91 98765 43210', 32);
    const email = textInput('contactEmail', 'orders@example.com', 254);
    label.value = (contact && contact.label) || '';
    phone.value = (contact && contact.phone) || '';
    email.value = (contact && contact.email) || '';
    return pairRow(
      'contact-row',
      [
        field('pair-label', 'Which one', label, 'Optional — a region or a team'),
        field('pair-value', 'Phone', phone, 'With country code'),
        field('pair-value', 'Email', email, ''),
      ],
      syncContacts,
    );
  }

  /** Says so when a list is empty, instead of showing nothing at all. */
  function syncEmptyNote(host, text) {
    const existing = host.querySelector('.pair-empty');
    if (host.querySelectorAll('.pair-row').length > 0) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const note = document.createElement('p');
    note.className = 'hint pair-empty';
    note.textContent = text;
    host.appendChild(note);
  }

  function syncLinks() {
    syncEmptyNote(el('linkRows'), 'No links yet. Add one with +.');
  }

  function syncContacts() {
    syncEmptyNote(el('contactRows'), 'No contact details yet. Add one with +.');
  }

  /**
   * Reads the rows back, dropping ones nobody filled in.
   *
   * AN UNTOUCHED ROW IS NOT AN ERROR. Pressing + and then changing your mind
   * leaves a blank row on screen; sending it would be refused by the server
   * for saying nothing, which is a confusing way to be told "you left a row
   * empty". Dropped silently here, because an empty row carries no intent.
   */
  function readLinks() {
    const rows = Array.prototype.slice.call(document.querySelectorAll('.link-row'));
    return rows
      .map(function (row) {
        return {
          label: row.querySelector('.linkLabel').value.trim(),
          url: row.querySelector('.linkUrl').value.trim(),
        };
      })
      .filter(function (link) {
        return link.label !== '' || link.url !== '';
      });
  }

  function readContacts() {
    const rows = Array.prototype.slice.call(document.querySelectorAll('.contact-row'));
    return rows
      .map(function (row) {
        return {
          label: row.querySelector('.contactLabel').value.trim(),
          phone: row.querySelector('.contactPhone').value.trim(),
          email: row.querySelector('.contactEmail').value.trim(),
        };
      })
      .filter(function (contact) {
        return contact.label !== '' || contact.phone !== '' || contact.email !== '';
      })
      .map(function (contact) {
        /* `null`, not `""`: the server reads empty as "not given", and an
         * empty string would be an address that is not an address. */
        return {
          label: contact.label || null,
          phone: contact.phone || null,
          email: contact.email || null,
        };
      });
  }

  /**
   * The same refusals the server makes, said before Save rather than after.
   *
   * Returns a sentence, or null when there is nothing to say.
   */
  function whatIsWrong(links, contacts) {
    const seen = {};
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (link.label === '') return 'Every link needs a name — the words a customer reads.';
      if (link.url === '') return 'Every link needs an address.';
      if (link.label.indexOf('://') !== -1 || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(link.label)) {
        return (
          'The name for "' + link.label + '" looks like a web address. ' +
          'The name is what customers read; put the address in the next field.'
        );
      }
      const key = link.label.replace(/\s+/g, ' ').toLowerCase();
      if (seen[key]) return 'Two links are both called "' + link.label + '".';
      seen[key] = true;

      /* Parsed, not pattern-matched — the same test the server makes, using
       * the browser's own parser. A regex would accept things the server
       * then refuses, which is worse than not checking at all. */
      let parsed = null;
      try {
        parsed = new URL(link.url);
      } catch (error) {
        return '"' + link.url + '" is not a full web address. It should start with https://.';
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return 'Only https:// and http:// links can be shared with customers.';
      }
      if (parsed.username !== '' || parsed.password !== '') {
        return 'Remove the username and password from "' + link.url + '" before sharing it.';
      }
    }

    for (let j = 0; j < contacts.length; j += 1) {
      const contact = contacts[j];
      if (!contact.phone && !contact.email) {
        return 'Every contact needs a phone number or an email address.';
      }
      if (contact.phone && !/^\+[1-9]\d{7,14}$/.test(contact.phone.replace(/[\s()./-]/g, ''))) {
        return (
          '"' + contact.phone + '" needs its country code, like +91 98765 43210 — ' +
          'the person reading it cannot guess the country.'
        );
      }
    }
    return null;
  }

  async function load() {
    try {
      const me = await window.api.request('/auth/me');
      const identity = (me.data && me.data) || {};
      permissions = identity.permissions || [];
      el('who').textContent = (identity.enterprise && identity.enterprise.name) || '';

      const [options, current] = await Promise.all([
        window.api.request('/enterprises/settings/options'),
        window.api.request('/enterprises/current'),
      ]);

      const business = current.data || {};
      /*
       * "Not set" is an option for the timezone too, and deliberately.
       * It used to default to Asia/Kolkata at signup, so a business in London
       * had one it never picked — correct-looking and wrong. An empty row
       * would read as a loading bug; the words say it is a state.
       */
      fill(el('timezone'), options.data.timezones, business.timezone, 'Not set');
      /*
       * The currency CAN be empty, and the option says so in words. A blank
       * row would read as a loading bug; "Not set" is a choice somebody made.
       */
      fill(el('currencyCode'), options.data.currencies, business.currencyCode, 'Not set');

      /*
       * The suggested names, from the server, for the same reason the
       * timezone list comes from there: one copy. A datalist rather than a
       * select, because the server accepts any name and the control must not
       * imply otherwise.
       */
      const suggestions = el('linkLabelOptions');
      suggestions.innerHTML = '';
      (options.data.linkLabels || []).forEach(function (label) {
        const option = document.createElement('option');
        option.value = label;
        suggestions.appendChild(option);
      });

      el('displayName').value = business.displayName || '';
      el('about').value = business.about || '';
      el('aboutCount').textContent = String((business.about || '').length);

      el('linkRows').innerHTML = '';
      (business.links || []).forEach(function (link) {
        el('linkRows').appendChild(linkRow(link));
      });
      syncLinks();

      el('contactRows').innerHTML = '';
      (business.contacts || []).forEach(function (contact) {
        el('contactRows').appendChild(contactRow(contact));
      });
      syncContacts();

      /* Read-only without the permission: the server refuses anyway, and a
       * save button that always 403s is a lie told twice. */
      const mayManage = permissions.indexOf('enterprise.manage') !== -1;
      el('save').hidden = !mayManage;
      el('timezone').disabled = !mayManage;
      el('currencyCode').disabled = !mayManage;

      el('addLink').hidden = !mayManage;
      el('addContact').hidden = !mayManage;
      el('displayName').disabled = !mayManage;
      el('about').disabled = !mayManage;
      if (!mayManage) {
        /* The rows are rendered so they can be READ — disabling the inputs is
         * what stops them being edited, and hiding the minus stops a row
         * disappearing from a screen nobody can save. */
        Array.prototype.forEach.call(document.querySelectorAll('.pair-row input'), function (i) {
          i.disabled = true;
        });
        Array.prototype.forEach.call(document.querySelectorAll('.pair-remove'), function (b) {
          b.hidden = true;
        });
        show(message, 'info', 'You can see these settings but not change them.');
      }
    } catch (error) {
      handle(error, message);
    }
  }

  /**
   * Saves the page — all of it, in one request.
   *
   * ONE REQUEST BECAUSE IT IS ONE ENDPOINT. `PATCH /enterprises/current`
   * takes every field on this page; splitting it across two buttons was a
   * decision about the screen, not about the API, and it made the person
   * saving ask which half they had just changed.
   *
   * THE LISTS ARE SENT WHOLE, because the editor holds every row — so an
   * empty list is a real instruction, "I removed them all", and that is
   * exactly how the server reads it. The fields that are not lists are sent
   * as null when blank, which clears them; neither is ever omitted from here,
   * because this form knows the state of all of them.
   */
  async function save() {
    const links = readLinks();
    const contacts = readContacts();

    /* Said before the request, in words about the row that is wrong — the
     * server makes the same refusals and is still the validator. */
    const problem = whatIsWrong(links, contacts);
    if (problem) {
      show(message, 'error', problem);
      return;
    }

    const button = el('save');
    button.disabled = true;
    try {
      await window.api.request('/enterprises/current', {
        method: 'PATCH',
        body: {
          timezone: el('timezone').value || null,
          /* Empty means "not set", which is null on the wire — not "". */
          currencyCode: el('currencyCode').value || null,
          displayName: el('displayName').value.trim() || null,
          about: el('about').value.trim() || null,
          links: links,
          contacts: contacts,
        },
      });
      show(
        message,
        'ok',
        'Saved. Everything that reads these uses the new values from now on, and this is what customers see.',
      );
    } catch (error) {
      handle(error, message);
    } finally {
      button.disabled = false;
    }
  }

  el('save').addEventListener('click', save);

  el('addLink').addEventListener('click', function () {
    el('linkRows').appendChild(linkRow(null));
    syncLinks();
  });
  el('addContact').addEventListener('click', function () {
    el('contactRows').appendChild(contactRow(null));
    syncContacts();
  });

  /* The count is the only way to see a 5,000-character limit approaching. */
  el('about').addEventListener('input', function () {
    el('aboutCount').textContent = String(el('about').value.length);
  });

  void load();
})();
