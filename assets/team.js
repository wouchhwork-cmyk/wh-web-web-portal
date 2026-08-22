(function () {
  if (!window.api.requireSession()) return;

  const rows = document.getElementById('rows');
  const listMessage = document.getElementById('listMessage');
  const inviteMessage = document.getElementById('inviteMessage');
  const submit = document.getElementById('submit');

  let permissions = [];

  function show(target, kind, text, code, details) {
    target.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'message ' + kind;
    box.textContent = text;
    const extra = details && details.length
      ? details.map(function (d) { return (d.field ? d.field + ': ' : '') + d.issue; }).join(' · ')
      : code;
    if (extra) {
      const small = document.createElement('span');
      small.className = 'code';
      small.textContent = extra;
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
    show(target, 'error', error.message, error.code, error.details);
  }

  function pill(status) {
    const span = document.createElement('span');
    span.className = 'pill ' + status;
    span.textContent = status.replace(/_/g, ' ');
    return span;
  }

  async function loadHeader() {
    try {
      const me = (await window.api.request('/auth/me')).data;
      permissions = me.permissions || [];
      document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : '';

      // Only offer what the API will accept: an agent has no business seeing a
      // form whose every submission would be a 403.
      if (permissions.indexOf('employees.invite') === -1) {
        document.getElementById('invitePanel').hidden = true;
      }
    } catch (error) {
      handle(error, listMessage);
    }
  }

  async function loadRoles() {
    if (permissions.indexOf('roles.view') === -1) return;
    try {
      const roles = (await window.api.request('/employees/roles')).data;
      const select = document.getElementById('role');
      select.innerHTML = '';
      roles.forEach(function (role) {
        const option = document.createElement('option');
        option.value = role.refId;
        option.textContent = role.name;
        select.appendChild(option);
      });
    } catch (error) {
      handle(error, inviteMessage);
    }
  }

  async function loadTeam() {
    const includeSupport = document.getElementById('includeSupport').checked;
    try {
      const people = (await window.api.request(
        '/employees' + (includeSupport ? '?includeSupport=true' : ''),
      )).data;

      rows.innerHTML = '';
      if (people.length === 0) {
        rows.innerHTML = '<tr><td colspan="6">Nobody yet.</td></tr>';
        return;
      }

      people.forEach(function (person) {
        const tr = document.createElement('tr');

        const name = document.createElement('td');
        name.innerHTML = '<strong></strong><br><small></small>';
        name.querySelector('strong').textContent = person.name;
        name.querySelector('small').textContent =
          person.employeeKind === 'support' ? 'Wouchh support' : '';

        const contact = document.createElement('td');
        contact.textContent = person.email || person.mobile || '—';

        const role = document.createElement('td');
        role.textContent = person.roles.join(', ') || '—';

        const status = document.createElement('td');
        status.appendChild(pill(person.status));

        const active = document.createElement('td');
        active.textContent = person.lastActiveAt
          ? new Date(person.lastActiveAt).toLocaleDateString()
          : '—';

        const action = document.createElement('td');
        if (permissions.indexOf('employees.manage') !== -1 && person.employeeKind === 'business') {
          const button = document.createElement('button');
          const suspending = person.status !== 'suspended';
          button.className = suspending ? 'danger' : 'secondary';
          button.textContent = suspending ? 'Suspend' : 'Reinstate';
          button.addEventListener('click', function () {
            let reason = null;
            if (suspending) {
              // The API requires it and records it, so ask rather than invent one.
              reason = window.prompt('Why is ' + person.name + ' being suspended?');
              if (!reason) return;
            }
            setStatus(person.refId, suspending ? 'suspended' : 'active', reason);
          });
          action.appendChild(button);
        }

        [name, contact, role, status, active, action].forEach(function (cell) {
          tr.appendChild(cell);
        });
        rows.appendChild(tr);
      });
    } catch (error) {
      handle(error, listMessage);
    }
  }

  async function setStatus(refId, status, reason) {
    const body = { status: status };
    if (reason) body.reason = reason;
    try {
      await window.api.request('/employees/' + refId + '/status', { method: 'POST', body: body });
      await loadTeam();
    } catch (error) {
      handle(error, listMessage);
    }
  }

  document.getElementById('contactMethod').addEventListener('change', function (event) {
    const byEmail = event.target.value === 'email';
    document.getElementById('emailField').hidden = !byEmail;
    document.getElementById('mobileField').hidden = byEmail;
  });

  document.getElementById('includeSupport').addEventListener('change', loadTeam);

  document.getElementById('inviteForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    submit.disabled = true;
    inviteMessage.innerHTML = '';

    // No password field, deliberately: the API refuses one, and the person sets
    // their own from the code that reaches them.
    const body = {
      firstName: document.getElementById('firstName').value.trim(),
      roleRefId: document.getElementById('role').value,
    };
    const lastName = document.getElementById('lastName').value.trim();
    if (lastName) body.lastName = lastName;

    if (document.getElementById('contactMethod').value === 'email') {
      body.email = document.getElementById('email').value.trim();
    } else {
      body.mobile = {
        number: document.getElementById('mobile').value.trim(),
        countryCode: document.getElementById('countryCode').value,
      };
    }

    try {
      const created = await window.api.request('/employees', { method: 'POST', body: body });
      show(
        inviteMessage,
        'ok',
        created.data.name + ' was created and invited. They set their own password from the ' +
          'code we sent — you will never see it.',
      );
      document.getElementById('inviteForm').reset();
      await loadTeam();
    } catch (error) {
      handle(error, inviteMessage);
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('signOut').addEventListener('click', async function () {
    try { await window.api.request('/auth/logout', { method: 'POST' }); } catch (_) { /* leaving anyway */ }
    window.api.clearSession();
    window.location.href = 'index.html';
  });

  loadHeader().then(loadRoles).then(loadTeam);
})();
