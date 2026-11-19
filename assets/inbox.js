/**
 * The shared inbox.
 *
 * Every list is cursor-paginated by the API, so this holds the cursor rather
 * than a page number — the feed changes while somebody reads it, and offsets
 * would repeat or skip conversations.
 */
(function () {
  if (!window.api.requireSession()) return;

  const rows = document.getElementById('rows');

  /*
   * The element that actually scrolls the list. The rows live inside a
   * panel inside the aside, and it is the aside that has the overflow — so
   * reading `rows.scrollTop` would read zero for ever and restore nothing.
   */
  function asidePane() {
    return document.querySelector('.inbox-aside') || document.documentElement;
  }
  const listMessage = document.getElementById('listMessage');
  const threadPanel = document.getElementById('threadPanel');
  const threadTitle = document.getElementById('threadTitle');
  const threadMeta = document.getElementById('threadMeta');
  const assistantState = document.getElementById('assistantState');
  const messages = document.getElementById('messages');
  const threadMessage = document.getElementById('threadMessage');
  const replyBox = document.getElementById('replyBox');
  const loadMore = document.getElementById('loadMore');

  let permissions = [];
  let cursor = null;
  let openRefId = null;
  /*
   * Whether the OPEN conversation allows comment moderation. The server decides
   * it — Instagram permits hide and delete only to the owner of the media a
   * comment sits on — so this is carried rather than re-derived.
   */
  let openCanModerate = false;
  let openConversation = null;
  /** This agent's own employee ref, so "assign to me" has something to send. */
  let myEmployeeRefId = null;
  /** Colleagues, loaded once and only when this agent may see them. */
  let team = null;
  /** Older messages in the open thread; null once the whole thread is loaded. */
  let threadCursor = null;
  /*
   * Minted per COMPOSED MESSAGE, not per attempt.
   *
   * It used to be `Date.now()` at send time, which meant every retry carried a
   * NEW key — so the mechanism protected against nothing except a double click
   * inside the same millisecond. The key is now issued once for what the agent
   * typed and reused for every attempt at sending it, which is the only shape
   * that makes a retry after a timeout safe.
   */
  let replyKey = null;

  function newReplyKey() {
    const random =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : String(Date.now()) + '-' + String(Math.random()).slice(2);
    return 'reply-' + random;
  }

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

  function rowFor(conversation) {
    /*
     * THE WHOLE ROW IS THE TARGET. It used to be a block of text with an
     * "Open" button at the end, so picking a conversation meant aiming at a
     * button instead of clicking the thing you were looking at. A button
     * element rather than a div, so it keeps the keyboard and the focus ring
     * a list of choices needs.
     */
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'conv';
    if (conversation.refId === openRefId) row.classList.add('is-open');
    row.addEventListener('click', function () {
      openThread(conversation.refId);
    });

    const customer = conversation.customer;

    /*
     * The picture. Meta's link EXPIRES after a few days, so a failure to
     * load is expected: the image removes itself and the name carries the
     * row, rather than leaving a broken-image icon on every older thread.
     */
    if (customer && customer.avatarUrl) {
      const face = document.createElement('img');
      face.className = 'conv-face';
      face.src = customer.avatarUrl;
      face.alt = '';
      face.loading = 'lazy';
      face.addEventListener('error', function () {
        face.remove();
      });
      row.appendChild(face);
    }

    const body = document.createElement('span');
    body.className = 'conv-body';

    /*
     * The PERSON leads, not the kind. A name is not always known — a direct
     * message carries only a platform id until the thread's participants are
     * read — so the kind is the fallback rather than the headline.
     */
    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent =
      (customer && customer.displayName) ||
      (customer ? 'Unnamed customer' : conversation.conversationKind.replace(/_/g, ' '));
    body.appendChild(name);

    /*
     * WHAT IT IS ABOUT, on its own line and clipped to one. A subject is the
     * customer's own first words on a comment or a mention, which is the
     * single most useful thing for choosing what to pick up next.
     */
    if (conversation.subject) {
      const snippet = document.createElement('span');
      snippet.className = 'conv-snippet';
      snippet.textContent = conversation.subject;
      body.appendChild(snippet);
    }

    const meta = document.createElement('span');
    meta.className = 'conv-meta';
    meta.textContent =
      conversation.conversationKind.replace(/_/g, ' ') +
      ' · ' +
      conversation.messageCount +
      ' message' +
      (conversation.messageCount === 1 ? '' : 's');
    body.appendChild(meta);

    /* Triage at a glance: somebody who follows you is not a cold contact. */
    const flags = document.createElement('span');
    flags.className = 'conv-meta';
    if (customer && customer.followsUs) flags.appendChild(pill('follows you', 'active'));
    if (customer && customer.isVerified) flags.appendChild(pill('verified', 'none'));
    if (conversation.unreadCount > 0) {
      flags.appendChild(pill(conversation.unreadCount + ' unread', 'pending'));
    }
    // Visible in the list, so an agent picking work knows before opening it.
    if (conversation.canReply === false) flags.appendChild(pill('reply closed', 'suspended'));
    /*
     * WHO HAS IT. The whole point of a shared inbox: without this, two agents
     * pick up the same conversation and the customer gets two answers.
     */
    if (conversation.assignedTo) {
      const mine = conversation.assignedTo.refId === myEmployeeRefId;
      flags.appendChild(
        pill(mine ? 'you' : conversation.assignedTo.name || 'assigned', mine ? 'active' : 'none'),
      );
    }
    if (flags.childNodes.length > 0) body.appendChild(flags);

    row.appendChild(body);

    const side = document.createElement('span');
    side.className = 'conv-side';
    const stamp = document.createElement('span');
    stamp.className = 'conv-when';
    stamp.textContent = when(conversation.lastMessageAt);
    side.appendChild(stamp);
    side.appendChild(pill(conversation.status, conversation.status));
    row.appendChild(side);

    return row;
  }

  async function load(reset) {
    /*
     * THE LIST REDRAWS ON A TIMER and on every change a colleague makes, so
     * resetting it throws away where somebody had scrolled to — every thirty
     * seconds, while they are reading it. The aside scrolls itself now,
     * which makes that far more noticeable than it was when the whole page
     * moved as one.
     */
    const listScroll = reset ? asidePane().scrollTop : 0;

    if (reset) {
      rows.innerHTML = '';
      cursor = null;
    }

    const status = document.getElementById('statusFilter').value;
    const mine = document.getElementById('mineOnly').checked;

    const query = ['limit=20'];
    if (status) query.push('status=' + encodeURIComponent(status));
    if (mine) query.push('assignedToMe=true');
    if (cursor) query.push('cursor=' + encodeURIComponent(cursor));

    try {
      const result = await window.api.request('/conversations?' + query.join('&'));
      const items = result.data || [];
      const pagination = (result.meta && result.meta.pagination) || {};

      if (items.length === 0 && rows.children.length === 0) {
        show(
          listMessage,
          'info',
          'Nothing here yet. Conversations appear once a customer messages or comments, or once a ' +
            'backfill has run for a connected account.',
        );
      } else {
        listMessage.innerHTML = '';
      }

      items.forEach(function (conversation) { rows.appendChild(rowFor(conversation)); });

      /* Back where they were, now that there is something to scroll. */
      if (reset) asidePane().scrollTop = listScroll;

      cursor = pagination.nextCursor || null;
      loadMore.hidden = !pagination.hasMore;
    } catch (error) {
      handle(error, listMessage);
    }
  }

  /*
   * One attachment.
   *
   * The URL is the PLATFORM's CDN link, used directly: Meta's terms forbid
   * storing or caching the media on our side, so there is nothing of ours to
   * serve. A link the API marks `expires` dies with its content, about 24
   * hours for a story, so a load failure is reported as "no longer available
   * on the platform" rather than left as a broken image.
   *
   * A STORY MENTION HAS NO KNOWABLE TYPE. Meta labels the attachment
   * `story_mention` whether the story was a photo or a video, and gives no
   * mime type anywhere in the webhook — a video story's link answers
   * `video/mp4`, and rendering it in an <img> simply fails. That failure used
   * to be reported as "no longer available", which was wrong twice over: the
   * link worked perfectly, and the message it replaced was the only thing on
   * screen saying this was a story at all. So an image that fails is retried
   * as a video before anything is declared gone.
   */

  /*
   * EVERYTHING THE PLATFORM SENT, on demand.
   *
   * We capture far more than the thread shows — asset ids, story and reel ids,
   * mime types, the shape of a shared post — and until now none of it was
   * visible anywhere, which is how a captured field gets quietly dropped for
   * looking useless. Collapsed by default so it costs an agent nothing, and one
   * click away when somebody is trying to work out what Meta actually said.
   *
   * `platformDetails` is explicitly NOT part of the API contract: keys come and
   * go as the projectors change. Read it, decide what deserves a real field,
   * and promote that — do not branch on it.
   */
  function detailsPanel(summary, payload) {
    if (!payload || Object.keys(payload).length === 0) return null;

    const box = document.createElement('details');
    box.style.marginTop = '4px';

    const label = document.createElement('summary');
    label.className = 'hint';
    label.style.cursor = 'pointer';
    label.textContent = summary + ' (' + Object.keys(payload).length + ')';
    box.appendChild(label);

    const body = document.createElement('pre');
    body.style.cssText =
      'white-space:pre-wrap;word-break:break-word;font-size:11px;margin:4px 0;' +
      'max-height:260px;overflow:auto;opacity:0.85';
    // textContent, never innerHTML: every value here came from a stranger.
    body.textContent = JSON.stringify(payload, null, 2);
    box.appendChild(body);

    return box;
  }

  /**
   * Every attachment leaves through here, whatever it turned out to be.
   *
   * THE RENDERER HAS AN EARLY RETURN PER MEDIA TYPE — audio, link, video, and
   * then image by falling through — and the description was originally
   * appended in the last of those. So it showed under photos and nowhere
   * else: videos and voice notes, which are the media an agent can least
   * afford to open one by one, were silently the ones missing it.
   *
   * One exit, so a branch added later cannot quietly lose it again.
   */
  function withDescription(wrap, attachment) {
    var described = describedNode(attachment);
    if (described) wrap.appendChild(described);
    return wrap;
  }

  function attachmentNode(attachment, messageKind) {
    var wrap = document.createElement('div');
    wrap.className = 'attachment';

    var isStory = messageKind === 'story_reply';

    /*
     * SAY WHAT WAS SHARED, because the picture alone does not.
     *
     * A story somebody sent you and a story somebody FORWARDED look identical
     * once rendered — same CDN image, same bubble — and they are not the same
     * thing at all. The platform type is the only thing that separates them,
     * and it was being used for `share` and ignored otherwise.
     *
     * The wording of the two story lines is deliberate. A story MENTION belongs
     * to the sender, so "their story" is a fact. A shared story belongs to a
     * third party we cannot identify — Meta sends a media id and an expiring
     * link and nothing else, and that id resolves for nobody but the connected
     * account — so it says "someone's" rather than inventing an owner.
     */
    var SHARED_LABELS = {
      story_mention: 'mentioned you in their story',
      ig_story: "shared someone's story",
      ig_reel: 'shared a reel',
      ig_post: 'shared a post',
    };

    var label = SHARED_LABELS[attachment.platformType] || (isStory ? SHARED_LABELS.story_mention : null);
    if (label) {
      var tag = document.createElement('small');
      tag.className = 'hint';
      tag.style.display = 'block';
      tag.textContent = label;
      wrap.appendChild(tag);
    }

    // The label above must survive whatever happens to the media below it.
    var slot = document.createElement('div');
    wrap.appendChild(slot);

    if (!attachment.url) {
      /*
       * NOTHING IN THE BOX. Meta named an attachment and sent no payload for
       * it — a shared COMMENT arrives exactly like this, as an empty `template`
       * — so there is no link, no caption and no media.
       *
       * It said "(document, no link)" before, which is our internal bucket for
       * the shape and tells an agent nothing about what the customer sent. The
       * caption above still renders when there is one; this is the last resort.
       */
      slot.textContent = attachment.title
        ? ''
        : 'the platform sent no content for this — open the chat in ' + platformName() + ' to see it';
      slot.style.fontStyle = 'italic';
      slot.style.opacity = '0.75';
      return withDescription(wrap, attachment);
    }

    /*
     * ABOVE THE BRANCHES, because two of them return.
     *
     * This sat after the link and video branches, so only an IMAGE ever
     * showed a caption — and the caption matters most on exactly the ones
     * that returned early: a shared advert's copy is the whole message, and
     * the thread was showing a picture and a url with none of the words.
     */
    if (attachment.title) slot.appendChild(expandableText(attachment.title));

    /*
     * The API says whether this can be SHOWN or only linked. Deriving it from
     * the media kind here was guesswork that got shares wrong: a shared reel is
     * a video whose link is an instagram.com page, not a file a <video> can
     * play.
     */
    var renderAs = attachment.renderAs || attachment.mediaKind;

    if (renderAs === 'audio') {
      var audio = document.createElement('audio');
      audio.src = attachment.url;
      audio.controls = true;
      slot.appendChild(audio);
      return withDescription(wrap, attachment);
    }

    if (renderAs === 'link') {
      /*
       * A SHARED REEL CANNOT BE SHOWN, only linked. Instagram serves its embed
       * page with x-frame-options: DENY, the oEmbed API that returns a
       * thumbnail needs Meta oEmbed Read through App Review, and the public
       * page carries no Open Graph tags for an unauthenticated fetch. The
       * Graph media endpoints only read media on accounts we manage, and this
       * is somebody else's.
       *
       * So it is drawn as a card rather than a bare link: an agent should be
       * able to see at a glance that a reel was shared, without the row looking
       * like a footnote. The permalink is permanent, unlike everything else
       * here, so following it always works.
       */
      /*
       * `share` IS NOT THE ONLY NAME FOR A SHARE.
       *
       * Meta labels a forwarded reel or post `ig_reel` / `ig_post` on some
       * deliveries and `share` on others — both carry the same thing, a
       * permanent instagram.com permalink rather than a media file. Only
       * `share` was recognised, so a reel shared on 19 Sep fell through to the
       * image path, put an instagram.com PAGE into an <img>, failed, and
       * reported "this video could not be loaded" about a link that works
       * perfectly. The same reel shared on 08 Sep arrived as `share` and
       * rendered its card correctly, which is why one showed a link and the
       * other did not.
       *
       * Recognised by the LINK as well as the label: the thing that makes this
       * a share is that the url is an instagram.com page, and that is true
       * whatever Meta decides to call it next.
       */
      /*
       * A CARD, not a bare link — but only for something that really is a page.
       *
       * The label was enough to force this card, which was wrong in the
       * direction that hurts: a shared ADVERT is labelled `ig_post` and carries
       * a CDN image, so it was drawn as a card containing a 400-character
       * signed url instead of the advert itself. The server now decides
       * renderability from the url, and this agrees with it.
       */
      var isShare = (attachment.url || '').indexOf('instagram.com/') !== -1;
      var isReel = isShare && (attachment.url || '').indexOf('/reel/') !== -1;

      var link = document.createElement('a');
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.display = 'inline-block';
      link.style.textDecoration = 'none';

      if (isShare) {
        var card = document.createElement('span');
        card.style.display = 'inline-flex';
        card.style.alignItems = 'center';
        card.style.gap = '8px';
        card.style.border = '1px solid currentColor';
        card.style.borderRadius = '8px';
        card.style.padding = '8px 12px';
        card.style.opacity = '0.85';

        var mark = document.createElement('span');
        mark.textContent = isReel ? '\u25B6' : '\u25A6';
        mark.style.fontSize = '18px';
        card.appendChild(mark);

        var text = document.createElement('span');

        var label = document.createElement('span');
        label.textContent = isReel ? 'Shared a reel' : 'Shared a post';
        label.style.display = 'block';
        label.style.fontWeight = '600';
        text.appendChild(label);

        /*
         * The URL itself, under the label. An agent about to open a link
         * somebody else sent them should be able to see where it goes first —
         * and it also says which reel, when the same thread carries several.
         *
         * Only a real permalink, though. This branch used to be reached by
         * CDN-backed shares too, and printing a 400-character signed blob
         * teaches nobody anything about where they are going.
         */
        var href = document.createElement('small');
        href.textContent = attachment.url;
        href.style.display = 'block';
        href.style.opacity = '0.7';
        href.style.wordBreak = 'break-all';
        text.appendChild(href);

        card.appendChild(text);

        link.appendChild(card);
      } else {
        // Meta's own word for the shape, which is not something to show an
        // agent — "template" describes the envelope, never the content.
        link.textContent = attachment.title || 'open attachment';
      }

      slot.appendChild(link);
      return withDescription(wrap, attachment);
    }

    if (renderAs === 'video') {
      slot.appendChild(videoNode(attachment, slot));
      return withDescription(wrap, attachment);
    }

    // image, gif, sticker — and a story mention, which may be either.

    var image = document.createElement('img');
    image.src = attachment.url;
    image.alt = isStory ? 'story mention' : attachment.mediaKind || 'attachment';
    image.loading = 'lazy';
    image.style.maxWidth = '220px';
    image.style.borderRadius = '8px';
    image.addEventListener('error', function () {
      /*
       * ANY of these links may turn out to be a video. Meta gives no mime type
       * for a story mention, a shared story or a shared post — all three arrive
       * as a CDN link that is a photo or a video, and only trying tells you
       * which. Reporting "no longer available" for a video that plays perfectly
       * was the first version of this.
       *
       * The API now SAYS when it is guessing — `attachment.kindIsGuessed`, set
       * for a story mention, whose payload carries no type at all. So this
       * first failure is declared rather than assumed, and the two sides agree
       * instead of each carrying its own private theory.
       *
       * Tried once: the video's own error handler shows the placeholder.
       */
      slot.replaceChildren(videoNode(attachment, slot));
    });
    slot.appendChild(image);
    return withDescription(wrap, attachment);
  }

  function videoNode(attachment, slot) {
    var video = document.createElement('video');
    video.src = attachment.url;
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.style.maxWidth = '260px';
    video.style.borderRadius = '8px';
    video.addEventListener('error', function () {
      /* Both renderings have now failed, so the link itself is the problem —
       * which is the moment to ask for a new one. */
      onMediaDead(attachment, slot);
    });
    return video;
  }

  /* ------------------------------------------------------------------ *
   * Replacing dead media links.
   *
   * Meta serves message media from links that expire and carry NO expiry in
   * the URL, so the server cannot predict a dead one — the browser is the
   * only party that finds out, by trying. The API has an endpoint for exactly
   * this, and until now nothing called it: a failed image fell through to a
   * video, the video failed too, and the thread said "no longer available"
   * without ever asking for a replacement.
   *
   * ONE REQUEST PER THREAD, NOT PER ATTACHMENT. A thread can hold dozens of
   * media; this one holds 36. Asking per broken image would fire 36 calls,
   * each re-reading the thread from Meta, to do the same work 36 times. The
   * first failure asks, everything else waits on that same answer.
   *
   * AND IT ASKS ONCE. If the refresh comes back with nothing refreshed, the
   * links are gone for good — Meta only returns the most recent messages of a
   * thread, so anything older is unrecoverable and asking again will not
   * change that. `exhausted` is how the thread stops trying.
   * ------------------------------------------------------------------ */
  /*
   * `rounds` is the stop. A successful refresh re-reads the thread, and a
   * re-read can surface another dead link, which would ask again — and a
   * fresh link that is itself already dead would turn that into a loop
   * hammering Meta for as long as the tab is open. Two rounds is enough for
   * the real case (some links replaced, the rest beyond reach) and cannot
   * become a cycle.
   */
  var MEDIA_REFRESH_ROUNDS = 2;
  var mediaRefresh = { refId: null, state: 'idle', waiting: null, rounds: 0 };

  function resetMediaRefresh(refId) {
    mediaRefresh = { refId: refId, state: 'idle', waiting: null, rounds: 0 };
  }

  /**
   * Asks the server to replace this thread's expired links, at most once.
   *
   * Resolves true when something was replaced and the thread is worth
   * re-reading, false when there is nothing more to be had.
   */
  function refreshThreadMedia(refId) {
    if (mediaRefresh.refId !== refId) resetMediaRefresh(refId);
    if (mediaRefresh.state === 'exhausted') return Promise.resolve(false);
    if (mediaRefresh.waiting) return mediaRefresh.waiting;
    if (mediaRefresh.rounds >= MEDIA_REFRESH_ROUNDS) {
      mediaRefresh.state = 'exhausted';
      return Promise.resolve(false);
    }

    mediaRefresh.state = 'running';
    mediaRefresh.rounds += 1;
    mediaRefresh.waiting = window.api
      .request('/conversations/' + encodeURIComponent(refId) + '/attachments/refresh', {
        method: 'POST',
      })
      .then(function (result) {
        var data = (result && result.data) || {};
        /*
         * `beyondReach` counts attachments whose message is older than the
         * window Meta will return. Those are permanently unrecoverable, and
         * the API documents that a client seeing them should stop asking.
         */
        var refreshed = data.refreshed || 0;
        mediaRefresh.state = refreshed > 0 ? 'idle' : 'exhausted';
        mediaRefresh.waiting = null;
        /*
         * THE RE-READ HAPPENS HERE, ONCE, and that placement is the whole
         * point. It used to sit in the caller — so all 36 dead attachments
         * attached a `.then` to this one shared promise and all 36 called
         * `openThread` when it resolved. The POST was deduplicated; the
         * reload it triggers was not. 36 simultaneous thread reads against a
         * 120-per-minute limit is a self-inflicted RATE_LIMITED, and each
         * reload re-rendered the same dead images to do it again.
         *
         * One refresh, one re-read. The waiting slots are replaced by the
         * re-render itself, so they need do nothing on success.
         */
        if (refreshed > 0 && openRefId === refId) void openThread(refId);
        return refreshed > 0;
      })
      .catch(function () {
        /*
         * A refresh that fails is not worth reporting: the thread already
         * shows the media is missing, and that is the thing the agent needs
         * to know. Marked exhausted so one broken call does not become one
         * per image.
         */
        mediaRefresh.state = 'exhausted';
        mediaRefresh.waiting = null;
        return false;
      });

    return mediaRefresh.waiting;
  }

  /**
   * What a dead link does now: ask for a replacement, and only give up if
   * there is none.
   */
  function onMediaDead(attachment, slot) {
    var refId = openRefId;
    if (!refId || !attachment.expires) {
      slot.replaceChildren(gone(attachment));
      return;
    }

    /*
     * THE SERVER HAS ALREADY LOOKED, AND THERE IS NOTHING THERE.
     *
     * Meta serves details for only the 20 most recent messages of a thread,
     * so once a refresh has failed for an attachment no later one can
     * succeed. `recoverable: false` is the server saying it has been
     * established — and it is the only way this client can know, because its
     * own "already tried" state lives in the tab and dies on reload. Without
     * this, every reopening of a thread full of long-dead media spent another
     * request to be told the same permanent thing.
     */
    if (attachment.recoverable === false) {
      slot.replaceChildren(gone(attachment));
      return;
    }

    slot.replaceChildren(refreshing());
    refreshThreadMedia(refId).then(function (replaced) {
      /* On success the whole thread is being re-read and this slot goes with
       * it, so there is nothing to do here but say when it failed. */
      if (!replaced) slot.replaceChildren(gone(attachment));
    });
  }

  /** Says a replacement is being fetched, so a blank box is not the answer. */
  function refreshing() {
    var note = document.createElement('small');
    note.className = 'hint';
    note.textContent = 'checking for a fresh link\u2026';
    return note;
  }

  /**
   * What this media WAS, in words.
   *
   * Shown whether or not the picture still loads, and that is the point of
   * both placements. Beside a working image it is a caption nobody has to ask
   * for; in place of a dead one it is the only surviving account of what the
   * customer sent — Meta expires these links and will not re-issue one past
   * the newest 20 messages of a thread.
   *
   * The API sends this only once the description is finished, so there is no
   * "analysing…" state to render here: a promise of something that may never
   * arrive is worse than silence.
   */
  function describedNode(attachment) {
    var analysis = attachment.analysis;
    if (!analysis) return null;
    if (!analysis.summary && !analysis.transcript && !analysis.visibleText) return null;

    var box = document.createElement('div');
    box.className = 'media-description';

    var label = document.createElement('small');
    label.className = 'hint';
    label.textContent = 'described by AI';
    box.appendChild(label);

    if (analysis.summary) {
      var summary = document.createElement('p');
      summary.className = 'media-summary';
      summary.textContent = analysis.summary;
      box.appendChild(summary);
    }

    /*
     * HEARD, READ AND SEEN — QUOTED SEPARATELY, and labelled.
     *
     * These are quoted rather than run together with the summary because one
     * is our description OF the media and the others are what was actually
     * in it; an agent acting on them should be able to see they are verbatim.
     *
     * They are LABELLED because the API stopped conflating them and this
     * panel had not caught up. `transcript` used to mean "everything said or
     * written"; it means sound alone now, so an image's on-screen text —
     * prices, a receipt total, the date on an invitation — rendered nowhere
     * at all, and the description looked like it had got worse when it had
     * in fact got more precise.
     */
    quoted(box, 'heard', analysis.transcript);
    quoted(box, 'read', analysis.visibleText);
    quoted(box, 'scene by scene', analysis.scenes);

    return box;
  }

  /** One verbatim block of a description, under what kind of thing it is. */
  function quoted(box, label, text) {
    if (!text) return;

    var head = document.createElement('small');
    head.className = 'hint media-part';
    head.textContent = label;
    box.appendChild(head);

    var quote = document.createElement('blockquote');
    quote.className = 'media-transcript';
    quote.textContent = text;
    box.appendChild(quote);
  }

  /** What to show once a platform link has genuinely stopped working. */
  function gone(attachment) {
    var wrap = document.createElement('div');

    var note = document.createElement('small');
    note.className = 'hint';
    note.textContent = attachment.expires
      ? 'this ' + (attachment.mediaKind || 'attachment') + ' is no longer available on the platform'
      : 'this ' + (attachment.mediaKind || 'attachment') + ' could not be loaded';
    wrap.appendChild(note);

    /*
     * No description is added here. `withDescription` has already put it on
     * the ATTACHMENT's wrapper, which is this slot's parent — so it survives
     * the slot being replaced, and adding it again would print it twice.
     */
    return wrap;
  }

  /*
   * The platform's own name, for the times we have to send somebody to it.
   *
   * Hardcoded as "Instagram" in two places before this, which was true of every
   * thread anybody had looked at and not true of the product: the same webhook
   * shapes arrive for a Facebook Page, and telling an agent to go and check
   * Instagram for a Messenger thread sends them somewhere the message is not.
   */
  const PLATFORM_NAMES = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    messenger: 'Messenger',
    whatsapp: 'WhatsApp',
  };

  function platformName() {
    const key = openConversation && openConversation.platform;
    // Falls back to the bare key, then to something that still reads as a
    // sentence — never to "undefined", which is how this class of bug shows up.
    return PLATFORM_NAMES[key] || key || 'the platform';
  }


  /**
   * Long text with a way to see the rest of it.
   *
   * CUT OFF AT 220 CHARACTERS AND THAT WAS THE END OF IT. A shared post's
   * caption is frequently the entire message — a carousel arriving on live
   * traffic carried about a thousand characters, of which an agent could read
   * the first fifth and never the ask buried at the bottom. The ellipsis looked
   * deliberate, which made it worse: nothing suggested there was more, so
   * nobody thought to go and look on the platform.
   *
   * Collapsed by default, because a thread of full captions is unreadable in a
   * different way. The control appears ONLY when there is something hidden, so
   * a short caption gains no furniture.
   */
  var CAPTION_PREVIEW_CHARS = 220;

  function expandableText(text) {
    var wrap = document.createElement('div');

    var body = document.createElement('small');
    body.className = 'hint';
    body.style.display = 'block';
    body.style.whiteSpace = 'pre-wrap';
    body.style.maxWidth = '320px';
    wrap.appendChild(body);

    if (text.length <= CAPTION_PREVIEW_CHARS) {
      // Short enough to simply show. No toggle, no ellipsis.
      body.textContent = text;
      return wrap;
    }

    /*
     * A real <button>, not a styled span: this is keyboard-reachable and
     * announces itself, and the captions most worth expanding are the ones
     * somebody is reading carefully.
     */
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'secondary';
    toggle.style.cssText =
      'display:block;margin-top:2px;padding:0;border:0;background:none;' +
      'font-size:11px;text-decoration:underline;cursor:pointer;opacity:0.8';

    var expanded = false;
    var render = function () {
      // textContent throughout: this is somebody else's caption, and it reaches
      // the page as words rather than as markup.
      body.textContent = expanded ? text : text.slice(0, CAPTION_PREVIEW_CHARS) + '…';
      toggle.textContent = expanded ? 'Show less' : 'Show more';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    };

    toggle.addEventListener('click', function () {
      expanded = !expanded;
      render();
    });

    render();
    wrap.appendChild(toggle);
    return wrap;
  }

  function messageRow(message) {
    /*
     * THEIRS AND OURS, TOLD APART BY SHAPE. Every message rendered
     * identically before this, so a thread read as a single voice and the
     * only way to know who said what was to read the direction word in the
     * meta line. An internal note gets its own colour for the same reason,
     * and a stronger one: it is the message that must never be mistaken for
     * something the customer can see.
     */
    const row = document.createElement('div');
    row.className = 'msg ' + (message.direction === 'outbound' ? 'outbound' : 'inbound');
    if (message.isInternalNote) row.classList.add('internal');

    const left = document.createElement('div');
    left.className = 'msg-bubble';

    /*
     * WHAT THIS ANSWERS, above the message itself — the way every messaging app
     * draws it. Instagram lets a customer reply to one specific message, and
     * without this their "Reply" is a loose line and nobody can tell which of
     * five outbound messages it was aimed at.
     */
    if (message.replyTo) {
      var quote = document.createElement('div');
      quote.className = 'hint';
      quote.style.borderLeft = '3px solid currentColor';
      quote.style.paddingLeft = '8px';
      quote.style.marginBottom = '4px';
      quote.style.opacity = '0.75';

      /*
       * WHO was answered, then WHAT. Three states, not two: an answer to
       * something we sent, an answer to something the customer said earlier,
       * and an answer to a message we never received — which says so plainly
       * rather than pretending the reply is a loose line.
       */
      var who = document.createElement('strong');
      who.style.display = 'block';
      who.textContent = message.replyTo.isSelfReply
        ? 'Replying to their own earlier message'
        : message.replyTo.direction === 'outbound'
          ? 'Replying to you'
          : 'Replying to';
      quote.appendChild(who);

      var what = document.createElement('span');
      // Excerpt only; the API trims it so the thread carries no second copy.
      what.textContent = message.replyTo.refId
        ? message.replyTo.excerpt || '(no text)'
        : 'a message we never received';
      quote.appendChild(what);

      left.appendChild(quote);
    }

    /*
     * REPLYING TO A STORY, which is not the same as replying to a message.
     *
     * A customer taps a story and types. Nothing is being answered and there is
     * no text to quote, so this cannot reuse the block above — it shows the
     * story itself, which is the whole context for whatever they said.
     *
     * The thumbnail is Meta's CDN link and dies with the story, about 24 hours,
     * so a failure to load is expected rather than a bug: the label survives on
     * its own and says the story has gone.
     */
    if (message.repliedToStory) {
      var storyQuote = document.createElement('div');
      storyQuote.className = 'hint';
      storyQuote.style.borderLeft = '3px solid currentColor';
      storyQuote.style.paddingLeft = '8px';
      storyQuote.style.marginBottom = '4px';
      storyQuote.style.opacity = '0.75';

      var storyWho = document.createElement('strong');
      storyWho.style.display = 'block';
      storyWho.textContent = 'Replying to your story';
      storyQuote.appendChild(storyWho);

      var storyUrl = message.repliedToStory.url;
      if (storyUrl) {
        var thumb = document.createElement('img');
        thumb.src = storyUrl;
        thumb.alt = 'the story they replied to';
        thumb.style.maxHeight = '120px';
        thumb.style.borderRadius = '6px';
        thumb.style.display = 'block';
        thumb.style.marginTop = '4px';
        /*
         * A story can be a video, and the CDN serves it under the SAME link
         * with no type to tell them apart — the same discovery-by-trying the
         * attachment renderer already does. A story that has expired fails
         * both ways, and then it says so.
         */
        thumb.onerror = function () {
          var video = document.createElement('video');
          video.src = storyUrl;
          video.controls = true;
          video.style.maxHeight = '120px';
          video.style.borderRadius = '6px';
          video.style.display = 'block';
          video.style.marginTop = '4px';
          video.onerror = function () {
            var gone = document.createElement('span');
            gone.textContent = 'this story has expired';
            storyQuote.replaceChild(gone, video);
          };
          storyQuote.replaceChild(video, thumb);
        };
        storyQuote.appendChild(thumb);
      } else {
        var noLink = document.createElement('span');
        noLink.textContent = 'the story is no longer available';
        storyQuote.appendChild(noLink);
      }

      left.appendChild(storyQuote);
    }

    const body = document.createElement('div');
    // Customer words: set as text, never as HTML.
    const attachments = message.attachments || [];

    /*
     * SENT, BUT THE PLATFORM WILL NOT SAY WHAT. A shared post, story or reel
     * whose webhook Meta dropped: the resync recovers the message id and its
     * time, and every read path returns it with no content — so this is
     * permanent, not pending. "(no text)" read as the customer sending an empty
     * message, which is the one thing that did not happen.
     */
    if (message.contentUnavailable) {
      /*
       * SAY WHAT TO DO, not only what went wrong.
       *
       * This read "sent something Instagram will not show us", which is
       * accurate and leaves the agent stuck: the content genuinely exists, it
       * is simply not in any API response, so the only way to see it is to open
       * the thread on the platform. Confirmed again on 26 Sep with a shared
       * PROFILE — Meta sent is_unsupported: true and nothing else at all: no
       * username, no id, no thumbnail, no link.
       */
      body.textContent =
        'Unsupported message — open this chat in ' + platformName() + ' to see it';
      body.style.fontStyle = 'italic';
      body.style.opacity = '0.75';
    } else if (message.platformSentNoText) {
      /*
       * A COMMENT THAT IS MEDIA. Instagram omits `text` entirely for a GIF, a
       * sticker or a photo in a comment, and exposes no field for the media on
       * ANY post — including our own, with full ownership, on every API version.
       *
       * This showed as a blank line, and the damage was not cosmetic: a reply
       * underneath asking about it read as a non-sequitur, which is exactly how
       * it turned up on live traffic.
       */
      body.textContent =
        'a photo or GIF — ' + platformName() + ' gives us no media for a comment';
      body.style.fontStyle = 'italic';
      body.style.opacity = '0.75';
    } else {
      body.textContent = message.body || (attachments.length ? '' : '(no text)');
    }

    /*
     * UNSENT ON INSTAGRAM, and still shown here on purpose. The business is
     * accountable for the conversation, and a record that rewrites itself when
     * somebody deletes a message is not a record — so the words stay and the
     * marker says the platform no longer shows them. Struck through, so nobody
     * quotes it back believing the customer can still see it.
     */
    if (message.deletedOnPlatform) {
      body.style.textDecoration = 'line-through';
      body.style.opacity = '0.7';
    }
    left.appendChild(body);

    if (message.deletedOnPlatform) {
      var unsent = document.createElement('small');
      unsent.className = 'hint';
      unsent.style.display = 'block';
      unsent.textContent =
        'deleted on Instagram' +
        (message.deletedOnPlatformAt ? ' · ' + when(message.deletedOnPlatformAt) : '') +
        ' — kept here';
      left.appendChild(unsent);
    }

    var facts = message.platformDetails || {};

    /*
     * THE CUSTOMER TAPPED SOMETHING rather than typing it.
     *
     * The body is the words on the button, which is right — that is the
     * customer's side of the exchange, and an agent should read "See menu", not
     * MENU_V2_EN. But a tap and a sentence are different acts: one is a choice
     * from what we offered, the other is a person writing to us, and replying
     * to the first as though it were the second reads badly.
     */
    if (facts.isPostback || facts.quickReplyPayload) {
      var tapped = document.createElement('small');
      tapped.className = 'hint';
      tapped.style.display = 'block';
      tapped.textContent = facts.isPostback ? 'tapped a button' : 'chose a quick reply';
      left.appendChild(tapped);
    }

    /*
     * HOW THEY GOT HERE. Meta tells us when a conversation started from an ad
     * or a referral link, and we have always stored it and never shown it —
     * which made it useless. An agent who knows the customer arrived from a
     * specific ad is answering a different question from one who does not.
     */
    if (facts.referral && typeof facts.referral === 'object') {
      var from = document.createElement('small');
      from.className = 'hint';
      from.style.display = 'block';
      var referralParts = [];
      if (facts.referral.source) referralParts.push(String(facts.referral.source).toLowerCase());
      if (facts.referral.ad_id) referralParts.push('ad ' + facts.referral.ad_id);
      if (facts.referral.ref) referralParts.push('ref ' + facts.referral.ref);
      from.textContent =
        'arrived from ' + (referralParts.length ? referralParts.join(' · ') : 'a referral');
      left.appendChild(from);
    }

    /*
     * The customer's emoji on this message. Shown ON the message, because that
     * is what it is: a reaction is a property of a message, not a line in the
     * conversation.
     */
    if (message.reaction) {
      var react = document.createElement('span');
      react.style.display = 'inline-block';
      react.style.marginTop = '2px';
      react.style.fontSize = '15px';
      react.title = message.reaction.name || 'reaction';
      react.textContent = message.reaction.emoji || '\u2764\ufe0f';
      left.appendChild(react);
    }

    // Media, where there is any. Before this the thread showed "(no text)" for
    // a photo, a GIF, a video or a story mention — which is every message whose
    // whole content is the attachment.
    attachments.forEach(function (attachment) {
      left.appendChild(attachmentNode(attachment, message.messageKind));
      const attachmentDetails = detailsPanel('everything Meta sent about this file', attachment.platformDetails);
      if (attachmentDetails) left.appendChild(attachmentDetails);
    });
    const meta = document.createElement('small');
    meta.className = 'hint';
    // WHO sent it, where the API knows: a shared inbox needs to show which
    // colleague answered, and the thread used to say only "outbound".
    const parts = [message.direction || message.messageKind || ''];
    /*
     * WHO WROTE IT. A comment thread carries several different customers — one
     * post, many commenters — and every inbound message was drawn as an unnamed
     * "inbound", so an agent could not tell two people apart or notice that a
     * reply came from somebody else entirely.
     */
    if (message.author) parts.push('@' + message.author);
    if (message.sentBy) parts.push(message.sentBy.name || 'a colleague');
    /*
     * SENT BY NOTHING HUMAN, and said plainly rather than left to inference.
     *
     * `sentBy` is null for a customer's own message AND for one the assistant
     * wrote, so its absence cannot distinguish them. An agent scrolling a
     * thread needs to know which words their business actually chose — most
     * of all when a customer is quoting one of them back.
     */


    if (message.isInternalNote) parts.push('internal note');
    // Read receipts are about OUR messages: whether the customer has seen it.
    if (message.seenAt) parts.push('seen ' + when(message.seenAt));
    parts.push(when(message.platformSentAt || message.createdAt));
    meta.textContent = parts.filter(Boolean).join(' · ');
    left.appendChild(meta);

    /*
     * WHAT THE ASSISTANT DID, on a line of its own.
     *
     * All of this used to be appended to the middot run above — direction,
     * author, model, handoff, timestamp, one sentence — and five facts in
     * one sentence read as none. It is also the line somebody acts on: a
     * handoff is a promise this business has just made, kept by a human who
     * has to know it was made.
     *
     * Built lazily and appended once at the end, because more than one thing
     * writes to it: an automatic reply explains itself, and any message of
     * ours can offer the notes behind it. Two <small> rows stacked under one
     * bubble read as two separate remarks about it.
     */
    let note = null;
    function assistantLine() {
      if (!note) {
        note = document.createElement('small');
        note.className = 'assistant-note';
      }
      return note;
    }

    if (message.automated) {
      assistantLine();

      if (message.handoff) {
        const flag = document.createElement('span');
        flag.className = 'pill expiring_soon';
        flag.textContent = 'needs a person';
        note.appendChild(flag);
      }

      note.appendChild(
        document.createTextNode(
          'Sent automatically' +
            (message.assistantModel ? ' by ' + message.assistantModel : '') +
            (message.handoff ? ' — ' + message.handoff : ''),
        ),
      );

      /*
       * THE QUESTION IS ASKED AT THE MESSAGE, so the answer is offered
       * here. It was only reachable from a list further down the page,
       * which meant finding the call that wrote THIS reply before you could
       * read what it was shown. The prompt is still not stored anywhere —
       * this rebuilds it.
       */
      if (message.promptRef) {
        const why = document.createElement('button');
        why.type = 'button';
        why.className = 'linklike';
        why.style.marginLeft = '6px';
        why.textContent = 'why did it say this?';
        why.addEventListener('click', function () {
          showPrompt({ refId: message.promptRef });
        });
        note.appendChild(why);

        /*
         * THE EXCHANGE ITSELF, which the rebuilt prompt is not.
         *
         * "why did it say this?" shows what we WOULD send if we built it
         * again now. This shows what actually went out and what actually
         * came back — and, since tools arrived, every round of it: a single
         * reply can be four calls, and the message row keeps only the last
         * one's ref, so asking by message is the only way to see the whole
         * thing rather than its final step.
         *
         * Only where the environment was told to keep them. Elsewhere the
         * dialog says so rather than pretending the call is missing.
         */
        const exchange = document.createElement('button');
        exchange.type = 'button';
        exchange.className = 'linklike';
        exchange.style.marginLeft = '6px';
        exchange.textContent = 'see the exchange';
        exchange.addEventListener('click', function () {
          showExchange(message.promptRef);
        });
        note.appendChild(exchange);
      }
    }

    /*
     * WHAT IT KNEW BY HERE.
     *
     * On every message of OURS, not only the automatic ones. The assistant
     * keeps running notes on a conversation and rewrites them each time it
     * answers; a colleague replying from the Instagram app writes messages
     * those notes have not read yet. Both questions are asked at the same
     * place — "what had it understood when this went out?" — and the second
     * is the one that shows the notes trailing behind.
     *
     * Fetched on click, never with the thread: these are a paragraph each
     * and a reader opens one at a time.
     */
    if (message.hasNotes) {
      const line = assistantLine();
      const summary = document.createElement('button');
      summary.type = 'button';
      summary.className = 'linklike';
      if (line.childNodes.length) summary.style.marginLeft = '6px';
      summary.textContent = 'summary so far';
      summary.addEventListener('click', function () {
        showNotes(message.refId);
      });
      line.appendChild(summary);
    }

    if (note) left.appendChild(note);

    const messageDetails = detailsPanel('everything Meta sent about this message', message.platformDetails);
    if (messageDetails) left.appendChild(messageDetails);
    row.appendChild(left);

    /*
     * INSIDE THE BUBBLE, not beside it. The status and the controls belong
     * to this message, and in a two-sided thread "beside" means left of our
     * own messages and right of theirs — the actions would drift to a
     * different edge depending on who was speaking.
     */
    const right = document.createElement('div');
    right.className = 'msg-actions';
    if (message.status) right.appendChild(pill(message.status, message.status));

    /*
     * Answer THIS message, the way the customer can answer ours. Offered only
     * where the platform can act on it: a message with no platform id — an
     * internal note, or a send still in the relay — has nothing to quote.
     */
    /*
     * HIDE AND DELETE, on comments on our OWN post only.
     *
     * Both are offered together because they answer different needs: hiding is
     * reversible and takes the comment off the post for everybody else, while
     * deleting is permanent. Delete confirms first — Instagram sends no webhook
     * when a comment is deleted, so there is no undo and no way for us even to
     * observe it happening.
     *
     * Only for the customer's own comments: our replies are ours to delete too,
     * but the platform id is what matters and both have one, so the control is
     * offered on anything the platform can act on.
     */
    /*
     * THE INBOX AND INSTAGRAM DISAGREE, and saying so is the whole point.
     *
     * Hiding and deleting are marked here optimistically, so a send that died
     * leaves the comment public while this thread shows it as gone. Without
     * this line an agent reads "hidden", believes it, and the comment stays up.
     */
    if (message.moderationFailed) {
      var stuck = document.createElement('small');
      stuck.className = 'hint';
      stuck.style.display = 'block';
      stuck.style.color = '#b45309';
      stuck.textContent =
        'This did not reach Instagram — the comment is still visible there.';
      left.appendChild(stuck);
    }

    if (openCanModerate && message.moderationFailed) {
      var again = document.createElement('button');
      again.className = 'secondary';
      again.style.marginLeft = '8px';
      again.textContent = 'Send again';
      again.addEventListener('click', function () {
        void retryModeration(message);
      });
      right.appendChild(again);
    }

    if (openCanModerate && message.canBeRepliedTo) {
      var hide = document.createElement('button');
      hide.className = 'secondary';
      hide.style.marginLeft = '8px';
      hide.textContent = message.hiddenOnPlatform ? 'Unhide' : 'Hide';
      hide.addEventListener('click', function () {
        void moderate(message, message.hiddenOnPlatform ? 'unhide' : 'hide');
      });
      right.appendChild(hide);

      var remove = document.createElement('button');
      remove.className = 'secondary';
      remove.style.marginLeft = '8px';
      remove.textContent = 'Delete';
      remove.addEventListener('click', function () {
        // Permanent on Instagram, and we cannot detect it being undone.
        if (!window.confirm('Delete this comment on Instagram? This cannot be undone.')) return;
        void moderate(message, 'delete');
      });
      right.appendChild(remove);
    }

    if (message.canBeRepliedTo) {
      var reply = document.createElement('button');
      reply.className = 'secondary';
      reply.style.marginLeft = '8px';
      reply.textContent = 'Reply';
      reply.addEventListener('click', function () {
        setReplyTarget(message);
      });
      right.appendChild(reply);
    }

    if (right.childNodes.length > 0) left.appendChild(right);
    return row;
  }

  /*
   * What the next reply will answer, held until it is sent or cleared. Kept
   * beside the composer rather than in the message row so it survives the
   * thread re-rendering under it.
   */
  var replyTarget = null;

  function setReplyTarget(message) {
    replyTarget = message;
    renderReplyTarget();
    var box = document.getElementById('replyBody');
    if (box) box.focus();
  }

  function clearReplyTarget() {
    replyTarget = null;
    renderReplyTarget();
  }

  function renderReplyTarget() {
    var banner = document.getElementById('replyTargetBanner');
    if (!banner) return;
    banner.textContent = '';
    banner.hidden = replyTarget === null;
    if (replyTarget === null) return;

    var label = document.createElement('span');
    label.textContent =
      'Replying to: ' + ((replyTarget.body || '').slice(0, 60) || '(no text)');
    banner.appendChild(label);

    var cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.style.marginLeft = '8px';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', clearReplyTarget);
    banner.appendChild(cancel);
  }


  /* ------------------------------------------------------------------ *
   * Assignment and status
   *
   * Both endpoints existed from the first commit and nothing ever called
   * them, so every conversation was open and unassigned forever.
   *
   * "Assign to me" needs no employee list, so it works for an agent who
   * cannot see the team. The picker appears only when this agent holds
   * employees.view — otherwise handing work to a NAMED colleague would
   * require a list they are not allowed to read.
   * ------------------------------------------------------------------ */

  async function loadTeam() {
    if (team !== null) return team;
    if (permissions.indexOf('employees.view') === -1) {
      team = [];
      return team;
    }
    try {
      // Every page: somebody on page two is still somebody the work can be
      // assigned to, and a picker that silently omits them is worse than slow.
      const people = await window.api.requestAll('/employees');
      team = people.filter(function (person) {
        // Only somebody who can actually pick the work up.
        return person.status === 'active';
      });
    } catch (_) {
      // Not fatal: assign-to-me still works, which is the common case anyway.
      team = [];
    }
    return team;
  }

  /**
   * THE POST SOMEBODY TAGGED US UNDER.
   *
   * A mention is a comment on a stranger's post, and without this the thread is
   * one line of text with no hint of what it is about — an agent cannot answer
   * "do you feel same ???" without seeing the post it was said under.
   *
   * Everything here is drawn ONLY if the platform gave it. Meta omits fields it
   * will not answer rather than erroring, so a missing like count means "we
   * were refused", and showing 0 would be inventing a fact.
   */
  function renderMentionContext(conversation) {
    var existing = document.getElementById('mentionContext');
    if (existing) existing.remove();

    var context = conversation.mentionContext;
    if (!context) return;

    var card = document.createElement('div');
    card.id = 'mentionContext';
    card.className = 'attachment';
    card.style.marginBottom = '12px';

    var heading = document.createElement('strong');
    heading.style.display = 'block';
    heading.textContent = context.ownerUsername
      ? 'Tagged under @' + context.ownerUsername + "'s post"
      : 'Tagged under a post';
    card.appendChild(heading);

    /*
     * ASK WHAT IT IS, RATHER THAN GUESSING AND RECOVERING.
     *
     * This used to put `mediaUrl` into an <img> and wait for the error. On a
     * reel `media_url` IS the .mp4 — 1.6 MB of video/mp4, verified on the wire
     * — so the image always failed, and the video only appeared after a
     * round trip that downloaded the whole file into a tag that could never
     * render it. The API says `mediaType`, so this asks.
     *
     * The same order the mentions page uses: a thumbnail is always a still, and
     * media_url is only an image when there is no thumbnail beside it.
     */
    var MEDIA_STYLE = 'max-height:160px;border-radius:6px;display:block;margin:6px 0';

    /** Media is gone — but `permalink` never expires, so offer that instead. */
    function mediaGone(what) {
      var note = document.createElement('div');
      note.className = 'hint';
      note.textContent = what + ' is no longer available';
      if (context.permalink) {
        note.textContent += ' — ';
        var link = document.createElement('a');
        link.href = context.permalink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'open it on Instagram';
        note.appendChild(link);
      }
      return note;
    }

    /*
     * THE REST OF A CAROUSEL, after the cover.
     *
     * `previewUrl` on a CAROUSEL_ALBUM is one image out of however many, so a
     * mention on a ten-slide post read as a mention on a single photo. The
     * server sends every slide; this draws the ones the cover is hiding.
     */
    function carouselStrip() {
      var slides = context.carousel || [];
      if (slides.length < 2) return null;

      var wrap = document.createElement('div');
      var label = document.createElement('small');
      label.className = 'muted';
      label.style.display = 'block';
      label.textContent = slides.length + ' images in this post';
      wrap.appendChild(label);

      var strip = document.createElement('div');
      strip.style.cssText =
        'display:flex;gap:6px;overflow-x:auto;margin-top:4px;padding-bottom:4px';
      slides.slice(1).forEach(function (slide) {
        var url = slide.previewUrl || slide.mediaUrl;
        if (!url) return;
        var img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.style.cssText =
          'width:56px;height:56px;object-fit:cover;border-radius:6px;flex:0 0 auto';
        // Signed links expire; drop a dead slide rather than leave a broken
        // tile sitting between working ones.
        img.onerror = function () { img.remove(); };
        strip.appendChild(img);
      });

      if (!strip.children.length) return null;
      wrap.appendChild(strip);
      return wrap;
    }

    function still() {
      var img = document.createElement('img');
      img.src = context.previewUrl || context.mediaUrl;
      img.alt = 'the post they tagged you under';
      img.style.cssText = MEDIA_STYLE;
      img.onerror = function () {
        img.replaceWith(mediaGone('The preview'));
      };
      return img;
    }

    if (context.mediaType === 'VIDEO' && context.mediaUrl) {
      var video = document.createElement('video');
      video.src = context.mediaUrl;
      video.controls = true;
      // Metadata only: an inbox should not pull megabytes to show a card.
      video.preload = 'metadata';
      if (context.thumbnailUrl) video.poster = context.thumbnailUrl;
      video.style.cssText = MEDIA_STYLE;
      video.onerror = function () {
        // The video link dies first; the still usually outlives it.
        if (context.previewUrl) video.replaceWith(still());
        else video.replaceWith(mediaGone('The video'));
      };
      card.appendChild(video);
    } else if (context.previewUrl || context.mediaUrl) {
      card.appendChild(still());
      var strip = carouselStrip();
      if (strip) card.appendChild(strip);
      // Meta sometimes omits media_url on a reel and sends the thumbnail
      // anyway, so a still with no player is correct rather than broken.
      if (context.mediaType === 'VIDEO') {
        var noVideo = document.createElement('div');
        noVideo.className = 'hint';
        noVideo.textContent = 'Instagram did not include the video for this post.';
        card.appendChild(noVideo);
      }
    }

    if (context.caption) {
      var caption = document.createElement('div');
      caption.className = 'hint';
      caption.style.whiteSpace = 'pre-wrap';
      caption.style.margin = '4px 0';
      // Somebody else's words: set as text, never as HTML.
      caption.textContent = context.caption;
      card.appendChild(caption);
    }

    /*
     * COUNTS THE PLATFORM ACTUALLY GAVE US.
     *
     * shareCount is always null — Instagram exposes no share or save count for
     * a post we do not own, and there is no field to ask for. It is therefore
     * left out entirely rather than shown as a zero or a dash, which would both
     * read as "nobody shared this".
     */
    var facts = [];
    if (typeof context.likeCount === 'number') {
      facts.push(context.likeCount.toLocaleString() + ' likes');
    }
    if (typeof context.commentCount === 'number') {
      facts.push(context.commentCount.toLocaleString() + ' comments');
    }
    if (context.mediaType) facts.push(context.mediaType.toLowerCase());
    if (context.postedAt) facts.push('posted ' + when(context.postedAt));
    if (facts.length) {
      var stats = document.createElement('small');
      stats.className = 'hint';
      stats.style.display = 'block';
      stats.textContent = facts.join(' · ');
      card.appendChild(stats);
    }

    if (context.permalink) {
      var link = document.createElement('a');
      link.href = context.permalink;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.display = 'block';
      link.style.marginTop = '4px';
      link.textContent = 'Open on Instagram ↗';
      card.appendChild(link);
    }

    /*
     * THE REPLIES UNDER OUR MENTION — a snapshot, and deliberately labelled as
     * one. Meta sends no webhook when somebody replies to a mention, so this is
     * the thread as it stood when we read it and it does not update itself.
     *
     * Every reply is anonymous: the platform omits the author on all of them.
     * Some carry no text either, which is what a media-only reply looks like
     * from here — so it is shown as a real reply we simply cannot read.
     */
    var replies = context.replies || [];
    if (replies.length) {
      var thread = document.createElement('div');
      thread.style.marginTop = '8px';
      thread.style.borderTop = '1px solid currentColor';
      thread.style.paddingTop = '6px';

      var threadHead = document.createElement('small');
      threadHead.className = 'hint';
      threadHead.style.display = 'block';
      threadHead.textContent =
        replies.length + (replies.length === 1 ? ' reply' : ' replies') +
        ' under your mention · when we last looked';
      thread.appendChild(threadHead);

      replies.forEach(function (reply) {
        var row = document.createElement('div');
        row.style.margin = '4px 0 0 8px';

        var who = document.createElement('small');
        who.className = 'hint';
        who.style.display = 'block';
        // Never available — say so plainly rather than leaving a blank.
        who.textContent =
          'someone (Instagram does not tell us who)' +
          (reply.postedAt ? ' · ' + when(reply.postedAt) : '');
        row.appendChild(who);

        var text = document.createElement('div');
        if (reply.text) {
          text.textContent = reply.text;
        } else {
          text.className = 'hint';
          text.style.fontStyle = 'italic';
          text.textContent = 'a reply we cannot read — Instagram withheld it';
        }
        row.appendChild(text);
        thread.appendChild(row);
      });

      card.appendChild(thread);
    }

    messages.appendChild(card);
  }

  function renderThreadControls(conversation) {
    const controls = document.getElementById('threadControls');
    const assignedLabel = document.getElementById('assignedTo');
    const assignWrap = document.getElementById('assignControls');
    const statusWrap = document.getElementById('statusControls');
    const picker = document.getElementById('assignPicker');
    const assignMe = document.getElementById('assignMe');
    const unassign = document.getElementById('unassign');
    const statusPicker = document.getElementById('statusPicker');

    const canAssign = permissions.indexOf('conversations.assign') !== -1;
    const canManage = permissions.indexOf('conversations.manage') !== -1;

    controls.hidden = !canAssign && !canManage;
    assignWrap.hidden = !canAssign;
    statusWrap.hidden = !canManage;

    /*
     * Only a message thread can be re-read from the platform, so the button is
     * hidden rather than shown and then refused: the API answers 422 for a
     * comment thread, and a control that only ever errors is worse than none.
     */
    const resyncWrap = document.getElementById('resyncControls');
    const kind = conversation.conversationKind;
    resyncWrap.hidden = !canManage || (kind !== 'direct_message' && kind !== 'story_reply');
    document.getElementById('resyncNote').textContent = '';

    const holder = conversation.assignedTo;
    const mine = holder && holder.refId === myEmployeeRefId;
    assignedLabel.textContent = holder
      ? mine
        ? 'Assigned to you'
        : 'Assigned to ' + (holder.name || 'a colleague')
      : 'Unassigned';

    assignMe.hidden = Boolean(mine) || !myEmployeeRefId;
    unassign.hidden = !holder;
    statusPicker.value = conversation.status || 'open';

    if (canAssign) {
      void loadTeam().then(function (people) {
        if (people.length === 0) {
          picker.hidden = true;
          return;
        }
        picker.hidden = false;
        picker.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'Assign to…';
        picker.appendChild(none);
        people.forEach(function (person) {
          const option = document.createElement('option');
          option.value = person.refId;
          // The employees list returns a single joined `name`, not parts.
          option.textContent = person.name || 'Unnamed colleague';
          picker.appendChild(option);
        });
        picker.value = holder ? holder.refId : '';
      });
    }
  }

  async function setAssignee(employeeRefId) {
    if (!openRefId) return;
    try {
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + '/assign', {
        method: 'POST',
        body: { employeeRefId: employeeRefId },
      });
      // Re-read rather than patching local state: the API is the authority on
      // who holds it, and a colleague may have taken it in the meantime.
      await openThread(openRefId);
      await load(true);
    } catch (error) {
      handle(error, threadMessage);
    }
  }

  async function setStatus(status) {
    if (!openRefId) return;
    try {
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + '/status', {
        method: 'POST',
        body: { status: status },
      });
      await openThread(openRefId);
      await load(true);
    } catch (error) {
      handle(error, threadMessage);
    }
  }

  /**
   * The two switches, in the thread where the decision is actually made.
   *
   * SCOPED TO THIS INBOX. A flag raised here is about this connected
   * account: pausing while you type to somebody on one account leaves the
   * assistant answering them everywhere else they write. A direct message
   * and a comment on the same account share one flag, because they are the
   * same inbox.
   *
   * NOTHING AT ALL WHEN THERE IS NO CUSTOMER. A comment thread always has an
   * author, but a conversation can exist before one is resolved, and an
   * empty bar of controls that do nothing is worse than no bar.
   */
  function drawAssistantState(person) {
    const state = person && person.assistant;
    if (!person || !person.refId || !state) {
      assistantState.hidden = true;
      assistantState.textContent = '';
      return;
    }

    assistantState.hidden = false;
    assistantState.textContent = '';

    const message = document.createElement('span');
    message.className = 'hint';

    /* --- needs a person ------------------------------------------------ */
    if (state.needsHuman) {
      assistantState.appendChild(pill('needs a person', 'warning'));

      if (state.needsHumanReason) {
        const why = document.createElement('span');
        why.className = 'hint';
        why.style.marginLeft = '6px';
        /* The assistant's own words for what it could not do. */
        why.textContent = state.needsHumanReason;
        assistantState.appendChild(why);
      }

      assistantState.appendChild(
        action('mark as handled', function () {
          void switchFor(person, '/needs-human', { needsHuman: false }, message);
        }),
      );
    } else {
      assistantState.appendChild(
        action('flag for a person', function () {
          const reason = window.prompt('Why does this need a person?');
          if (reason === null || reason.trim() === '') return;
          void switchFor(person, '/needs-human', { needsHuman: true, reason: reason.trim() }, message);
        }),
      );
    }

    /* --- the assistant's voice ------------------------------------------ */
    if (state.paused) {
      assistantState.appendChild(pill('assistant paused', 'none'));

      const until = document.createElement('span');
      until.className = 'hint';
      until.style.marginLeft = '6px';
      until.textContent = state.resumesAt
        ? 'back on at ' + when(state.resumesAt)
        : 'until you resume it';
      assistantState.appendChild(until);

      assistantState.appendChild(
        action('resume now', function () {
          void switchFor(person, '/automation-pause', { paused: false }, message);
        }),
      );
    } else {
      /*
       * AN HOUR AND INDEFINITELY. An hour is the ordinary case — somebody
       * picking this up to type for a few minutes — and it comes back by
       * itself, which is what stops a pause being forgotten.
       */
      assistantState.appendChild(
        action('pause assistant 1h', function () {
          void switchFor(
            person,
            '/automation-pause',
            { paused: true, resumesAt: new Date(Date.now() + 3600000).toISOString() },
            message,
          );
        }),
      );
      assistantState.appendChild(
        action('pause until I resume', function () {
          void switchFor(person, '/automation-pause', { paused: true }, message);
        }),
      );
    }

    assistantState.appendChild(message);
  }

  /** A link-styled button, which is every control on this bar. */
  function action(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'linklike';
    button.style.marginLeft = '8px';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * One write, then the thread is re-read.
   *
   * RE-READ RATHER THAN TOGGLED IN PLACE: the server decides what "paused"
   * means — a resume time already past is not paused — and a bar updated
   * from what was clicked would eventually disagree with the thing that
   * actually gates the assistant.
   */
  async function switchFor(person, path, body, message) {
    if (!openRefId) return;
    message.className = 'hint';
    message.textContent = ' saving…';
    try {
      /*
       * AGAINST THE CONVERSATION, not the customer. Both switches are per
       * connected account, and the conversation is the thing that knows
       * both halves — who the person is and which inbox this is. Asking a
       * client for a channel id would mean publishing one.
       */
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + path, {
        method: 'POST',
        body: body,
      });
      await openThread(openRefId);
    } catch (error) {
      message.className = 'hint prompt-drifted';
      message.textContent = ' ' + ((error && error.message) || 'that could not be saved');
    }
  }

  async function openThread(refId, appendOlder) {
    const older = Boolean(appendOlder);
    openRefId = refId;
    threadPanel.hidden = false;
    threadMessage.innerHTML = '';
    if (!older) {
      threadCursor = null;
      messages.innerHTML = '<p class="hint">Loading…</p>';
    }

    try {
      // A long thread arrives one page at a time. Before this the endpoint had no
      // pagination surface at all, so a conversation simply stopped at the
      // newest fifty messages with nothing to say there were more.
      const query = older && threadCursor ? '?cursor=' + encodeURIComponent(threadCursor) : '';
      const result = await window.api.request(
        '/conversations/' + encodeURIComponent(refId) + query,
      );
      const data = result.data || {};
      const conversation = data.conversation || {};
      // In meta, like every other list on this API.
      const pagination = (result.meta && result.meta.pagination) || {};

      const person = conversation.customer;
      threadTitle.textContent =
        (person && person.displayName) ||
        (conversation.conversationKind || 'Conversation').replace(/_/g, ' ');
      threadMeta.textContent =
        (conversation.conversationKind || '').replace(/_/g, ' ') +
        ' · ' + (conversation.platform || '') +
        ' · ' + (conversation.status || '') +
        ' · ' + (conversation.messageCount || 0) + ' messages';

      /*
       * SET BEFORE THE ROWS ARE BUILT, because messageRow reads it — placed
       * after the draw it was always one thread behind, so opening a moderable
       * conversation showed no controls until you opened another.
       *
       * Both halves are required: the permission to manage, and the platform
       * actually allowing it. The server answers the second — Instagram permits
       * moderation only on a comment sitting on a post we own — so this carries
       * its answer rather than guessing from the conversation kind.
       */
      openCanModerate =
        conversation.canModerateComments === true &&
        permissions.indexOf('conversations.manage') !== -1;

      /* Who is waiting, and whether the assistant has been told to be quiet. */
      drawAssistantState(person);

      /*
       * Taken before anything is cleared: a thread already at its newest
       * should stay there as messages arrive, and one scrolled back should
       * stay where it was. The tolerance absorbs sub-pixel scroll heights,
       * which never settle exactly on the bottom.
       */
      const atBottom =
        older ||
        messages.scrollHeight === 0 ||
        messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;

      if (!older) messages.innerHTML = '';
      /*
       * BEFORE ANYTHING IS DRAWN, because the rendering reads it.
       *
       * This was set after the message loop, which made `platformName()` fall
       * back to the word "the platform" on a freshly opened thread — and worse
       * on the second one, where it still held the PREVIOUS conversation and
       * could confidently name the wrong network. Nothing above this line
       * renders, so it is the right place for it.
       */
      openConversation = conversation;

      // The tagged post sits above the thread, not inside it: it is what the
      // whole conversation is ABOUT, not one message in it.
      if (!older) renderMentionContext(conversation);
      const list = data.messages || [];
      if (list.length === 0 && !older) {
        messages.appendChild(Object.assign(document.createElement('p'), {
          className: 'hint',
          textContent: 'No messages in this thread.',
        }));
      }
      /*
       * OLDEST AT THE TOP, NEWEST AT THE BOTTOM — the way every messaging
       * app draws a conversation, and the way the people in it remember it.
       * The API answers newest-first because that is what pagination needs;
       * reading is the other direction.
       */
      const ordered = list.slice().reverse();

      if (older) {
        /*
         * An older page belongs ABOVE what is already on screen, as one
         * block, in the same order. Appending it would put the oldest
         * messages after the newest and shuffle the conversation.
         *
         * The scroll is held still across the insert: content added above
         * the viewport otherwise shoves everything down and the reader loses
         * the line they were on, which is the whole reason they pressed the
         * button.
         */
        const was = messages.scrollHeight;
        const frame = document.createDocumentFragment();
        ordered.forEach(function (message) { frame.appendChild(messageRow(message)); });
        messages.insertBefore(frame, messages.firstChild);
        messages.scrollTop += messages.scrollHeight - was;
      } else {
        /*
         * STICK TO THE BOTTOM ONLY IF THEY WERE ALREADY THERE.
         *
         * A live update redraws the whole thread, and it fires on anything
         * that touches the conversation — a new message, a colleague
         * assigning it, a status change. Scrolling to the newest every time
         * yanks somebody who is scrolled up reading history back down to
         * the bottom, repeatedly, while a colleague works. Measured BEFORE
         * the redraw, because afterwards the old position is gone.
         */
        ordered.forEach(function (message) { messages.appendChild(messageRow(message)); });
        if (atBottom) messages.scrollTop = messages.scrollHeight;
      }

      threadCursor = pagination.nextCursor || null;
      document.getElementById('loadOlder').hidden = !pagination.hasMore;

      renderThreadControls(conversation);

      /*
       * The reply box follows the API's OWN answer rather than a rule
       * reimplemented here. `canReply` depends on when the customer last wrote,
       * which the client cannot work out from the thread alone — and duplicating
       * a 24-hour rule in two places is how the two drift apart.
       */
      const canReply = permissions.indexOf('conversations.reply') !== -1;
      replyBox.hidden = !canReply;


      const blocked = conversation.canReply === false;
      const send = document.getElementById('sendReply');
      const note = document.getElementById('internalNote');
      const body = document.getElementById('replyBody');

      if (canReply && blocked) {
        // An internal note never reaches the platform, so it stays available —
        // and becomes the only thing this box can do.
        note.checked = true;
        note.disabled = true;
        body.placeholder = 'Add an internal note…';
        send.textContent = 'Save note';
        show(
          threadMessage,
          'info',
          conversation.replyBlockedReason ||
            'The platform will not accept a reply on this conversation right now.',
        );
      } else if (canReply) {
        note.disabled = false;
        body.placeholder = 'Type a reply…';
        send.textContent = 'Send';

        /*
         * A REPLY TO A MENTION CANNOT BE UNSENT.
         *
         * Instagram lets a comment be deleted only by the owner of the media it
         * sits on — explicitly even when we wrote it — so a reply we post on
         * somebody else's post is permanent from our side. It cannot even be
         * read back by id (platform-limitations 1.8, 4.6). One we had to remove
         * during testing had to be deleted by hand, from the app.
         *
         * Said BEFORE the agent types, because afterwards there is nothing
         * anyone can do about it. The composer is not blocked — replying is the
         * whole point of the thread — so this is a warning, not a refusal.
         */
        if (conversation.conversationKind === 'mention') {
          show(
            threadMessage,
            'info',
            'This reply is posted on someone else\u2019s post. Instagram does not let us ' +
              'delete it afterwards \u2014 only the post\u2019s owner can.',
          );
        }
      }

      // Reading a thread marks it read; failing that is not worth an error.
      try {
        await window.api.request('/conversations/' + encodeURIComponent(refId) + '/read', {
          method: 'POST',
        });
      } catch (_) { /* the unread badge is cosmetic */ }
    } catch (error) {
      messages.innerHTML = '';
      handle(error, threadMessage);
    }
  }

  /**
   * Hides, unhides or deletes one comment on the platform.
   *
   * Accepted rather than applied: the API writes to the outbox and the relay
   * performs the call, so this reloads the thread instead of pretending it knows
   * the outcome. The server has already applied the local state, which it must —
   * Instagram sends no webhook when a comment is hidden or deleted, so nothing
   * would ever tell us.
   */
  /*
   * Sends a hide or delete again after the first one died.
   *
   * NOT the same call as moderate. Our copy already reads hidden — the mark is
   * optimistic, because Instagram sends no webhook for either action — so the
   * ordinary path is refused from here on, correctly. This replays the failed
   * ledger row instead, which is also why pressing it twice cannot produce two
   * calls to Instagram.
   */
  async function retryModeration(message) {
    if (!openRefId) return;
    try {
      await window.api.request(
        '/conversations/' +
          encodeURIComponent(openRefId) +
          '/messages/' +
          encodeURIComponent(message.refId) +
          '/moderate/retry',
        { method: 'POST' },
      );
      await openThread(openRefId);
      show(threadMessage, 'success', 'Sending to Instagram again.');
    } catch (error) {
      handle(error, threadMessage);
    }
  }

  async function moderate(message, action) {
    if (!openRefId) return;
    try {
      await window.api.request(
        '/conversations/' +
          encodeURIComponent(openRefId) +
          '/messages/' +
          encodeURIComponent(message.refId) +
          '/moderate',
        { method: 'POST', body: { action: action } },
      );
      await openThread(openRefId);
      show(
        threadMessage,
        'success',
        action === 'delete'
          ? 'Deleting on Instagram. This cannot be undone.'
          : action === 'hide'
            ? 'Hiding on Instagram.'
            : 'Unhiding on Instagram.',
      );
    } catch (error) {
      handle(error, threadMessage);
    }
  }

  /**
   * Asks the assistant for a reply, using everything we already hold: the
   * recent thread, the descriptions of media whose links have since died,
   * and what the business says about itself.
   *
   * IT FILLS THE BOX, IT DOES NOT SEND. The draft lands where a typed reply
   * would, so the agent reads it, edits it and presses Send — the same path,
   * the same idempotency key, the same ledger row. An assistant that could
   * reach a customer without a person in between is a different feature.
   *
   * WHAT IT WAS GIVEN IS REPORTED, because a draft that reads oddly is
   * nearly always a context problem rather than a model one: "it answered as
   * though it had not seen the photo" is a question the note below answers.
   */
  async function draftReply() {
    if (!openRefId) return;
    const button = document.getElementById('draftReply');
    const note = document.getElementById('draftNote');
    const box = document.getElementById('replyBody');

    button.disabled = true;
    note.textContent = 'reading the conversation…';
    try {
      const result = await window.api.request(
        '/conversations/' + encodeURIComponent(openRefId) + '/ai-reply',
        { method: 'POST' },
      );
      const draft = result.data;

      /* Never over something the agent has already typed. */
      if (box.value.trim()) {
        box.value = box.value.trim() + '\n\n' + draft.text;
      } else {
        box.value = draft.text;
      }
      box.focus();

      const seen = [
        draft.context.messages + ' message' + (draft.context.messages === 1 ? '' : 's'),
      ];
      if (draft.context.mediaDescriptions > 0) {
        seen.push(draft.context.mediaDescriptions + ' media description' +
          (draft.context.mediaDescriptions === 1 ? '' : 's'));
      }
      if (draft.context.hasBusinessProfile) seen.push('the business profile');
      if (draft.context.hasPerson) seen.push('who you are talking to');
      if (draft.context.hasPost) seen.push('the post this is under');

      /*
       * WHAT IT COULD NOT DO, said before anything else. An agent who sends
       * this draft without reading that line has sent a customer a promise
       * that somebody will follow up — and they are that somebody.
       */
      const trouble = [];
      if (draft.handoff) trouble.push('It wants a person on this: ' + draft.handoff + '.');
      if (draft.silent) trouble.push('It judged that nothing needs saying here.');
      if (draft.truncated) trouble.push('It ran into the length cap.');

      note.textContent =
        (trouble.length ? trouble.join(' ') + ' ' : '') +
        'Drafted by ' + draft.model + ' (' + draft.provider + ') from ' + seen.join(', ') +
        '. Read it before sending.';
    } catch (error) {
      note.textContent = '';
      handle(error, threadMessage);
    } finally {
      button.disabled = false;
    }
  }

  const PURPOSES = {
    auto_reply: 'replied automatically',
    draft: 'drafted for a colleague',
    media_description: 'described media',
  };

  /**
   * ONE DIALOG, two questions asked at the same message: what the assistant
   * was shown, and what it had understood by then. Both are a title, a line
   * of provenance and a block of text, and a second dialog would duplicate
   * the markup, the backdrop handler and the copy button to say so.
   *
   * Opens before the fetch so a click has a visible effect rather than
   * appearing to do nothing for as long as the read takes.
   */
  function openTextDialog(title, prose) {
    const dialog = document.getElementById('promptDialog');
    const parts = {
      title: document.getElementById('aiPromptTitle'),
      hint: document.getElementById('aiPromptDrift'),
      body: document.getElementById('aiPromptBody'),
    };
    parts.title.textContent = title;
    parts.hint.textContent = '';
    parts.hint.className = 'hint';
    parts.body.textContent = '';
    /* Sentences and a prompt are not read the same way — see .as-prose. */
    parts.body.className = prose ? 'as-prose' : '';
    if (!dialog.open) dialog.showModal();
    return parts;
  }

  /**
   * Rebuilds one prompt and shows it over the conversation.
   *
   * NOTHING IS STORED AND NOTHING IS KEPT HERE EITHER: it is fetched, read
   * and replaced the next time somebody opens another. The line under the
   * title is the load-bearing part — whether what is on screen is
   * byte-for-byte what was sent, or a reconstruction that has drifted since.
   */
  async function showPrompt(call) {
    const parts = openTextDialog('Rebuilding…');
    const title = parts.title;
    const drift = parts.hint;
    const body = parts.body;

    try {
      const result = await window.api.request(
        '/ai-calls/' + encodeURIComponent(call.refId) + '/prompt',
        { method: 'GET' },
      );
      const replayed = result.data;

      title.textContent =
        (PURPOSES[replayed.call.purpose] || replayed.call.purpose) +
        ' · ' + replayed.call.model +
        ' · ' + when(replayed.call.createdAt);

      drift.className = 'hint ' + (replayed.matchesOriginal ? 'prompt-exact' : 'prompt-drifted');
      drift.textContent = replayed.matchesOriginal
        ? 'This is exactly what was sent.'
        : replayed.drift.join(' ');
      body.textContent = replayed.prompt;
    } catch (error) {
      title.textContent = 'Could not rebuild this prompt';
      drift.className = 'hint prompt-drifted';
      drift.textContent =
        (error && error.message) || 'The call could not be read back.';
    }
  }

  /**
   * Every exchange with the model behind one reply, verbatim.
   *
   * THE DIFFERENCE FROM showPrompt IS THE WHOLE POINT. That one rebuilds a
   * prompt from today's code and tells you whether it still matches. This
   * one is the bodies themselves — what was sent, what came back, and the
   * model's own answer before anything parsed it.
   *
   * ROUND BY ROUND, because a reply that used a tool is several calls. Round
   * 0 is the opening ask; each one after it carries the results of the tools
   * the model asked for in the round before.
   */
  async function showExchange(callRefId) {
    const parts = openTextDialog('Reading the exchange…');

    try {
      const result = await window.api.request(
        '/ai-calls/' + encodeURIComponent(callRefId) + '/exchange',
        { method: 'GET' },
      );
      const wire = result.data;

      /*
       * THE BODY ALWAYS SAYS SOMETHING. These two branches used to set the
       * title and the hint and leave the body empty, which reads as a dialog
       * that failed to load — a heading, a blank space and two buttons — when
       * in fact it had a perfectly good answer to give.
       */
      if (!wire.captured) {
        parts.title.textContent = 'The exchange was not kept';
        parts.hint.className = 'hint prompt-drifted';
        parts.hint.textContent = 'Nothing is wrong — this environment does not keep them.';
        parts.body.textContent =
          'The bodies of a model call are only kept where AI_WIRE_CAPTURE_ENABLED is on, ' +
          'and it is off here. They are whole customer conversations in plain text, so it ' +
          'is off by default and refused outright in production.\n\n' +
          '"why did it say this?" still works: it rebuilds the prompt from the code and ' +
          'checks it against a fingerprint taken at the time.';
        return;
      }
      if (!wire.rounds.length) {
        parts.title.textContent = 'Nothing kept for this reply';
        parts.hint.className = 'hint prompt-drifted';
        parts.hint.textContent = 'Capture is on, but there is nothing on file for this one.';
        parts.body.textContent =
          'This reply was written before capture was switched on, or by a call that was ' +
          'never recorded.\n\nReplies sent from here on will have their exchange kept. ' +
          'For an older one, "why did it say this?" rebuilds the prompt instead.';
        return;
      }

      parts.title.textContent =
        wire.rounds.length === 1
          ? 'One exchange with ' + wire.rounds[0].model
          : wire.rounds.length + ' exchanges with ' + wire.rounds[0].model;
      parts.hint.className = 'hint prompt-exact';
      parts.hint.textContent =
        'Exactly what crossed the wire. ' +
        (wire.rounds.length > 1
          ? 'Round 0 is the opening ask; each one after it carries the tool results.'
          : 'No tool was used on this reply.');

      parts.body.textContent = wire.rounds.map(roundText).join('\n\n');
    } catch (error) {
      parts.title.textContent = 'Could not read the exchange';
      parts.hint.className = 'hint prompt-drifted';
      parts.hint.textContent =
        (error && error.message) || 'The bodies could not be read back.';
    }
  }

  /**
   * One round as text, because the container is already a <pre>.
   *
   * BUILT AS A STRING rather than as elements, the same way the rebuilt
   * prompt is. The thing somebody opened this to read is a prompt and an
   * answer — both of which are text with meaningful newlines — so anything
   * that puts them through markup is working against the content.
   */
  function roundText(round) {
    const rule = '='.repeat(60);
    return (
      rule +
      '\nROUND ' + round.round +
      ' · ' + round.provider + ' · ' + round.model +
      ' · ' + round.durationMs + 'ms' +
      '\n' + rule +
      '\n\n--- SENT ---------------------------------------------------\n' +
      readableRequest(round.request) +
      '\n\n--- CAME BACK ----------------------------------------------\n' +
      JSON.stringify(round.response, null, 2) +
      '\n\n--- READ AS ------------------------------------------------\n' +
      JSON.stringify(round.parsed, null, 2)
    );
  }

  /**
   * A request body with its prompt readable rather than escaped.
   *
   * Both providers carry the text in `input`, as a list of either strings or
   * objects with a text field, and OpenAI puts the standing instruction in
   * `instructions`. Anything this does not recognise falls back to JSON, so
   * a provider shape changing makes the view plainer, never empty.
   */
  function readableRequest(request) {
    if (!request || typeof request !== 'object') return JSON.stringify(request, null, 2);

    const head = {};
    Object.keys(request).forEach(function (key) {
      if (key !== 'input' && key !== 'instructions') head[key] = request[key];
    });

    let out = JSON.stringify(head, null, 2);
    if (typeof request.instructions === 'string') {
      out += '\n\ninstructions:\n' + request.instructions;
    }
    if (Array.isArray(request.input)) {
      request.input.forEach(function (part, index) {
        const text =
          typeof part === 'string'
            ? part
            : part && typeof part.text === 'string'
              ? part.text
              : part && typeof part.content === 'string'
                ? part.content
                : JSON.stringify(part, null, 2);
        const role = part && part.role ? ' (' + part.role + ')' : '';
        out += '\n\ninput[' + index + ']' + role + ':\n' + text;
      });
    } else if (request.input !== undefined) {
      out += '\n\ninput:\n' + JSON.stringify(request.input, null, 2);
    }
    return out;
  }

  /**
   * The assistant's running notes as they stood at one of our messages.
   *
   * WHY THIS IS NOT THE SAME AS THE PROMPT. The prompt is what the model was
   * handed; these are what it concluded and carried forward — rewritten
   * every time it answers, and the only account of a conversation older than
   * the window it reads. Asked at a message because the useful question is
   * "what had it understood when this went out?", not "what does it think
   * now".
   *
   * A message the business typed into Instagram has no notes of its own and
   * is shown the last ones written, said out loud: a summary that has not
   * read the message you are looking at is worth knowing about.
   */
  async function showNotes(messageRefId) {
    if (!openRefId) return;
    const parts = openTextDialog('Reading the notes…', true);

    try {
      const result = await window.api.request(
        '/conversations/' + encodeURIComponent(openRefId) +
          '/messages/' + encodeURIComponent(messageRefId) + '/notes',
        { method: 'GET' },
      );
      const notes = result.data;

      parts.title.textContent = 'What it knew by this message';
      parts.hint.className = 'hint ' + (notes.summarisedHere ? 'prompt-exact' : 'prompt-drifted');
      parts.hint.textContent = notes.summarisedHere
        ? 'Written with this message, ' + when(notes.writtenAt) + '.'
        : 'Nothing has summarised this message yet — these notes were written ' +
          when(notes.writtenAt) + ', before it.';
      parts.body.textContent = notes.notes;
    } catch (error) {
      parts.title.textContent = 'No notes for this message';
      parts.hint.className = 'hint prompt-drifted';
      parts.hint.textContent =
        (error && error.message) || 'The notes could not be read back.';
    }
  }

  async function sendReply() {
    if (!openRefId) return;
    const body = document.getElementById('replyBody').value.trim();
    if (!body) {
      show(threadMessage, 'error', 'A reply needs some text.');
      return;
    }

    // Minted here, once, and kept until this message is actually accepted.
    if (!replyKey) replyKey = newReplyKey();

    const button = document.getElementById('sendReply');
    button.disabled = true;
    try {
      await window.api.request('/conversations/' + encodeURIComponent(openRefId) + '/reply', {
        method: 'POST',
        body: {
          body: body,
          internalNote: document.getElementById('internalNote').checked,
          // The SAME key for every attempt at this message, so a retry after a
          // timeout returns the original rather than sending a second copy.
          idempotencyKey: replyKey,
          // Answering one message in particular, when the agent chose one. The
          // API refuses this on an internal note, which is why the control is
          // hidden while the note box is ticked.
          ...(replyTarget ? { replyToMessageRefId: replyTarget.refId } : {}),
        },
      });
      document.getElementById('replyBody').value = '';
      clearReplyTarget();
      // Delivered, so the next thing typed is a different message and gets its
      // own key. Only ever reset on SUCCESS.
      replyKey = null;
      show(threadMessage, 'ok', 'Queued for delivery.');
      await openThread(openRefId);
      /*
       * ALWAYS, after sending. The redraw only sticks to the bottom when
       * somebody was already there, which is right for a colleague's update
       * arriving while you read history — and wrong for your own message,
       * which you have just written and would otherwise not see.
       */
      messages.scrollTop = messages.scrollHeight;
    } catch (error) {
      // The window can close between opening the thread and pressing send, so
      // this is a normal outcome rather than a fault: explain it and keep what
      // they typed.
      if (error.code === 'MESSAGING_WINDOW_CLOSED') {
        show(threadMessage, 'info', error.message);
        if (openConversation) openConversation.canReply = false;
        document.getElementById('internalNote').checked = true;
        document.getElementById('internalNote').disabled = true;
      } else {
        handle(error, threadMessage);
      }
    } finally {
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Live updates
   *
   * fetch + ReadableStream rather than EventSource, because EventSource
   * cannot set an Authorization header — the alternatives are a token in
   * the query string, which lands in access logs, or a one-time ticket
   * endpoint. Streaming by hand costs a few lines and avoids both.
   *
   * The stream is an OPTIMISATION. A slow poll runs regardless, so a
   * dropped connection, a hostile proxy or an old browser costs latency
   * and nothing else.
   * ------------------------------------------------------------------ */
  const POLL_MS = 30000;
  const STREAM_RETRY_BASE_MS = 2000;
  const STREAM_RETRY_MAX_MS = 60000;

  let streamAbort = null;
  let streamAttempt = 0;
  let pollTimer = null;

  function onInboxChanged(change) {
    // Refresh the list, and the open thread when it is the one that moved. An
    // 'assigned' or 'status' event is exactly the case worth reacting to: it is
    // a COLLEAGUE's action, and seeing it late is how two people answer the
    // same customer.
    load(true);
    if (openRefId && change && change.conversationRefId === openRefId) {
      void openThread(openRefId);
    }
  }

  /** Parses the SSE frames out of a byte stream. */
  async function consume(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Frames are separated by a blank line; anything after the last one is
      // a partial frame and stays in the buffer.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      frames.forEach(function (frame) {
        let event = 'message';
        let data = '';
        frame.split('\n').forEach(function (line) {
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          // A line starting with ':' is a heartbeat comment: ignored, but it
          // kept the connection open, which was its whole job.
        });

        /*
         * The server CAPS a stream's lifetime, because an open stream is an
         * authorisation with no expiry otherwise. It says so before closing, and
         * reconnecting immediately keeps that invisible instead of waiting out
         * the reconnect backoff for something that is not a failure.
         */
        if (event === 'expired') {
          streamAttempt = 0;
          return;
        }

        if (event !== 'inbox' || !data) return;
        try {
          onInboxChanged(JSON.parse(data));
        } catch (_) { /* a malformed frame is not worth tearing the stream down */ }
      });
    }
  }

  /*
   * WHETHER THIS IS LIVE, said out loud.
   *
   * The stream is an optimisation with a poll underneath it, which is the
   * right design and makes failure invisible: updates still arrive, just up
   * to thirty seconds late, and "is it live or is it polling?" becomes a
   * question nobody can answer by looking. One word in the header answers
   * it — for whoever is using the inbox, and for whoever is debugging it.
   */
  function liveState(state, detail) {
    const el = document.getElementById('liveState');
    if (!el) return;
    el.textContent = detail ? state + ' · ' + detail : state;
    el.className = 'hint live-' + state.replace(/[^a-z]/g, '');
  }

  async function openStream() {
    const session = window.api.readSession();
    if (!session || !session.accessToken) {
      liveState('polling', 'not signed in');
      return;
    }

    streamAbort = new AbortController();
    try {
      const response = await fetch(window.WOUCHH_CONFIG.apiBaseUrl + '/conversations/stream', {
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + session.accessToken },
        credentials: 'include',
        signal: streamAbort.signal,
      });

      if (!response.ok || !response.body) throw new Error('stream rejected: ' + response.status);

      streamAttempt = 0;
      liveState('live');
      await consume(response);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      liveState('polling', (error && error.message) || 'stream failed');
    }

    // Ended or failed: back off and try again. The poll is still running, so
    // nothing is lost in the meantime.
    streamAttempt += 1;
    const delay = Math.min(STREAM_RETRY_BASE_MS * 2 ** (streamAttempt - 1), STREAM_RETRY_MAX_MS);
    liveState('polling', 'retrying in ' + Math.round(delay / 1000) + 's');
    setTimeout(function () {
      if (!document.hidden) void openStream();
    }, delay);
  }

  function startLiveUpdates() {
    liveState('connecting');
    // The floor: even with no stream at all, the list stays roughly current.
    pollTimer = setInterval(function () {
      if (!document.hidden) void load(true);
    }, POLL_MS);

    void openStream();

    // A backgrounded tab is not worth a connection; reopening on return also
    // catches anything missed while it was hidden.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (streamAbort) streamAbort.abort();
        return;
      }
      load(true);
      void openStream();
    });

    window.addEventListener('beforeunload', function () {
      if (pollTimer) clearInterval(pollTimer);
      if (streamAbort) streamAbort.abort();
    });
  }

  async function start() {
    try {
      const me = (await window.api.request('/auth/me')).data;
      permissions = me.permissions || [];
      // Needed to offer "assign to me" and to render "assigned to you": the API
      // speaks in refIds, so a client has to know its own.
      myEmployeeRefId = me.employeeRefId || null;
      document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : '';
    } catch (error) {
      handle(error, listMessage);
      return;
    }

    if (permissions.indexOf('conversations.view') === -1) {
      show(
        listMessage,
        'error',
        'You do not have access to the inbox. It needs the unified inbox feature and a role that ' +
          'grants conversations.view.',
      );
      return;
    }

    document.getElementById('statusFilter').addEventListener('change', function () { load(true); });
    document.getElementById('mineOnly').addEventListener('change', function () { load(true); });
    loadMore.addEventListener('click', function () { load(false); });
    document.getElementById('sendReply').addEventListener('click', sendReply);
    document.getElementById('draftReply').addEventListener('click', draftReply);

    /*
     * A prompt runs to thousands of characters and the reason to open one is
     * usually to compare it with something else. Selecting it by hand out of
     * a scrolling box is the kind of small friction that stops people
     * checking at all.
     */
    document.getElementById('aiPromptCopy').addEventListener('click', function () {
      const text = document.getElementById('aiPromptBody').textContent || '';
      const button = this;
      void navigator.clipboard.writeText(text).then(
        function () {
          button.textContent = 'Copied';
          setTimeout(function () { button.textContent = 'Copy'; }, 1500);
        },
        function () {
          /* Clipboard access can be refused outright. Saying so beats a
           * button that silently did nothing. */
          button.textContent = 'Press ⌘C';
          setTimeout(function () { button.textContent = 'Copy'; }, 2000);
        },
      );
    });

    /*
     * Clicking the backdrop closes it, which is what everybody expects of a
     * dialog and what `dialog` itself does not do. The target IS the dialog
     * only when the click landed outside its content box.
     */
    document.getElementById('promptDialog').addEventListener('click', function (event) {
      if (event.target === this) this.close();
    });

    document.getElementById('resync').addEventListener('click', function () {
      var button = this;
      var note = document.getElementById('resyncNote');
      if (!openRefId) return;
      button.disabled = true;
      note.textContent = 'asking Instagram…';

      window.api
        .request('/conversations/' + encodeURIComponent(openRefId) + '/resync', {
          method: 'POST',
        })
        .then(function (result) {
          /*
           * queued:false is a success, not a failure: a repair for this thread
           * is already running and a second would do the same work twice.
           */
          note.textContent = (result.data || {}).queued
            ? 'checking — new messages appear here as they arrive'
            : 'already checking';
        })
        .catch(function (error) {
          note.textContent = 'could not start: ' + (error.message || 'unknown error');
        })
        .finally(function () {
          button.disabled = false;
        });
    });

    document.getElementById('assignMe').addEventListener('click', function () {
      void setAssignee(myEmployeeRefId);
    });
    document.getElementById('unassign').addEventListener('click', function () {
      void setAssignee(null);
    });
    document.getElementById('assignPicker').addEventListener('change', function (event) {
      const value = event.target.value;
      void setAssignee(value || null);
    });
    document.getElementById('statusPicker').addEventListener('change', function (event) {
      void setStatus(event.target.value);
    });
    document.getElementById('loadOlder').addEventListener('click', function () {
      void openThread(openRefId, true);
    });

    load(true);
    startLiveUpdates();
  }

  start();
})();
