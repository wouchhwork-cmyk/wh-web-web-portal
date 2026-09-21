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
          '</td></tr>'
        );
      })
      .join('');

    Array.prototype.forEach.call(rows.querySelectorAll('[data-save]'), function (button) {
      button.addEventListener('click', function () {
        void save(button.getAttribute('data-save'));
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

  async function load() {
    try {
      var results = await Promise.all([
        window.api.request('/platform/staff'),
        window.api.request('/platform/staff/roles'),
      ]);
      options = results[1].data || [];
      message.innerHTML = '';
      render(results[0].data || []);
    } catch (_) {
      document.getElementById('staffPanel').hidden = true;
    }
  }

  void load();
})();
