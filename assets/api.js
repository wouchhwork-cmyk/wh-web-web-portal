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
    writeSession(Object.assign({}, readSession(), { me: me }));
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
