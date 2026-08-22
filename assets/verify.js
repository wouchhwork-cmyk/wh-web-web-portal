(function () {
  const pending = window.api.readPending();
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

  // Nothing to verify against: the reference lives in this tab's storage, so a
  // direct visit or a new tab has to start again.
  if (!pending || !pending.verificationRefId) {
    document.getElementById('verifyForm').hidden = true;
    document.getElementById('sentTo').textContent = '';
    show('info', 'Nothing to verify. Start from the sign-in page.');
    return;
  }

  const channel = pending.deliveryChannel === 'email' ? 'email' : 'SMS';
  document.getElementById('sentTo').textContent =
    'We sent a code by ' + channel + ' to ' + (pending.maskedDestination || 'your account') + '.';

  // Development only, and driven by config rather than baked into the logic: with
  // OTP_REALTIME_ENABLED=false the API issues one fixed code and sends nothing,
  // so without this hint there is no way to complete the flow locally.
  if (window.WOUCHH_CONFIG.devOtpHint) {
    show(
      'info',
      'Development: real sending is switched off, so the code is ' +
        window.WOUCHH_CONFIG.devOtpHint + '.',
    );
    document.getElementById('code').value = window.WOUCHH_CONFIG.devOtpHint;
  }

  document.getElementById('verifyForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    submit.disabled = true;

    try {
      const result = await window.api.request('/auth/verify', {
        method: 'POST',
        body: {
          verificationRefId: pending.verificationRefId,
          code: document.getElementById('code').value.trim(),
        },
      });
      const data = result.data;

      if (data.outcome === 'authenticated') {
        window.api.writeSession({ accessToken: data.accessToken });
        await window.api.routeToHome();
        return;
      }

      // A verified owner whose business is not activated yet still has no
      // membership to select, so say so plainly rather than looping.
      show('info', 'Verified. ' + JSON.stringify(data.outcome));
    } catch (error) {
      submit.disabled = false;
      show('error', error.message, error.code);
    }
  });
})();
