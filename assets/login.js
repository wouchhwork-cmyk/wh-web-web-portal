(function () {
  const form = document.getElementById('loginForm');
  const method = document.getElementById('method');
  const message = document.getElementById('message');
  const submit = document.getElementById('submit');

  function show(kind, text, code) {
    message.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'message ' + kind;
    box.textContent = text;
    if (code) {
      const small = document.createElement('span');
      small.className = 'code';
      small.textContent = code;
      box.appendChild(small);
    }
    message.appendChild(box);
  }

  method.addEventListener('change', function () {
    const byMobile = method.value === 'mobile';
    document.getElementById('mobileFields').hidden = !byMobile;
    document.getElementById('emailFields').hidden = byMobile;
  });

  /**
   * One business per row. The selection token is exchanged for a session, which
   * is why the picker cannot simply pick for you: the server has to mint a token
   * scoped to the business you chose.
   */
  function renderPicker(selectionToken, enterprises) {
    document.getElementById('loginPanel').hidden = true;
    const panel = document.getElementById('pickerPanel');
    const list = document.getElementById('pickerList');
    panel.hidden = false;
    list.innerHTML = '';

    enterprises.forEach(function (enterprise) {
      const row = document.createElement('div');
      row.className = 'feature';

      const name = document.createElement('div');
      name.className = 'name';
      name.innerHTML = '<strong></strong><small></small>';
      name.querySelector('strong').textContent = enterprise.name;
      name.querySelector('small').textContent = enterprise.slug + ' · ' + enterprise.memberKind;

      const choose = document.createElement('button');
      choose.textContent = 'Continue';
      choose.addEventListener('click', async function () {
        choose.disabled = true;
        try {
          const result = await window.api.request('/auth/select-enterprise', {
            method: 'POST',
            body: { selectionToken: selectionToken, enterpriseRefId: enterprise.enterpriseRefId },
          });
          window.api.writeSession({ accessToken: result.data.accessToken });
          await window.api.routeToHome();
        } catch (error) {
          choose.disabled = false;
          show('error', error.message, error.code);
        }
      });

      row.appendChild(name);
      row.appendChild(choose);
      list.appendChild(row);
    });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    submit.disabled = true;
    message.innerHTML = '';

    const password = document.getElementById('password').value;
    const body = { password: password };
    if (method.value === 'mobile') {
      body.mobile = {
        number: document.getElementById('mobile').value.trim(),
        countryCode: document.getElementById('countryCode').value,
      };
    } else {
      body.email = document.getElementById('email').value.trim();
    }

    try {
      const result = await window.api.request('/auth/login', { method: 'POST', body: body });
      const data = result.data;

      if (data.outcome === 'authenticated') {
        window.api.writeSession({ accessToken: data.accessToken });
        await window.api.routeToHome();
        return;
      }

      if (data.outcome === 'verification_required') {
        // The code screen is told only the opaque reference, never the address.
        window.api.writePending({
          verificationRefId: data.verificationRefId,
          maskedDestination: data.maskedDestination,
          deliveryChannel: data.deliveryChannel,
          expiresInSeconds: data.expiresInSeconds,
          origin: 'login',
        });
        window.location.href = 'verify.html';
        return;
      }

      if (data.outcome === 'enterprise_selection_required') {
        renderPicker(data.selectionToken, data.enterprises);
        return;
      }

      show('error', 'Unexpected response from the API.');
    } catch (error) {
      show('error', error.message, error.code);
    } finally {
      submit.disabled = false;
    }
  });
})();
