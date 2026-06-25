import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api';
import type {
  Profile,
  ScriptResult,
  CharacterCast,
  InputMode,
} from './types';

interface UseScriptGeneratorOptions {
  profiles: Profile[];
}

interface UseScriptGeneratorReturn {
  // Project selection
  selectedProjectName: string;
  setSelectedProjectName: (name: string) => void;
  selectedProfileIdx: number;
  setSelectedProfileIdx: (idx: number) => void;
  projectNames: string[];
  selectedProfile: Profile | undefined;
  selectedProjectId: string | null;
  
  // Scripts
  scripts: any[];
  selectedScriptId: string | null;
  loadingScripts: boolean;
  loadScript: (scriptId: string) => Promise<void>;
  deleteScript: (scriptId: string) => Promise<void>;
  
  // Gemini settings
  geminiApiKeys: string;
  setGeminiApiKeys: (keys: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  saveGeminiSettings: () => Promise<void>;
  settingsSaved: boolean;
  
  // Generation
  generating: boolean;
  result: ScriptResult | null;
  error: string | null;
  setError: (error: string | null) => void;
  generateScript: (params: GenerateParams) => Promise<void>;
  
  // Character casting
  characterCasting: CharacterCast[];
  setCharacterCasting: (chars: CharacterCast[]) => void;
  castingStep: boolean;
  setCastingStep: (step: boolean) => void;
  castingModified: boolean;
  handleSaveCharactersToScript: () => Promise<void>;
  
  // Reset
  reset: () => void;
}

interface GenerateParams {
  inputMode: InputMode;
  youtubeUrl: string;
  topic: string;
  language: string;
  durationMinutes: number;
  storytellingMode: 'auto' | 'narration' | 'dialogue' | 'mixed';
  copyRatio: number;
  additionalDesc: string;
  temperature: number;
  noVoice: boolean;
  noMusic: boolean;
}

export function useScriptGenerator({ profiles }: UseScriptGeneratorOptions): UseScriptGeneratorReturn {
  // Project selection
  const [selectedProjectName, setSelectedProjectName] = useState('');
  const [selectedProfileIdx, setSelectedProfileIdx] = useState(0);

  // Gemini settings
  const [geminiApiKeys, setGeminiApiKeys] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-3.5-flash');
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Scripts
  const [scripts, setScripts] = useState<any[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [loadingScripts, setLoadingScripts] = useState(false);

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<ScriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Character casting
  const [characterCasting, setCharacterCasting] = useState<CharacterCast[]>([]);
  const [castingStep, setCastingStep] = useState(false);
  const [castingModified, setCastingModified] = useState(false);

  // Build project groups
  const projectGroups: Record<string, { profile: Profile; projectIdx: number }[]> = {};
  profiles.forEach((profile) => {
    const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
    flowProjects.forEach((proj, idx) => {
      const name = proj.name || `Project ${idx + 1}`;
      if (!projectGroups[name]) projectGroups[name] = [];
      projectGroups[name].push({ profile, projectIdx: idx });
    });
  });

  const projectNames = Object.keys(projectGroups).sort();
  const selectedEntries = projectGroups[selectedProjectName] || [];
  const selectedEntry = selectedEntries[selectedProfileIdx];
  const selectedProfile = selectedEntry?.profile;
  const selectedProjectObj = selectedEntry
    ? ((selectedEntry.profile.metadata as any)?.flowProjects || [])[selectedEntry.projectIdx]
    : null;
  const selectedProjectId = selectedProjectObj?.projectId || null;

  // Auto-select first project
  useEffect(() => {
    if (!selectedProjectName && projectNames.length > 0) {
      setSelectedProjectName(projectNames[0]);
      setSelectedProfileIdx(0);
    }
  }, [projectNames, selectedProjectName]);

  // Load scripts when project changes
  useEffect(() => {
    if (!selectedProjectId) {
      setScripts([]);
      return;
    }
    setLoadingScripts(true);
    api.getScripts(undefined, selectedProjectId)
      .then(setScripts)
      .catch(() => setScripts([]))
      .finally(() => setLoadingScripts(false));
  }, [selectedProjectId]);

  // Load saved Gemini settings
  useEffect(() => {
    api.getGeminiSettings().then(res => {
      if (res?.apiKeys !== undefined) setGeminiApiKeys(res.apiKeys);
      if (res?.model) setGeminiModel(res.model);
    }).catch(() => { });
  }, []);

  // Load a specific script
  const loadScript = useCallback(async (scriptId: string) => {
    try {
      const script = await api.getScript(scriptId);
      const content = typeof script.content === 'string' ? JSON.parse(script.content) : script.content;
      setResult(content);
      setSelectedScriptId(scriptId);
      
      const charNames = new Set<string>();
      content.scenes.forEach((scene: any) => {
        (scene.characters || []).forEach((c: string) => charNames.add(c));
      });
      const chars = Array.from(charNames).map(name => ({
        name,
        description: (content.characters as any[])?.find((c: any) => c.name === name)?.description || ''
      }));
      setCharacterCasting(chars);
      setCastingStep(true);
      setCastingModified(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi khi tải kịch bản');
    }
  }, []);

  // Delete a script
  const deleteScript = useCallback(async (scriptId: string) => {
    if (!confirm('Xóa kịch bản này?')) return;
    try {
      await api.deleteScript(scriptId);
      setScripts(prev => prev.filter(s => s.id !== scriptId));
      if (selectedScriptId === scriptId) {
        setSelectedScriptId(null);
        setResult(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi khi xóa kịch bản');
    }
  }, [selectedScriptId]);

  // Save Gemini settings
  const saveGeminiSettings = useCallback(async () => {
    try {
      await api.saveGeminiSettings({ apiKeys: geminiApiKeys, model: geminiModel });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch { /* silent */ }
  }, [geminiApiKeys, geminiModel]);

  // Generate script
  const generateScript = useCallback(async (params: GenerateParams) => {
    if (params.inputMode === 'youtube_url' && !params.youtubeUrl.trim()) {
      setError('Vui lòng nhập URL YouTube');
      return;
    }
    if (params.inputMode === 'topic' && !params.topic.trim()) {
      setError('Vui lòng nhập chủ đề video');
      return;
    }

    setGenerating(true);
    setError(null);
    setResult(null);

    try {
      const data = await api.generateScript({
        profileId: selectedProfile?.id,
        projectId: selectedProjectId || undefined,
        input_type: params.inputMode,
        youtube_url: params.inputMode === 'youtube_url' ? params.youtubeUrl : undefined,
        topic: params.inputMode === 'topic' ? params.topic : undefined,
        language: params.language,
        duration_minutes: params.durationMinutes,
        storytelling_mode: params.storytellingMode,
        copy_ratio: params.copyRatio,
        additional_description: params.additionalDesc,
        temperature: params.temperature,
        gemini_api_keys: params.noVoice ? undefined : geminiApiKeys,
        gemini_model: geminiModel,
        no_voice: params.noVoice,
        no_music: params.noMusic,
      });
      setResult(data);

      const charNames = new Set<string>();
      data.scenes.forEach((scene: any) => {
        (scene.characters || []).forEach((c: string) => charNames.add(c));
      });
      const chars = Array.from(charNames).map(name => ({
        name,
        description: (data.characters as any[])?.find((c: any) => c.name === name)?.description || ''
      }));
      setCharacterCasting(chars);
      setCastingStep(true);
      setCastingModified(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi khi sinh kịch bản');
    } finally {
      setGenerating(false);
    }
  }, [selectedProfile, selectedProjectId, geminiApiKeys, geminiModel]);

  // Save characters to script
  const handleSaveCharactersToScript = useCallback(async () => {
    if (!selectedScriptId) return;

    try {
      const charactersWithDescriptions = characterCasting
        .filter(char => char.description)
        .map(char => ({
          name: char.name,
          description: char.description || '',
          imagePrompt: char.imagePrompt,
          entityId: char.entityId
        }));

      if (charactersWithDescriptions.length === 0) {
        setError('Cần có ít nhất 1 mô tả nhân vật để cập nhật');
        return;
      }

      const updatedScript = await api.updateScriptWithCharacters({
        scriptId: selectedScriptId,
        characters: charactersWithDescriptions
      });

      setResult(updatedScript.content);
      setCastingModified(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi khi lưu kịch bản');
    }
  }, [selectedScriptId, characterCasting]);

  // Reset state
  const reset = useCallback(() => {
    setResult(null);
    setSelectedScriptId(null);
    setCastingStep(false);
    setCharacterCasting([]);
    setError(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    selectedProjectName,
    setSelectedProjectName,
    selectedProfileIdx,
    setSelectedProfileIdx,
    projectNames,
    selectedProfile,
    selectedProjectId,
    scripts,
    selectedScriptId,
    loadingScripts,
    loadScript,
    deleteScript,
    geminiApiKeys,
    setGeminiApiKeys,
    geminiModel,
    setGeminiModel,
    saveGeminiSettings,
    settingsSaved,
    generating,
    result,
    error,
    setError: clearError,
    generateScript,
    characterCasting,
    setCharacterCasting,
    castingStep,
    setCastingStep,
    castingModified,
    handleSaveCharactersToScript,
    reset,
  };
}
