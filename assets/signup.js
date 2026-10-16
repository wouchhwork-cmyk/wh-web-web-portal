(function () {
  const form = document.getElementById('signupForm');
  const submit = document.getElementById('submit');
  const message = document.getElementById('message');

  function show(kind, text, code, details) {
    message.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'message ' + kind;
    box.textContent = text;

    // The API names the offending fields; showing them beats making the person
    // guess which of a dozen inputs it meant.
    if (details && details.length) {
      const list = document.createElement('span');
      list.className = 'code';
      list.textContent = details
        .map(function (d) { return (d.field ? d.field + ': ' : '') + d.issue; })
        .join(' · ');
      box.appendChild(list);
    } else if (code) {
      const small = document.createElement('span');
      small.className = 'code';
      small.textContent = code;
      box.appendChild(small);
    }
    message.appendChild(box);
  }

  function value(id) {
    const raw = document.getElementById(id).value.trim();
    return raw === '' ? undefined : raw;
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    submit.disabled = true;
    message.innerHTML = '';

    const business = {
      name: value('businessName'),
      email: value('businessEmail'),
      city: value('city'),
    };
    const businessMobile = value('businessMobile');
    if (businessMobile) {
      business.mobile = {
        number: businessMobile,
        countryCode: document.getElementById('businessCountry').value,
      };
    }

    const owner = {
      firstName: value('firstName'),
      lastName: value('lastName'),
      email: value('ownerEmail'),
      password: document.getElementById('password').value,
    };
    const ownerMobile = value('ownerMobile');
    if (ownerMobile) {
      owner.mobile = {
        number: ownerMobile,
        countryCode: document.getElementById('ownerCountry').value,
      };
    }

    if (!owner.email && !owner.mobile) {
      submit.disabled = false;
      show('error', 'Give either your email or your mobile number.');
      return;
    }

    // Strip the keys we left undefined: the API's schemas are strict, and an
    // explicit null is not the same as an absent optional field.
    const body = { business: prune(business), owner: prune(owner) };

    try {
      const result = await window.api.request('/enterprises/signup', {
        method: 'POST',
        body: body,
      });
      const data = result.data;

      window.api.writePending({
        verificationRefId: data.verificationRefId,
        maskedDestination: data.maskedDestination,
        deliveryChannel: owner.email ? 'email' : 'sms',
        origin: 'signup',
        businessName: business.name,
      });
      window.location.href = 'verify.html';
    } catch (error) {
      submit.disabled = false;
      show('error', error.message, error.code, error.details);
    }
  });

  function prune(object) {
    const out = {};
    Object.keys(object).forEach(function (key) {
      if (object[key] !== undefined) out[key] = object[key];
    });
    return out;
  }
})();
