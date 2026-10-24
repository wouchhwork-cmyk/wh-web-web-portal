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

      /* Read-only without the permission: the server refuses anyway, and a
       * save button that always 403s is a lie told twice. */
      const mayManage = permissions.indexOf('enterprise.manage') !== -1;
      el('save').hidden = !mayManage;
      el('timezone').disabled = !mayManage;
      el('currencyCode').disabled = !mayManage;
      if (!mayManage) {
        show(message, 'info', 'You can see these settings but not change them.');
      }
    } catch (error) {
      handle(error, message);
    }
  }

  async function save() {
    const button = el('save');
    button.disabled = true;
    try {
      await window.api.request('/enterprises/current', {
        method: 'PATCH',
        body: {
          timezone: el('timezone').value || null,
          /* Empty means "not set", which is null on the wire — not "". */
          currencyCode: el('currencyCode').value || null,
        },
      });
      show(message, 'ok', 'Saved. Everything that reads these uses the new values from now on.');
    } catch (error) {
      handle(error, message);
    } finally {
      button.disabled = false;
    }
  }

  el('save').addEventListener('click', save);
  void load();
})();
