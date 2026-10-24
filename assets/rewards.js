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
  /*
   * THE TRIGGERS COME FROM THE SERVER, not from a list in here.
   *
   * This file used to carry its own copy — fourteen rows with their own
   * availability flags — which agrees with the API exactly until somebody
   * builds a producer and updates one of them. `GET /rewards/triggers`
   * serves the same list the create endpoints validate against, so the set
   * offered here and the set accepted there cannot drift.
   *
   * Filled by `loadTriggers()` before the picker is built.
   */
  let TRIGGERS = [];

  const GROUP_LABELS = {
    instagram: ['Instagram', 'Something a customer did. Pick as many as apply.'],
    system: [
      'Inside the system',
      'Not something a customer does — the engine raises it after a credit moves a balance. ' +
        'It cannot be combined with the Instagram triggers, because it is a transfer between ' +
        'your own balances rather than an interaction.',
    ],
  };

  const BALANCE_TRIGGER = 'points_balance_reached';

  /** ISO 1 = Monday … 7 = Sunday, matching the engine and Postgres. */
  const DAYS = [
    [1, 'Monday'],
    [2, 'Tuesday'],
    [3, 'Wednesday'],
    [4, 'Thursday'],
    [5, 'Friday'],
    [6, 'Saturday'],
    [7, 'Sunday'],
  ];

  /*
   * THE SAME CEILING THE SERVER ENFORCES, so the plus button stops where the
   * contract does. Offering a ninth and letting the save come back 422 is the
   * form disagreeing with the API about what is possible.
   */
  const MAX_SLOTS_PER_DAY = 8;

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
    /*
     * A MISSING BUSINESS CURRENCY IS NOT A FORM ERROR, so it does not get a
     * form error's treatment.
     *
     * Nothing on this screen is wrong — the rule is fine, the amount is fine.
     * What is missing lives on a different page, so saying "invalid" and
     * leaving them to work it out would be the unhelpful half of being
     * correct. The message names the remedy and the button performs it.
     *
     * Only ever reached for a rule that grants MONEY: a points programme
     * never needs a currency and is never asked for one.
     */
    if (error.code === 'ENTERPRISE_CURRENCY_NOT_SET') {
      showSettingsPrompt(
        target,
        'This rule grants money, and this business has not set a currency yet. ' +
          'Set one in business settings — or award points instead, which needs no currency.',
      );
      return;
    }

    if (error.code === 'ENTERPRISE_TIMEZONE_NOT_SET') {
      showSettingsPrompt(
        target,
        'This rule counts days — a cap or a time window — and this business has not set a ' +
          'timezone yet, so there is no day to count against. Set one in business settings.',
      );
      return;
    }

    show(target, 'error', error.message, error.code);
  }

  /** The message plus the way out of it. */
  function showSettingsPrompt(target, sentence) {
    target.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'message error';

    const text = document.createElement('div');
    text.textContent = sentence;
    box.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const go = document.createElement('button');
    go.className = 'secondary';
    go.textContent = 'Open business settings';
    go.addEventListener('click', () => {
      window.location.href = 'settings.html';
    });
    actions.appendChild(go);
    box.appendChild(actions);

    target.appendChild(box);
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

    /*
     * THE INTERNAL NAME IS THE HEADING, because this screen is the business
     * looking at its own programmes and that is the name it identifies them
     * by. The customer-facing one is shown beside it so somebody can see what
     * the public will read — and its absence is stated rather than left as an
     * empty line, since "not chosen yet" is a real answer here.
     */
    const meta = document.createElement('div');
    meta.className = 'hint';
    meta.textContent = program.displayName
      ? 'Customers see: ' + program.displayName
      : 'No customer-facing name yet';
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
     * KEPT FOR AN ARCHIVED PROGRAMME TOO, and placed before the early return
     * below for exactly that reason: a retired programme is a record, and
     * "what was this awarding last March" is the question the record exists
     * to answer.
     */
    const history = document.createElement('button');
    history.className = 'secondary';
    history.textContent = 'History';
    history.title = 'What this programme looked like after every change.';
    history.addEventListener('click', () => showHistory(program));
    right.appendChild(history);

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

  /**
   * One version: what the programme was, and what moved to get there.
   *
   * `changed` is empty on version 1 — the first version changed nothing, it IS
   * the beginning — so that row says so rather than listing every field as
   * having appeared from nowhere.
   */
  function versionRow(version) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'v' + version.version;
    left.appendChild(title);

    const when = document.createElement('div');
    when.className = 'hint';
    const who =
      version.actorKind === 'system'
        ? 'by the system'
        : version.isImpersonated
          ? 'by Wouchh support'
          : 'by somebody here';
    when.textContent = new Date(version.at).toLocaleString() + ' · ' + who;
    left.appendChild(when);

    const changed = Object.keys(version.changed || {});
    const detail = document.createElement('div');
    detail.className = 'hint';
    if (changed.length === 0) {
      detail.textContent =
        version.version === 1 ? 'created' : 'no field changed';
    } else {
      detail.textContent = changed
        .map(function (field) {
          const move = version.changed[field];
          return field + ': ' + JSON.stringify(move.from) + ' → ' + JSON.stringify(move.to);
        })
        .join(' · ');
    }
    left.appendChild(detail);

    /*
     * The snapshot's own fields, not a guess at them. This printed
     * `snapshot.timezone`, which a programme no longer carries — it belongs
     * to the business now — so the line read "status active · undefined".
     */
    const snapshot = document.createElement('div');
    snapshot.className = 'hint';
    const shown = version.snapshot.displayName
      ? 'customers see "' + version.snapshot.displayName + '"'
      : 'no customer-facing name';
    snapshot.textContent =
      'status ' + version.snapshot.status + ' · "' + version.snapshot.name + '" · ' + shown;
    left.appendChild(snapshot);

    row.appendChild(left);
    return row;
  }

  async function showHistory(program) {
    el('historyPanel').hidden = false;
    el('historyProgramName').textContent = program.name;
    const rows = el('historyRows');
    rows.innerHTML = '';
    el('historyMessage').innerHTML = '';

    try {
      const result = await window.api.request(
        '/rewards/programs/' + program.refId + '/versions',
      );
      const items = itemsOf(result);
      if (items.length === 0) {
        show(el('historyMessage'), 'info', 'No history recorded for this program yet.');
        return;
      }
      items.forEach((version) => rows.appendChild(versionRow(version)));
    } catch (error) {
      handle(error, el('historyMessage'));
    }
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
    const target = el('createProgramMessage');

    const triggers = chosenTriggers();
    /*
     * CHECKED HERE ONLY WHERE THE ANSWER IS OBVIOUS AND LOCAL. The server
     * refuses all of this too — these two just save a round trip on the
     * mistakes somebody makes while still filling the form in.
     */
    if (triggers.length > 0 && draftBenefits.length === 0) {
      show(target, 'error', 'Add at least one reward, or the triggers award nothing.');
      return;
    }

    button.disabled = true;
    try {
      const balancePicked = triggers.indexOf(BALANCE_TRIGGER) !== -1;
      const body = {
        name: el('programName').value.trim(),
        /* Empty means unset, not an empty name — the server normalises it to
         * null, and sending "" would be asking it to. */
        displayName: el('programDisplayName').value.trim() || null,
        triggers: triggers,
        capScope: el('ruleCapScope').value,
        holdHours: balancePicked ? 0 : Number(el('ruleHoldHours').value || 0),
        benefits: draftBenefits,
        schedule: readSchedule(),
      };
      /* Sent only with the trigger it belongs to; on anything else the server
       * refuses it as a condition the engine would never consult. */
      if (balancePicked) {
        body.minPointsBalance = Number(el('ruleMinPointsBalance').value || 0);
      }

      await window.api.request('/rewards/programs', { method: 'POST', body: body });
      show(
        target,
        'ok',
        triggers.length > 0
          ? 'Created as a draft, with ' +
              triggers.length +
              (triggers.length === 1 ? ' rule' : ' rules') +
              '. Switch it on when you are ready.'
          : 'Created as a draft. It has no triggers yet, so it awards nothing.',
      );
      resetProgramForm();
      await Promise.all([loadPrograms(), loadDashboard()]);
    } catch (error) {
      handle(error, target);
    } finally {
      button.disabled = false;
    }
  }

  /** Back to empty, so the next programme does not inherit the last one. */
  function resetProgramForm() {
    el('programName').value = '';
    el('programDisplayName').value = '';
    el('ruleCapScope').value = 'none';
    el('ruleHoldHours').value = '0';
    el('scheduleStartsAt').value = '';
    el('scheduleEndsAt').value = '';
    draftBenefits = [];
    renderDraft();
    renderTriggers();
    renderSchedule();
    syncTriggerFields();
    setTriggerMenuOpen(false);
  }


  /* ------------------------------------------------------------------ */
  /* Rules                                                               */
  /* ------------------------------------------------------------------ */

  function ruleRow(rule) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const label = TRIGGERS.find((t) => t.key === rule.triggerKind);
    const name = document.createElement('strong');
    name.textContent = label ? label.label : rule.triggerKind;
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

    /*
     * THE SWITCH THAT HAD NO BUTTON.
     *
     * The endpoint existed and nothing called it, so a rule could be created
     * and never turned off again from here — the pill reported a state the
     * screen could not change. Behind `rewards.manage` like every other
     * control, and absent on an archived programme, which awards nothing
     * whatever its rules say.
     */
    const archived = selectedProgram && selectedProgram.status === 'archived';
    if (!archived && permissions.indexOf('rewards.manage') !== -1) {
      const toggle = document.createElement('button');
      toggle.className = 'secondary';
      toggle.textContent = rule.isActive ? 'Switch off' : 'Switch on';
      toggle.title = rule.isActive
        ? 'Stop this rule awarding. The programme and its other rules carry on.'
        : 'Let this rule start awarding again.';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await window.api.request('/rewards/rules/' + rule.refId + '/active', {
            method: 'PATCH',
            /* A real boolean: the server rejects anything else now, which is
             * what stopped a typo quietly switching a money rule off. */
            body: { isActive: !rule.isActive },
          });
          await selectProgram(selectedProgram);
        } catch (error) {
          handle(error, el('ruleMessage'));
        } finally {
          toggle.disabled = false;
        }
      });
      right.appendChild(toggle);
    }

    row.appendChild(right);
    return row;
  }

  async function selectProgram(program) {
    selectedProgram = program;
    el('rulesPanel').hidden = false;
    el('rulesProgramName').textContent = program.name;

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


  /* ------------------------------------------------------------------ */
  /* The one form                                                        */
  /* ------------------------------------------------------------------ */

  /** Every trigger currently ticked. */
  function chosenTriggers() {
    return Array.from(document.querySelectorAll('.triggerPick:checked')).map((box) => box.value);
  }

  /**
   * Renders the menu: a group heading, then its options, like an optgroup
   * that can hold checkboxes.
   *
   * A native `<select multiple>` cannot hold a checkbox and a native
   * `<select>` cannot hold anything but `<option>`, so a control that needs
   * BOTH a hierarchy and a tick per row has to be built. It is styled as the
   * select it replaces rather than announcing itself as something new.
   */
  function renderTriggers() {
    const menu = el('triggerMenu');
    menu.innerHTML = '';

    /* Grouped in the order the server listed them, so the API decides what
     * exists and this decides only how it reads. */
    const groups = [];
    TRIGGERS.forEach(function (trigger) {
      let group = groups.find((g) => g.key === trigger.group);
      if (!group) {
        group = { key: trigger.group, triggers: [] };
        groups.push(group);
      }
      group.triggers.push(trigger);
    });

    groups.forEach(function (group) {
      const text = GROUP_LABELS[group.key] || [group.key, ''];

      const heading = document.createElement('div');
      heading.className = 'combo-group';
      heading.textContent = text[0];
      menu.appendChild(heading);

      if (text[1]) {
        const note = document.createElement('div');
        note.className = 'combo-group-note';
        note.textContent = text[1];
        menu.appendChild(note);
      }

      group.triggers.forEach(function (trigger) {
        const row = document.createElement('label');
        row.className = 'combo-option' + (trigger.available ? '' : ' is-disabled');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'triggerPick';
        input.value = trigger.key;
        input.dataset.group = trigger.group;
        /* Read back by syncTriggerFields, which toggles the two groups
         * against each other and must never re-enable one of these. */
        input.dataset.live = trigger.available ? 'true' : 'false';
        /*
         * Disabled, not hidden. One nobody can see is one somebody asks for
         * again next month — and the server refuses it on save too, so this
         * is the half that explains why rather than the half that enforces.
         */
        input.disabled = !trigger.available;
        input.addEventListener('change', syncTriggerFields);
        row.appendChild(input);

        const label = document.createElement('span');
        label.textContent = trigger.label;
        if (!trigger.available) {
          const why = document.createElement('span');
          why.className = 'why';
          why.textContent = 'not built yet';
          label.appendChild(why);
        }
        row.appendChild(label);

        menu.appendChild(row);
      });
    });
  }

  /** Fetches the list the server validates against. */
  async function loadTriggers() {
    const result = await window.api.request('/rewards/triggers');
    TRIGGERS = itemsOf(result);
    renderTriggers();
    syncTriggerFields();
  }

  /** Opens or closes the menu. */
  function setTriggerMenuOpen(open) {
    el('triggerMenu').hidden = !open;
    el('triggerToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /**
   * What the closed control says.
   *
   * Names up to two, then counts — a closed control listing seven triggers is
   * wider than the form and tells nobody anything they could not get by
   * opening it.
   */
  function renderTriggerSummary() {
    const chosen = chosenTriggers();
    const summary = el('triggerSummary');

    if (chosen.length === 0) {
      summary.className = 'placeholder';
      summary.textContent = 'Choose what sets this off';
      return;
    }

    const labels = chosen.map(function (value) {
      const found = TRIGGERS.find((t) => t.key === value);
      return found ? found.label : value;
    });

    summary.className = '';
    summary.textContent =
      labels.length <= 2 ? labels.join(', ') : labels[0] + ' and ' + (labels.length - 1) + ' more';
  }

  /**
   * Shows only the fields the chosen triggers actually use, and stops the two
   * groups being mixed.
   *
   * ENFORCED BY DISABLING, not by refusing on save. Ticking "reached a points
   * balance" greys out the Instagram options and vice versa, so the
   * combination cannot be expressed rather than being expressible and then
   * rejected. The server refuses it too — this is the half that explains why.
   */
  function syncTriggerFields() {
    const chosen = chosenTriggers();
    const balancePicked = chosen.indexOf(BALANCE_TRIGGER) !== -1;
    const socialPicked = chosen.some((t) => t !== BALANCE_TRIGGER);

    document.querySelectorAll('.triggerPick').forEach(function (box) {
      if (box.dataset.live === 'false') return;
      const isBalance = box.value === BALANCE_TRIGGER;
      box.disabled = isBalance ? socialPicked : balancePicked;
      box.closest('.combo-option').classList.toggle('is-disabled', box.disabled);
    });

    /* Only the balance trigger carries a threshold. */
    el('thresholdRow').hidden = !balancePicked;

    /*
     * A hold is a social idea — it exists so a comment deleted an hour later
     * never pays out, and nobody un-earns points by deleting something. The
     * server refuses the combination; hiding it is why nobody tries.
     */
    el('holdRow').hidden = balancePicked;
    if (balancePicked) el('ruleHoldHours').value = '0';

    renderTriggerSummary();
  }

  /** One from/to pair, with the button that removes it. */
  function slotRow(day) {
    const row = document.createElement('div');
    row.className = 'slot-row';

    const from = document.createElement('input');
    from.type = 'time';
    from.className = 'daySlotStart';
    row.appendChild(from);

    const to = document.createElement('input');
    to.type = 'time';
    to.className = 'daySlotEnd';
    row.appendChild(to);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary slot-remove';
    remove.textContent = '−';
    remove.title = 'Remove this window';
    remove.addEventListener('click', function () {
      row.remove();
      syncDay(day);
    });
    row.appendChild(remove);

    return row;
  }

  /**
   * Shows a day's hours only once the day is ticked, and keeps the add and
   * remove buttons honest about what is still possible.
   *
   * ONE EMPTY PAIR IS ALWAYS LEFT. A ticked day with no hours means the WHOLE
   * day, which is a real answer — so the last pair is never removable, and
   * leaving it blank is how somebody says "all of Friday".
   */
  function syncDay(day) {
    const ticked = day.querySelector('.dayPick').checked;
    const hours = day.querySelector('.day-hours');
    hours.hidden = !ticked;

    if (ticked && hours.querySelectorAll('.slot-row').length === 0) {
      hours.insertBefore(slotRow(day), hours.querySelector('.slot-add'));
    }

    const rows = hours.querySelectorAll('.slot-row');
    /* Nothing to remove when there is only the one that means "all day". */
    rows.forEach(function (row) {
      row.querySelector('.slot-remove').disabled = rows.length === 1;
    });
    /* And the plus stops where the contract does. */
    hours.querySelector('.slot-add').disabled = rows.length >= MAX_SLOTS_PER_DAY;
  }

  /**
   * Seven days, each a tick that reveals its own hours.
   *
   * Everything optional: no tick means the day is not restricted at all, a
   * tick with no hours means the whole of that day, and hours only count on a
   * ticked day. The absence of a restriction has to read as ALWAYS — the
   * opposite would silently disable whatever nobody filled in.
   */
  function renderSchedule() {
    const host = el('scheduleDays');
    host.innerHTML = '';

    DAYS.forEach(function (day) {
      const row = document.createElement('div');
      row.className = 'day-row';
      row.dataset.isoDay = String(day[0]);

      const label = document.createElement('label');
      label.className = 'day-pick';
      const tick = document.createElement('input');
      tick.type = 'checkbox';
      tick.className = 'dayPick';
      tick.value = String(day[0]);
      tick.addEventListener('change', function () {
        syncDay(row);
      });
      label.appendChild(tick);
      label.append(' ' + day[1]);
      row.appendChild(label);

      const hours = document.createElement('div');
      hours.className = 'day-hours';
      hours.hidden = true;

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'secondary slot-add';
      add.textContent = '+';
      add.title = 'Add another window on this day';
      add.addEventListener('click', function () {
        hours.insertBefore(slotRow(row), add);
        syncDay(row);
      });
      hours.appendChild(add);

      row.appendChild(hours);
      host.appendChild(row);
    });
  }

  /** The schedule as the API wants it: dates, and a day list with its hours. */
  function readSchedule() {
    const days = [];
    document.querySelectorAll('#scheduleDays .day-row').forEach(function (row) {
      const tick = row.querySelector('.dayPick');
      if (!tick || !tick.checked) return;

      const slots = [];
      row.querySelectorAll('.slot-row').forEach(function (slot) {
        const start = slot.querySelector('.daySlotStart').value;
        const end = slot.querySelector('.daySlotEnd').value;
        /* A half-filled pair is not a window. Both or neither — and neither
         * on every row is how somebody says "all of this day". */
        if (start && end) slots.push({ start: start, end: end });
      });

      days.push({ isoDay: Number(tick.value), slots: slots });
    });

    return {
      startsAt: el('scheduleStartsAt').value ? el('scheduleStartsAt').value : null,
      endsAt: el('scheduleEndsAt').value ? el('scheduleEndsAt').value : null,
      days: days,
    };
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
        show(el('createProgramMessage'), 'error', 'Give the item a reference.');
        return;
      }
    } else if (amount < 1) {
      show(el('createProgramMessage'), 'error', 'Enter how much this awards.');
      return;
    }
    if (kind === 'convert_value' && Number(el('benefitBurnPoints').value || 0) < 1) {
      show(el('createProgramMessage'), 'error', 'Enter how many points a conversion spends.');
      return;
    }
    el('createProgramMessage').innerHTML = '';

    const benefit = { benefitKind: kind, awardMode: mode, awardCap: null, config: {} };

    /*
     * NO CURRENCY IS SENT, and that is the change.
     *
     * This used to fall back to a hardcoded 'INR' — so a business that had
     * never said anything about rupees got a rule paying in them, and the
     * screen looked like it had worked. Omitting it means "the business's
     * own", which the server resolves; if the business has not set one, it
     * refuses with ENTERPRISE_CURRENCY_NOT_SET and the handler below says so
     * and offers to take them there.
     */
    if (kind === 'grant_points') {
      benefit.config = { points: amount };
    } else if (kind === 'grant_currency') {
      benefit.config = { minorUnits: amount };
    } else if (kind === 'convert_value') {
      benefit.config = {
        burnPoints: Number(el('benefitBurnPoints').value || 0),
        grantMinor: amount,
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

    /*
     * The three behaviours a real <select> gives for free and a built one has
     * to be handed: toggle, close on an outside click, close on Escape. Any
     * of them missing leaves a panel stuck open over the rest of the form.
     */
    el('triggerToggle').addEventListener('click', function () {
      setTriggerMenuOpen(el('triggerMenu').hidden);
    });
    document.addEventListener('click', function (event) {
      if (!el('triggerCombo').contains(event.target)) setTriggerMenuOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setTriggerMenuOpen(false);
    });

    el('createProgram').addEventListener('click', createProgram);
    el('addBenefit').addEventListener('click', addBenefit);
    el('toggleArchived').addEventListener('click', async () => {
      showingArchived = !showingArchived;
      /* A programme selected in one view should not stay open in the other. */
      el('rulesPanel').hidden = true;
      selectedProgram = null;
      await loadPrograms();
    });
    el('lookUp').addEventListener('click', lookUp);
    el('adjust').addEventListener('click', adjust);
  }

  async function start() {
    /* The schedule is static and can be built immediately; the triggers come
     * from the server and are filled in below, once the session is known. */
    renderSchedule();

    try {
      const me = (await window.api.request('/auth/me')).data;
      permissions = me.permissions || [];
      el('who').textContent = me.enterprise ? me.enterprise.name : '';
      if (permissions.indexOf('rewards.view') === -1) {
        show(el('programMessage'), 'error', 'You do not have access to reward programs.');
        return;
      }
      wireVisibility();
      await Promise.all([loadTriggers(), loadDashboard(), loadPrograms()]);
    } catch (error) {
      handle(error, el('programMessage'));
    }
  }

  start();
})();
