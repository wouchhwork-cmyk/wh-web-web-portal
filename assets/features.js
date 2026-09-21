/*
 * What this business has, and asking for what it does not.
 *
 * THE HONEST FRAMING MATTERS HERE. Asking is not buying and not enabling — it
 * puts a request in front of the Wouchh team, and a screen that implies
 * otherwise produces a support ticket every time somebody clicks it and nothing
 * happens.
 *
 * A feature that was REVOKED cannot be requested again from here at all. That
 * is withdrawn by us and is the one state the model has no way out of, so the
 * button is absent rather than present-and-refused.
 */
(function () {
  if (!window.api || !document.getElementById('featuresPanel')) return;

  var panel = document.getElementById('featuresPanel');
  var host = document.getElementById('featureRows');
  var message = document.getElementById('featuresMessage');

  function escape(value) {
    var node = document.createElement('span');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  }

  function label(feature) {
    if (feature.active) return '<span class="pill active">on</span>';
    if (!feature.status) return '<span class="pill none">not included</span>';
    return '<span class="pill ' + escape(feature.status) + '">' +
      escape(feature.status.replace(/_/gu, ' ')) + '</span>';
  }

  function render(features) {
    host.innerHTML = features
      .map(function (feature) {
        var note = '';
        if (feature.status === 'declined' && feature.declineReason) {
          note = '<small class="muted">Declined: ' + escape(feature.declineReason) + '</small>';
        } else if (feature.status === 'revoked') {
          note = '<small class="muted">Withdrawn. Talk to us if you need it back.</small>';
        } else if (feature.status === 'access_requested') {
          note = '<small class="muted">Requested — waiting on us.</small>';
        } else if (feature.expiresAt) {
          note = '<small class="muted">Until ' +
            escape(new Date(feature.expiresAt).toLocaleDateString()) + '</small>';
        }

        return (
          '<div class="feature">' +
          '<span class="name"><strong>' + escape(feature.name) + '</strong>' +
          (feature.description ? '<small>' + escape(feature.description) + '</small>' : '') +
          note +
          '</span>' +
          label(feature) +
          (feature.requestable
            ? '<button class="secondary" data-request="' + escape(feature.key) + '">Ask for this</button>'
            : '') +
          '</div>'
        );
      })
      .join('');

    Array.prototype.forEach.call(host.querySelectorAll('[data-request]'), function (button) {
      button.addEventListener('click', function () {
        void request(button.getAttribute('data-request'));
      });
    });
  }

  async function request(key) {
    try {
      await window.api.request('/features/' + key + '/request', { method: 'POST' });
      await load();
      message.innerHTML =
        '<div class="message ok">Asked. We will come back to you — nothing changes yet.</div>';
    } catch (error) {
      message.innerHTML =
        '<div class="message error">' +
        escape((error && error.message) || 'Could not send that request.') +
        '</div>';
    }
  }

  async function load() {
    try {
      var result = await window.api.request('/features');
      message.innerHTML = '';
      render(result.data || []);
      panel.hidden = false;
    } catch (_) {
      // Somebody without `features.view` simply does not see the panel. That is
      // the system working, not an error to announce.
      panel.hidden = true;
    }
  }

  void load();
})();
