/*
 * Wouchh's own people, on the platform admin page.
 *
 * WHAT THIS HAS TO MAKE CLEAR. There are two kinds of staff and they are
 * governed by different things, which is the part somebody will get wrong:
 *
 *   platform admin   every staff permission, every business. Comes from a flag,
 *                    not from roles — so roles shown against one of these would
 *                    look like they did something. The server refuses to set
 *                    them, and this screen says why rather than offering a
 *                    control that fails.
 *   scoped staff     only what their staff roles grant. Before those roles
 *                    could be granted, such a person could sign in and reach
 *                    nothing at all.
 */
(function () {
  if (!window.api || !document.getElementById('staffPanel')) return;

  var rows = document.getElementById('staffRows');
  var message = document.getElementById('staffMessage');
  var options = [];

  function escape(value) {
    var node = document.createElement('span');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  }

  function show(kind, text) {
    message.innerHTML = '<div class="message ' + kind + '">' + escape(text) + '</div>';
  }

  function render(staff) {
    if (!staff.length) {
      rows.innerHTML = '<tr><td colspan="5">Nobody yet.</td></tr>';
      return;
    }

    rows.innerHTML = staff
      .map(function (person) {
        var access = person.hasAllEnterpriseAccess
          ? '<span class="pill active">platform admin</span>'
          : '<span class="pill none">scoped</span>';

        var roles = person.hasAllEnterpriseAccess
          ? '<small class="muted">not used — access comes from the flag</small>'
          : options
              .map(function (option) {
                var held = person.roles.indexOf(option.name) !== -1;
                return (
                  '<label class="perm" style="border:0;padding:2px 0">' +
                  '<input type="checkbox" data-staff="' + escape(person.refId) + '"' +
                  ' value="' + escape(option.refId) + '"' + (held ? ' checked' : '') + ' />' +
                  '<span>' + escape(option.name) + '</span></label>'
                );
              })
              .join('') || '<small class="muted">no staff roles defined</small>';

        return (
          '<tr>' +
          '<td><strong>' + escape(person.name) + '</strong><br />' +
          '<small class="muted">' + escape(person.email || '—') + '</small></td>' +
          '<td>' + access + ' <span class="pill ' + escape(person.status) + '">' +
          escape(person.status) + '</span></td>' +
          '<td>' + roles + '</td>' +
          '<td><small class="muted">' +
          escape(person.lastLoginAt ? new Date(person.lastLoginAt).toLocaleDateString() : 'never') +
          '</small></td>' +
          '<td>' +
          (person.hasAllEnterpriseAccess
            ? ''
            : '<button class="secondary" data-save="' + escape(person.refId) + '">Save</button>') +
          /*
           * SUSPEND IS OFFERED ON EVERYBODY, admins included: the server
           * refuses the two cases that matter — acting on yourself, and
           * suspending the last platform admin — and refusing in one place
           * beats a button that is hidden here and reachable by curl.
           *
           * REINSTATE IS NOT OFFERED on an invitation that was never accepted.
           * The server refuses that too, because activating somebody is a claim
           * about what they agreed to and only they can make it; showing the
           * control anyway would just produce a confusing error.
           */
          (person.status === 'suspended'
            ? (person.everAccepted === false
                ? ' <small class="muted">invitation cancelled</small>'
                : ' <button class="secondary" data-status="active" data-ref="' +
                  escape(person.refId) + '">Reinstate</button>')
            : ' <button class="secondary" data-status="suspended" data-ref="' +
              escape(person.refId) + '">Suspend</button>') +
          '</td></tr>'
        );
      })
      .join('');

    Array.prototype.forEach.call(rows.querySelectorAll('[data-save]'), function (button) {
      button.addEventListener('click', function () {
        void save(button.getAttribute('data-save'));
      });
    });

    Array.prototype.forEach.call(rows.querySelectorAll('[data-status]'), function (button) {
      button.addEventListener('click', function () {
        void setStatus(button.getAttribute('data-ref'), button.getAttribute('data-status'));
      });
    });
  }

  async function save(refId) {
    var chosen = Array.prototype.slice
      .call(rows.querySelectorAll('input[data-staff="' + refId + '"]:checked'))
      .map(function (box) { return box.value; });

    try {
      await window.api.request('/platform/staff/' + refId + '/roles', {
        method: 'POST',
        body: { roleRefIds: chosen },
      });
      await load();
      show('ok', 'Saved.');
    } catch (error) {
      show('error', (error && error.message) || 'Could not save.');
    }
  }

  async function setStatus(refId, status) {
    /*
     * A reason is REQUIRED for a suspension and the server enforces it, so it
     * is asked for here rather than sent as a placeholder — this ends every
     * session that person holds, and the audit row is the only record of why.
     */
    var body = { status: status };
    if (status === 'suspended') {
      var reason = window.prompt('Why are you suspending them? This is recorded.');
      if (!reason) return;
      body.reason = reason;
    }

    try {
      await window.api.request('/platform/staff/' + refId + '/status', {
        method: 'POST',
        body: body,
      });
      await load();
      show('ok', status === 'suspended' ? 'Suspended, and signed out.' : 'Reinstated.');
    } catch (error) {
      show('error', (error && error.message) || 'Could not change that.');
    }
  }

  function renderInviteRoles() {
    var box = document.getElementById('inviteRoles');
    if (!box) return;
    box.innerHTML = options.length
      ? '<small class="muted">Roles (optional — can be granted later)</small><br />' +
        options
          .map(function (option) {
            return (
              '<label class="perm" style="border:0;padding:2px 8px 2px 0;display:inline-flex">' +
              '<input type="checkbox" data-invite-role value="' + escape(option.refId) + '" />' +
              '<span>' + escape(option.name) + '</span></label>'
            );
          })
          .join('')
      : '<small class="muted">No staff roles defined yet.</small>';
  }

  async function sendInvite() {
    var first = (document.getElementById('inviteFirst').value || '').trim();
    var last = (document.getElementById('inviteLast').value || '').trim();
    var email = (document.getElementById('inviteEmail').value || '').trim();

    // Checked here only to save a round trip; the server validates regardless.
    if (!first || !email) {
      show('error', 'A first name and an email address are both needed.');
      return;
    }

    var roleRefIds = Array.prototype.slice
      .call(document.querySelectorAll('#inviteRoles input[data-invite-role]:checked'))
      .map(function (box) { return box.value; });

    var body = { firstName: first, email: email };
    if (last) body.lastName = last;
    if (roleRefIds.length) body.roleRefIds = roleRefIds;

    try {
      await window.api.request('/platform/staff', { method: 'POST', body: body });
      document.getElementById('inviteFirst').value = '';
      document.getElementById('inviteLast').value = '';
      document.getElementById('inviteEmail').value = '';
      await load();
      show('ok', 'Invitation sent. They appear as invited until they accept.');
    } catch (error) {
      show('error', (error && error.message) || 'Could not send that invitation.');
    }
  }

  async function load() {
    try {
      var results = await Promise.all([
        window.api.request('/platform/staff'),
        window.api.request('/platform/staff/roles'),
      ]);
      options = results[1].data || [];
      message.innerHTML = '';
      render(results[0].data || []);
      renderInviteRoles();
    } catch (_) {
      document.getElementById('staffPanel').hidden = true;
    }
  }

  var inviteButton = document.getElementById('inviteSend');
  if (inviteButton) {
    inviteButton.addEventListener('click', function () {
      void sendInvite();
    });
  }

  void load();
})();
