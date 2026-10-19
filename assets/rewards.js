(function () {
  if (!window.api.requireSession()) return;

  /*
   * The trigger list mirrors RewardTriggerKind on the server. Two are listed
   * with a warning rather than hidden: post_caption_mention needs mention
   * monitoring, and post_like needs the like actor to be captured at all.
   * Hiding them would make a rule that cannot fire indistinguishable from one
   * nobody has written yet.
   */
  const TRIGGERS = [
    ['story_mention', 'Mentioned us in their story'],
    ['story_reply', 'Replied to our story'],
    ['comment_on_own_post', 'Commented on our post'],
    ['comment_on_mentioned_post', 'Commented on a post tagging us'],
    ['post_tagging_us', 'Posted and tagged us'],
    ['direct_message_inbound', 'Sent us a direct message'],
    ['message_reaction', 'Reacted to our message'],
    ['postback_tapped', 'Tapped a button'],
    ['opt_in_granted', 'Opted in'],
    ['referral_entry', 'Arrived from an ad, link or QR code'],
    ['post_caption_mention', 'Named us in a caption — needs mention monitoring'],
    ['post_like', 'Liked our post — not available yet'],
    ['post_share', 'Shared our post — not available yet'],
  ];

  const el = (id) => document.getElementById(id);

  let permissions = [];
  let selectedProgram = null;

  function show(target, kind, text, code) {
    target.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'message ' + kind;
    box.textContent = text;
    if (code) {
      const small = document.createElement('span');
      small.className = 'code';
      small.textContent = code;
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
    show(target, 'error', error.message, error.code);
  }

  function pill(text, kind) {
    const span = document.createElement('span');
    span.className = 'pill ' + (kind || 'none');
    span.textContent = String(text).replace(/_/g, ' ');
    return span;
  }

  function when(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  /**
   * Minor units are rendered with the currency's own scale, never a hardcoded
   * two. JPY has no minor unit at all and KWD has three; dividing by 100
   * everywhere would show the wrong number in both.
   */
  function money(minorUnits, currencyCode) {
    if (!currencyCode) return String(minorUnits);
    try {
      const format = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode,
      });
      const digits = format.resolvedOptions().maximumFractionDigits;
      return format.format(minorUnits / Math.pow(10, digits));
    } catch (error) {
      return minorUnits + ' ' + currencyCode;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Programs                                                            */
  /* ------------------------------------------------------------------ */

  function programRow(program) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = program.name;
    left.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'hint';
    const spent = program.budgetMinor
      ? money(program.spentMinor, program.budgetCurrencyCode) +
        ' of ' +
        money(program.budgetMinor, program.budgetCurrencyCode) +
        ' spent'
      : 'no budget cap';
    meta.textContent = program.timezone + ' · ' + spent;
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(pill(program.status, program.status === 'active' ? 'ok' : 'none'));

    const rules = document.createElement('button');
    rules.className = 'secondary';
    rules.textContent = 'Rules';
    rules.addEventListener('click', () => selectProgram(program));
    right.appendChild(rules);

    if (permissions.indexOf('rewards.manage') !== -1) {
      const toggle = document.createElement('button');
      toggle.className = 'secondary';
      toggle.textContent = program.status === 'active' ? 'Pause' : 'Activate';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await window.api.request('/rewards/programs/' + program.refId + '/status', {
            method: 'PATCH',
            body: { status: program.status === 'active' ? 'paused' : 'active' },
          });
          await loadPrograms();
        } catch (error) {
          handle(error, el('programMessage'));
        } finally {
          toggle.disabled = false;
        }
      });
      right.appendChild(toggle);
    }

    row.appendChild(right);
    return row;
  }

  async function loadPrograms() {
    const rows = el('programRows');
    rows.innerHTML = '';
    try {
      /*
       * The envelope unwraps a controller returning { items } into { data },
       * so the array is on .data rather than .items here.
       */
      const result = await window.api.request('/rewards/programs');
      const items = result.data || [];
      if (items.length === 0) {
        show(el('programMessage'), 'info', 'No programs yet.');
        return;
      }
      el('programMessage').innerHTML = '';
      items.forEach((program) => rows.appendChild(programRow(program)));
    } catch (error) {
      handle(error, el('programMessage'));
    }
  }

  async function createProgram() {
    const button = el('createProgram');
    button.disabled = true;
    try {
      const budget = el('programBudget').value.trim();
      const currency = el('programCurrency').value.trim().toUpperCase();
      const body = {
        name: el('programName').value.trim(),
        timezone: el('programTimezone').value.trim(),
        defaultCurrencyCode: currency || null,
      };
      if (budget) {
        body.budgetMinor = Number(budget);
        body.budgetCurrencyCode = currency || null;
      }
      await window.api.request('/rewards/programs', { method: 'POST', body: body });
      show(el('createProgramMessage'), 'ok', 'Created. It starts as a draft.');
      el('programName').value = '';
      await loadPrograms();
    } catch (error) {
      handle(error, el('createProgramMessage'));
    } finally {
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rules                                                               */
  /* ------------------------------------------------------------------ */

  function ruleRow(rule) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const label = TRIGGERS.find((t) => t[0] === rule.triggerKind);
    const name = document.createElement('strong');
    name.textContent = label ? label[1] : rule.triggerKind;
    left.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'hint';
    const cap = rule.capScope === 'none' ? 'no cap' : rule.capCount + ' per ' + rule.capScope;
    const hold = rule.holdHours > 0 ? rule.holdHours + 'h hold' : 'granted immediately';
    meta.textContent = cap + ' · ' + hold + ' · v' + rule.version;
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(pill(rule.isActive ? 'on' : 'off', rule.isActive ? 'ok' : 'none'));
    row.appendChild(right);
    return row;
  }

  async function selectProgram(program) {
    selectedProgram = program;
    el('rulesPanel').hidden = false;
    el('rulesProgramName').textContent = program.name;
    el('createRulePanel').hidden = permissions.indexOf('rewards.manage') === -1;

    const rows = el('ruleRows');
    rows.innerHTML = '';
    try {
      const result = await window.api.request(
        '/rewards/rules?programRefId=' + encodeURIComponent(program.refId),
      );
      const items = result.data || [];
      if (items.length === 0) {
        show(el('ruleMessage'), 'info', 'No rules yet. A program with no rules awards nothing.');
        return;
      }
      el('ruleMessage').innerHTML = '';
      items.forEach((rule) => rows.appendChild(ruleRow(rule)));
    } catch (error) {
      handle(error, el('ruleMessage'));
    }
  }

  async function createRule() {
    if (!selectedProgram) return;
    const button = el('createRule');
    button.disabled = true;
    try {
      const kind = el('benefitKind').value;
      const mode = el('benefitMode').value;
      const amount = Number(el('benefitAmount').value || 0);

      const benefit = { benefitKind: kind, awardMode: mode, awardCap: null, config: {} };
      if (kind === 'grant_points') {
        benefit.config = { points: amount };
      } else if (kind === 'grant_currency') {
        benefit.config = {
          minorUnits: amount,
          currencyCode: (selectedProgram.defaultCurrencyCode || 'INR').toUpperCase(),
        };
      } else {
        benefit.config = { itemRef: el('benefitItemRef').value.trim(), validForDays: null };
      }
      /*
       * "Up to" needs a ceiling for the factor to scale, and the amount field
       * IS that ceiling. The server refuses up_to on a kind that cannot be
       * divided, so an item never reaches here with it set.
       */
      if (mode === 'up_to') benefit.awardCap = amount;

      await window.api.request('/rewards/rules', {
        method: 'POST',
        body: {
          programRefId: selectedProgram.refId,
          triggerKind: el('ruleTrigger').value,
          capScope: el('ruleCapScope').value,
          capCount: 1,
          holdHours: Number(el('ruleHoldHours').value || 0),
          reversalPolicy: el('ruleReverse').checked ? 'on_content_deleted' : 'none',
          benefits: [benefit],
        },
      });
      show(el('createRuleMessage'), 'ok', 'Rule added.');
      await selectProgram(selectedProgram);
    } catch (error) {
      handle(error, el('createRuleMessage'));
    } finally {
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Balances                                                            */
  /* ------------------------------------------------------------------ */

  function walletRow(wallet) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const amount = document.createElement('strong');
    amount.textContent =
      wallet.walletKind === 'points'
        ? wallet.balance + ' points'
        : money(wallet.balance, wallet.currencyCode);
    left.appendChild(amount);

    if (wallet.balance < 0) {
      const warn = document.createElement('div');
      warn.className = 'hint';
      /*
       * A negative balance is real debt, not a glitch: the customer spent or
       * converted value that was later clawed back. It never expires and the
       * next earn offsets it.
       */
      warn.textContent = 'Owed back. The next thing they earn clears it first.';
      left.appendChild(warn);
    }
    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(pill(wallet.walletKind, 'none'));
    row.appendChild(right);
    return row;
  }

  function awardRow(award) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = when(award.occurredAtUtc);
    left.appendChild(title);

    if (award.reasonCode) {
      const why = document.createElement('div');
      why.className = 'hint';
      /*
       * The reason is the point of showing skipped awards at all. A row saying
       * "cap consumed" with its period is what answers "why didn't I get my
       * points?" without anybody opening a database.
       */
      why.textContent = String(award.reasonCode).replace(/[_:]/g, ' ');
      if (award.periodKey) why.textContent += ' · ' + award.periodKey;
      left.appendChild(why);
    }
    row.appendChild(left);

    const right = document.createElement('div');
    const good = award.status === 'granted';
    right.appendChild(pill(award.status, good ? 'ok' : award.status === 'held' ? 'warn' : 'none'));
    row.appendChild(right);
    return row;
  }

  async function lookUp() {
    const refId = el('customerRefId').value.trim();
    if (!refId) return;
    el('balanceRows').innerHTML = '';
    el('awardRows').innerHTML = '';
    try {
      const balances = await window.api.request(
        '/rewards/customers/' + encodeURIComponent(refId) + '/balances',
      );
      const wallets = (balances.data && balances.data.wallets) || [];
      if (wallets.length === 0) {
        show(el('balanceMessage'), 'info', 'This customer has earned nothing yet.');
      } else {
        el('balanceMessage').innerHTML = '';
        wallets.forEach((wallet) => el('balanceRows').appendChild(walletRow(wallet)));
      }

      ((balances.data && balances.data.entitlements) || []).forEach((item) => {
        const row = document.createElement('div');
        row.className = 'row';
        const left = document.createElement('div');
        left.textContent = item.itemRef + ' · ' + item.redemptionCode;
        row.appendChild(left);
        const right = document.createElement('div');
        right.appendChild(pill(item.status, item.status === 'issued' ? 'ok' : 'none'));
        row.appendChild(right);
        el('balanceRows').appendChild(row);
      });

      const awards = await window.api.request(
        '/rewards/customers/' + encodeURIComponent(refId) + '/awards',
      );
      (awards.data || []).forEach((award) => el('awardRows').appendChild(awardRow(award)));

      el('adjustPanel').hidden = permissions.indexOf('rewards.adjust') === -1;
    } catch (error) {
      handle(error, el('balanceMessage'));
    }
  }

  async function adjust() {
    const button = el('adjust');
    button.disabled = true;
    try {
      const kind = el('adjustWalletKind').value;
      await window.api.request('/rewards/adjustments', {
        method: 'POST',
        body: {
          customerRefId: el('customerRefId').value.trim(),
          walletKind: kind,
          currencyCode: kind === 'points' ? null : el('adjustCurrency').value.trim().toUpperCase(),
          amount: Number(el('adjustAmount').value || 0),
          reason: el('adjustReason').value.trim(),
        },
      });
      show(el('adjustMessage'), 'ok', 'Applied, and recorded against you.');
      el('adjustAmount').value = '';
      el('adjustReason').value = '';
      await lookUp();
    } catch (error) {
      handle(error, el('adjustMessage'));
    } finally {
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */

  function wireVisibility() {
    el('createProgramPanel').hidden = permissions.indexOf('rewards.manage') === -1;

    el('benefitKind').addEventListener('change', () => {
      const isItem = el('benefitKind').value === 'issue_entitlement';
      el('benefitItemRef').hidden = !isItem;
      el('benefitAmount').hidden = isItem;
      /*
       * An item cannot be "up to" — six tenths of a free coffee is nothing.
       * The server refuses it; disabling the option here means nobody has to
       * discover that by being rejected.
       */
      const mode = el('benefitMode');
      mode.value = isItem ? 'fixed' : mode.value;
      mode.disabled = isItem;
    });

    el('adjustWalletKind').addEventListener('change', () => {
      el('adjustCurrency').hidden = el('adjustWalletKind').value === 'points';
    });

    el('createProgram').addEventListener('click', createProgram);
    el('createRule').addEventListener('click', createRule);
    el('lookUp').addEventListener('click', lookUp);
    el('adjust').addEventListener('click', adjust);
  }

  async function start() {
    TRIGGERS.forEach(function (trigger) {
      const option = document.createElement('option');
      option.value = trigger[0];
      option.textContent = trigger[1];
      el('ruleTrigger').appendChild(option);
    });

    try {
      const me = await window.api.request('/auth/me');
      permissions = me.permissions || [];
      el('who').textContent = me.email || '';
      if (permissions.indexOf('rewards.view') === -1) {
        show(el('programMessage'), 'error', 'You do not have access to reward programs.');
        return;
      }
      wireVisibility();
      el('programTimezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await loadPrograms();
    } catch (error) {
      handle(error, el('programMessage'));
    }
  }

  start();
})();
