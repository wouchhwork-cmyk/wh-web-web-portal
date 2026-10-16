/**
 * The only file that should need changing between environments.
 *
 * Loaded as a plain script before everything else, so there is no build step and
 * no bundler: this is a deliberately basic portal whose job right now is to prove
 * the API flows work end to end.
 */
window.WOUCHH_CONFIG = {
  /**
   * Must be an origin the API allows in CORS_ORIGINS, and the page must be
   * served from one too — the refresh token is an httpOnly cookie, so every
   * request is credentialed and the browser will refuse a mismatched origin.
   */
  apiBaseUrl: 'http://localhost:3000/api/v1',

  /**
   * Shown on the code screen while the backend has OTP_REALTIME_ENABLED=false,
   * where every issued code is the fixed one. Blank this the moment a real SMS
   * or email provider is wired up.
   */
  devOtpHint: '666666',
};
