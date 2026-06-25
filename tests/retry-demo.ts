// ============================================
// RETRY LOGIC DEMO - Run with: npx ts-node tests/retry-demo.ts
// ============================================

// Mock implementation matching the actual code
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;

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

interface QueueItem {
  sceneId: string;
  status: string;
  retryCount: number;
  maxRetries: number;
  error?: string;
}

function updateQueueForRetry(item: QueueItem, errorMsg: string): QueueItem {
  const newRetryCount = item.retryCount + 1;
  if (newRetryCount > item.maxRetries) {
    return {
      ...item,
      status: 'failed',
      error: errorMsg,
    };
  }
  return {
    ...item,
    status: 'retrying',
    retryCount: newRetryCount,
    error: `Retry ${newRetryCount}/${item.maxRetries}: ${errorMsg}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock API call
async function mockApiCall(shouldFail: boolean[], failErrors: string[]): Promise<{ success: boolean; mediaId?: string; error?: string }> {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    if (shouldFail[i]) {
      const error = failErrors[i] || 'Unknown error';
      const canRetry = isRetryableError(error) && i < MAX_RETRIES;
      
      console.log(`  Attempt ${i + 1}: FAILED - "${error}"`);
      console.log(`    → isRetryable: ${isRetryableError(error)}, attempts left: ${MAX_RETRIES - i}`);
      
      if (canRetry) {
        console.log(`    → Will retry in ${RETRY_BASE_DELAY_MS}ms...`);
        await sleep(RETRY_BASE_DELAY_MS);
        continue;
      }
      
      console.log(`    → Will NOT retry (max retries exceeded or non-retryable error)`);
      return { success: false, error };
    }
    
    const mediaId = `media-${Date.now()}`;
    console.log(`  Attempt ${i + 1}: SUCCESS - mediaId: ${mediaId}`);
    return { success: true, mediaId };
  }
  
  return { success: false, error: 'Max retries exceeded' };
}

// Demo scenarios
async function runDemo() {
  console.log('\n' + '='.repeat(60));
  console.log('RETRY LOGIC DEMO - Testing Error Handling');
  console.log('='.repeat(60) + '\n');

  // Scenario 1: Success on first try
  console.log('📌 SCENARIO 1: Success on first try');
  console.log('-'.repeat(40));
  let result = await mockApiCall([false], []);
  console.log(`Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log('');

  // Scenario 2: Captcha error, success on retry
  console.log('📌 SCENARIO 2: Captcha error, success on retry');
  console.log('-'.repeat(40));
  result = await mockApiCall(
    [true, true, false], // Fail twice, then succeed
    ['403 Forbidden - Captcha required', 'Captcha required again']
  );
  console.log(`Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log('');

  // Scenario 3: Network error, success on second retry
  console.log('📌 SCENARIO 3: Network error, success on second retry');
  console.log('-'.repeat(40));
  result = await mockApiCall(
    [true, true, false],
    ['ECONNRESET connection reset', 'ETIMEDOUT operation timed out']
  );
  console.log(`Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log('');

  // Scenario 4: Invalid API key (non-retryable), fail immediately
  console.log('📌 SCENARIO 4: Invalid API key (non-retryable)');
  console.log('-'.repeat(40));
  result = await mockApiCall(
    [true],
    ['Invalid API key provided']
  );
  console.log(`Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log('');

  // Scenario 5: Rate limit, fail after max retries
  console.log('📌 SCENARIO 5: Rate limit, fail after 2 retries');
  console.log('-'.repeat(40));
  result = await mockApiCall(
    [true, true, true],
    ['Rate limit exceeded (429)', 'Rate limit still active', 'Rate limit persists']
  );
  console.log(`Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log('');

  // QueueItem state demo
  console.log('📌 QUEUE ITEM STATE TRANSITIONS');
  console.log('-'.repeat(40));
  let item: QueueItem = {
    sceneId: 'scene-1',
    status: 'processing',
    retryCount: 0,
    maxRetries: 2,
  };
  
  console.log('Initial state:', item);
  
  item = updateQueueForRetry(item, '403 Captcha');
  console.log('After 1st retry:', item);
  
  item = updateQueueForRetry(item, 'Captcha again');
  console.log('After 2nd retry:', item);
  
  item = updateQueueForRetry(item, 'Still failing');
  console.log('After 3rd retry (max exceeded):', item);
  
  console.log('\n' + '='.repeat(60));
  console.log('DEMO COMPLETE');
  console.log('='.repeat(60) + '\n');
}

// Run the demo
runDemo().catch(console.error);
