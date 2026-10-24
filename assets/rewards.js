(function () {
  if (!window.api.requireSession()) return;

  /*
   * The trigger list mirrors RewardTriggerKind on the server, and the third
   * column is the one that matters: CAN IT ACTUALLY FIRE TODAY.
   *
   * Only four triggers have a producer. The projector derives the trigger from
   * the CONVERSATION KIND, which knows three, plus the balance threshold the
   * engine raises itself. Everything else is modelled, accepted and saved by
   * the API — and never raised by anything.
   *
   * They stay listed rather than hidden, because a trigger nobody has built is
   * worth seeing, but they cannot be CHOSEN. A rule that can never fire should
   * not be creatable: saving one looks like success and produces silence, which
   * is how a programme called "dm loyalty" ends up listening for story mentions
   * and awarding nothing.
   */
  const TRIGGERS = [
    ['direct_message_inbound', 'Sent us a direct message', true],
    ['comment_on_own_post', 'Commented on our post', true],
    ['comment_on_mentioned_post', 'Commented on a post tagging us', true],
    /*
     * Not a social action: the engine raises it after any credit that moves a
     * points balance. It is what makes "30 points becomes RS 50" an ordinary
     * rule, and it carries a threshold nothing else does.
     */
    ['points_balance_reached', 'Reached a points balance', true],
    /*
     * These four arrive in the DM thread like any other message and are told
     * apart by facts already captured on it — see resolveDirectMessageTrigger.
     * EXACTLY ONE fires per event, most specific first: a story mention does
     * NOT also fire a "sent us a direct message" rule.
     */
    ['story_mention', 'Mentioned us in their story', true],
    ['story_reply', 'Replied to our story', true],
    ['referral_entry', 'Arrived from an ad, link or QR code', true],
    ['postback_tapped', 'Tapped a button', true],

    /* No producer. Listed so they are visible, disabled so they are not traps. */
    ['post_tagging_us', 'Posted and tagged us', false],
    ['message_reaction', 'Reacted to our message', false],
    ['opt_in_granted', 'Opted in', false],
    ['post_caption_mention', 'Named us in a caption', false],
    ['post_like', 'Liked our post', false],
    ['post_share', 'Shared our post', false],
  ];

  const BALANCE_TRIGGER = 'points_balance_reached';

  const el = (id) => document.getElementById(id);

  /*
   * The list endpoints answer `{ items: [...] }`.
   *
   * The envelope interceptor lifts `items` onto `data` only for a PAGINATED
   * payload — one carrying `pagination` — and the rewards lists carry none, so
   * `data` stays the wrapping object. Reading `data` as an array here is what
   * made every list on this page read as empty and then throw.
   */
  const itemsOf = (result) => (result.data && result.data.items) || [];

  let permissions = [];
  let selectedProgram = null;
  /* What the rule being built will carry. Cleared when the rule is created. */
  let draftBenefits = [];
  let draftSlots = [];

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
  /* Dashboard                                                           */
  /* ------------------------------------------------------------------ */

  function dashboardRow(program) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = program.name;
    left.appendChild(name);

    /*
     * The net figures, one line per wallet. An empty list means the program has
     * granted nothing yet, which is different from having granted zero.
     */
    const value = document.createElement('div');
    value.className = 'hint';
    value.textContent =
      program.value.length === 0
        ? 'nothing awarded yet'
        : program.value
            .map(function (v) {
              /*
               * `net` arrives as a STRING: int8 exceeds what a JS number holds
               * safely, so the API hands back text rather than a silently
               * rounded figure. Converted once, here, where it is about to be
               * rendered and nothing arithmetic happens to it afterwards.
               */
              const net = Number(v.net);
              return v.walletKind === 'points'
                ? net + ' points'
                : money(net, v.currencyCode);
            })
            .join(' · ');
    left.appendChild(value);

    const counts = document.createElement('div');
    counts.className = 'hint';
    const parts = [
      program.awardsGranted + ' granted',
      program.customersRewarded + ' customers',
    ];
    if (program.awardsHeld > 0) parts.push(program.awardsHeld + ' waiting');
    if (program.awardsReversed > 0) parts.push(program.awardsReversed + ' taken back');

    /*
     * Refusals, named by reason. A program granting 12 and refusing 400 is
     * working as configured — hiding that would make a correctly-capped
     * programme look broken, and it is the number that answers "why is nobody
     * earning?"
     */
    const refused = program.byStatus.filter(function (s) {
      return s.status.indexOf('skipped') === 0;
    });
    refused.forEach(function (s) {
      parts.push(s.awards + ' ' + s.status.replace('skipped_', 'refused: ').replace(/_/g, ' '));
    });
    counts.textContent = parts.join(' · ');
    left.appendChild(counts);

    if (program.budgetMinor !== null) {
      const budget = document.createElement('div');
      budget.className = 'hint';
      const pct = Math.round((program.spentMinor / program.budgetMinor) * 100);
      budget.textContent =
        money(program.spentMinor, program.budgetCurrencyCode) +
        ' of ' +
        money(program.budgetMinor, program.budgetCurrencyCode) +
        ' committed (' +
        pct +
        '%)';
      /* Past 90% a program is about to start refusing. Worth saying before it does. */
      if (pct >= 90) budget.textContent += ' — nearly spent';
      left.appendChild(budget);
    }

    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(pill(program.status, program.status === 'active' ? 'ok' : 'none'));
    row.appendChild(right);
    return row;
  }

  async function loadDashboard() {
    const rows = el('dashboardRows');
    rows.innerHTML = '';
    try {
      const result = await window.api.request('/rewards/dashboard');
      const items = itemsOf(result);
      if (items.length === 0) {
        show(el('dashboardMessage'), 'info', 'No programs yet.');
        return;
      }
      el('dashboardMessage').innerHTML = '';
      items.forEach(function (program) {
        rows.appendChild(dashboardRow(program));
      });
    } catch (error) {
      handle(error, el('dashboardMessage'));
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

    /*
     * AN ARCHIVED PROGRAMME IS A RECORD, so it keeps "Rules" — you can still
     * read what it did — and loses every control that would change it. The
     * server refuses those anyway; showing a button that always 409s would be
     * a lie told twice.
     */
    if (program.status === 'archived') {
      row.appendChild(right);
      return row;
    }

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

      const archive = document.createElement('button');
      archive.className = 'secondary';
      archive.textContent = 'Archive';
      archive.title = 'Retire this programme. It is kept as a record and cannot be switched on again.';
      archive.addEventListener('click', async () => {
        /*
         * ASKED, because it cannot be undone. The server enforces that; this
         * is so nobody discovers the rule by losing a programme to a stray
         * click on the button next to Pause.
         */
        const sure = window.confirm(
          'Archive "' +
            program.name +
            '"?\n\nIt stops awarding immediately and is kept as a record. This cannot be undone.',
        );
        if (!sure) return;

        archive.disabled = true;
        try {
          await window.api.request('/rewards/programs/' + program.refId + '/status', {
            method: 'PATCH',
            body: { status: 'archived' },
          });
          show(el('programMessage'), 'ok', '"' + program.name + '" archived.');
          await loadPrograms();
          await loadDashboard();
        } catch (error) {
          handle(error, el('programMessage'));
        } finally {
          archive.disabled = false;
        }
      });
      right.appendChild(archive);
    }

    row.appendChild(right);
    return row;
  }

  /* Which list is on screen. The working set, or the retired ones. */
  let showingArchived = false;

  async function loadPrograms() {
    const rows = el('programRows');
    rows.innerHTML = '';
    el('programsHeading').textContent = showingArchived
      ? 'Archived programs'
      : 'Reward programs';
    el('toggleArchived').textContent = showingArchived
      ? 'Back to active programs'
      : 'View archived';
    /* Creating a programme while looking at retired ones makes no sense. */
    el('createProgramPanel').hidden =
      showingArchived || permissions.indexOf('rewards.manage') === -1;

    try {
      /*
       * The envelope unwraps a controller returning { items } into { data },
       * so the array is on .data.items — see itemsOf.
       *
       * Archived programmes are excluded by the server unless asked for by
       * status, so the working list never shows a retired programme.
       */
      const result = await window.api.request(
        '/rewards/programs' + (showingArchived ? '?status=archived' : ''),
      );
      const items = itemsOf(result);
      if (items.length === 0) {
        show(
          el('programMessage'),
          'info',
          showingArchived ? 'Nothing archived yet.' : 'No programs yet.',
        );
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
      const items = itemsOf(result);
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
    if (draftBenefits.length === 0) {
      show(el('createRuleMessage'), 'error', 'A rule has to award something.');
      return;
    }

    const button = el('createRule');
    button.disabled = true;
    try {
      /*
       * AN EMPTY WINDOW LIST MEANS ALWAYS, never never. So no condition is
       * sent when nobody added one — sending an empty slots array would be a
       * window that can never match.
       */
      const conditions =
        draftSlots.length > 0
          ? [{ conditionKind: 'time_window', config: { slots: draftSlots } }]
          : [];

      await window.api.request('/rewards/rules', {
        method: 'POST',
        body: {
          programRefId: selectedProgram.refId,
          triggerKind: el('ruleTrigger').value,
          triggerConfig: triggerConfigFromForm(),
          capScope: el('ruleCapScope').value,
          capCount: 1,
          holdHours: Number(el('ruleHoldHours').value || 0),
          reversalPolicy: el('ruleReverse').checked ? 'on_content_deleted' : 'none',
          conditions: conditions,
          benefits: draftBenefits,
        },
      });
      show(el('createRuleMessage'), 'ok', 'Rule added.');
      draftBenefits = [];
      draftSlots = [];
      renderDraft();
      await selectProgram(selectedProgram);
    } catch (error) {
      handle(error, el('createRuleMessage'));
    } finally {
      button.disabled = false;
    }
  }

  /*
   * The threshold, and only for the trigger that takes one.
   *
   * The server refuses `minPointsBalance` on any other trigger and refuses its
   * absence on this one, so sending it unconditionally would 400 every rule.
   */
  function triggerConfigFromForm() {
    if (el('ruleTrigger').value !== BALANCE_TRIGGER) return {};
    return { minPointsBalance: Number(el('ruleMinPointsBalance').value || 0) };
  }

  function syncTriggerFields() {
    el('ruleThresholdRow').hidden = el('ruleTrigger').value !== BALANCE_TRIGGER;
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
      itemsOf(awards).forEach((award) => el('awardRows').appendChild(awardRow(award)));

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
      await loadDashboard();
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

  /* ------------------------------------------------------------------ */
  /* Building a rule                                                     */
  /* ------------------------------------------------------------------ */

  function describeBenefit(benefit) {
    const amount = benefit.awardMode === 'up_to' ? 'up to ' + benefit.awardCap : 'exactly ';
    if (benefit.benefitKind === 'grant_points') {
      return amount + (benefit.awardMode === 'up_to' ? ' points' : benefit.config.points + ' points');
    }
    if (benefit.benefitKind === 'grant_currency') {
      return (
        amount +
        (benefit.awardMode === 'up_to' ? '' : benefit.config.minorUnits) +
        ' ' +
        benefit.config.currencyCode
      );
    }
    if (benefit.benefitKind === 'convert_value') {
      return (
        benefit.config.burnPoints +
        ' points become ' +
        benefit.config.grantMinor +
        ' ' +
        benefit.config.currencyCode
      );
    }
    return 'the item ' + benefit.config.itemRef;
  }

  function renderDraft() {
    const benefitList = el('benefitList');
    benefitList.innerHTML = '';
    draftBenefits.forEach(function (benefit, index) {
      const row = document.createElement('div');
      row.className = 'row';
      const left = document.createElement('div');
      left.textContent = describeBenefit(benefit);
      row.appendChild(left);
      const remove = document.createElement('button');
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        draftBenefits.splice(index, 1);
        renderDraft();
      });
      row.appendChild(remove);
      benefitList.appendChild(row);
    });

    const conditionList = el('conditionList');
    conditionList.innerHTML = '';
    draftSlots.forEach(function (slot, index) {
      const row = document.createElement('div');
      row.className = 'row';
      const left = document.createElement('div');
      const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const wraps = slot.start > slot.end ? ' (into the next day)' : '';
      left.textContent =
        slot.days.map((d) => names[d]).join(', ') +
        ' · ' +
        slot.start +
        '–' +
        slot.end +
        wraps;
      row.appendChild(left);
      const remove = document.createElement('button');
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        draftSlots.splice(index, 1);
        renderDraft();
      });
      row.appendChild(remove);
      conditionList.appendChild(row);
    });
  }

  function addBenefit() {
    const kind = el('benefitKind').value;
    const mode = el('benefitMode').value;
    const amount = Number(el('benefitAmount').value || 0);

    /*
     * Caught here rather than left to the server. Every amount schema requires
     * a positive number, so a blank field becomes a 422 that says "too small"
     * about a field the person has not filled in — which reads like a bug
     * rather than an instruction.
     */
    if (kind === 'issue_entitlement') {
      if (!el('benefitItemRef').value.trim()) {
        show(el('createRuleMessage'), 'error', 'Give the item a reference.');
        return;
      }
    } else if (amount < 1) {
      show(el('createRuleMessage'), 'error', 'Enter how much this awards.');
      return;
    }
    if (kind === 'convert_value' && Number(el('benefitBurnPoints').value || 0) < 1) {
      show(el('createRuleMessage'), 'error', 'Enter how many points a conversion spends.');
      return;
    }
    el('createRuleMessage').innerHTML = '';
    const currency = (selectedProgram && selectedProgram.defaultCurrencyCode) || 'INR';

    const benefit = { benefitKind: kind, awardMode: mode, awardCap: null, config: {} };

    if (kind === 'grant_points') {
      benefit.config = { points: amount };
    } else if (kind === 'grant_currency') {
      benefit.config = { minorUnits: amount, currencyCode: currency.toUpperCase() };
    } else if (kind === 'convert_value') {
      benefit.config = {
        burnPoints: Number(el('benefitBurnPoints').value || 0),
        grantMinor: amount,
        currencyCode: currency.toUpperCase(),
      };
    } else {
      benefit.config = { itemRef: el('benefitItemRef').value.trim(), validForDays: null };
    }

    /*
     * "Up to" needs a ceiling for the factor to scale, and the amount field IS
     * that ceiling. The server refuses it on a kind that cannot be divided, so
     * the UI disables the option rather than letting somebody be rejected.
     */
    if (mode === 'up_to') {
      benefit.awardCap = amount;
      if (kind === 'grant_points') benefit.config.points = amount;
      if (kind === 'grant_currency') benefit.config.minorUnits = amount;
    }

    draftBenefits.push(benefit);
    renderDraft();
  }

  function addSlot() {
    const days = Array.prototype.slice
      .call(document.querySelectorAll('.slotDay:checked'))
      .map(function (box) {
        return Number(box.value);
      });
    if (days.length === 0) {
      show(el('createRuleMessage'), 'error', 'Pick at least one day for the window.');
      return;
    }
    const start = el('slotStart').value;
    const end = el('slotEnd').value;
    if (!start || !end) {
      show(el('createRuleMessage'), 'error', 'Give the window a start and an end time.');
      return;
    }
    /*
     * Equal times are the one case neither side can interpret: it is either an
     * empty window or a 24-hour one, and guessing either way would be wrong
     * half the time. The server treats start < end as a normal window and
     * start > end as a wrap, so equality has no meaning.
     */
    if (start === end) {
      show(
        el('createRuleMessage'),
        'error',
        'A window has to start and end at different times. For all day, leave the windows empty.',
      );
      return;
    }
    draftSlots.push({ days: days, start: start, end: end });
    el('createRuleMessage').innerHTML = '';
    renderDraft();
  }

  function wireVisibility() {
    el('createProgramPanel').hidden = permissions.indexOf('rewards.manage') === -1;

    el('benefitKind').addEventListener('change', () => {
      const kind = el('benefitKind').value;
      const isItem = kind === 'issue_entitlement';
      const isConvert = kind === 'convert_value';
      /* The WRAPPER, not the input: hiding the box alone strands its label. */
      el('benefitItemRefField').hidden = !isItem;
      el('benefitBurnPointsField').hidden = !isConvert;
      el('benefitAmountField').hidden = isItem;
      /*
       * An item cannot be "up to" — six tenths of a free coffee is nothing.
       * The server refuses it; disabling the option here means nobody has to
       * discover that by being rejected.
       */
      /*
       * Neither an item nor a conversion can be "up to". Six tenths of a free
       * coffee is nothing, and a conversion is a stated exchange rate — if a
       * factor could shave it, 30 points would sometimes buy 50 rupees and
       * sometimes 30, which is not a thing a business can explain.
       */
      const mode = el('benefitMode');
      const fixedOnly = isItem || isConvert;
      mode.value = fixedOnly ? 'fixed' : mode.value;
      mode.disabled = fixedOnly;
    });

    el('adjustWalletKind').addEventListener('change', () => {
      el('adjustCurrencyField').hidden = el('adjustWalletKind').value === 'points';
    });

    el('createProgram').addEventListener('click', createProgram);
    el('addBenefit').addEventListener('click', addBenefit);
    el('addSlot').addEventListener('click', addSlot);
    el('toggleArchived').addEventListener('click', async () => {
      showingArchived = !showingArchived;
      /* A programme selected in one view should not stay open in the other. */
      el('rulesPanel').hidden = true;
      el('createRulePanel').hidden = true;
      selectedProgram = null;
      await loadPrograms();
    });
    el('createRule').addEventListener('click', createRule);
    el('lookUp').addEventListener('click', lookUp);
    el('adjust').addEventListener('click', adjust);
  }

  async function start() {
    el('ruleTrigger').addEventListener('change', syncTriggerFields);
    TRIGGERS.forEach(function (trigger) {
      const option = document.createElement('option');
      option.value = trigger[0];
      option.textContent = trigger[2] ? trigger[1] : trigger[1] + ' — not built yet';
      /*
       * Disabled, not hidden. The first option is whatever the browser selects
       * by default, so a dead trigger at the top of this list is a rule that
       * silently never fires — which is exactly what happened twice.
       */
      option.disabled = !trigger[2];
      el('ruleTrigger').appendChild(option);
    });
    /* The select now holds a value; make the form agree with it. */
    syncTriggerFields();

    try {
      const me = (await window.api.request('/auth/me')).data;
      permissions = me.permissions || [];
      el('who').textContent = me.enterprise ? me.enterprise.name : '';
      if (permissions.indexOf('rewards.view') === -1) {
        show(el('programMessage'), 'error', 'You do not have access to reward programs.');
        return;
      }
      wireVisibility();
      el('programTimezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await Promise.all([loadDashboard(), loadPrograms()]);
    } catch (error) {
      handle(error, el('programMessage'));
    }
  }

  start();
})();
