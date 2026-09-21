/*
 * The role editor.
 *
 * WHAT THIS SCREEN HAS TO GET RIGHT, because getting it wrong is an access
 * mistake rather than a cosmetic one:
 *
 *   - A permission the person cannot hand out is SHOWN and disabled, never
 *     hidden. Hiding it makes a role that already grants it look corrupt, and
 *     hides from an owner what they could delegate if they wanted to.
 *   - A permission whose feature the business does not have is likewise shown,
 *     labelled, and still selectable — the role outlives the subscription, and
 *     a business buying the feature back should not have to rebuild its roles.
 *   - The level is explained in words, not just as a number. "40" means nothing
 *     on its own; "below yours (70)" does.
 *
 * Every rule here is also enforced by the server. This exists so somebody is
 * not offered a button that will be refused, not as the check itself.
 */
(function () {
  if (!window.api || !document.getElementById('rolesPanel')) return;

  var roleRows = document.getElementById('roleRows');
  var rolesMessage = document.getElementById('rolesMessage');
  var editor = document.getElementById('roleEditor');
  var editorTitle = document.getElementById('roleEditorTitle');
  var editorMessage = document.getElementById('editorMessage');
  var groupsHost = document.getElementById('permissionGroups');
  var nameInput = document.getElementById('roleName');
  var levelInput = document.getElementById('roleLevel');
  var levelHint = document.getElementById('roleLevelHint');
  var descriptionInput = document.getElementById('roleDescription');

  var catalogue = [];
  var roles = [];
  /** The role being edited, or null when creating. */
  var editing = null;
  /** The highest level this person may give a role: one below their own. */
  var ceiling = null;

  function escape(value) {
    var node = document.createElement('span');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  }

  function show(host, kind, text) {
    host.innerHTML = '<div class="message ' + kind + '">' + escape(text) + '</div>';
  }

  /**
   * The level ceiling, derived from the roles the API says this person can
   * assign rather than from anything the client is told directly.
   *
   * `assignable` is true only for roles strictly below the viewer, so the
   * highest assignable level plus one is their own level — and one below that
   * is the highest they may CREATE. Reading it off the data keeps the client
   * from having to be told its own level, which it has no other use for.
   */
  function deriveCeiling() {
    var assignable = roles.filter(function (role) { return role.assignable; });
    if (!assignable.length) return null;
    return Math.max.apply(
      null,
      assignable.map(function (role) { return role.level; }),
    );
  }

  function renderRoles() {
    if (!roles.length) {
      roleRows.innerHTML = '<tr><td colspan="5">No roles yet.</td></tr>';
      return;
    }

    roleRows.innerHTML = roles
      .map(function (role) {
        var actions = [];
        if (role.editable) {
          actions.push('<button class="secondary" data-edit="' + escape(role.refId) + '">Edit</button>');
          if (role.holderCount === 0) {
            actions.push(
              '<button class="secondary" data-archive="' + escape(role.refId) + '">Retire</button>',
            );
          }
        }

        return (
          '<tr>' +
          '<td><strong>' + escape(role.name) + '</strong>' +
          (role.isSystem ? ' <span class="pill none">built-in</span>' : '') +
          (role.description ? '<br /><small class="muted">' + escape(role.description) + '</small>' : '') +
          '</td>' +
          '<td>' + escape(role.level) + '</td>' +
          '<td>' + escape(role.holderCount) + '</td>' +
          '<td><small class="muted">' + escape(role.permissions.length) + ' permission(s)</small></td>' +
          '<td>' + (actions.join(' ') || '<small class="muted">—</small>') + '</td>' +
          '</tr>'
        );
      })
      .join('');

    Array.prototype.forEach.call(roleRows.querySelectorAll('[data-edit]'), function (button) {
      button.addEventListener('click', function () {
        openEditor(button.getAttribute('data-edit'));
      });
    });
    Array.prototype.forEach.call(roleRows.querySelectorAll('[data-archive]'), function (button) {
      button.addEventListener('click', function () {
        void archive(button.getAttribute('data-archive'));
      });
    });
  }

  function renderPermissions(selected) {
    var chosen = {};
    (selected || []).forEach(function (code) { chosen[code] = true; });

    groupsHost.innerHTML = catalogue
      .map(function (group) {
        var boxes = group.permissions
          .map(function (permission) {
            /*
             * Disabled ONLY when the person cannot grant it. An unavailable
             * feature leaves the box usable on purpose: a role outlives a
             * subscription, and a business buying the feature back should not
             * have to rebuild its roles from memory.
             */
            var disabled = permission.grantable ? '' : ' disabled';
            var notes = [];
            if (!permission.grantable) notes.push('you do not have this');
            if (!permission.available) {
              notes.push('needs the ' + permission.featureKey.replace(/_/gu, ' ') + ' feature');
            }

            return (
              '<label class="perm' + (permission.grantable ? '' : ' perm-off') + '">' +
              '<input type="checkbox" value="' + escape(permission.code) + '"' +
              (chosen[permission.code] ? ' checked' : '') + disabled + ' />' +
              '<span><strong>' + escape(permission.description || permission.code) + '</strong>' +
              '<small class="muted">' + escape(permission.code) +
              (notes.length ? ' · ' + escape(notes.join(' · ')) : '') +
              '</small></span></label>'
            );
          })
          .join('');

        return (
          '<fieldset class="perm-group">' +
          '<legend>' + escape(group.label) + '</legend>' +
          '<p class="hint">' + escape(group.description) + '</p>' +
          boxes +
          '</fieldset>'
        );
      })
      .join('');
  }

  function selectedCodes() {
    return Array.prototype.slice
      .call(groupsHost.querySelectorAll('input[type=checkbox]:checked'))
      .map(function (box) { return box.value; });
  }

  function openEditor(refId) {
    editing = refId ? roles.find(function (role) { return role.refId === refId; }) : null;
    editorTitle.textContent = editing ? 'Edit ' + editing.name : 'New role';
    nameInput.value = editing ? editing.name : '';
    descriptionInput.value = editing && editing.description ? editing.description : '';
    levelInput.value = editing ? editing.level : '';
    levelInput.max = ceiling === null ? 99 : ceiling;
    levelHint.textContent =
      ceiling === null
        ? 'Higher means more authority.'
        : 'Higher means more authority. You can go up to ' + ceiling + '.';
    editorMessage.innerHTML = '';
    renderPermissions(editing ? editing.permissions : []);
    editor.hidden = false;
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeEditor() {
    editor.hidden = true;
    editing = null;
  }

  async function save() {
    var body = {
      name: nameInput.value.trim(),
      level: Number(levelInput.value),
      permissions: selectedCodes(),
    };
    var description = descriptionInput.value.trim();
    if (description) body.description = description;

    if (!body.name || Number.isNaN(body.level)) {
      show(editorMessage, 'error', 'A role needs a name and a level.');
      return;
    }

    try {
      if (editing) {
        await window.api.request('/roles/' + editing.refId, { method: 'PATCH', body: body });
      } else {
        await window.api.request('/roles', { method: 'POST', body: body });
      }
      closeEditor();
      await load();
      show(rolesMessage, 'ok', 'Saved.');
    } catch (error) {
      /*
       * The server's own words. It refuses for reasons a client cannot always
       * predict — the subset rule depends on what the person holds — and
       * rewriting the message here would mean maintaining a second, drifting
       * copy of the rules.
       */
      show(editorMessage, 'error', (error && error.message) || 'Could not save this role.');
    }
  }

  async function archive(refId) {
    try {
      await window.api.request('/roles/' + refId + '/archive', { method: 'POST' });
      await load();
      show(rolesMessage, 'ok', 'Role retired.');
    } catch (error) {
      show(rolesMessage, 'error', (error && error.message) || 'Could not retire this role.');
    }
  }

  async function load() {
    try {
      var results = await Promise.all([
        window.api.request('/roles'),
        window.api.request('/roles/permissions'),
      ]);
      roles = results[0].data || [];
      catalogue = results[1].data || [];
      ceiling = deriveCeiling();
      rolesMessage.innerHTML = '';
      renderRoles();
    } catch (error) {
      /*
       * A person without `roles.view` gets a refusal here, which is not an
       * error to shout about — it is the system working. The panel says so
       * quietly and gets out of the way.
       */
      document.getElementById('rolesPanel').hidden = true;
    }
  }

  document.getElementById('newRole').addEventListener('click', function () { openEditor(null); });
  document.getElementById('cancelRole').addEventListener('click', closeEditor);
  document.getElementById('saveRole').addEventListener('click', function () { void save(); });

  void load();
})();
