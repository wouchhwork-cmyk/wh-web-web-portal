(function () {
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
    const byEmail = method.value === 'email';
    document.getElementById('emailFields').hidden = !byEmail;
    document.getElementById('mobileFields').hidden = byEmail;
  });

  // Development only: with realtime delivery off the code is the fixed one, so
  // there is otherwise no way to complete this locally.
  if (window.WOUCHH_CONFIG.devOtpHint) {
    document.getElementById('code').value = window.WOUCHH_CONFIG.devOtpHint;
    show('info', 'Development: real sending is off, so the code is ' +
      window.WOUCHH_CONFIG.devOtpHint + '.');
  }

  document.getElementById('acceptForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    submit.disabled = true;

    // Keyed on the address, not a verification reference: whoever invited you
    // made that request on their own device, so you never saw one.
    const body = {
      code: document.getElementById('code').value.trim(),
      password: document.getElementById('password').value,
    };
    if (method.value === 'email') {
      body.email = document.getElementById('email').value.trim();
    } else {
      body.mobile = {
        number: document.getElementById('mobile').value.trim(),
        countryCode: document.getElementById('countryCode').value,
      };
    }

    try {
      const result = await window.api.request('/auth/accept-invite', {
        method: 'POST',
        body: body,
      });
      window.api.writeSession({ accessToken: result.data.accessToken });
      await window.api.routeToHome();
    } catch (error) {
      submit.disabled = false;
      show('error', error.message, error.code);
    }
  });
})();
