(function () {
  if (!window.api.requireSession()) return;

  const state = document.getElementById('state');
  const permissionsPanel = document.getElementById('permissions');

  function paragraph(text, className) {
    const p = document.createElement('p');
    if (className) p.className = className;
    p.textContent = text;
    return p;
  }

  async function load() {
    let me;
    try {
      me = (await window.api.request('/auth/me')).data;
    } catch (error) {
      if (error.status === 401) {
        window.api.clearSession();
        window.location.href = 'index.html';
        return;
      }
      state.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'message error';
      box.textContent = error.message;
      state.appendChild(box);
      return;
    }

    if (me.isPlatformAdmin) {
      window.location.href = 'admin.html';
      return;
    }

    document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : 'Signed in';
    state.innerHTML = '';

    if (!me.enterprise) {
      state.appendChild(paragraph('No business is attached to this session.'));
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = me.enterprise.name;
    state.appendChild(heading);
    state.appendChild(paragraph(me.enterprise.slug, 'hint'));

    /*
     * The three states a business can be in, spelled out.
     *
     * This is the whole reason the portal exists today: an owner who signs up
     * needs to be told they are waiting on us, rather than shown an empty app
     * whose every button returns 403.
     */
    if (me.enterprise.status === 'pending_activation') {
      const box = document.createElement('div');
      box.className = 'message info';
      box.textContent =
        'Your account is created and your contact details are verified. Wouchh is reviewing it, ' +
        'and the portal opens as soon as it is activated.';
      state.appendChild(box);
      return;
    }

    if (me.enterprise.status === 'suspended') {
      const box = document.createElement('div');
      box.className = 'message error';
      box.textContent = 'This business account is suspended. Please contact support.';
      state.appendChild(box);
      return;
    }

    const box = document.createElement('div');
    box.className = 'message ok';
    box.textContent = 'Your account is active.';
    state.appendChild(box);

    state.appendChild(
      paragraph(
        'Connecting Facebook and Instagram, and the shared inbox, land here next. Nothing is ' +
          'wired to this screen yet on purpose — the sign-in, verification and activation flows ' +
          'come first.',
        'hint',
      ),
    );

    // What this person can do, straight from the API's own answer. Useful while
    // building: it shows the effect of a feature being granted or withdrawn.
    permissionsPanel.hidden = false;
    permissionsPanel.innerHTML = '';
    const permissionsHeading = document.createElement('h2');
    permissionsHeading.textContent = 'What you can do';
    permissionsPanel.appendChild(permissionsHeading);
    permissionsPanel.appendChild(
      paragraph(
        'Resolved per request by the API: your roles, narrowed to the features this business ' +
          'actually has.',
        'hint',
      ),
    );

    if (me.permissions.length === 0) {
      permissionsPanel.appendChild(paragraph('No permissions resolved.'));
      return;
    }

    const list = document.createElement('div');
    me.permissions.forEach(function (permission) {
      const span = document.createElement('span');
      span.className = 'pill none';
      span.style.margin = '0 6px 6px 0';
      span.textContent = permission;
      list.appendChild(span);
    });
    permissionsPanel.appendChild(list);
  }

  document.getElementById('signOut').addEventListener('click', async function () {
    try { await window.api.request('/auth/logout', { method: 'POST' }); } catch (_) { /* leaving anyway */ }
    window.api.clearSession();
    window.location.href = 'index.html';
  });

  load();
})();
