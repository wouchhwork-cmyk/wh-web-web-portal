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

  /* And the same for rewards: `benefits` is capped at 16 on both create paths. */
  const MAX_REWARDS_PER_PROGRAM = 16;

  /*
   * THE REWARDS COME FROM THE SERVER TOO, for the reason the triggers do.
   * `GET /rewards/benefits` carries which are selectable at all and which need
   * a particular trigger chosen with them, so this form and the validator
   * cannot disagree about what is offerable.
   */
  let BENEFITS = [];

  /*
   * The business's currency, or NULL when it has not set one. Used for labels
   * and for how many decimal places money may be typed with — never to guess
   * one, which is the mistake this page has made before.
   */
  let BUSINESS_CURRENCY = null;

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
  /*
   * NULL = the form is creating. A refId = it is editing that programme, and
   * Save sends a PUT instead of a POST. One form, two verbs, and the heading
   * says which so nobody edits a programme believing they are making one.
   */
  let editingRefId = null;

  /*
   * CONDITIONS THIS FORM CANNOT SHOW, carried through untouched.
   *
   * The engine has condition kinds beyond days-and-hours — `customer_tenure`
   * and `content_match` — which can be set through the rules API and have no
   * control here. Held as opaque data and sent straight back on save, because
   * the alternative is what used to happen: the form saved what it understood
   * and silently destroyed the rest.
   *
   * Never edited here. If this form ever grows controls for them, this
   * variable is what they replace.
   */
  let carriedConditions = [];

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

    /*
     * "UPDATE", NOT "RULES".
     *
     * A business does not think in rules. It thinks "reward DMs and story
     * mentions, once a week, Friday evenings" — which is one programme and
     * happens to be several rules. The form that created it is the form that
     * edits it, so this reopens that form filled in rather than sending
     * somebody to a separate list of the pieces it was built from.
     *
     * An archived programme keeps a READ-ONLY route to the same information
     * through History, and never gets this button — see below.
     */
    if (permissions.indexOf('rewards.manage') !== -1 && program.status !== 'archived') {
      const update = document.createElement('button');
      update.className = 'secondary';
      update.textContent = 'Update';
      update.title = 'Reopen the full form, change anything, save once.';
      update.addEventListener('click', () => openForEditing(program));
      right.appendChild(update);
    }

    /*
     * VIEW AND HISTORY ARE BOTH READ-ONLY, so both sit before the early return
     * below and an ARCHIVED programme keeps them. A retired programme is a
     * record: "what was this configured to do" and "what did it look like last
     * March" are the questions the record exists to answer, and neither of
     * them changes anything.
     */
    const view = document.createElement('button');
    view.className = 'secondary';
    view.textContent = 'View';
    view.title = 'Everything this programme is set to do, read only.';
    view.addEventListener('click', () => openProgramView(program));
    right.appendChild(view);

    const people = document.createElement('button');
    people.className = 'secondary';
    people.textContent = 'Beneficiaries';
    people.title = 'Everyone this programme has rewarded.';
    people.addEventListener('click', () => openBeneficiaries(program));
    right.appendChild(people);

    const history = document.createElement('button');
    history.className = 'secondary';
    history.textContent = 'History';
    history.title = 'What this programme looked like after every change.';
    history.addEventListener('click', () => showHistory(program));
    right.appendChild(history);

    /*
     * AN ARCHIVED PROGRAMME IS A RECORD. It keeps History — "what was this
     * awarding last March" is the question the record exists to answer — and
     * loses every control that would change it. The server refuses those
     * anyway; showing a button that always 409s would be a lie told twice.
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
    /*
     * Creating or editing a programme while looking at retired ones makes no
     * sense, so the button goes away with the list it belongs to. The FORM is
     * not touched here any more — it is opened by "New program" or by
     * "Update", and this would otherwise reopen it on every list refresh.
     */
    el('newProgram').hidden = showingArchived || permissions.indexOf('rewards.manage') === -1;

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
    const editing = editingRefId !== null;

    const triggers = chosenTriggers();
    /*
     * CHECKED HERE ONLY WHERE THE ANSWER IS OBVIOUS AND LOCAL. The server
     * refuses all of this too — these two just save a round trip on the
     * mistakes somebody makes while still filling the form in.
     */
    const rewards = readRewards();
    if (rewards.error) {
      show(target, 'error', rewards.error);
      return;
    }
    /*
     * BOTH DIRECTIONS, as on the server. A programme with triggers and no
     * reward awards nothing; a programme with rewards and no trigger builds no
     * rule to hang them off, so they would be accepted and silently dropped.
     */
    if (triggers.length === 0) {
      show(
        target,
        'error',
        'Pick at least one trigger. Rewards need something to fire them, or nothing would ever award them.',
      );
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
        benefits: rewards.benefits,
        destination: el('rewardDestination').value,
        /* Returned exactly as they were read — see `carriedConditions`. */
        conditions: carriedConditions,
        schedule: readSchedule(),
      };
      /* Sent only with the trigger it belongs to; on anything else the server
       * refuses it as a condition the engine would never consult. */
      if (balancePicked) {
        body.minPointsBalance = Number(el('ruleMinPointsBalance').value || 0);
      }

      await window.api.request(
        editing ? '/rewards/programs/' + encodeURIComponent(editingRefId) : '/rewards/programs',
        { method: editing ? 'PUT' : 'POST', body: body },
      );
      show(
        target,
        'ok',
        editing
          ? 'Saved. The rules it had were retired and kept — awards already made still point at ' +
              'the version that decided them — and ' +
              triggers.length +
              (triggers.length === 1 ? ' rule was' : ' rules were') +
              ' written in their place.'
          : 'Created as a draft, with ' +
              triggers.length +
              (triggers.length === 1 ? ' rule' : ' rules') +
              '. Switch it on when you are ready.',
      );
      resetProgramForm();
      /* Shut once it has been saved. Leaving a blank form open afterwards is
       * how a business ends up looking at a form rather than at what it just
       * made; the confirmation moves to the list it was added to. */
      el('createProgramPanel').hidden = true;
      el('programMessage').innerHTML = target.innerHTML;
      target.innerHTML = '';
      await Promise.all([loadPrograms(), loadDashboard()]);
    } catch (error) {
      handle(error, target);
    } finally {
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reading one programme                                               */
  /* ------------------------------------------------------------------ */

  function setting(name, value) {
    const row = document.createElement('div');
    row.className = 'setting';

    const left = document.createElement('div');
    left.className = 'setting-name';
    left.textContent = name;
    row.appendChild(left);

    const right = document.createElement('div');
    right.className = 'setting-value';
    if (value instanceof Node) right.appendChild(value);
    else right.textContent = value;
    row.appendChild(right);

    return row;
  }

  const DAY_NAMES = {};
  DAYS.forEach(function (day) {
    DAY_NAMES[day[0]] = day[1];
  });

  /** A benefit as a sentence, using the business's currency for money. */
  function describeReward(benefit) {
    const config = benefit.config || {};
    const upTo = benefit.awardMode === 'up_to';
    if (benefit.benefitKind === 'grant_points') {
      return (upTo ? 'Up to ' : '') + config.points + ' points';
    }
    if (benefit.benefitKind === 'grant_currency') {
      return (
        (upTo ? 'Up to ' : '') + money(config.minorUnits, config.currencyCode || BUSINESS_CURRENCY)
      );
    }
    if (benefit.benefitKind === 'convert_value') {
      /* Said as the slab it is, because "20" and "200" side by side read as a
       * rate and are not one — a balance of 50 converts twice and keeps 10. */
      return (
        'Every ' +
        config.burnPoints +
        ' points becomes ' +
        money(config.grantMinor, config.currencyCode || BUSINESS_CURRENCY)
      );
    }
    return 'The item ' + config.itemRef;
  }

  /** The schedule as a person would read it back. */
  function describeSchedule(schedule) {
    const days = (schedule && schedule.days) || [];
    if (days.length === 0) return 'Any day, any time';

    const list = document.createElement('div');
    days.forEach(function (day) {
      const line = document.createElement('div');
      line.textContent =
        (DAY_NAMES[day.isoDay] || 'Day ' + day.isoDay) +
        ' — ' +
        (day.slots.length === 0
          ? 'all day'
          : day.slots
              .map(function (slot) {
                return slot.start + '–' + slot.end;
              })
              .join(', '));
      list.appendChild(line);
    });
    return list;
  }

  /**
   * Everything a programme is set to do, read only.
   *
   * THE SAME READ THE EDIT FORM USES. One endpoint describing a programme
   * means the screen that shows it and the screen that changes it cannot
   * disagree about what it says — and an archived programme, which can never
   * be edited again, still has somewhere to be read.
   */
  async function openProgramView(program) {
    const panel = el('programViewPanel');
    const host = el('viewRows');
    el('viewProgramName').textContent = program.name;
    host.innerHTML = '';
    panel.hidden = false;

    try {
      const result = await window.api.request(
        '/rewards/programs/' + encodeURIComponent(program.refId) + '/configuration',
      );
      const config = (result && result.data) || {};

      host.appendChild(setting('Internal name', config.name || '—'));
      host.appendChild(
        setting('Customers see', config.displayName || 'Not chosen yet — they would see nothing'),
      );
      host.appendChild(setting('Status', config.status || '—'));
      host.appendChild(setting('Version', 'v' + (config.version || 1)));

      const triggers = (config.triggers || []).map(function (key) {
        const found = TRIGGERS.find(function (t) {
          return t.key === key;
        });
        return found ? found.label : key;
      });
      host.appendChild(
        setting(
          'Sets it off',
          triggers.length > 0 ? triggers.join(', ') : 'Nothing — it awards nothing',
        ),
      );
      if (config.minPointsBalance) {
        host.appendChild(setting('Fires at a balance of', config.minPointsBalance + ' points'));
      }

      host.appendChild(
        setting(
          'How often it can pay out',
          config.capScope === 'none'
            ? 'No cap — as often as it is triggered'
            : config.capCount + ' per ' + config.capScope + ', per customer',
        ),
      );
      host.appendChild(
        setting(
          'Held before granting',
          config.holdHours > 0 ? config.holdHours + ' hours' : 'Granted immediately',
        ),
      );

      host.appendChild(
        setting(
          'Runs from',
          (config.schedule && config.schedule.startsAt
            ? dateOnly(config.schedule.startsAt)
            : 'Already running') +
            ' to ' +
            (config.schedule && config.schedule.endsAt
              ? dateOnly(config.schedule.endsAt)
              : 'no end'),
        ),
      );
      host.appendChild(setting('When', describeSchedule(config.schedule)));

      const rewards = document.createElement('div');
      const benefits = config.benefits || [];
      if (benefits.length === 0) {
        rewards.textContent = 'Nothing — it awards nothing';
      } else {
        benefits.forEach(function (benefit) {
          const line = document.createElement('div');
          line.textContent = describeReward(benefit);
          rewards.appendChild(line);
        });
      }
      host.appendChild(setting('What they get', rewards));

      if ((config.conditions || []).length > 0) {
        /*
         * NAMED, not rendered in detail. This screen cannot edit them and the
         * form cannot show them; what somebody needs to know here is that the
         * programme has extra qualifying rules, so the configuration they can
         * see is not the whole of it.
         */
        const extra = document.createElement('div');
        config.conditions.forEach(function (condition) {
          const line = document.createElement('div');
          line.textContent = String(condition.conditionKind).replace(/_/g, ' ');
          extra.appendChild(line);
        });
        host.appendChild(setting('Other conditions', extra));
      }

      host.appendChild(
        setting(
          'Where the value goes',
          config.destination === 'external'
            ? 'Marked for an external system — recorded only; nothing is sent yet'
            : 'Kept in Wouchh',
        ),
      );

      /* Stated here too, because this is the screen somebody reads before
       * deciding to edit — and the edit is where the flattening would happen. */
      if (config.uniform === false) {
        host.appendChild(
          setting(
            'Note',
            'This programme’s rules do not all share the same cap and hold. The values above are ' +
              'from one of them.',
          ),
        );
      }

      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      panel.hidden = true;
      handle(error, el('programMessage'));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Who a programme rewarded                                            */
  /* ------------------------------------------------------------------ */

  /*
   * WHERE THE NEXT PAGE STARTS, and which programme it belongs to.
   *
   * Both, because a cursor on its own is a cursor into whichever list was
   * open last — opening a second programme while the first still had pages
   * left would page through one programme's beneficiaries under the other
   * one's heading.
   */
  let peopleProgramRefId = null;
  let peopleCursor = null;

  function beneficiaryRow(person) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('div');
    const name = document.createElement('strong');
    /* A customer with no name is normal — they arrived through a platform that
     * gave us a handle and nothing else — so the absence is stated. */
    name.textContent = person.displayName || 'Unnamed customer';
    left.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'hint';
    meta.textContent = 'Last rewarded ' + when(person.lastAwardedAt);
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    right.appendChild(pill(person.granted + ' granted', person.granted > 0 ? 'ok' : 'none'));
    /* Shown only when there are any: three pills reading zero on every row is
     * noise that hides the one row where it is not zero. */
    if (person.held > 0) right.appendChild(pill(person.held + ' held', 'none'));
    if (person.reversed > 0) {
      /* `suspended` is the red variant this stylesheet already defines. A
       * made-up class name renders as an unstyled pill, which reads as if
       * nothing was taken back. */
      right.appendChild(pill(person.reversed + ' taken back', 'suspended'));
    }
    row.appendChild(right);

    return row;
  }

  /**
   * Opens the list, or appends the next page of it.
   *
   * ONE FUNCTION FOR BOTH, because they differ only in whether the rows are
   * cleared first — and two functions would be two places to keep the cursor
   * handling right.
   */
  async function loadBeneficiaries(append) {
    const button = el('morePeople');
    button.disabled = true;
    try {
      const query = peopleCursor === null ? '' : '?cursor=' + encodeURIComponent(peopleCursor);
      const result = await window.api.request(
        '/rewards/programs/' + encodeURIComponent(peopleProgramRefId) + '/beneficiaries' + query,
      );

      /* A paginated payload arrives with its items lifted onto `data` and its
       * pagination in `meta` — unlike the unpaginated lists on this page,
       * which keep `{ items }` inside `data`. */
      const rows = (result && result.data) || [];
      const pagination = (result && result.meta && result.meta.pagination) || {};

      const host = el('peopleRows');
      if (!append) host.innerHTML = '';
      rows.forEach(function (person) {
        host.appendChild(beneficiaryRow(person));
      });

      if (host.children.length === 0) {
        show(el('peopleMessage'), 'info', 'Nobody has been rewarded by this program yet.');
      } else {
        el('peopleMessage').innerHTML = '';
      }

      peopleCursor = pagination.nextCursor || null;
      button.hidden = !pagination.hasMore;
    } catch (error) {
      handle(error, el('peopleMessage'));
    } finally {
      button.disabled = false;
    }
  }

  async function openBeneficiaries(program) {
    /* Reset before the request, not after: leaving the previous programme's
     * cursor in place while this one loads is how page two of the wrong list
     * ends up under this heading. */
    peopleProgramRefId = program.refId;
    peopleCursor = null;
    el('peopleProgramName').textContent = program.name;
    el('peopleMessage').innerHTML = '';
    el('peopleRows').innerHTML = '';
    el('morePeople').hidden = true;
    el('peoplePanel').hidden = false;

    await loadBeneficiaries(false);
    el('peoplePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * Reopens the form on an existing programme, filled in.
   *
   * READ FROM THE SERVER, NOT FROM THE LIST ROW. The row carries a summary —
   * name, status, dates — and the form needs triggers, rewards, cap, hold and
   * the schedule. `GET /rewards/programs/:refId/configuration` returns exactly
   * the shape the PUT accepts, so what is loaded is what will be sent and
   * neither side has to reassemble the other's model.
   */
  async function openForEditing(program) {
    const target = el('createProgramMessage');
    target.innerHTML = '';
    try {
      const result = await window.api.request(
        '/rewards/programs/' + encodeURIComponent(program.refId) + '/configuration',
      );
      const config = (result && result.data) || {};

      resetProgramForm();
      el('programViewPanel').hidden = true;
      el('createProgramPanel').hidden = false;
      editingRefId = program.refId;
      el('programFormTitle').textContent = 'Update ' + config.name;
      el('createProgram').textContent = 'Update program';
      el('cancelEdit').hidden = false;

      el('programName').value = config.name || '';
      el('programDisplayName').value = config.displayName || '';
      el('ruleCapScope').value = config.capScope || 'none';
      el('ruleHoldHours').value = String(config.holdHours || 0);
      carriedConditions = config.conditions || [];
      el('rewardDestination').value = config.destination || 'internal';
      syncDestination();
      if (config.minPointsBalance) {
        el('ruleMinPointsBalance').value = String(config.minPointsBalance);
      }

      /* Dates arrive as timestamps and the inputs want YYYY-MM-DD. */
      el('scheduleStartsAt').value = dateOnly(config.schedule && config.schedule.startsAt);
      el('scheduleEndsAt').value = dateOnly(config.schedule && config.schedule.endsAt);

      fillTriggers(config.triggers || []);
      fillSchedule((config.schedule && config.schedule.days) || []);
      fillRewards(config.benefits || []);
      syncTriggerFields();

      /*
       * THE ONE CASE WHERE THIS FORM CANNOT TELL THE WHOLE TRUTH.
       *
       * It holds ONE cap and ONE hold for the programme, because the form
       * that creates one writes the same values onto every rule. A programme
       * whose rules were added separately can have rules that genuinely
       * differ — and saving here would flatten them to one answer. The server
       * says so with `uniform`; hiding it until after the save would be
       * finding out too late.
       */
      if (config.uniform === false) {
        show(
          target,
          'info',
          'This program’s rules do not all share the same cap and hold. This form holds one of ' +
            'each, so saving will give every rule the values shown here. Cancel if that is not ' +
            'what you want.',
        );
      }

      el('createProgramPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      handle(error, el('programMessage'));
    }
  }

  /** "2026-03-01T00:00:00.000Z" → "2026-03-01". Empty for anything else. */
  function dateOnly(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }

  function syncDestination() {
    const external = el('rewardDestination').value === 'external';
    const note = el('rewardDestinationNote');
    note.textContent = external
      ? 'Recorded on the program, and nothing is sent yet — the forwarding pipeline is not ' +
        'built. Choose this to state the intent; rewards continue to land in Wouchh balances ' +
        'until it is.'
      : 'One answer for the whole program, not per reward — a customer’s balance living in two ' +
        'places with nothing reconciling them is not a balance.';
    note.className = external ? 'field-note warn' : 'field-note';
  }

  /** Ticks exactly the triggers the programme runs on, and no others. */
  function fillTriggers(triggers) {
    document.querySelectorAll('.triggerPick').forEach(function (box) {
      box.checked = triggers.indexOf(box.value) !== -1;
    });
  }

  /**
   * Ticks the days and rebuilds their slots.
   *
   * A day with NO slots is a ticked day with the one empty pair `syncDay`
   * leaves behind — which is how this form says "the whole of that day", and
   * is exactly what the server sent back for one.
   */
  function fillSchedule(days) {
    document.querySelectorAll('#scheduleDays .day-row').forEach(function (row) {
      const tick = row.querySelector('.dayPick');
      const day = days.find(function (d) {
        return String(d.isoDay) === tick.value;
      });

      tick.checked = Boolean(day);
      const hours = row.querySelector('.day-hours');
      hours.querySelectorAll('.slot-row').forEach(function (slot) {
        slot.remove();
      });
      syncDay(row);
      if (!day || !day.slots || day.slots.length === 0) return;

      /* syncDay left one empty pair; the first slot fills it and the rest are
       * appended, so a three-slot day does not come back with four rows. */
      const add = hours.querySelector('.slot-add');
      day.slots.forEach(function (slot, index) {
        if (index > 0) hours.insertBefore(slotRow(row), add);
        const rows = hours.querySelectorAll('.slot-row');
        const target = rows[index];
        target.querySelector('.daySlotStart').value = slot.start;
        target.querySelector('.daySlotEnd').value = slot.end;
      });
      syncDay(row);
    });
  }

  /** One row per reward, in the order the programme holds them. */
  function fillRewards(benefits) {
    const host = el('rewardRows');
    host.innerHTML = '';

    /* A programme with no rewards still gets its one empty row, because the
     * form is never a form with nothing in it. */
    const list = benefits.length > 0 ? benefits : [null];
    const digits = currencyDigits(BUSINESS_CURRENCY);

    list.forEach(function (benefit) {
      const row = rewardRow();
      host.appendChild(row);
      if (!benefit) return;

      row.querySelector('.rewardKind').value = benefit.benefitKind;
      row.querySelector('.rewardMode').value = benefit.awardMode || 'fixed';

      const config = benefit.config || {};
      if (benefit.benefitKind === 'grant_points') {
        row.querySelector('.rewardPoints').value = String(config.points || '');
      } else if (benefit.benefitKind === 'grant_currency') {
        row.querySelector('.rewardMoney').value = fromMinorUnits(config.minorUnits, digits);
      } else if (benefit.benefitKind === 'convert_value') {
        row.querySelector('.rewardBurnPoints').value = String(config.burnPoints || '');
        row.querySelector('.rewardMoney').value = fromMinorUnits(config.grantMinor, digits);
      }
    });

    syncRewards();
  }

  /**
   * 250 → "2.50". The inverse of `toMinorUnits`, and by string for the same
   * reason: dividing by 100 reintroduces exactly the float error that padding
   * and concatenating avoids.
   */
  function fromMinorUnits(minor, digits) {
    if (minor === null || minor === undefined) return '';
    const text = String(Math.abs(Math.trunc(Number(minor) || 0)));
    if (digits === 0) return text;
    const padded = text.padStart(digits + 1, '0');
    return padded.slice(0, padded.length - digits) + '.' + padded.slice(padded.length - digits);
  }

  /** Back to empty AND back to creating, so neither carries into the next one. */
  function resetProgramForm() {
    editingRefId = null;
    carriedConditions = [];
    el('programFormTitle').textContent = 'New program';
    el('createProgram').textContent = 'Save program';
    el('cancelEdit').hidden = true;
    el('programEditNotice').innerHTML = '';
    el('programName').value = '';
    el('programDisplayName').value = '';
    el('ruleCapScope').value = 'none';
    el('ruleHoldHours').value = '0';
    el('ruleMinPointsBalance').value = '100';
    el('rewardDestination').value = 'internal';
    syncDestination();
    el('scheduleStartsAt').value = '';
    el('scheduleEndsAt').value = '';
    renderRewards();
    renderTriggers();
    renderSchedule();
    syncTriggerFields();
    setTriggerMenuOpen(false);
  }


  /* ------------------------------------------------------------------ */
  /* Rules                                                               */
  /* ------------------------------------------------------------------ */

  /*
   * THE RULES PANEL IS GONE, and with it `ruleRow` and `selectProgram`.
   *
   * A programme row used to open a list of the rules it was built from, each
   * with its own on/off switch. Nothing reaches that list any more: "Rules"
   * became "Update", which reopens the whole form instead, because a business
   * thinks in programmes and not in the rules a programme expands into.
   *
   * WHAT WENT WITH IT, said rather than quietly dropped: the per-rule switch.
   * Unticking a trigger in the form now retires that trigger's rule, which is
   * the same outcome by the route somebody would look for it on. The endpoint
   * it called (`PATCH /rewards/rules/:refId/active`) is untouched and still
   * works.
   */

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

    /* A conversion is only offerable while the balance trigger is chosen, so
     * the rewards have to be re-read whenever the triggers move. */
    syncRewards();
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

  /*
   * THE KEY FOR THE ADJUSTMENT CURRENTLY BEING MADE.
   *
   * Held across attempts and cleared on success, which is the whole point: a
   * send that times out and is pressed again reuses this key, so the server
   * recognises the retry and the customer is credited ONCE. A genuinely new
   * adjustment starts with none and gets a fresh one — including the case the
   * server cares about, the same employee crediting the same customer the
   * same amount twice on purpose.
   *
   * Disabling the button only covers a double-click while the request is in
   * flight. It does nothing for the case that actually loses money: the
   * request succeeded, the response never arrived, and somebody pressed again.
   */
  let adjustmentKey = null;

  function newIdempotencyKey() {
    /* `crypto.randomUUID` needs a secure context. The portal is served over
     * one, but a fallback costs two lines and beats throwing at the moment
     * somebody is trying to correct a customer's balance. */
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'adj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
  }

  async function adjust() {
    const button = el('adjust');
    button.disabled = true;
    if (adjustmentKey === null) adjustmentKey = newIdempotencyKey();
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
          idempotencyKey: adjustmentKey,
        },
      });
      /* Only on success. A failure keeps the key so the retry is recognised
       * as one rather than credited as a second adjustment. */
      adjustmentKey = null;
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

  /**
   * MONEY IS TYPED THE WAY IT IS SPOKEN, and converted here.
   *
   * The wire carries MINOR UNITS as an integer, which is the only honest way
   * to put money in JSON — 0.1 + 0.2 is not 0.3 in a double, and a rounding
   * error in a reward is money. But nobody thinks in minor units, and the old
   * field asked for them while claiming "500 is ₹5.00" about a business that
   * may never have mentioned rupees. So the field takes 5.00 and this turns
   * it into 500.
   *
   * THE SCALE COMES FROM THE CURRENCY, never a hardcoded two. JPY has no
   * minor unit and KWD has three; multiplying by 100 would be wrong in both.
   */
  function currencyDigits(code) {
    if (!code) return 2;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code })
        .resolvedOptions()
        .maximumFractionDigits;
    } catch (error) {
      return 2;
    }
  }

  /**
   * "12.34" → 1234. Null for anything that is not money.
   *
   * BY STRING, NOT BY ARITHMETIC. `2.675 * 100` is 267.49999999999997, so the
   * obvious implementation loses a unit on values a person would type. Padding
   * the fraction and concatenating cannot.
   *
   * The pattern has NO SIGN IN IT, so "-5" is rejected by shape rather than by
   * a comparison somebody could forget to write.
   */
  function toMinorUnits(text, digits) {
    const trimmed = String(text == null ? '' : text).trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const parts = trimmed.split('.');
    const fraction = parts[1] || '';
    /* More decimal places than the currency has is not a rounding question —
     * it is a number this currency cannot express, so it is refused. */
    if (fraction.length > digits) return null;
    const padded = (fraction + '0000000000').slice(0, digits);
    const minor = Number(parts[0] + padded);
    return Number.isSafeInteger(minor) ? minor : null;
  }

  /**
   * Points are WHOLE and never negative. Null for anything else.
   *
   * Again by shape: `Number("2.5")` is a perfectly good number and `parseInt`
   * would quietly read it as 2, which is how a business ends up awarding half
   * of what it typed. There is no such thing as half a point.
   */
  function toWholePoints(text) {
    const trimmed = String(text == null ? '' : text).trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const points = Number(trimmed);
    return Number.isSafeInteger(points) ? points : null;
  }

  /** The currency's name for a label, or a plain word when none is set. */
  function moneyUnitLabel() {
    return BUSINESS_CURRENCY || 'money';
  }

  /**
   * A field, its label and its note.
   *
   * THE NOTE SPAN IS ALWAYS BUILT, even when it starts empty. Building it only
   * when there was text to put in it left `syncRewards` dereferencing null on
   * the money field — which threw PART WAY THROUGH the row loop, so every row
   * after the first conversion kept whatever it was showing. A points row sat
   * there offering "Amount" and "Every … points" because the code that would
   * have hidden them never ran.
   */
  function labelled(text, control, note) {
    const box = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = text;
    box.appendChild(label);
    box.appendChild(control);
    const hint = document.createElement('span');
    hint.className = 'field-note';
    hint.textContent = note || '';
    box.appendChild(hint);
    return box;
  }

  function numberInput(className, placeholder, step) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = className;
    input.min = '0';
    input.step = step;
    input.placeholder = placeholder;
    input.addEventListener('input', syncRewards);
    return input;
  }

  /**
   * One reward, with the button that removes it.
   *
   * EVERY FIELD LIVES IN THE ROW. The old form had one set of inputs and an
   * "Add reward" button that copied them into a list, which meant what was on
   * screen and what would be saved were two different things — somebody could
   * type an amount, not press the button, press Save, and silently lose it.
   * Now the rows ARE the answer and the global save reads them.
   */
  function rewardRow() {
    const row = document.createElement('div');
    row.className = 'row reward-row';

    const kind = document.createElement('select');
    kind.className = 'rewardKind';
    BENEFITS.forEach(function (benefit) {
      const option = document.createElement('option');
      option.value = benefit.key;
      option.textContent = benefit.label;
      /* Marked here, enabled or disabled by syncRewards — which has to run
       * against the triggers anyway, so there is one place that decides. */
      option.dataset.available = String(benefit.available);
      option.dataset.requires = (benefit.requiresTrigger || []).join(',');
      kind.appendChild(option);
    });
    kind.addEventListener('change', syncRewards);
    row.appendChild(labelled('Reward', kind));

    const mode = document.createElement('select');
    mode.className = 'rewardMode';
    [
      ['fixed', 'Exactly'],
      ['up_to', 'Up to'],
    ].forEach(function (pair) {
      const option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      mode.appendChild(option);
    });
    row.appendChild(
      labelled(
        'Exactly, or up to',
        mode,
        '“Exactly” is a promise and is never shaved. “Up to” is a ceiling the scoring engine may scale down.',
      ),
    );

    const points = numberInput('rewardPoints', '20', '1');
    row.appendChild(labelled('Points', points, 'Whole points. There is no half a point.'));

    const money = numberInput('rewardMoney', '5.00', '0.01');
    const moneyBox = labelled('Amount', money, '');
    /* Hidden until syncRewards says otherwise, so a row never flashes every
     * field it owns between being appended and being read. */
    moneyBox.hidden = true;
    row.appendChild(moneyBox);

    /*
     * THE CONVERSION IS A SLAB, and it is asked for as one.
     *
     * "Every 20 points becomes 2.00" is not the same offer as "every 10 points
     * becomes 1.00" even though the ratio is identical: with the first, a
     * balance of 10 converts nothing and a balance of 50 converts 4.00 and
     * leaves 10 behind. The engine already works in whole slabs — it takes
     * floor(balance / burnPoints) of them — so the form has to show the slab
     * rather than two numbers that look like a rate.
     */
    const burn = numberInput('rewardBurnPoints', '20', '1');
    const burnBox = labelled('Every … points', burn, 'Spent from the customer, a slab at a time.');
    burnBox.hidden = true;
    row.appendChild(burnBox);

    const preview = document.createElement('div');
    preview.className = 'field-note reward-preview';
    row.appendChild(preview);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary reward-remove';
    remove.textContent = '−';
    remove.title = 'Remove this reward';
    remove.addEventListener('click', function () {
      row.remove();
      syncRewards();
    });
    row.appendChild(remove);

    return row;
  }

  /** One row to start with, exactly as a day starts with one slot. */
  function renderRewards() {
    const host = el('rewardRows');
    host.innerHTML = '';
    host.appendChild(rewardRow());
    syncRewards();
  }

  /**
   * Keeps every row honest about the triggers currently chosen, and the add
   * and remove buttons honest about what is still possible.
   *
   * THE SAME TWO RULES THE API ENFORCES, no more and no less: a reward with
   * nothing behind it cannot be chosen, and a conversion needs the balance
   * trigger. Greying them out is why nobody has to discover that by being
   * refused — it is not what makes it true.
   */
  function syncRewards() {
    const chosen = chosenTriggers();
    const rows = document.querySelectorAll('#rewardRows .reward-row');
    const digits = currencyDigits(BUSINESS_CURRENCY);

    /*
     * ONE ROW PER EFFECT, claimed in order.
     *
     * Two "points" rows are not two rewards — they are one reward of the sum,
     * written twice, giving a business two lines to maintain for one effect.
     * The server refuses it; taking the option away is why nobody tries.
     *
     * FIRST COME, FIRST SERVED, which is why this walks the rows in order
     * rather than computing "used by everybody else" per row. With the latter,
     * two rows holding the same kind would each see the other holding it and
     * BOTH would move — the row that was there first would lose its answer to
     * the row that was just added.
     *
     * The form never sets a per-reward currency, so an effect here is just its
     * kind. The contract keys on kind PLUS wallet, because two currency grants
     * in different currencies are genuinely two rewards; nothing on this
     * screen can produce that case yet.
     */
    const taken = new Set();
    let selectable = 0;

    rows.forEach(function (row) {
      const kind = row.querySelector('.rewardKind');

      Array.prototype.forEach.call(kind.options, function (option) {
        const requires = option.dataset.requires ? option.dataset.requires.split(',') : [];
        const triggerOk =
          requires.length === 0 ||
          requires.some(function (t) {
            return chosen.indexOf(t) !== -1;
          });
        const offerable = option.dataset.available === 'true' && triggerOk;
        option.disabled = !offerable || taken.has(option.value);
      });

      /* How many kinds could be chosen at all, counted once: it is what the
       * plus button stops at. Read before `taken` grows past this row. */
      if (selectable === 0) {
        selectable = Array.prototype.filter.call(kind.options, function (o) {
          const requires = o.dataset.requires ? o.dataset.requires.split(',') : [];
          return (
            o.dataset.available === 'true' &&
            (requires.length === 0 ||
              requires.some(function (t) {
                return chosen.indexOf(t) !== -1;
              }))
          );
        }).length;
      }

      /*
       * A SELECTION THAT HAS JUST BECOME INVALID IS MOVED, not left sitting
       * there disabled. A <select> keeps showing a disabled option it already
       * holds, and its value still submits — so unticking the balance trigger
       * while a conversion row was open would have sent a conversion the
       * server then refuses, with the screen showing it as chosen.
       */
      if (kind.selectedOptions.length && kind.selectedOptions[0].disabled) {
        const firstUsable = Array.prototype.find.call(kind.options, function (o) {
          return !o.disabled;
        });
        kind.value = firstUsable ? firstUsable.value : '';
      }

      const chosenKind = kind.value;
      if (chosenKind) taken.add(chosenKind);
      const isConvert = chosenKind === 'convert_value';
      const isMoney = chosenKind === 'grant_currency';
      const isPoints = chosenKind === 'grant_points';

      /* The WRAPPER, not the input: hiding the box alone strands its label. */
      row.querySelector('.rewardPoints').parentNode.hidden = !isPoints;
      row.querySelector('.rewardMoney').parentNode.hidden = !(isMoney || isConvert);
      row.querySelector('.rewardBurnPoints').parentNode.hidden = !isConvert;

      const money = row.querySelector('.rewardMoney');
      money.step = digits === 0 ? '1' : '0.' + '0'.repeat(digits - 1) + '1';
      money.parentNode.querySelector('.field-note').textContent = BUSINESS_CURRENCY
        ? 'In ' + BUSINESS_CURRENCY + ', as you would write it — ' + (digits === 0 ? '5' : '5.' + '0'.repeat(digits)) + '.'
        : 'This business has no currency set yet, so saving a money reward will ask you to set one.';
      money.parentNode.querySelector('label').textContent = isConvert
        ? '… becomes (' + moneyUnitLabel() + ')'
        : 'Amount (' + moneyUnitLabel() + ')';

      /*
       * Neither an item nor a conversion can be "up to". Six tenths of a free
       * coffee is nothing, and a conversion is a stated exchange rate — if a
       * factor could shave it, 20 points would sometimes buy 2.00 and
       * sometimes 1.20, which is not a thing a business can explain.
       */
      /*
       * "UP TO" ONLY WHERE THERE IS SOMETHING TO SCALE, and which kinds those
       * are comes from the server with the rest of the catalogue rather than
       * being named here. A conversion is a stated exchange rate: if a factor
       * could shave it, 20 points would sometimes buy 2.00 and sometimes 1.20.
       */
      const entry = BENEFITS.find(function (b) {
        return b.key === chosenKind;
      });
      const mode = row.querySelector('.rewardMode');
      const exactOnly = !entry || entry.scalable !== true;
      if (exactOnly) mode.value = 'fixed';
      mode.disabled = exactOnly;

      row.querySelector('.reward-preview').textContent = isConvert
        ? previewConversion(row, digits)
        : '';

      row.querySelector('.reward-remove').disabled = rows.length === 1;
    });

    /*
     * THE PLUS STOPS WHERE THE CHOICES DO. A row that could only repeat an
     * effect already chosen is a row whose dropdown would be entirely
     * disabled — offering it and then refusing every option in it is the form
     * disagreeing with itself.
     */
    const addButton = el('addReward');
    const exhausted = selectable > 0 && rows.length >= selectable;
    addButton.disabled = exhausted || rows.length >= MAX_REWARDS_PER_PROGRAM;
    addButton.title = exhausted
      ? 'Every kind of reward this program can give is already on the form.'
      : 'Add another reward';
  }

  /**
   * Says the slab back in words, with a worked example.
   *
   * This is the whole reason the slab is asked for as a slab: "every 20 points
   * becomes 2.00" and "every 10 points becomes 1.00" look like the same rate
   * and are not, and the only way to make that visible is to show what happens
   * to a balance that does not divide evenly.
   */
  function previewConversion(row, digits) {
    const burn = toWholePoints(row.querySelector('.rewardBurnPoints').value);
    const minor = toMinorUnits(row.querySelector('.rewardMoney').value, digits);
    if (!burn || minor === null || minor < 1) return '';

    const example = burn * 2 + Math.floor(burn / 2);
    const slabs = Math.floor(example / burn);
    const left = example - slabs * burn;
    return (
      'Every ' +
      burn +
      ' points becomes ' +
      money(minor, BUSINESS_CURRENCY) +
      '. A balance of ' +
      example +
      ' converts ' +
      money(minor * slabs, BUSINESS_CURRENCY) +
      ' and leaves ' +
      left +
      ' points behind.'
    );
  }

  /**
   * Every row, as the API wants them — or the first thing that is wrong.
   *
   * REFUSED HERE RATHER THAN BY THE SERVER only where the answer is local and
   * obvious. The server refuses all of it too; these messages exist because
   * "expected integer, received number" about `benefits[1].config.points` is
   * a true sentence that helps nobody filling in a form.
   */
  function readRewards() {
    const digits = currencyDigits(BUSINESS_CURRENCY);
    const benefits = [];
    const rows = document.querySelectorAll('#rewardRows .reward-row');

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const kind = row.querySelector('.rewardKind').value;
      const mode = row.querySelector('.rewardMode').value;
      const where = rows.length === 1 ? 'The reward' : 'Reward ' + (index + 1);

      if (!kind) return { error: where + ' has nothing chosen.' };

      const benefit = { benefitKind: kind, awardMode: mode, awardCap: null, config: {} };

      if (kind === 'grant_points') {
        const points = toWholePoints(row.querySelector('.rewardPoints').value);
        if (points === null || points < 1) {
          return { error: where + ' needs a whole number of points, 1 or more.' };
        }
        benefit.config = { points: points };
        if (mode === 'up_to') benefit.awardCap = points;
      } else if (kind === 'grant_currency') {
        const minor = toMinorUnits(row.querySelector('.rewardMoney').value, digits);
        if (minor === null) {
          return { error: where + ' needs an amount of money — ' + describeMoneyShape(digits) };
        }
        if (minor < 1) return { error: where + ' awards nothing. Enter an amount above zero.' };
        /*
         * NO CURRENCY IS SENT. Unstated means the business's own, which the
         * server resolves; sending one here is how a hardcoded 'INR' used to
         * make a business pay in a currency it had never mentioned.
         */
        benefit.config = { minorUnits: minor };
        if (mode === 'up_to') benefit.awardCap = minor;
      } else if (kind === 'convert_value') {
        const burn = toWholePoints(row.querySelector('.rewardBurnPoints').value);
        if (burn === null || burn < 1) {
          return { error: where + ' needs a whole number of points to spend, 1 or more.' };
        }
        const minor = toMinorUnits(row.querySelector('.rewardMoney').value, digits);
        if (minor === null) {
          return { error: where + ' needs what the points become — ' + describeMoneyShape(digits) };
        }
        if (minor < 1) {
          return { error: where + ' converts points into nothing. Enter an amount above zero.' };
        }
        benefit.config = { burnPoints: burn, grantMinor: minor };
      } else {
        /* Unreachable while the only other kind is unavailable, and here so it
         * stays unreachable rather than silently sending an empty config. */
        return { error: where + ' is not a reward that can be saved yet.' };
      }

      benefits.push(benefit);
    }

    return { benefits: benefits };
  }

  function describeMoneyShape(digits) {
    return digits === 0
      ? 'a whole number, as this currency has no minor unit.'
      : 'a number with at most ' + digits + ' decimal places, and never negative.';
  }

  /**
   * The business's currency, for labels and for the decimal places money may
   * be typed with. NULL IS A REAL ANSWER — a business that has not set one —
   * and so is a 403 from a user who may manage rewards without being allowed
   * to read enterprise settings. Neither is an error worth stopping the page
   * for: the save still refuses, and the refusal still offers the way out.
   */
  async function loadBusinessCurrency() {
    try {
      const result = await window.api.request('/enterprises/current');
      const data = result && result.data ? result.data : result;
      BUSINESS_CURRENCY = (data && data.currencyCode) || null;
    } catch (error) {
      BUSINESS_CURRENCY = null;
    }
  }

  /** The same list the create endpoints validate against, never a copy. */
  async function loadBenefits() {
    const result = await window.api.request('/rewards/benefits');
    BENEFITS = itemsOf(result);
  }

  function wireVisibility() {
    /*
     * THE FORM STAYS SHUT UNTIL SOMEBODY ASKS FOR IT.
     *
     * It used to be open on every visit, so the page a business sees when it
     * wants to check a programme was mostly a blank form for making another
     * one. It is a long form, it pushed the list of programmes off the screen,
     * and nothing on the page had asked for it.
     *
     * What permission controls now is the BUTTON that opens it; the panel
     * itself is opened by "New program" or by "Update" on a row.
     */
    el('newProgram').hidden = permissions.indexOf('rewards.manage') === -1;

    el('addReward').addEventListener('click', function () {
      el('rewardRows').appendChild(rewardRow());
      syncRewards();
    });

    /*
     * SAYS WHAT "EXTERNAL" ACTUALLY DOES TODAY.
     *
     * The choice is stored, audited and versioned like any other setting, and
     * NOTHING IS FORWARDED YET — the pipeline is designed in
     * `docs/reward-programs-design.md` §13 and not built. A toggle that looks
     * like it sends value somewhere and silently does not is the exact failure
     * this codebase keeps rediscovering, so the screen says so instead.
     */
    el('rewardDestination').addEventListener('change', syncDestination);

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

    el('newProgram').addEventListener('click', function () {
      /* Fresh every time: a form left holding the last programme is how the
       * next "new programme" quietly becomes an edit of it. */
      resetProgramForm();
      el('createProgramMessage').innerHTML = '';
      el('programViewPanel').hidden = true;
      el('createProgramPanel').hidden = false;
      el('createProgramPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      el('programName').focus();
    });

    el('closeView').addEventListener('click', function () {
      el('programViewPanel').hidden = true;
    });

    el('closePeople').addEventListener('click', function () {
      el('peoplePanel').hidden = true;
    });
    el('morePeople').addEventListener('click', function () {
      void loadBeneficiaries(true);
    });

    el('createProgram').addEventListener('click', createProgram);
    /* Abandons an edit without saving it, and puts the form back to creating
     * — leaving it half-filled with somebody else's programme is how the next
     * "new programme" quietly becomes an edit of the last one. */
    el('cancelEdit').addEventListener('click', function () {
      resetProgramForm();
      el('createProgramMessage').innerHTML = '';
      el('createProgramPanel').hidden = true;
    });
    el('toggleArchived').addEventListener('click', async () => {
      showingArchived = !showingArchived;
      /* Neither panel should outlive the list it was opened from — the
       * programme either refers to may not even be listed in the other view. */
      el('programViewPanel').hidden = true;
      el('peoplePanel').hidden = true;
      if (editingRefId !== null) {
        resetProgramForm();
        el('createProgramPanel').hidden = true;
      }
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
      await Promise.all([
        loadTriggers(),
        loadBenefits(),
        loadBusinessCurrency(),
        loadDashboard(),
        loadPrograms(),
      ]);
      /* After both, because a reward row is built from the served catalogue
       * and labelled with the business's currency. */
      renderRewards();
    } catch (error) {
      handle(error, el('programMessage'));
    }
  }

  start();
})();
