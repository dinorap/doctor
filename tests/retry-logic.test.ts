import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ============================================
// TEST: isRetryableError Logic
// ============================================

function isRetryableError(error: string): boolean {
  const err = error.toLowerCase();
  return err.includes('403') || 
         err.includes('captcha') || 
         err.includes('blocked') || 
         err.includes('verify') ||
         err.includes('human') ||
         err.includes('rate limit') ||
         err.includes('429') ||
         err.includes('timeout') ||
         err.includes('network') ||
         err.includes('econnreset') ||
         err.includes('html') ||
         err.includes('<!doctype') ||
         err.includes('econnrefused') ||
         err.includes('etimedout') ||
         err.includes('empty') ||
         err.includes('no downloadable');
}

describe('isRetryableError', () => {
  it('should return true for 403 errors', () => {
    expect(isRetryableError('403 Forbidden')).toBe(true);
    expect(isRetryableError('HTTP 403')).toBe(true);
    expect(isRetryableError('Error: 403')).toBe(true);
  });

  it('should return true for captcha errors', () => {
    expect(isRetryableError('Captcha required')).toBe(true);
    expect(isRetryableError('captcha verification')).toBe(true);
    expect(isRetryableError('CaptchaError: solve captcha')).toBe(true);
  });

  it('should return true for blocked errors', () => {
    expect(isRetryableError('Access blocked')).toBe(true);
    expect(isRetryableError('Request blocked')).toBe(true);
    expect(isRetryableError('IP blocked')).toBe(true);
  });

  it('should return true for verify/human errors', () => {
    expect(isRetryableError('Please verify you are human')).toBe(true);
    expect(isRetryableError('Verify your identity')).toBe(true);
    expect(isRetryableError('Human verification required')).toBe(true);
  });

  it('should return true for rate limit errors', () => {
    expect(isRetryableError('Rate limit exceeded')).toBe(true);
    expect(isRetryableError('429 Too Many Requests')).toBe(true);
    expect(isRetryableError('Rate limit error occurred')).toBe(true);
  });

  it('should return true for network errors', () => {
    expect(isRetryableError('Network error')).toBe(true);
    expect(isRetryableError('ECONNRESET')).toBe(true);
    expect(isRetryableError('Connection timeout')).toBe(true);
    expect(isRetryableError('ETIMEDOUT')).toBe(true);
  });

  it('should return true for HTML responses', () => {
    expect(isRetryableError('Response is HTML<!doctype')).toBe(true);
    expect(isRetryableError('<!DOCTYPE html>')).toBe(true);
    expect(isRetryableError('HTML page returned')).toBe(true);
  });

  it('should return true for empty/no downloadable results', () => {
    expect(isRetryableError('No downloadable result')).toBe(true);
    expect(isRetryableError('empty response')).toBe(true);
  });

  it('should return false for non-retryable errors', () => {
    expect(isRetryableError('Invalid API key')).toBe(false);
    expect(isRetryableError('Scene prompt is blank')).toBe(false);
    expect(isRetryableError('Flow key missing for profile')).toBe(false);
    expect(isRetryableError('Video successfully created')).toBe(false);
  });
});

// ============================================
// TEST: QueueItem Retry State
// ============================================

interface QueueItem {
  requestId: string;
  profileId: string;
  projectId: string;
  sceneId: string;
  status: 'pending' | 'processing' | 'polling' | 'downloading' | 'completed' | 'failed' | 'done' | 'error' | 'retrying';
  progress: number;
  retryCount: number;
  maxRetries: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function createQueueItem(sceneId: string): QueueItem {
  return {
    requestId: sceneId,
    profileId: 'profile-1',
    projectId: 'project-1',
    sceneId,
    status: 'processing',
    progress: 0,
    retryCount: 0,
    maxRetries: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function updateQueueForRetry(item: QueueItem, errorMsg: string): QueueItem {
  const newRetryCount = item.retryCount + 1;
  // maxRetries=2 means we allow 3 attempts total (initial + 2 retries)
  // So we fail when newRetryCount > maxRetries
  if (newRetryCount > item.maxRetries) {
    return {
      ...item,
      status: 'failed',
      error: errorMsg,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...item,
    status: 'retrying',
    retryCount: newRetryCount,
    error: `Retry ${newRetryCount}/${item.maxRetries}: ${errorMsg}`,
    updatedAt: new Date().toISOString(),
  };
}

describe('QueueItem Retry Logic', () => {
  it('should create queue item with initial retry state', () => {
    const item = createQueueItem('scene-1');
    expect(item.retryCount).toBe(0);
    expect(item.maxRetries).toBe(2);
    expect(item.status).toBe('processing');
  });

  it('should update status to retrying on first retry', () => {
    const item = createQueueItem('scene-1');
    const updated = updateQueueForRetry(item, 'Captcha required');
    
    expect(updated.retryCount).toBe(1);
    expect(updated.status).toBe('retrying');
    expect(updated.error).toContain('Retry 1/2');
  });

  it('should update status to retrying on second retry', () => {
    const item = createQueueItem('scene-1');
    const firstRetry = updateQueueForRetry(item, 'Captcha required');
    const secondRetry = updateQueueForRetry(firstRetry, 'Captcha required again');
    
    expect(secondRetry.retryCount).toBe(2);
    expect(secondRetry.status).toBe('retrying');
    expect(secondRetry.error).toContain('Retry 2/2');
  });

  it('should mark as failed after max retries exceeded', () => {
    const item = createQueueItem('scene-1');
    const firstRetry = updateQueueForRetry(item, 'Captcha required');
    const secondRetry = updateQueueForRetry(firstRetry, 'Captcha required again');
    const failed = updateQueueForRetry(secondRetry, 'Still failing');
    
    expect(failed.status).toBe('failed');
    expect(failed.retryCount).toBe(2); // Stops at maxRetries
    expect(failed.error).toBe('Still failing'); // Original error, not prefixed
  });
});

// ============================================
// TEST: StatusProgressBar Display
// ============================================

type StatusType = 'pending' | 'processing' | 'polling' | 'downloading' | 'completed' | 'failed' | 'done' | 'error' | 'retrying';

const STATUS_CONFIG: Record<StatusType, { color: string; bgColor: string; label: string; animated: boolean }> = {
  pending: { color: '#9ca3af', bgColor: 'rgba(156, 163, 175, 0.2)', label: 'Chờ', animated: false },
  processing: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang xử lý', animated: true },
  polling: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang kiểm tra', animated: true },
  downloading: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang tải về', animated: true },
  retrying: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang thử lại', animated: true },
  completed: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.2)', label: 'Hoàn thành', animated: false },
  done: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.2)', label: 'Xong', animated: false },
  failed: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.2)', label: 'Lỗi', animated: false },
  error: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.2)', label: 'Lỗi', animated: false },
};

describe('StatusProgressBar Config', () => {
  it('should have yellow color for processing/polling/retrying status', () => {
    expect(STATUS_CONFIG.processing.color).toBe('#f59e0b'); // Yellow
    expect(STATUS_CONFIG.polling.color).toBe('#f59e0b'); // Yellow
    expect(STATUS_CONFIG.retrying.color).toBe('#f59e0b'); // Yellow
    expect(STATUS_CONFIG.downloading.color).toBe('#f59e0b'); // Yellow
  });

  it('should have green color for completed/done status', () => {
    expect(STATUS_CONFIG.completed.color).toBe('#22c55e'); // Green
    expect(STATUS_CONFIG.done.color).toBe('#22c55e'); // Green
  });

  it('should have red color for failed/error status', () => {
    expect(STATUS_CONFIG.failed.color).toBe('#ef4444'); // Red
    expect(STATUS_CONFIG.error.color).toBe('#ef4444'); // Red
  });

  it('should have animated for processing states', () => {
    expect(STATUS_CONFIG.processing.animated).toBe(true);
    expect(STATUS_CONFIG.polling.animated).toBe(true);
    expect(STATUS_CONFIG.retrying.animated).toBe(true);
  });

  it('should not have animated for terminal states', () => {
    expect(STATUS_CONFIG.completed.animated).toBe(false);
    expect(STATUS_CONFIG.failed.animated).toBe(false);
  });
});

// ============================================
// TEST: Retry Decision Flow
// ============================================

describe('Retry Decision Flow', () => {
  it('should decide to retry on captcha error with remaining retries', () => {
    const errorMsg = 'Captcha required';
    const retryCount = 1;
    const maxRetries = 2;
    
    const shouldRetry = isRetryableError(errorMsg) && retryCount < maxRetries;
    expect(shouldRetry).toBe(true);
  });

  it('should decide NOT to retry when max retries exceeded', () => {
    const errorMsg = 'Captcha required';
    const retryCount = 2;
    const maxRetries = 2;
    
    const shouldRetry = isRetryableError(errorMsg) && retryCount < maxRetries;
    expect(shouldRetry).toBe(false);
  });

  it('should decide NOT to retry on non-retryable error', () => {
    const errorMsg = 'Invalid API key';
    const retryCount = 0;
    const maxRetries = 2;
    
    const shouldRetry = isRetryableError(errorMsg) && retryCount < maxRetries;
    expect(shouldRetry).toBe(false);
  });

  it('should decide NOT to retry on successful result', () => {
    const errorMsg = 'Video successfully created'; // No error
    const retryCount = 0;
    const maxRetries = 2;
    
    // This would be handled differently - success path
    const isError = errorMsg.toLowerCase().includes('error') || 
                    errorMsg.toLowerCase().includes('failed') ||
                    errorMsg.toLowerCase().includes('captcha') ||
                    errorMsg.toLowerCase().includes('403');
    const shouldRetry = isError && isRetryableError(errorMsg) && retryCount < maxRetries;
    expect(shouldRetry).toBe(false);
  });
});

// ============================================
// TEST: Backend Retry Loop Logic (Mock)
// ============================================

describe('Backend Retry Loop (Mock)', () => {
  const MAX_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 100; // Short delay for tests

  async function mockProcessWithRetry(
    shouldFail: boolean[],
    failErrors: string[]
  ): Promise<{ success: boolean; attempts: number; error?: string }> {
    let attempts = 0;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      attempts++;
      
      if (shouldFail[attempt]) {
        const error = failErrors[attempt] || 'Unknown error';
        const isRetryable = isRetryableError(error);
        
        if (isRetryable && attempt < MAX_RETRIES) {
          // Simulate delay
          await new Promise(resolve => setTimeout(resolve, 50));
          continue; // Retry
        }
        
        return { success: false, attempts, error };
      }
      
      // Success
      return { success: true, attempts };
    }
    
    return { success: false, attempts, error: 'Max retries exceeded' };
  }

  it('should succeed on first attempt when no failures', async () => {
    const result = await mockProcessWithRetry([false], []);
    
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('should retry and succeed on second attempt', async () => {
    const result = await mockProcessWithRetry(
      [true, false], // First fails, second succeeds
      ['Captcha required']
    );
    
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('should retry twice and succeed on third attempt', async () => {
    const result = await mockProcessWithRetry(
      [true, true, false], // First two fail, third succeeds
      ['Captcha required', 'Network timeout']
    );
    
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('should fail after max retries exceeded', async () => {
    const result = await mockProcessWithRetry(
      [true, true, true], // All fail
      ['Captcha required', 'Network timeout', 'Rate limit']
    );
    
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3); // 3 attempts (0, 1, 2)
    expect(result.error).toBe('Rate limit');
  });

  it('should fail immediately on non-retryable error', async () => {
    const result = await mockProcessWithRetry(
      [true], // First fails
      ['Invalid API key'] // Non-retryable
    );
    
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toBe('Invalid API key');
  });
});

// ============================================
// TEST: Frontend Retry Flow (Mock)
// ============================================

describe('Frontend Retry Flow (Mock)', () => {
  interface GenerateResult {
    success: boolean;
    mediaIds?: string[];
    error?: string;
  }

  async function mockFrontendGenerate(
    payload: any,
    shouldFail: boolean[],
    failErrors: string[]
  ): Promise<GenerateResult> {
    for (let attempt = 0; attempt < shouldFail.length; attempt++) {
      if (shouldFail[attempt]) {
        const error = failErrors[attempt];
        
        if (isRetryableError(error)) {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        
        return { success: false, error };
      }
      
      return { success: true, mediaIds: ['media-id-123'] };
    }
    
    return { success: false, error: 'Max retries exceeded' };
  }

  it('should succeed without retry', async () => {
    const result = await mockFrontendGenerate({}, [false], []);
    
    expect(result.success).toBe(true);
    expect(result.mediaIds).toContain('media-id-123');
  });

  it('should retry on 403 error and succeed', async () => {
    const result = await mockFrontendGenerate(
      {},
      [true, false],
      ['403 Forbidden - Captcha required']
    );
    
    expect(result.success).toBe(true);
  });

  it('should retry on network error and succeed', async () => {
    const result = await mockFrontendGenerate(
      {},
      [true, true, false],
      ['ECONNRESET', 'Timeout', 'Video generation failed']
    );
    
    expect(result.success).toBe(true);
  });

  it('should fail immediately on invalid API key', async () => {
    const result = await mockFrontendGenerate(
      {},
      [true],
      ['Invalid API key provided']
    );
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid API key');
  });
});

console.log('✅ All retry logic tests defined successfully!');
