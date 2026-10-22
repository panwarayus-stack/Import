'use strict';

/**
 * YouTube Shorts uploader (official Data API v3, OAuth 2.0, resumable upload).
 *
 * Safety rules:
 *  - never uploads the same file twice (checksum + unique video_id constraint);
 *  - refuses videos that fail technical validation;
 *  - defaults to `private` until ALLOW_PUBLIC_UPLOAD=true is set explicitly;
 *  - dry-run mode records the attempt without contacting YouTube.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { requestJson, ApiError } = require('../lib/http');
const { sha256File } = require('../lib/fs-safe');
const { probeMedia, resolveBinaries } = require('../lib/media');
const { AuthRequiredError } = require('./google-oauth');

class UploadError extends Error {
  constructor(message, { code = 'upload_error', retryable = false, details = null } = {}) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

class YouTubeUploader {
  constructor(config, { db, logger, oauth } = {}) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.oauth = oauth;
  }

  get privacy() {
    const configured = String(this.config.upload?.privacy || 'private').toLowerCase();
    if (configured !== 'private' && !this.config.upload?.allowPublicUpload) {
      return 'private';
    }
    return ['private', 'unlisted', 'public'].includes(configured) ? configured : 'private';
  }

  /** Validate the file against current Shorts requirements before uploading. */
  async validateVideo(filePath) {
    const problems = [];
    if (!fs.existsSync(filePath)) throw new UploadError(`video file not found: ${filePath}`);
    const probe = await probeMedia(filePath, resolveBinaries(this.config));
    if (!probe.hasVideo) problems.push('no video stream');
    if (probe.videoCodec !== 'h264') problems.push(`video codec is ${probe.videoCodec}, expected h264`);
    if (!probe.hasAudio) problems.push('no audio stream');
    if (probe.audioCodec !== 'aac') problems.push(`audio codec is ${probe.audioCodec}, expected aac`);
    if (probe.height < 1280) problems.push(`height ${probe.height}px is below the 1280px needed for a vertical Short`);
    if (!(probe.height > probe.width)) problems.push('video is not vertical (9:16 required for Shorts)');
    if (probe.durationSec > 180) problems.push(`duration ${probe.durationSec.toFixed(1)}s exceeds the 3 minute Shorts limit`);
    if (probe.durationSec < 3) problems.push('duration under 3 seconds');
    return { ok: problems.length === 0, problems, probe };
  }

  buildMetadata({ script, websiteUrl, author = null, comment = null }) {
    const title = sanitizeTitle(`${script.title || 'A comment became a website'} #Shorts`);
    const descriptionLines = [
      script.description || script.hook || 'Built from a YouTube comment.',
      '',
      websiteUrl ? `Live site: ${websiteUrl}` : null,
      author ? `Original comment by ${author}` : null,
      comment ? `Comment: "${truncate(comment, 220)}"` : null,
      '',
      'Generated automatically: the comment became a real website, recorded in a real browser.',
      '#Shorts',
    ].filter((line) => line !== null && line !== undefined);
    return {
      title,
      description: descriptionLines.join('\n').slice(0, 4900),
      tags: normalizeTags(script.tags || script.keywords || []),
      categoryId: '28', // Science & Technology
      privacyStatus: this.privacy,
      madeForKids: false,
    };
  }

  /**
   * @param {object} params
   * @param {object} params.videoRow    DB row for the rendered video
   * @param {object} params.script
   * @param {string} params.websiteUrl
   * @param {boolean} params.simulated  true when the video is a dry-run artifact
   */
  async upload({ videoRow, script, websiteUrl, author, comment, simulated = false, jobId = null }) {
    const filePath = videoRow.output_path;
    const checksum = await sha256File(filePath);

    const existing = this.db.getUploadByVideo(videoRow.id);
    if (existing) {
      this.logger?.info?.('Video already has an upload record; skipping duplicate upload', { jobId, uploadId: existing.id });
      return { skipped: true, reason: 'already_uploaded', upload: existing };
    }

    const duplicateChecksum = this.db.db
      .prepare('SELECT id, youtube_video_id, url FROM uploads WHERE checksum = ? AND status = ?')
      .get(checksum, 'uploaded');
    if (duplicateChecksum) {
      this.logger?.warn?.('Identical video file was already uploaded; refusing duplicate', { jobId });
      return { skipped: true, reason: 'duplicate_checksum', upload: duplicateChecksum };
    }

    const validation = await this.validateVideo(filePath);
    if (!validation.ok) throw new UploadError(`Video failed Shorts validation: ${validation.problems.join('; ')}`);

    const metadata = this.buildMetadata({ script, websiteUrl, author, comment });
    const uploadRecord = this.db.saveUpload({
      video_id: videoRow.id,
      job_id: videoRow.job_id,
      title: metadata.title,
      privacy: metadata.privacyStatus,
      status: 'pending',
      checksum,
      simulated: simulated ? 1 : 0,
    });

    if (simulated) {
      this.logger?.warn?.('Simulated upload: real video was not sent to YouTube', { jobId });
      const updated = this.db.updateUpload(uploadRecord.id, {
        status: 'simulated',
        response_json: {
          dryRun: true,
          reason: 'Video was produced without a real browser recording or OAuth is not configured.',
          metadata,
        },
      });
      return { skipped: false, simulated: true, upload: updated, metadata, url: null };
    }

    if (!this.oauth?.isConnected()) {
      this.db.updateUpload(uploadRecord.id, {
        status: 'failed',
        response_json: { error: 'YouTube is not connected' },
      });
      throw new UploadError('YouTube is not connected. Authorize the channel in Settings first.', {
        code: 'auth_required',
      });
    }

    const accessToken = await this.oauth.accessToken();
    const size = fs.statSync(filePath).size;
    const uploadUrl = `${this.config.youtube.uploadBase}/videos?uploadType=resumable&part=snippet,status`;

    const init = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          categoryId: metadata.categoryId,
        },
        status: {
          privacyStatus: metadata.privacyStatus,
          selfDeclaredMadeForKids: metadata.madeForKids,
        },
      }),
    }).catch((error) => {
      throw new UploadError(`Could not start the upload session: ${error.message}`, { retryable: true });
    });

    if (!init.ok) {
      const body = await init.text();
      throw new UploadError(`YouTube rejected the upload session (HTTP ${init.status}): ${body.slice(0, 500)}`, {
        code: init.status === 403 ? 'quota_or_permission' : 'session_error',
        retryable: init.status >= 500 || init.status === 429,
      });
    }
    const sessionUri = init.headers.get('location');
    if (!sessionUri) throw new UploadError('YouTube did not return a resumable upload session URL');

    this.logger?.info?.(`Uploading ${(size / 1024 / 1024).toFixed(1)} MiB to YouTube`, { jobId, privacy: metadata.privacyStatus });
    const body = Readable.toWeb(fs.createReadStream(filePath));
    const release = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'video/mp4',
        'Content-Length': String(size),
      },
      body,
      duplex: 'half',
    }).catch((error) => {
      throw new UploadError(`Upload failed mid-transfer: ${error.message}`, { retryable: true });
    });

    const responseText = await release.text();
    if (!release.ok) {
      this.db.updateUpload(uploadRecord.id, {
        status: 'failed',
        response_json: { status: release.status, body: responseText.slice(0, 2000) },
      });
      throw new UploadError(`YouTube upload failed (HTTP ${release.status}): ${responseText.slice(0, 500)}`, {
        code: release.status === 403 ? 'quota_or_permission' : 'upload_failed',
        retryable: release.status >= 500 || release.status === 429,
      });
    }

    let parsed = {};
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = { raw: responseText.slice(0, 1000) };
    }
    const youtubeId = parsed.id || null;
    if (!youtubeId) {
      this.db.updateUpload(uploadRecord.id, { status: 'failed', response_json: parsed });
      throw new UploadError('YouTube accepted the request but returned no video id');
    }

    const url = `https://www.youtube.com/shorts/${youtubeId}`;
    const upload = this.db.updateUpload(uploadRecord.id, {
      youtube_video_id: youtubeId,
      url,
      status: 'uploaded',
      response_json: parsed,
    });
    this.db.bumpWorkerCounter('uploads_today');
    this.logger?.info?.(`Uploaded to YouTube: ${url}`, { jobId, youtubeId });
    return { skipped: false, simulated: false, upload, metadata, url, youtubeId };
  }

  /** Optional: refresh upload processing status (quota cost: 1 unit). */
  async status(youtubeId) {
    const token = await this.oauth.accessToken();
    const response = await requestJson(
      `${this.config.youtube.apiBase}/videos?part=status,processingDetails&id=${encodeURIComponent(youtubeId)}`,
      { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 30000 },
    );
    const item = response.json?.items?.[0];
    if (!item) throw new UploadError(`YouTube video ${youtubeId} not found`, { code: 'not_found' });
    return { uploadStatus: item.status?.uploadStatus, privacy: item.status?.privacyStatus, processing: item.processingDetails || null };
  }
}

function sanitizeTitle(title) {
  // YouTube rejects < and >, and caps titles at 100 characters.
  const cleaned = String(title)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 100) return cleaned;
  return `${cleaned.slice(0, 97).trimEnd()}...`;
}

function normalizeTags(tags) {
  const cleaned = tags
    .map((tag) => String(tag).replace(/[#<>]/g, '').trim().toLowerCase())
    .filter((tag) => tag.length > 1 && tag.length <= 30);
  const unique = [...new Set(cleaned)].slice(0, 15);
  return unique;
}

function truncate(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

module.exports = { YouTubeUploader, UploadError, sanitizeTitle, normalizeTags, AuthRequiredError };
