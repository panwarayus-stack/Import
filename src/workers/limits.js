'use strict';

/**
 * Daily limit + safety gates for uploads.
 *
 * Uploads are skipped (not failed) whenever a gate is not satisfied, and the reason is
 * recorded on the job so the dashboard can show exactly why nothing was published.
 */

const { today } = require('../database');

function uploadLimits(worker, job) {
  const config = worker.config;
  const settings = worker.getSettings();

  if (!config.upload.allowPublicUpload && String(settings.privacy).toLowerCase() === 'public') {
    return { allowed: false, reason: 'Public uploads are disabled. Set ALLOW_PUBLIC_UPLOAD=true after testing.' };
  }
  if (config.dryRun.global) {
    return { allowed: false, reason: 'DRY_RUN=true — uploads are disabled globally.' };
  }
  if (!worker.uploader?.oauth?.isConnected()) {
    return { allowed: false, reason: 'YouTube channel is not connected (OAuth).' };
  }

  const dailyLimit = Number(settings.dailyUploadLimit ?? config.worker.dailyUploadLimit);
  if (dailyLimit <= 0) {
    return { allowed: false, reason: 'Daily upload limit is set to 0.' };
  }
  const uploadsToday = worker.db.uploadCountSince(`${today()}T00:00:00.000Z`);
  if (uploadsToday >= dailyLimit) {
    return { allowed: false, reason: `Daily upload limit reached (${uploadsToday}/${dailyLimit}).` };
  }

  const jobStateEarly = job?.state || worker.db.getJob(job.id)?.state || {};
  if (jobStateEarly.skipUpload) {
    return { allowed: false, reason: 'Upload skipped (requested when the job was created).' };
  }

  const quota = worker.comments?.quotaStatus?.();
  if (config.youtube.uploadUsesSharedQuota) {
    // Legacy projects still charge uploads against the shared 10,000 unit pool.
    if (quota?.exhausted) {
      return { allowed: false, reason: 'YouTube API quota exhausted for today.' };
    }
    const uploadCost = config.youtube.quotaCosts.upload;
    if (quota && quota.remaining < uploadCost) {
      return { allowed: false, reason: `Not enough YouTube quota for an upload (${quota.remaining}/${uploadCost} units).` };
    }
  } else if (quota && quota.uploadBucketRemaining <= 0) {
    return {
      allowed: false,
      reason: `YouTube upload bucket exhausted for today (${quota.uploadsToday}/${quota.uploadDailyLimit}).`,
    };
  }

  // Never publish an artifact that is not a real recording by default.
  const simulated = Boolean(jobStateEarly.videoSimulated);
  if (simulated && config.upload.requireRealRecording) {
    return {
      allowed: false,
      reason:
        'The rendered video came from a dry-run artifact (offline assets or screenshot fallback). ' +
        'Set UPLOAD_REQUIRE_REAL_RECORDING=false only if you accept that.',
    };
  }

  return { allowed: true, reason: null };
}

module.exports = { uploadLimits };
