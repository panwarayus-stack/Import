'use strict';

/**
 * Static hosting deployments.
 *
 * Providers (DEPLOY_PROVIDER):
 *   - github-pages : GitHub repo + Pages (free for public repos, 1 GB site limit, ~10 builds/hour)
 *   - netlify      : Netlify deploy API (free tier has bandwidth/build-minute limits)
 *   - local        : served by this app at /sites/<id>/ — a real live URL only if the
 *                    app itself is publicly reachable; always labelled as local.
 *
 * Safety:
 *   - never overwrites an existing project (unique repo/site per generated site);
 *   - verifies the live URL before the pipeline may record it;
 *   - credentials stay server-side (env only).
 */

const fs = require('node:fs');
const path = require('node:path');
const { requestJson, ApiError, sleep } = require('../lib/http');
const { createZip } = require('../lib/zip');
const { listFiles, slugify } = require('../lib/fs-safe');

class DeployError extends Error {
  constructor(message, { provider = null, code = 'deploy_error', retryable = false } = {}) {
    super(message);
    this.name = 'DeployError';
    this.provider = provider;
    this.code = code;
    this.retryable = retryable;
  }
}

class DeployConflictError extends DeployError {
  constructor(message) {
    super(message, { code: 'deploy_conflict', retryable: false });
    this.name = 'DeployConflictError';
  }
}

class Deployer {
  constructor(config, { logger, db } = {}) {
    this.config = config;
    this.logger = logger;
    this.db = db;
  }

  get provider() {
    return this.config.deploy.provider;
  }

  /**
   * @returns {Promise<{provider:string, url:string, simulated:boolean, verified:boolean,
   *                    public:boolean, meta:object, note:string}>}
   */
  async deploy({ siteId, siteDir, brief = {}, title = 'Website' }) {
    const provider = this.provider;
    if (provider === 'github-pages' && (!this.config.deploy.github.token || !this.config.deploy.github.owner)) {
      this.logger?.warn?.('github-pages selected but GITHUB_TOKEN/GITHUB_OWNER are missing; using the local preview deployment');
      return this.deployLocal({ siteId });
    }
    if (provider === 'netlify' && !this.config.deploy.netlify.token) {
      this.logger?.warn?.('netlify selected but NETLIFY_AUTH_TOKEN is missing; using the local preview deployment');
      return this.deployLocal({ siteId });
    }
    this.logger?.info?.(`Deploying site via ${provider}`, { siteId });
    switch (provider) {
      case 'github-pages':
        return this.deployGitHubPages({ siteId, siteDir, brief, title });
      case 'netlify':
        return this.deployNetlify({ siteId, siteDir, brief, title });
      case 'local':
      default:
        return this.deployLocal({ siteId });
    }
  }

  deployLocal({ siteId }) {
    const url = `${this.config.deploy.local.publicBaseUrl}/${siteId}/`;
    return {
      provider: 'local',
      url,
      simulated: true,
      verified: false,
      public: false,
      meta: { note: 'Served by this application at /sites/<id>/. Not a public third-party host.' },
      note: 'Local preview deployment (no external hosting credentials configured).',
    };
  }

  async deployGitHubPages({ siteId, siteDir, brief, title }) {
    const { token, owner, repoPrefix, visibility, branch } = this.config.deploy.github;
    if (!token || !owner) {
      throw new DeployError('GITHUB_TOKEN and GITHUB_OWNER are required for github-pages', { provider: 'github-pages' });
    }
    const repoName = `${slugify(repoPrefix, { max: 30, fallback: 'comment-site' })}-${siteId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(-12)}`;
    const api = this.config.deploy.github.apiBase;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'ai-website-shorts-factory',
    };

    // 1. Refuse to touch an existing repository with the same name.
    const existing = await fetch(`${api}/repos/${owner}/${repoName}`, { headers }).catch(() => null);
    if (existing && existing.status === 200) {
      throw new DeployConflictError(`Repository ${owner}/${repoName} already exists; refusing to overwrite it.`);
    }

    // 2. Create the repository (user or organisation owner).
    const me = await requestJson(`${api}/user`, { headers, timeoutMs: 30000 }).catch(() => null);
    const isUser = me?.json?.login?.toLowerCase() === owner.toLowerCase();
    const createUrl = isUser ? `${api}/user/repos` : `${api}/orgs/${owner}/repos`;
    const created = await requestJson(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: repoName,
        description: `Generated site: ${title}`.slice(0, 350),
        private: visibility === 'private',
        auto_init: false,
        has_issues: false,
        has_wiki: false,
        has_projects: false,
      }),
      timeoutMs: 45000,
    });

    const files = listFiles(siteDir, {
      maxFiles: this.config.deploy.maxFiles,
      maxBytes: this.config.deploy.maxSiteBytes,
    }).files;

    // 3. Commit every file with the contents API (sequential to stay well under rate limits).
    let firstCommitSha = null;
    for (const file of files) {
      const content = fs.readFileSync(path.join(siteDir, file.rel));
      const response = await requestJson(`${api}/repos/${owner}/${repoName}/contents/${encodeURI(file.rel)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `Add ${file.rel}`,
          content: content.toString('base64'),
          branch,
        }),
        timeoutMs: 60000,
      });
      firstCommitSha = firstCommitSha || response.json?.commit?.sha || null;
      await sleep(120);
    }
    if (!firstCommitSha) throw new DeployError('No files were committed to GitHub', { provider: 'github-pages' });

    // 4. Enable GitHub Pages from the branch root (idempotent-ish: 409 means already enabled).
    await requestJson(`${api}/repos/${owner}/${repoName}/pages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { branch, path: '/' } }),
      timeoutMs: 45000,
    }).catch((error) => {
      if (error.status && ![409, 422].includes(error.status)) throw error;
    });

    const isUserSite = repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`;
    const url = isUserSite ? `https://${repoName}` : `https://${owner}.github.io/${repoName}/`;

    return {
      provider: 'github-pages',
      url,
      simulated: false,
      verified: false, // verification happens in verify()
      public: visibility === 'public',
      meta: {
        owner,
        repo: repoName,
        branch,
        htmlUrl: created.json?.html_url || `https://github.com/${owner}/${repoName}`,
        pagesUrl: url,
        commitSha: firstCommitSha,
        files: files.length,
        brief: { title: brief.title || title, slug: brief.slug || null },
      },
      note: 'GitHub Pages can take 30-120 seconds to publish the first build.',
    };
  }

  async deployNetlify({ siteId, siteDir, brief, title }) {
    const { token, siteId: netlifySiteId, apiBase } = this.config.deploy.netlify;
    if (!token) throw new DeployError('NETLIFY_AUTH_TOKEN is required for netlify deployments', { provider: 'netlify' });
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ai-website-shorts-factory',
    };

    let targetSiteId = netlifySiteId;
    let siteUrl = null;
    if (!targetSiteId) {
      const siteName = `${slugify(this.config.deploy.github.repoPrefix || 'comment-site', { max: 24 })}-${siteId
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(-10)}`;
      const created = await requestJson(`${apiBase}/sites`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: siteName }),
        timeoutMs: 45000,
      });
      targetSiteId = created.json?.id;
      siteUrl = created.json?.ssl_url || created.json?.url || null;
    }

    const files = listFiles(siteDir, { maxFiles: this.config.deploy.maxFiles, maxBytes: this.config.deploy.maxSiteBytes }).files;
    const zip = createZip(files.map((file) => ({ name: file.rel, data: fs.readFileSync(path.join(siteDir, file.rel)) })));

    const deploy = await requestJson(`${apiBase}/sites/${targetSiteId}/deploys`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/zip' },
      body: zip,
      timeoutMs: 180000,
    });

    const deployId = deploy.json?.id;
    let state = deploy.json?.state;
    let deployUrl = deploy.json?.ssl_url || deploy.json?.deploy_url || siteUrl;

    // Poll the deploy until it is ready (bounded).
    for (let i = 0; i < 20 && state !== 'ready'; i += 1) {
      if (!deployId) break;
      await sleep(3000);
      const status = await requestJson(`${apiBase}/deploys/${deployId}`, { headers, timeoutMs: 30000 }).catch(() => null);
      state = status?.json?.state || state;
      deployUrl = status?.json?.ssl_url || status?.json?.deploy_url || deployUrl;
      if (state === 'error') throw new DeployError('Netlify reported a failed deploy', { provider: 'netlify' });
    }

    if (!deployUrl) throw new DeployError('Netlify did not return a deploy URL', { provider: 'netlify' });

    return {
      provider: 'netlify',
      url: deployUrl,
      simulated: false,
      verified: false,
      public: true,
      meta: {
        siteId: targetSiteId,
        deployId,
        state,
        files: files.length,
        brief: { title: brief.title || title, slug: brief.slug || null },
      },
      note: 'Netlify free tier applies bandwidth and build-minute limits.',
    };
  }

  /**
   * Verify a deployed URL is actually live before recording.
   * @returns {Promise<{ok:boolean, status:number, attempts:number, error?:string}>}
   */
  async verify(url, { expectedText = null, timeoutMs = null, attempts = 6 } = {}) {
    const totalBudget = timeoutMs || this.config.deploy.verifyTimeoutMs;
    const started = Date.now();
    let lastStatus = 0;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (Date.now() - started > totalBudget) break;
      try {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        lastStatus = response.status;
        const body = await response.text();
        const looksLikeSite = /<html/i.test(body) && body.length > 200;
        const textOk = !expectedText || body.toLowerCase().includes(String(expectedText).toLowerCase().slice(0, 40));
        if (response.ok && looksLikeSite && textOk) {
          return { ok: true, status: response.status, attempts: attempt, durationMs: Date.now() - started };
        }
        lastError = `HTTP ${response.status}${textOk ? '' : ' (content mismatch)'}`;
      } catch (error) {
        lastError = error.message;
      }
      await sleep(Math.min(15000, 1500 * 2 ** (attempt - 1)));
    }
    return {
      ok: false,
      status: lastStatus,
      attempts,
      error: lastError || 'verification timed out',
      durationMs: Date.now() - started,
    };
  }

  /** Deploy + verify, failing closed when verification is required. */
  async deployAndVerify({ siteId, siteDir, brief, title }) {
    const result = await this.deploy({ siteId, siteDir, brief, title });
    if (result.provider === 'local') {
      return { ...result, verified: false, verification: { ok: false, skipped: true, error: 'local preview is not a public deployment' } };
    }
    const verification = await this.verify(result.url, {
      expectedText: brief?.title || null,
      attempts: result.provider === 'github-pages' ? 10 : 6,
    });
    if (!verification.ok && this.config.deploy.verifyRequired) {
      throw new DeployError(`Deployed URL did not verify: ${verification.error}`, {
        provider: result.provider,
        code: 'verification_failed',
        retryable: true,
      });
    }
    return { ...result, verified: verification.ok, verification };
  }
}

module.exports = { Deployer, DeployError, DeployConflictError, ApiError };
