/**
 * Mentions: every comment where somebody tagged this business, and the thread
 * around each one.
 *
 * SEPARATE FROM THE INBOX ON PURPOSE. A mention is not a conversation with a
 * customer — it happens on a stranger's post, the reply goes through a
 * different Meta edge, and most of what an agent needs is context the inbox has
 * no place for: which post, whose, and what was being said around it. Squeezing
 * that into a message thread would bury it.
 */
(function () {
  if (!window.api.requireSession()) return;

  var listView = document.getElementById('listView');
  var threadView = document.getElementById('threadView');
  var rows = document.getElementById('rows');
  var listMessage = document.getElementById('listMessage');
  var threadMessage = document.getElementById('threadMessage');
  var threadBody = document.getElementById('threadBody');
  var loadMore = document.getElementById('loadMore');
  var backToList = document.getElementById('backToList');

  var cursor = null;
  /** Which thread is open, so a live change to THAT one can redraw it. */
  var openRefId = null;

  function show(target, kind, text, code) {
    target.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'message ' + kind;
    box.textContent = text;
    if (code) {
      var small = document.createElement('span');
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

  function when(value) {
    if (!value) return '';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  /**
   * A count, or nothing at all.
   *
   * Meta omits a field it will not answer rather than erroring, so a missing
   * like count means we were REFUSED — and printing 0 would invent a fact about
   * somebody's post. A blank is the honest rendering.
   */
  function count(value, one, many) {
    if (typeof value !== 'number') return null;
    return value.toLocaleString() + ' ' + (value === 1 ? one : many);
  }

  function text(tag, value, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  }

  /* ---------------------------------------------------------------- list -- */

  function mentionRow(conversation) {
    var context = conversation.mentionContext || {};

    var row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;cursor:pointer';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    if (context.previewUrl) {
      var thumb = document.createElement('img');
      thumb.src = context.previewUrl;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.style.cssText =
        'width:56px;height:56px;object-fit:cover;border-radius:6px;flex:0 0 auto';
      /*
       * The image is a signed Instagram URL and expires, so a broken thumbnail
       * is expected rather than exceptional — the row must still read properly
       * without it.
       */
      thumb.onerror = function () {
        thumb.remove();
      };
      row.appendChild(thumb);
    }

    var main = document.createElement('div');
    main.style.flex = '1';

    // WHO tagged us, which is the thing an agent scans this list for.
    var tagger =
      conversation.customer && conversation.customer.displayName
        ? conversation.customer.displayName
        : 'someone';
    main.appendChild(text('strong', '@' + tagger));

    // The mention itself. `subject` is the comment text the projector stored.
    if (conversation.subject) {
      main.appendChild(text('div', conversation.subject));
    }

    var meta = [];
    if (context.ownerUsername) meta.push('on @' + context.ownerUsername + "'s post");
    var likes = count(context.likeCount, 'like', 'likes');
    if (likes) meta.push(likes);
    var comments = count(context.commentCount, 'comment', 'comments');
    if (comments) meta.push(comments);
    /*
     * Likes on THE MENTION, said as such. The post's own like count is already
     * in this line, and a bare number next to it would be read as the post's.
     */
    var mentionLikes = count(context.mentionLikeCount, 'like', 'likes');
    if (mentionLikes) meta.push(mentionLikes + ' on this comment');
    var at = when(conversation.lastMessageAt);
    if (at) meta.push(at);
    if (meta.length) main.appendChild(text('small', meta.join(' · '), 'hint'));

    row.appendChild(main);

    function open() {
      openThread(conversation.refId);
    }
    row.addEventListener('click', open);
    row.addEventListener('keydown', function (event) {
      // A div with role=button is only actually a button if it answers the keyboard.
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    return row;
  }

  async function loadPage(reset) {
    /*
     * A REFRESH REPLACES, a "load more" APPENDS. Without the distinction a live
     * update would staple a second copy of page one onto the list.
     */
    if (reset) {
      cursor = null;
      rows.innerHTML = '';
    }
    try {
      var query = '/conversations?kind=mention&limit=20';
      if (cursor) query += '&cursor=' + encodeURIComponent(cursor);
      var result = await window.api.request(query);

      var items = result.data || [];
      if (!items.length && !cursor) {
        show(
          listMessage,
          'info',
          'No mentions yet. When somebody tags this business in a comment, it appears here.',
        );
      } else {
        listMessage.innerHTML = '';
      }

      items.forEach(function (conversation) {
        rows.appendChild(mentionRow(conversation));
      });

      // Pagination is lifted into `meta` by the envelope interceptor, the same
      // as every other list in this portal.
      var pagination = (result.meta && result.meta.pagination) || {};
      cursor = pagination.nextCursor || null;
      loadMore.hidden = !pagination.hasMore;
    } catch (error) {
      handle(error, listMessage);
    }
  }

  /* -------------------------------------------------------------- thread -- */

  /** The post the mention was left under. */
  function postCard(context) {
    var panel = document.createElement('div');
    panel.className = 'panel';

    panel.appendChild(text('h2', 'The post'));

    var MEDIA_CSS = 'max-width:100%;max-height:320px;border-radius:8px;display:block';

    /**
     * What to show when the media has gone.
     *
     * NOT JUST A LINE SAYING SO. Instagram's media links are signed and expire
     * — the API now says as much in `mediaExpires` — but `permalink` does not,
     * so there is always somewhere to send the person. Saying "no longer
     * available" and stopping reads as "this post is gone", when the post is
     * perfectly fine and one click away.
     */
    function mediaGone(what) {
      if (!context.permalink) return text('p', what + ' is no longer available.', 'hint');

      var wrap = document.createElement('p');
      wrap.className = 'hint';
      wrap.textContent = what + ' is no longer available — ';
      var link = document.createElement('a');
      link.href = context.permalink;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'open it on Instagram';
      wrap.appendChild(link);
      return wrap;
    }

    /** The thumbnail, or a way through to the post when even that has expired. */
    function stillPreview() {
      var image = document.createElement('img');
      image.src = context.previewUrl;
      image.alt = '';
      image.style.cssText = MEDIA_CSS;
      image.onerror = function () {
        image.replaceWith(mediaGone('The preview'));
      };
      return image;
    }

    /*
     * PLAY THE REEL WHEN WE ACTUALLY HAVE IT.
     *
     * A reel's `media_url` is sometimes the real .mp4 — 1.8 MB of playable
     * video/mp4, verified on the wire — and it was being stored, served to the
     * client, and then ignored while the page showed a still. There is no
     * reason to make an agent leave for Instagram to watch something we already
     * hold.
     *
     * NOT UNCONDITIONAL, because Meta is inconsistent here: across four reels
     * one gave neither field, one only a thumbnail, and two both. So this plays
     * only when there IS a video, and falls back to the still otherwise.
     *
     * `poster` is the thumbnail, so the card looks identical before playback
     * and does not download the video until somebody asks for it. And these are
     * signed CDN links that expire, so a reel that plays today 404s later —
     * hence the fallback to the still, and then to a plain line, rather than a
     * broken player.
     */
    var hasVideo = context.mediaType === 'VIDEO' && !!context.mediaUrl;

    if (hasVideo) {
      var video = document.createElement('video');
      video.src = context.mediaUrl;
      video.controls = true;
      // Metadata only: the list of mentions should not pull megabytes per card.
      video.preload = 'metadata';
      if (context.thumbnailUrl) video.poster = context.thumbnailUrl;
      video.style.cssText = MEDIA_CSS;
      video.onerror = function () {
        /*
         * The signed link has expired. The still often outlives it — measured
         * on one reel, the video lasted about 35 hours and the thumbnail about
         * 4.5 days — so the still is tried before giving up.
         */
        if (context.previewUrl) video.replaceWith(stillPreview());
        else video.replaceWith(mediaGone('The video'));
      };
      panel.appendChild(video);
    } else if (context.previewUrl) {
      panel.appendChild(stillPreview());

      /*
       * SAY WHY THERE IS NO PLAY BUTTON.
       *
       * Meta is inconsistent about `media_url` on a reel: asked for eleven
       * fields on one, it returned ten and simply omitted the video — verified
       * on the wire 19 Sep 2026, and the thumbnail came back fine. So a still
       * with no player is the correct rendering, not a failure, and without a
       * line saying so it reads as one. It cost somebody twenty minutes.
       */
      if (context.mediaType === 'VIDEO') {
        panel.appendChild(
          text('p', 'Instagram did not include the video for this post — open it there to watch.', 'hint'),
        );
      }
    }

    if (context.ownerUsername) {
      // "Reel" rather than "post" where the platform says so — an agent opening
      // the link should know what they are about to watch.
      var kind = context.productType === 'REELS' ? 'Reel' : 'Post';
      panel.appendChild(text('p', kind + ' by @' + context.ownerUsername));
    }
    if (context.caption) {
      var caption = text('p', context.caption);
      caption.style.whiteSpace = 'pre-wrap';
      panel.appendChild(caption);
    }

    var facts = [];
    var likes = count(context.likeCount, 'like', 'likes');
    if (likes) facts.push(likes);
    var comments = count(context.commentCount, 'comment', 'comments');
    if (comments) facts.push(comments);
    var posted = when(context.postedAt);
    if (posted) facts.push('posted ' + posted);
    /*
     * Share count is deliberately absent rather than shown as a dash. Instagram
     * exposes no share or save count for a post we do not own — there is no
     * field for it — and a dash would read as "nobody shared this".
     */
    if (facts.length) panel.appendChild(text('small', facts.join(' · '), 'hint'));

    /*
     * The comment link first, because it is what an agent actually wants: it
     * lands on the mention itself rather than the top of a post with two
     * thousand comments. The post link stays as the dependable fallback — the
     * comment URL is composed by us, not given by Meta.
     */
    if (context.commentUrl) {
      var commentLink = document.createElement('a');
      commentLink.href = context.commentUrl;
      commentLink.target = '_blank';
      commentLink.rel = 'noopener noreferrer';
      commentLink.textContent = 'Open this comment on Instagram';
      commentLink.style.display = 'block';
      panel.appendChild(commentLink);
    }

    /*
     * The share form Instagram's own app produces. Kept alongside the deep link
     * because it is what somebody pasting from their phone will recognise, and
     * it opens the comment sheet directly on mobile.
     */
    if (context.commentShareUrl) {
      var shareLink = document.createElement('a');
      shareLink.href = context.commentShareUrl;
      shareLink.target = '_blank';
      shareLink.rel = 'noopener noreferrer';
      shareLink.textContent = 'Open with comments (app share link)';
      shareLink.style.display = 'block';
      panel.appendChild(shareLink);
    }

    if (context.permalink) {
      var link = document.createElement('a');
      link.href = context.permalink;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = context.commentUrl ? 'Open the post' : 'Open on Instagram';
      link.style.display = 'block';
      panel.appendChild(link);
    }

    return panel;
  }

  /**
   * One comment in the thread.
   *
   * `author` is null for everything except our own mention and the comment it
   * answered: Instagram omits the author on every other comment in a thread it
   * did not have to show us, so the row says so rather than leaving a blank
   * where a name should be.
   */
  function commentRow(comment, options) {
    var settings = options || {};
    var row = document.createElement('div');
    row.className = 'row';
    if (settings.highlight) {
      row.style.cssText = 'border-left:3px solid currentColor;padding-left:8px';
    }

    /*
     * THREE WAYS TO NAME A COMMENT, and only the last is a shrug. Our own sends
     * are "you"; a comment we already hold carries the name we stored for it;
     * everything else is genuinely anonymous because Meta omits the author.
     */
    var who = comment.isOurs ? 'you' : comment.authorUsername ? '@' + comment.authorUsername : null;
    row.appendChild(text('strong', who || 'someone'));

    if (comment.text) {
      var body = text('div', comment.text);
      body.style.whiteSpace = 'pre-wrap';
      row.appendChild(body);
    } else {
      /*
       * A comment with no text is almost always a media reply — a GIF or a
       * sticker. Instagram exposes NO media field on a comment at all, so the
       * content is genuinely unreachable rather than merely not requested.
       */
      /*
       * A comment with no text is a MEDIA comment — a photo, a GIF, a sticker.
       * Instagram exposes no media field on a comment at all, so the content is
       * unreachable rather than merely unrequested, and saying which is the
       * difference between "we failed" and "the platform does not offer it".
       */
      row.appendChild(
        text('em', 'a photo or GIF — Instagram exposes no media on a comment, so we cannot show it'),
      );
    }

    var meta = [];
    // Said only when it is TRUE. It was being printed against our own replies,
    // which claimed we did not know who had said something we said ourselves.
    if (!who) meta.push('Instagram does not tell us who');
    var at = when(comment.postedAt);
    if (at) meta.push(at);
    var likes = count(comment.likeCount, 'like', 'likes');
    if (likes) meta.push(likes);
    if (meta.length) row.appendChild(text('small', meta.join(' · '), 'hint'));

    return row;
  }

  function threadPanel(conversation, messages) {
    var context = conversation.mentionContext || {};
    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.appendChild(text('h2', 'The thread'));

    /*
     * WHAT THE MENTION WAS ANSWERING. Somebody can tag us inside a reply, and
     * then the tag alone is a fragment — "tell this guy" means nothing without
     * the comment above it. Absent when the mention is top-level, and also when
     * the parent did not mention us, which Instagram refuses to describe.
     */
    if (context.parentComment && context.parentComment.available === false) {
      /*
       * THE TAG WAS A REPLY TO A STRANGER'S COMMENT. Instagram will not show us
       * that comment — the mentions edge refuses it and the post's comment list
       * does not contain it — so the mention arrives as a fragment. Saying so
       * is the whole point: without this the reply reads as if it opened the
       * conversation, and an agent answers the wrong thing.
       */
      /*
       * A DEAD END IS NOT AN ANSWER. The tag sits under a stranger's comment,
       * and Instagram refuses to describe that comment by either route — the
       * mentions edge answers `(#10) User is not mentioned in the comment`, and
       * the post's own comment list returns one page that does not contain it.
       *
       * But the agent does not actually need us to fetch it: the deep link
       * opens their own reply IN PLACE, with the comment it answers directly
       * above. So this offers the way there instead of just apologising.
       */
      var missing = document.createElement('div');
      missing.appendChild(
        text('strong', 'This was a reply to somebody else\u2019s comment'),
      );
      missing.appendChild(
        text(
          'small',
          'Instagram will not tell us what that comment said \u2014 open the mention on Instagram to read it in place.',
          'hint',
        ),
      );

      if (context.commentUrl) {
        var jump = document.createElement('a');
        jump.href = context.commentUrl;
        jump.target = '_blank';
        jump.rel = 'noopener noreferrer';
        jump.textContent = 'See it in context on Instagram \u2192';
        jump.style.display = 'block';
        missing.appendChild(jump);
      }

      panel.appendChild(missing);
      panel.appendChild(document.createElement('hr'));
    } else if (context.parentComment) {
      panel.appendChild(text('small', 'This mention was a reply to:', 'hint'));
      panel.appendChild(commentRow(context.parentComment));

      /*
       * THE SAME EXCHANGE, FILED TWICE. When the comment this answered also
       * tagged us, it is a mention of ours in its own right — so the parent is
       * not just quoted text, it is another thread with its own post card,
       * replies and reply box. Offering the jump beats showing the words twice
       * with no way to reach the conversation they belong to.
       */
      if (context.parentMention) {
        var jumpToParent = document.createElement('button');
        jumpToParent.className = 'secondary';
        jumpToParent.textContent = 'Open that mention →';
        jumpToParent.addEventListener('click', function () {
          openThread(context.parentMention.refId);
        });
        panel.appendChild(jumpToParent);
      }

      /*
       * THE MENTION IS A SIBLING OF ITSELF. It sits in this thread like any
       * other reply, so drawing the list unfiltered showed it twice — once
       * anonymously here and once as the message below, reading as two people
       * saying the same thing at the same second.
       */
      (context.parentComment.replies || [])
        .filter(function (reply) {
          return !reply.isThisMention;
        })
        .forEach(function (reply) {
          var row = commentRow(reply);
          row.style.marginLeft = '20px';
          panel.appendChild(row);
        });
      panel.appendChild(document.createElement('hr'));
    }

    /*
     * OLDEST FIRST. The API returns a thread newest-first because that is what
     * its cursor pages on, and rendering it in that order put our replies ABOVE
     * the mention they answered — a conversation running backwards.
     */
    var ordered = (messages || []).slice().sort(function (a, b) {
      return (
        new Date(a.platformSentAt || a.createdAt) - new Date(b.platformSentAt || b.createdAt)
      );
    });
    ordered.forEach(function (message) {
      panel.appendChild(
        commentRow(
          {
            // Our own sends say "you" through isOurs, exactly as they do in the
            // thread above — one rule for naming a comment, not two.
            isOurs: message.direction === 'outbound',
            authorUsername:
              message.direction === 'outbound'
                ? null
                : conversation.customer && conversation.customer.displayName,
            text: message.body,
            postedAt: message.platformSentAt || message.createdAt,
            likeCount: null,
          },
          { highlight: message.direction === 'inbound' },
        ),
      );
    });

    /*
     * Replies under our mention, as they looked when we last read them. Meta
     * sends NO webhook when somebody replies to a mention, so this cannot be
     * live and must not pretend to be.
     */
    var replies = context.replies || [];
    if (replies.length) {
      panel.appendChild(text('small', 'Replies, when we last looked:', 'hint'));
      replies
        .filter(function (reply) {
          return !reply.isThisMention;
        })
        .forEach(function (reply) {
          var row = commentRow(reply);
          row.style.marginLeft = '20px';
          panel.appendChild(row);
        });
    }

    /*
     * THE WIDER COMMENT SECTION, behind a disclosure and closed by default.
     *
     * It is the room, not the conversation: fifty anonymous lines, none of them
     * answerable, most of them nothing to do with us. Useful to glance at, and
     * actively harmful mixed into the thread above — so it is one click away
     * and labelled for what it is.
     */
    /*
     * The mention is a comment on that post like any other, so it comes back in
     * this list too — filtered out here for the same reason it is filtered out
     * of the parent thread: it is already shown above, and seeing your own tag
     * a third time reads as a third person saying it.
     */
    var postComments = (context.postComments || []).filter(function (comment) {
      return !comment.isThisMention;
    });
    if (postComments.length) {
      var box = document.createElement('details');
      var head = document.createElement('summary');
      head.textContent =
        'The rest of the comment section (' + postComments.length + ', nobody named)';
      box.appendChild(head);

      var note = text(
        'small',
        context.postCommentsReadAt
          ? 'A snapshot from ' +
              when(context.postCommentsReadAt) +
              ' — Instagram sends nothing when somebody comments on another account\u2019s post.'
          : 'A snapshot, not a live view.',
        'hint',
      );
      note.style.display = 'block';
      box.appendChild(note);

      postComments.forEach(function (comment) {
        box.appendChild(commentRow(comment));
      });
      panel.appendChild(box);
    }

    return panel;
  }

  /** Answering a mention goes through Instagram's mentions edge, not the inbox. */
  function replyPanel(conversation) {
    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.appendChild(text('h2', 'Reply'));

    var box = document.createElement('textarea');
    box.rows = 3;
    box.style.width = '100%';
    box.placeholder = 'Reply under this comment on Instagram…';
    panel.appendChild(box);

    var feedback = document.createElement('div');
    var button = document.createElement('button');
    button.textContent = 'Send reply';

    button.addEventListener('click', async function () {
      var body = box.value.trim();
      if (!body) {
        show(feedback, 'error', 'Write something first.');
        return;
      }

      button.disabled = true;
      try {
        await window.api.request('/conversations/' + conversation.refId + '/reply', {
          method: 'POST',
          body: {
            body: body,
            /*
             * One key per composed message, reused by any retry — that is what
             * makes the send idempotent. Minting a fresh one per attempt would
             * protect nothing.
             */
            idempotencyKey:
              window.crypto && window.crypto.randomUUID
                ? window.crypto.randomUUID()
                : String(Date.now()) + Math.random().toString(16).slice(2),
            internalNote: false,
          },
        });
        box.value = '';
        show(feedback, 'success', 'Sent. It will appear on Instagram under the mention.');
        openThread(conversation.refId);
      } catch (error) {
        handle(error, feedback);
      } finally {
        button.disabled = false;
      }
    });

    panel.appendChild(button);
    panel.appendChild(feedback);
    return panel;
  }

  async function openThread(refId) {
    openRefId = refId;
    listView.hidden = true;
    threadView.hidden = false;
    threadBody.innerHTML = '';
    threadMessage.innerHTML = '';

    try {
      var result = await window.api.request('/conversations/' + refId);
      var conversation = result.data.conversation;
      var messages = result.data.messages || [];

      var context = conversation.mentionContext;
      if (context) threadBody.appendChild(postCard(context));
      threadBody.appendChild(threadPanel(conversation, messages));

      /*
       * The reply control is shown only when the API says a reply can actually
       * reach the platform. Offering a button that can only fail is worse than
       * offering none.
       */
      if (conversation.canReply) {
        threadBody.appendChild(replyPanel(conversation));
      } else if (conversation.replyBlockedReason) {
        show(threadMessage, 'info', conversation.replyBlockedReason);
      }
    } catch (error) {
      handle(error, threadMessage);
    }
  }

  /* ------------------------------------------------------------------ *
   * Live updates
   *
   * The mentions page had NONE, while the inbox did — so a mention that
   * arrived while the page was open simply never showed, and the honest
   * conclusion to draw was that it had not arrived at all. Two list pages in
   * one portal, one live and one not, with nothing saying which.
   *
   * Same approach as the inbox, and for the same reason: fetch + a readable
   * stream rather than EventSource, because EventSource cannot set an
   * Authorization header and the alternatives are a token in the query string
   * (which lands in access logs) or a ticket endpoint.
   *
   * The stream is an OPTIMISATION. The slow poll runs regardless, so a dropped
   * connection or a hostile proxy costs latency and nothing else.
   * ------------------------------------------------------------------ */
  var POLL_MS = 30000;
  var STREAM_RETRY_BASE_MS = 2000;
  var STREAM_RETRY_MAX_MS = 60000;

  var streamAbort = null;
  var streamAttempt = 0;

  function onConversationChanged(change) {
    /*
     * The stream carries EVERY conversation this business has, not just
     * mentions — it is a nudge with a ref and nothing else. Rather than guess
     * which kind changed, the list is simply re-read; the server filters to
     * mentions, so an unrelated DM costs one cheap query and no wrong rows.
     */
    if (!threadView.hidden) {
      // A thread is open: refresh it only when it is the one that moved.
      if (openRefId && change && change.conversationRefId === openRefId) {
        void openThread(openRefId);
      }
      return;
    }
    loadPage(true);
  }

  /** Parses SSE frames out of a byte stream. */
  async function consume(response) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Frames are blank-line separated; the tail is a partial frame and stays.
      var frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      frames.forEach(function (frame) {
        var event = 'message';
        var data = '';
        frame.split('\n').forEach(function (line) {
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          // A ':' line is a heartbeat comment — ignored, but it did its job.
        });

        /*
         * The server caps a stream's lifetime on purpose, because an open
         * stream is otherwise an authorisation with no expiry. It says so
         * first, and reconnecting at once keeps that invisible rather than
         * waiting out a backoff for something that is not a failure.
         */
        if (event === 'expired') {
          streamAttempt = 0;
          return;
        }

        if (event !== 'inbox' || !data) return;
        try {
          onConversationChanged(JSON.parse(data));
        } catch (_) {
          // A malformed frame is not worth tearing the stream down for.
        }
      });
    }
  }

  async function openStream() {
    var session = window.api.readSession();
    if (!session || !session.accessToken) return;

    streamAbort = new AbortController();
    try {
      var response = await fetch(window.WOUCHH_CONFIG.apiBaseUrl + '/conversations/stream', {
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + session.accessToken },
        credentials: 'include',
        signal: streamAbort.signal,
      });
      if (!response.ok || !response.body) throw new Error('stream rejected: ' + response.status);
      streamAttempt = 0;
      await consume(response);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }

    // Ended or failed: back off and retry. The poll covers the gap.
    streamAttempt += 1;
    var delay = Math.min(STREAM_RETRY_BASE_MS * Math.pow(2, streamAttempt - 1), STREAM_RETRY_MAX_MS);
    setTimeout(function () {
      if (!document.hidden) void openStream();
    }, delay);
  }

  function startLiveUpdates() {
    // The floor: with no stream at all the list still stays roughly current.
    var pollTimer = setInterval(function () {
      if (!document.hidden && threadView.hidden) loadPage(true);
    }, POLL_MS);
    if (pollTimer && pollTimer.unref) pollTimer.unref();

    void openStream();

    // A backgrounded tab is not worth a connection; reopening on return also
    // catches whatever arrived while it was hidden.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (streamAbort) streamAbort.abort();
        return;
      }
      if (threadView.hidden) loadPage(true);
      void openStream();
    });
  }

  backToList.addEventListener('click', function () {
    openRefId = null;
    threadView.hidden = true;
    listView.hidden = false;
    // Coming back from a thread is the natural moment to pick up anything that
    // arrived while it was open.
    loadPage(true);
  });

  // Explicitly not passing the click event through as `reset`.
  loadMore.addEventListener('click', function () {
    loadPage(false);
  });

  (async function start() {
    try {
      var me = (await window.api.request('/auth/me')).data;
      document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : '';
    } catch (_) {
      // The header name is decoration; the list is the page.
    }
    loadPage(true);
    startLiveUpdates();
  })();
})();
