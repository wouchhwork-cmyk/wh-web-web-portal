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

  async function loadPage() {
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

    if (context.previewUrl) {
      var image = document.createElement('img');
      image.src = context.previewUrl;
      image.alt = '';
      image.style.cssText = 'max-width:100%;max-height:320px;border-radius:8px;display:block';
      image.onerror = function () {
        image.replaceWith(text('p', 'The image is no longer available.', 'hint'));
      };
      panel.appendChild(image);
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
      row.appendChild(text('em', 'a reply we cannot read — Instagram gives us no media for it'));
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
      panel.appendChild(
        text(
          'small',
          'This was a reply to someone else\u2019s comment, which Instagram will not show us.',
          'hint',
        ),
      );
      panel.appendChild(document.createElement('hr'));
    } else if (context.parentComment) {
      panel.appendChild(text('small', 'This mention was a reply to:', 'hint'));
      panel.appendChild(commentRow(context.parentComment));

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
    var postComments = context.postComments || [];
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

  backToList.addEventListener('click', function () {
    threadView.hidden = true;
    listView.hidden = false;
  });

  loadMore.addEventListener('click', loadPage);

  (async function start() {
    try {
      var me = (await window.api.request('/auth/me')).data;
      document.getElementById('who').textContent = me.enterprise ? me.enterprise.name : '';
    } catch (_) {
      // The header name is decoration; the list is the page.
    }
    loadPage();
  })();
})();
