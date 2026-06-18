import fs from 'fs';
import path from 'path';

export interface ResolvedVideoModel {
  videoModelKey: string;
  tier: string;
  maxDuration?: string;
}

export interface VideoModelsConfig {
  [tierKey: string]: {
    [modeKey: string]: {
      [qualityKey: string]: string | {
        [key: string]: string | {
          [aspectKey: string]: string;
        };
      };
    };
  };
}

function parseVideoModels(): VideoModelsConfig {
  const modelPath = path.join(__dirname, '..', '..', 'veo_models.json');
  const raw = fs.readFileSync(modelPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.video_models !== 'object') {
    return {};
  }

  return parsed.video_models as VideoModelsConfig;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolve video model key based on veo_models.json structure
 * 
 * Structure:
 * - tier: PAYGATE_TIER_TWO | PAYGATE_TIER_ONE
 * - mode: T2V | R2V | I2V
 * - quality: FAST | QUALITY | LITE | LITE_LOW_PRIORITY | OMNI_FLASH
 * - aspect ratio / duration nested based on quality level
 */
function resolveVideoModelKey(params: {
  modelKey?: string; // frontend model label like 'veo 3.1 - fast'
  aspectRatio?: string;
  duration?: string;
  tier?: string;
  mode?: 'T2V' | 'R2V' | 'I2V';
}): ResolvedVideoModel | null {
  const models = parseVideoModels();
  const tierKeys = Object.keys(models);
  
  // Determine tier
  const tier =
    params.tier && tierKeys.includes(params.tier) ? params.tier : tierKeys[0];

  if (!tier) {
    return null;
  }

  const tierNode = models[tier];
  if (!tierNode) {
    return null;
  }

  // Determine mode (T2V, R2V, I2V)
  const mode = params.mode || 'T2V';
  const modeNode = tierNode[mode];
  if (!modeNode) {
    return null;
  }

  // Determine quality from model label
  const normalizedLabel = (params.modelKey || '').toLowerCase().trim();
  let qualityKey = 'FAST'; // default
  
  if (normalizedLabel.includes('omni flash')) {
    qualityKey = 'OMNI_FLASH';
  } else if (normalizedLabel.includes('fast')) {
    qualityKey = 'FAST';
  } else if (normalizedLabel.includes('quality')) {
    qualityKey = 'QUALITY';
  } else if (normalizedLabel.includes('lite') && normalizedLabel.includes('priority')) {
    qualityKey = 'LITE_LOW_PRIORITY';
  } else if (normalizedLabel.includes('lite')) {
    qualityKey = 'LITE';
  }

  const qualityConfig = modeNode[qualityKey];
  if (!qualityConfig) {
    return null;
  }

  const aspectRatio = params.aspectRatio;
  const duration = params.duration;

  // Omni Flash / Lite - direct duration mapping
  if (qualityKey === 'OMNI_FLASH' || qualityKey === 'LITE' || qualityKey === 'LITE_LOW_PRIORITY') {
    const durationKey = duration ? `VIDEO_DURATION_${duration.toUpperCase()}` : null;
    if (durationKey && typeof qualityConfig === 'object') {
      const modelKey = readString(qualityConfig[durationKey]);
      if (modelKey) {
        return { videoModelKey: modelKey, tier, maxDuration: duration || '8s' };
      }
    }
    // Fallback to 8s
    if (typeof qualityConfig === 'object' && qualityConfig['VIDEO_DURATION_8S']) {
      return { videoModelKey: qualityConfig['VIDEO_DURATION_8S'] as string, tier, maxDuration: '8s' };
    }
  }

  // FAST / QUALITY - check duration with aspect ratio
  if (duration && typeof qualityConfig === 'object') {
    const durationKey = `VIDEO_DURATION_${duration.toUpperCase()}`;
    const durationConfig = qualityConfig[durationKey];
    if (typeof durationConfig === 'object') {
      if (aspectRatio && durationConfig[aspectRatio]) {
        return { videoModelKey: durationConfig[aspectRatio] as string, tier, maxDuration: duration };
      }
      // Fallback to landscape
      const landscape = durationConfig['VIDEO_ASPECT_RATIO_LANDSCAPE'];
      if (landscape) {
        return { videoModelKey: landscape as string, tier, maxDuration: duration };
      }
    }
  }

  // FAST / QUALITY - check aspect ratio directly
  if (typeof qualityConfig === 'object') {
    if (aspectRatio && qualityConfig[aspectRatio]) {
      return { videoModelKey: qualityConfig[aspectRatio] as string, tier };
    }
    // Fallback to landscape
    const landscape = qualityConfig['VIDEO_ASPECT_RATIO_LANDSCAPE'];
    if (landscape) {
      return { videoModelKey: landscape as string, tier };
    }
    // Try 8s default
    const config8s = qualityConfig['VIDEO_DURATION_8S'];
    if (typeof config8s === 'string') {
      return { videoModelKey: config8s, tier, maxDuration: '8s' };
    }
    if (typeof config8s === 'object') {
      return { videoModelKey: config8s['VIDEO_ASPECT_RATIO_LANDSCAPE'] as string || Object.values(config8s)[0] as string, tier, maxDuration: '8s' };
    }
  }

  return null;
}

export function getAvailableDurations(params: {
  aspectRatio?: string;
  tier?: string;
  mode?: 'T2V' | 'R2V' | 'I2V';
  quality?: string;
}): string[] {
  const models = parseVideoModels();
  const tierKeys = Object.keys(models);
  const tier =
    params.tier && tierKeys.includes(params.tier) ? params.tier : tierKeys[0];
  if (!tier) {
    return [];
  }

  const tierNode = models[tier];
  const mode = params.mode || 'T2V';
  const modeNode = tierNode[mode];
  if (!modeNode) {
    return [];
  }

  const qualityKey = params.quality || 'FAST';
  const qualityConfig = modeNode[qualityKey];
  if (!qualityConfig || typeof qualityConfig !== 'object') {
    return [];
  }

  // Extract durations from the quality config
  const durations = new Set<string>();
  
  for (const [key, value] of Object.entries(qualityConfig)) {
    if (key.startsWith('VIDEO_DURATION_')) {
      // Value might be string or object
      if (typeof value === 'string') {
        durations.add(key);
      } else if (typeof value === 'object') {
        durations.add(key);
      }
    }
  }

  return Array.from(durations).sort();
}
