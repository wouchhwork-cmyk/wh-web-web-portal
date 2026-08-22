/**
 * The one place that talks to the API.
 *
 * Everything goes through request(): one place that attaches the token, unwraps
 * the response envelope, and turns an error envelope into a thrown Error whose
 * message is already fit to show a person.
 */
(function () {
  const config = window.WOUCHH_CONFIG;

  const SESSION_KEY = 'wouchh.session';
  const PENDING_KEY = 'wouchh.pendingVerification';

  /** Thrown for any non-2xx, carrying the API's machine-readable code. */
  class ApiError extends Error {
    constructor(message, code, status, details) {
      super(message);
      this.code = code;
      this.status = status;
      this.details = details || [];
    }
  }

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function writeSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PENDING_KEY);
  }

  function readPending() {
    try {
      return JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function writePending(pending) {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  }

  /**
   * An access token lives fifteen minutes; a person's tab does not.
   *
   * SINGLE-FLIGHT, deliberately: a page that fires four requests at once gets
   * four 401s, and four parallel refreshes would be four sessions' worth of work
   * to reach the same token. Everyone waits on the first one.
   *
   * The refresh cookie is NOT rotated by the API (auth.service.ts §refresh), so
   * a retry after a failed refresh is safe — there is no burnt token to lose.
   */
  let refreshInFlight = null;

  function currentEnterpriseRefId() {
    const session = readSession();
    if (!session) return null;
    // Written by routeToHome(); falls back to the /auth/me payload it stored.
    if (session.enterpriseRefId) return session.enterpriseRefId;
    if (session.me && session.me.enterprise) return session.me.enterprise.refId;
    return null;
  }

  function attemptRefresh() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async function () {
      try {
        // WITHOUT enterpriseRefId the API issues an UNSCOPED token: refresh()
        // only resolves employment when the query names an enterprise, so an
        // employee would come back with enterpriseId null and 403 on every
        // scoped route. Staff with no business selected pass null correctly.
        const enterpriseRefId = currentEnterpriseRefId();
        const query = enterpriseRefId
          ? '?enterpriseRefId=' + encodeURIComponent(enterpriseRefId)
          : '';
        const result = await request('/auth/refresh' + query, {
          method: 'POST',
          skipRefresh: true,
        });
        writeSession(
          Object.assign({}, readSession(), { accessToken: result.data.accessToken }),
        );
        return true;
      } catch (_) {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  }

  async function request(path, options) {
    const opts = options || {};
    const session = readSession();

    const headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (session && session.accessToken) {
      headers.Authorization = 'Bearer ' + session.accessToken;
    }

    let response;
    try {
      response = await fetch(config.apiBaseUrl + path, {
        method: opts.method || 'GET',
        headers: headers,
        // The refresh token is an httpOnly cookie. Without this the browser
        // never sends it and /auth/refresh can never work.
        credentials: 'include',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (cause) {
      throw new ApiError(
        'Could not reach the API. Is it running on ' + config.apiBaseUrl + '?',
        'NETWORK_ERROR',
        0,
      );
    }

    // 204 and friends carry nothing to parse.
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const error = (payload && payload.error) || {};

      // ONLY an expired access token is retryable. A revoked session or a
      // permission denial must surface as itself — retrying those would loop.
      const retryable =
        response.status === 401 &&
        error.code === 'AUTH_TOKEN_EXPIRED' &&
        !opts.skipRefresh &&
        !opts.retried;

      if (retryable) {
        const refreshed = await attemptRefresh();
        if (refreshed) {
          return request(path, Object.assign({}, opts, { retried: true }));
        }
        // The refresh token is gone or revoked too: this session is over.
        // Send them to sign in rather than leaving a page of dead errors.
        clearSession();
        if (!/(^|\/)index\.html$/.test(window.location.pathname)) {
          window.location.href = 'index.html';
        }
      }

      throw new ApiError(
        error.message || 'Request failed.',
        error.code || 'UNKNOWN',
        response.status,
        error.details,
      );
    }

    return { data: payload ? payload.data : null, meta: payload ? payload.meta : null };
  }

  /**
   * Sends the caller wherever their session says they belong.
   *
   * Called after every successful sign-in and on every page load of a protected
   * page, so there is exactly one implementation of "where does this person go".
   */
  async function routeToHome() {
    const me = (await request('/auth/me')).data;
    // enterpriseRefId is stored flat because refresh needs it on every
    // retry, including before any page has re-read /auth/me.
    writeSession(
      Object.assign({}, readSession(), {
        me: me,
        enterpriseRefId: me.enterprise ? me.enterprise.refId : null,
      }),
    );
    window.location.href = me.isPlatformAdmin ? 'admin.html' : 'portal.html';
  }

  /** For protected pages: bounce to login if there is no token. */
  function requireSession() {
    const session = readSession();
    if (!session || !session.accessToken) {
      window.location.href = 'index.html';
      return null;
    }
    return session;
  }

  window.api = {
    ApiError: ApiError,
    request: request,
    readSession: readSession,
    writeSession: writeSession,
    clearSession: clearSession,
    readPending: readPending,
    writePending: writePending,
    routeToHome: routeToHome,
    requireSession: requireSession,
  };
})();
