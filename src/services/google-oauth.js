'use strict';

/**
 * Google OAuth 2.0 (installed/web app flow) for YouTube Data API v3.
 *
 * Tokens live in SQLite (`oauth_tokens`) and in the git-ignored credentials dir when
 * imported from `youtube-token.json`. Access tokens are refreshed automatically;
 * refresh tokens are never logged or returned to the browser.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { request, requestJson, ApiError } = require('../lib/http');

class AuthRequiredError extends Error {
  constructor(message = 'Google authorization required') {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'auth_required';
  }
}

const TOKEN_PROVIDER = 'google-youtube';

class GoogleOAuthService {
  constructor(config, { db, logger } = {}) {
    this.config = config;
    this.db = db;
    this.logger = logger;
  }

  get configured() {
    return Boolean(this.config.youtube.clientId && this.config.youtube.clientSecret);
  }

  get redirectUri() {
    return this.config.youtube.redirectUri;
  }

  createState() {
    return crypto.randomBytes(24).toString('hex');
  }

  authUrl(state) {
    if (!this.configured) throw new AuthRequiredError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
    const params = new URLSearchParams({
      client_id: this.config.youtube.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: this.config.youtube.scopes.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(code) {
    if (!this.configured) throw new AuthRequiredError();
    const response = await requestJson(`${this.config.youtube.oauthBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.youtube.clientId,
        client_secret: this.config.youtube.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
      timeoutMs: 30000,
      retries: 1,
    });
    return this.persistTokens(response.json);
  }

  async refresh(refreshToken) {
    const response = await requestJson(`${this.config.youtube.oauthBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.config.youtube.clientId,
        client_secret: this.config.youtube.clientSecret,
        grant_type: 'refresh_token',
      }).toString(),
      timeoutMs: 30000,
      retries: 2,
    });
    return this.persistTokens(response.json);
  }

  persistTokens(tokenResponse) {
    const expiresIn = Number(tokenResponse.expires_in) || 3600;
    const tokens = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      token_type: tokenResponse.token_type || 'Bearer',
      scope: tokenResponse.scope || this.config.youtube.scopes.join(' '),
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
    this.db.saveTokens(TOKEN_PROVIDER, tokens);
    this.logger?.info?.('Google OAuth tokens stored', { expiresAt: tokens.expires_at });
    return this.db.getTokens(TOKEN_PROVIDER);
  }

  storedTokens() {
    return this.db.getTokens(TOKEN_PROVIDER);
  }

  isConnected() {
    return Boolean(this.storedTokens()?.refresh_token || this.storedTokens()?.access_token);
  }

  /** Valid access token, refreshed if expiring within the skew window. */
  async accessToken({ forceRefresh = false } = {}) {
    const stored = this.storedTokens();
    if (!stored) throw new AuthRequiredError('No YouTube tokens stored. Connect the channel from Settings.');
    const expiresAt = stored.expires_at ? Date.parse(stored.expires_at) : 0;
    const expiresSoon = !expiresAt || expiresAt - Date.now() < 60_000;
    if (!forceRefresh && stored.access_token && !expiresSoon) return stored.access_token;
    if (!stored.refresh_token) {
      if (stored.access_token && !expiresSoon) return stored.access_token;
      throw new AuthRequiredError('Access token expired and no refresh token is available. Reconnect the channel.');
    }
    const refreshed = await this.refresh(stored.refresh_token);
    return refreshed.access_token;
  }

  async authorizedFetch(url, options = {}) {
    const token = await this.accessToken();
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
    const response = await request(url, { ...options, headers });
    if (response.status === 401) {
      const token2 = await this.accessToken({ forceRefresh: true });
      return request(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token2}` } });
    }
    return response;
  }

  /** Fetch the authorized channel and cache its id/title. */
  async fetchChannel() {
    const response = await requestJson(
      `${this.config.youtube.apiBase}/channels?part=snippet,contentDetails,statistics&mine=true`,
      {
        headers: { Authorization: `Bearer ${await this.accessToken()}` },
        timeoutMs: 30000,
        retries: 2,
      },
    );
    const item = response.json?.items?.[0];
    if (!item) throw new ApiError('No YouTube channel is attached to this Google account', { code: 'no_channel' });
    const tokens = this.storedTokens();
    this.db.saveTokens(TOKEN_PROVIDER, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      scope: tokens.scope,
      expires_at: tokens.expires_at,
      channel_id: item.id,
      channel_title: item.snippet.title,
      extra: { thumbnail: item.snippet.thumbnails?.default?.url || null, statistics: item.statistics || {} },
    });
    return {
      id: item.id,
      title: item.snippet.title,
      customUrl: item.snippet.customUrl || null,
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
      statistics: item.statistics || {},
    };
  }

  /** Import a previously downloaded token file (e.g. from an OAuth playground). */
  importTokenFile(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`token file not found: ${filePath}`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const merged = data.refresh_token || data.access_token ? data : data.token || data.tokens;
    if (!merged?.access_token && !merged?.refresh_token) throw new Error('token file does not contain OAuth tokens');
    const tokens = {
      access_token: merged.access_token || null,
      refresh_token: merged.refresh_token || null,
      token_type: merged.token_type || 'Bearer',
      scope: merged.scope || null,
      expires_at: merged.expiry_date
        ? new Date(merged.expiry_date).toISOString()
        : merged.expires_at || new Date(Date.now() + (Number(merged.expires_in) || 3600) * 1000).toISOString(),
    };
    this.db.saveTokens(TOKEN_PROVIDER, tokens);
    this.logger?.info?.('Imported Google tokens from file');
    return this.storedTokens();
  }

  async disconnect() {
    const stored = this.storedTokens();
    if (stored?.access_token) {
      await request(`${this.config.youtube.oauthBase}/revoke?token=${encodeURIComponent(stored.access_token)}`, {
        method: 'POST',
        timeoutMs: 15000,
      }).catch(() => null);
    }
    this.db.deleteTokens(TOKEN_PROVIDER);
  }

  credentialFilePath() {
    return path.join(this.config.paths.credentials, 'google-oauth.json');
  }
}

module.exports = { GoogleOAuthService, AuthRequiredError, TOKEN_PROVIDER };
