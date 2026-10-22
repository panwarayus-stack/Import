'use strict';

/**
 * YouTube comment collection (official Data API v3 only).
 *
 * - Uses `commentThreads.list?allThreadsRelatedToChannelId=` (1 quota unit per page).
 * - Paginates with pageToken until the configured cap or no next page.
 * - Filters/sanitises every comment, stores ids + content hashes to avoid re-processing.
 * - Tracks quota units per day and stops cleanly when the budget is exhausted.
 */

const { requestJson, ApiError, sleep } = require('../lib/http');
const { evaluateComment, sanitizeComment } = require('./comment-filter');

class QuotaExceededError extends Error {
  constructor(message = 'YouTube API quota budget exhausted') {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = 'quota_exceeded';
  }
}

class YouTubeCommentsService {
  constructor(config, { db, logger, oauth } = {}) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.oauth = oauth;
  }

  get apiBase() {
    return this.config.youtube.apiBase;
  }

  quotaStatus() {
    const usage = this.db?.usageForDay?.() || {};
    const used = usage.youtube?.units || 0;
    const limit = this.config.youtube.dailyQuotaUnits;
    const remaining = Math.max(0, limit - used);
    const uploadsToday = this.db?.uploadCountSince?.(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) || 0;
    return {
      used,
      limit,
      remaining,
      percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0,
      warning: limit > 0 && remaining < limit * 0.15,
      exhausted: remaining <= 0,
      uploadsToday,
      uploadDailyLimit: this.config.youtube.uploadDailyLimit,
      uploadBucketRemaining: Math.max(0, this.config.youtube.uploadDailyLimit - uploadsToday),
    };
  }

  recordQuota(operation, units) {
    try {
      this.db.recordUsage({ service: 'youtube', operation, units, calls: 1 });
    } catch {
      /* ignore */
    }
  }

  assertQuota(units, operation) {
    const status = this.quotaStatus();
    if (units > status.remaining) {
      throw new QuotaExceededError(
        `YouTube quota exhausted for ${operation}: needs ${units} units, ${status.remaining} remaining of ${status.limit}`,
      );
    }
  }

  async get(path, params, { cost = 1, operation = 'read' } = {}) {
    if (!this.oauth?.isConnected()) {
      throw new ApiError('YouTube channel is not connected', { code: 'auth_required', retryable: false });
    }
    this.assertQuota(cost, operation);
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const token = await this.oauth.accessToken();
    const response = await requestJson(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 30000,
      retries: 2,
    });
    this.recordQuota(operation, cost);
    return response.json;
  }

  /** Videos uploaded by the authenticated channel (uploads playlist). */
  async listOwnedVideos({ maxVideos = 10 } = {}) {
    const channelId = this.config.youtube.channelId || (await this.oauth.fetchChannel()).id;
    const channel = await this.get('/channels', { part: 'contentDetails,statistics', mine: true, id: channelId }, {
      cost: 1,
      operation: 'channels.list',
    });
    const uploads = channel?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    const videos = [];
    let pageToken = null;
    while (videos.length < maxVideos) {
      const page = await this.get(
        '/playlistItems',
        { part: 'snippet,contentDetails', playlistId: uploads, maxResults: Math.min(50, maxVideos), pageToken },
        { cost: 1, operation: 'playlistItems.list' },
      );
      for (const item of page.items || []) {
        videos.push({
          id: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
          title: item.snippet?.title || '',
          publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
        });
      }
      pageToken = page.nextPageToken;
      if (!pageToken || !page.items?.length) break;
      await sleep(100);
    }
    return videos.filter((v) => v.id).slice(0, maxVideos);
  }

  /** Paginated comment threads for the whole channel (single quota-cheap call per page). */
  async fetchChannelComments({ maxComments = 200, channelId = null } = {}) {
    const cid = channelId || this.config.youtube.channelId || (await this.oauth.fetchChannel()).id;
    const collected = [];
    let pageToken = null;
    let pages = 0;

    while (collected.length < maxComments) {
      const page = await this.get(
        '/commentThreads',
        {
          part: 'snippet,replies',
          allThreadsRelatedToChannelId: cid,
          maxResults: Math.min(100, maxComments - collected.length),
          order: 'time',
          textFormat: 'plainText',
          pageToken,
        },
        { cost: this.config.youtube.quotaCosts.commentThreads, operation: 'commentThreads.list' },
      );
      pages += 1;
      for (const thread of page.items || []) collected.push(normalizeThread(thread));
      pageToken = page.nextPageToken;
      if (!pageToken || !page.items?.length) break;
      await sleep(150);
      if (pages > 20) break; // safety valve
    }
    return collected.slice(0, maxComments);
  }

  /** Fallback per-video comment fetch (used when channel-wide thread search returns nothing). */
  async fetchVideoComments({ videoId, maxComments = 50 }) {
    const page = await this.get(
      '/commentThreads',
      { part: 'snippet', videoId, maxResults: Math.min(100, maxComments), order: 'time', textFormat: 'plainText' },
      { cost: this.config.youtube.quotaCosts.commentThreads, operation: 'commentThreads.list' },
    );
    return (page.items || []).map(normalizeThread);
  }

  /**
   * Fetch, sanitise, deduplicate and persist comments.
   * @returns {Promise<{fetched:number, inserted:number, eligible:number, rejected:number,
   *                    duplicates:number, errors:string[], quota:object, simulated:boolean}>}
   */
  async collectAndStore(options = {}) {
    const { dryRunSample = null } = options;
    const summary = {
      fetched: 0,
      inserted: 0,
      eligible: 0,
      rejected: 0,
      duplicates: 0,
      errors: [],
      quota: this.quotaStatus(),
      simulated: false,
    };

    let comments = [];
    if (!this.oauth?.isConnected()) {
      summary.simulated = true;
      summary.errors.push('YouTube channel not connected — no live comments were collected.');
      if (dryRunSample) comments = [dryRunSample];
      else return summary;
    } else {
      try {
        comments = await this.fetchChannelComments({ maxComments: this.config.youtube.maxCommentsPerPoll });
        if (!comments.length) {
          const videos = await this.listOwnedVideos({ maxVideos: Math.min(3, this.config.youtube.maxVideosPerPoll) });
          for (const video of videos) {
            comments.push(...(await this.fetchVideoComments({ videoId: video.id, maxComments: 50 })));
          }
        }
      } catch (error) {
        summary.errors.push(error.message);
        if (error instanceof QuotaExceededError) {
          summary.quota = this.quotaStatus();
          return summary;
        }
        if (error.code === 'auth_required') return summary;
        this.logger?.error?.(`Comment fetch failed: ${error.message}`);
        return summary;
      }
    }

    summary.fetched = comments.length;
    const recent = this.db.recentComments(200).map((c) => c.text);
    const seenHashes = new Set();
    const now = Date.now();
    const maxAgeMs = this.config.youtube.maxCommentAgeDays * 86400000;

    for (const raw of comments) {
      try {
        if (raw.publishedAt && now - Date.parse(raw.publishedAt) > maxAgeMs) {
          summary.rejected += 1;
          continue;
        }
        const existing = this.db.getComment(raw.id);
        if (existing) {
          summary.duplicates += 1;
          continue;
        }
        const evaluation = evaluateComment(raw.text, {
          minLength: this.config.youtube.minCommentLength,
          maxLength: this.config.youtube.maxCommentLength,
          minLikes: this.config.youtube.minLikes,
          likeCount: raw.likeCount,
          existingTexts: recent,
          maxLinks: 1,
        });
        if (evaluation.hash && (seenHashes.has(evaluation.hash) || this.db.hashSeen(evaluation.hash))) {
          summary.duplicates += 1;
          continue;
        }
        if (evaluation.hash) seenHashes.add(evaluation.hash);

        const { inserted } = this.db.upsertComment({
          id: raw.id,
          video_id: raw.videoId,
          video_title: raw.videoTitle || null,
          author: raw.author,
          author_channel_id: raw.authorChannelId || null,
          text: evaluation.text,
          like_count: raw.likeCount || 0,
          published_at: raw.publishedAt,
          status: evaluation.eligible ? 'eligible' : 'rejected',
          reject_reason: evaluation.reason,
          content_hash: evaluation.hash,
          raw_json: { source: 'youtube', threadId: raw.threadId || null },
        });
        if (!inserted) {
          summary.duplicates += 1;
          continue;
        }
        summary.inserted += 1;
        if (evaluation.eligible) summary.eligible += 1;
        else summary.rejected += 1;
      } catch (error) {
        summary.errors.push(`comment ${raw.id}: ${error.message}`);
      }
    }

    summary.quota = this.quotaStatus();
    this.db.setLastPoll();
    this.logger?.info?.(
      `Comment poll finished: fetched=${summary.fetched} inserted=${summary.inserted} eligible=${summary.eligible} rejected=${summary.rejected}`,
      { quota: summary.quota },
    );
    return summary;
  }

  /** Insert a manually supplied comment (CLI / dashboard "generate now"). */
  addManualComment({ text, author = 'manual', videoId = null, videoTitle = null, force = false }) {
    const sanitized = sanitizeComment(text, { maxLength: this.config.youtube.maxCommentLength });
    const evaluation = evaluateComment(sanitized, {
      minLength: 1,
      maxLength: this.config.youtube.maxCommentLength,
      allowSuspicious: true,
      existingTexts: [],
    });
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { comment } = this.db.upsertComment({
      id,
      video_id: videoId,
      video_title: videoTitle,
      author,
      author_channel_id: null,
      text: sanitized,
      like_count: Number(process.env.MANUAL_COMMENT_LIKES || 0),
      published_at: new Date().toISOString(),
      status: force || evaluation.eligible ? 'eligible' : 'rejected',
      reject_reason: force ? null : evaluation.reason,
      content_hash: evaluation.hash,
      raw_json: { source: 'manual' },
    });
    return { comment, evaluation };
  }
}

function normalizeThread(thread) {
  const snippet = thread.snippet || {};
  const top = snippet.topLevelComment || {};
  const s = top.snippet || {};
  return {
    id: top.id || `thread_${thread.id}`,
    threadId: thread.id,
    videoId: snippet.videoId || s.videoId || null,
    videoTitle: snippet.title || null,
    author: s.authorDisplayName || 'unknown',
    authorChannelId: s.authorChannelId?.value || null,
    text: s.textOriginal || s.textDisplay || '',
    likeCount: Number(s.likeCount) || 0,
    publishedAt: s.publishedAt || null,
    replyCount: thread.snippet?.totalReplyCount || 0,
  };
}

module.exports = { YouTubeCommentsService, QuotaExceededError, normalizeThread };
