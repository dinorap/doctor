// Script Generator Types and Constants

export type InputMode = 'youtube_url' | 'topic' | 'upload_files';

export interface ScriptScene {
  scene_id: number;
  scene_title: string;
  characters?: string[];
  visual_prompt: string;
  tts_script: string;
  duration_seconds: number;
  suggested_visual?: string;
  transition?: string;
}

export interface CharacterCast {
  name: string;
  description?: string;
  imagePrompt?: string;
  entity?: any;
  entityId?: string;
}

export interface ScriptResult {
  title: string;
  topic: string;
  duration_seconds: number;
  total_scenes: number;
  summary?: string;
  style_notes?: string;
  characters?: { name: string; description?: string }[];
  scenes: ScriptScene[];
}

export interface ScriptGeneratorTabProps {
  profiles: Profile[];
  projectName?: string;
  onOpenProfile?: (profileId: string) => Promise<void>;
  onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
}

export interface ProjectEntry {
  profile: Profile;
  projectIdx: number;
}

export interface LanguageOption {
  value: string;
  label: string;
}

export interface GeminiModelOption {
  value: string;
  label: string;
  desc: string;
  icon: string;
}

export const LANGUAGES: LanguageOption[] = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'zh', label: '中文' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
];

export const GEMINI_MODELS: GeminiModelOption[] = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', desc: 'Nhanh, chi phí thấp', icon: '⚡' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: 'Mới nhất, cân bằng', icon: '✨' },
  { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', desc: 'Siêu nhẹ, miễn phí', icon: '🌟' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: 'Ổn định, phổ biến', icon: '🔷' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', desc: 'Tiết kiệm quota', icon: '💎' },
];

// Re-export Profile type for convenience
import type { Profile } from '../../types';
export type { Profile };
