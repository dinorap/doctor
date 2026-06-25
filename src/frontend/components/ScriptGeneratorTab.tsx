import React, { useState, useCallback } from 'react';
import type { Profile, ScriptResult, CharacterCast, InputMode } from './ScriptGeneratorTab/types';
import { useScriptGenerator } from './ScriptGeneratorTab/useScriptGenerator';
import { ScriptInputPanel } from './ScriptGeneratorTab/ScriptInputPanel';
import { SceneCard } from './ScriptGeneratorTab/SceneCard';
import LibraryModal from './LibraryModal';

function ScriptGeneratorTab({ profiles, projectName, onOpenProfile, onWaitForProfileReady }: {
  profiles: Profile[];
  projectName?: string;
  onOpenProfile?: (profileId: string) => Promise<void>;
  onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
}) {
  // Input state
  const [inputMode, setInputMode] = useState<InputMode>('topic');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [topic, setTopic] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  
  // Settings state
  const [language, setLanguage] = useState('vi');
  const [storytellingMode, setStorytellingMode] = useState('auto');
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [copyRatio, setCopyRatio] = useState(90);
  const [additionalDesc, setAdditionalDesc] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [noVoice, setNoVoice] = useState(false);
  const [noMusic, setNoMusic] = useState(false);

  // UI state
  const [expandedScenes, setExpandedScenes] = useState<Set<number>>(new Set());
  const [showLibrary, setShowLibrary] = useState(false);
  const [selectingCharacter, setSelectingCharacter] = useState<string | null>(null);
  const [characterCasting, setCharacterCasting] = useState<CharacterCast[]>([]);
  const [castingStep, setCastingStep] = useState(false);
  const [castingModified, setCastingModified] = useState(false);

  // Use the hook
  const {
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
    setError,
    generateScript,
    handleSaveCharactersToScript,
    reset,
  } = useScriptGenerator({ profiles });

  // Scene interaction handlers
  const toggleScene = useCallback((idx: number) => {
    setExpandedScenes(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  // Character casting handlers
  const handleSelectFromLibrary = (entity: any) => {
    if (selectingCharacter && entity.reference_image_url) {
      setCharacterCasting(prev => prev.map(c =>
        c.name === selectingCharacter
          ? { ...c, entity, entityId: entity.id, description: entity.image_prompt || entity.description, imagePrompt: entity.image_prompt || '' }
          : c
      ));
      setCastingModified(true);
    }
    setShowLibrary(false);
    setSelectingCharacter(null);
  };

  const removeCharacterCast = (name: string) => {
    setCharacterCasting(prev => prev.map(c =>
      c.name === name ? { ...c, entity: undefined, entityId: undefined, description: undefined, imagePrompt: undefined } : c
    ));
    setCastingModified(true);
  };

  const updateCharacterDescription = (name: string, description: string) => {
    setCharacterCasting(prev => prev.map(c =>
      c.name === name ? { ...c, description } : c
    ));
    setCastingModified(true);
  };

  const finishCasting = () => {
    setCastingStep(false);
    setExpandedScenes(new Set(result?.scenes.map((_: any, i: number) => i) || []));
  };

  // Calculate total duration
  const totalScriptDuration = result?.scenes.reduce((sum, s) => sum + (s.duration_seconds || 8), 0) || 0;

  // Handle generate button
  const handleGenerate = () => {
    generateScript({
      inputMode,
      youtubeUrl,
      topic,
      language,
      durationMinutes,
      storytellingMode: storytellingMode as 'auto' | 'narration' | 'dialogue' | 'mixed',
      copyRatio,
      additionalDesc,
      temperature,
      noVoice,
      noMusic,
    });
  };

  // Copy entire script
  const copyEntireScript = () => {
    if (!result) return;
    const scriptText = result.scenes.map(s =>
      `[Cảnh ${s.scene_id}] ${s.scene_title}\n` +
      `🖼️ Visual Prompt: ${s.visual_prompt}\n` +
      `🔊 TTS: ${s.tts_script}\n` +
      `⏱ ${s.duration_seconds}s\n` +
      (s.transition ? `➡️ Chuyển cảnh: ${s.transition}\n` : '')
    ).join('\n\n');
    navigator.clipboard.writeText(scriptText);
  };

  return (
    <div className="script-generator-tab">
      <div className="script-gen-grid">
        {/* LEFT: Input Panel */}
        <ScriptInputPanel
          profiles={profiles}
          projectNames={projectNames}
          selectedProjectName={selectedProjectName}
          onProjectChange={setSelectedProjectName}
          selectedProfileIdx={selectedProfileIdx}
          onProfileIdxChange={setSelectedProfileIdx}
          inputMode={inputMode}
          onInputModeChange={(mode) => {
            setInputMode(mode);
            setTopic('');
            setYoutubeUrl('');
          }}
          youtubeUrl={youtubeUrl}
          onYoutubeUrlChange={setYoutubeUrl}
          topic={topic}
          onTopicChange={setTopic}
          uploadedFiles={uploadedFiles}
          onUploadedFilesChange={setUploadedFiles}
          language={language}
          onLanguageChange={setLanguage}
          storytellingMode={storytellingMode}
          onStorytellingModeChange={setStorytellingMode}
          durationMinutes={durationMinutes}
          onDurationMinutesChange={setDurationMinutes}
          copyRatio={copyRatio}
          onCopyRatioChange={setCopyRatio}
          additionalDesc={additionalDesc}
          onAdditionalDescChange={setAdditionalDesc}
          temperature={temperature}
          onTemperatureChange={setTemperature}
          noVoice={noVoice}
          onNoVoiceChange={setNoVoice}
          noMusic={noMusic}
          onNoMusicChange={setNoMusic}
          geminiApiKeys={geminiApiKeys}
          onGeminiApiKeysChange={setGeminiApiKeys}
          geminiModel={geminiModel}
          onGeminiModelChange={setGeminiModel}
          onSaveSettings={saveGeminiSettings}
          settingsSaved={settingsSaved}
          onGenerate={handleGenerate}
          generating={generating}
        />

        {/* RIGHT: Result Panel */}
        <div className="script-gen-right">
          {/* Error display */}
          {error && (
            <div className="error-banner">
              <span>❌ {error}</span>
              <button className="error-close" onClick={() => setError(null)}>✕</button>
            </div>
          )}

          {/* No result yet */}
          {!result && !generating && (
            <div className="script-empty-state">
              {/* Scripts list */}
              <div className="scripts-panel">
                <div className="scripts-header">
                  <h3>📜 Kịch bản đã lưu</h3>
                </div>
                {loadingScripts ? (
                  <div className="scripts-loading">
                    <span className="loading-dots"><span>.</span><span>.</span><span>.</span></span>
                    Đang tải...
                  </div>
                ) : scripts.length === 0 ? (
                  <div className="scripts-empty">
                    <p>Chưa có kịch bản nào cho project này.</p>
                    <p className="scripts-empty-hint">Tạo kịch bản mới ở panel bên trái.</p>
                  </div>
                ) : (
                  <div className="scripts-list">
                    {scripts.map(script => (
                      <div
                        key={script.id}
                        className={`script-item ${selectedScriptId === script.id ? 'selected' : ''}`}
                        onClick={() => loadScript(script.id)}
                      >
                        <div className="script-item-icon">📜</div>
                        <div className="script-item-info">
                          <div className="script-item-name">{script.name}</div>
                          <div className="script-item-meta">
                            <span>v{script.version}</span>
                            <span>•</span>
                            <span>{new Date(script.created_at || script.createdAt).toLocaleDateString('vi-VN')}</span>
                          </div>
                        </div>
                        <div className="script-item-actions">
                          <button
                            className="script-delete-btn"
                            onClick={(e) => deleteScript(script.id)}
                            title="Xóa kịch bản"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Feature highlights */}
              <div className="empty-script-state">
                <div className="empty-icon">🎬</div>
                <h3>Tạo Kịch Bản Mới</h3>
                <p>Nhập chủ đề hoặc URL YouTube ở panel bên trái để Gemini sinh kịch bản video</p>
                <div className="feature-highlights">
                  <div className="feature-highlight">
                    <span className="fh-icon">🎬</span>
                    <span>Chia cảnh ngắn 7-10s</span>
                  </div>
                  <div className="feature-highlight">
                    <span className="fh-icon">🖼️</span>
                    <span>Prompt tạo ảnh cho từng cảnh</span>
                  </div>
                  <div className="feature-highlight">
                    <span className="fh-icon">🔊</span>
                    <span>Script TTS tự nhiên</span>
                  </div>
                  <div className="feature-highlight">
                    <span className="fh-icon">✨</span>
                    <span>Style nhất quán xuyên suốt</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Generating state */}
          {generating && (
            <div className="generating-state">
              <div className="gen-animation">
                <div className="gen-dot" /><div className="gen-dot" /><div className="gen-dot" />
              </div>
              <h3>Gemini đang sinh kịch bản...</h3>
              <p>Phân tích nội dung và tạo các cảnh video ngắn</p>
              <div className="gen-steps">
                <div className="gen-step done">✓ Phân tích yêu cầu</div>
                <div className="gen-step done">✓ Xác định cấu trúc video</div>
                <div className="gen-step active">⟳ Đang sinh scene prompts...</div>
                <div className="gen-step pending">○ Tối ưu TTS scripts</div>
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <>
              {/* Script Header */}
              <div className="profile-card script-header-card">
                <div className="profile-header">
                  <div className="profile-title">
                    <div className="profile-avatar">✅</div>
                    <div>
                      <div className="profile-name">{result.title}</div>
                      <div className="profile-id">{result.topic}</div>
                    </div>
                  </div>
                  <div className="script-stats">
                    <span className="stat-chip">⏱ {totalScriptDuration}s</span>
                    <span className="stat-chip">🎬 {result.scenes.length} cảnh</span>
                    <span className="stat-chip">🌐 {language === 'vi' ? 'Tiếng Việt' : 'English'}</span>
                  </div>
                </div>
                {(result.summary || result.style_notes) && (
                  <div className="script-meta">
                    {result.summary && <p className="script-summary">📋 {result.summary}</p>}
                    {result.style_notes && <p className="script-notes">💡 {result.style_notes}</p>}
                  </div>
                )}
                <div className="script-actions">
                  <button className="btn btn-secondary" onClick={copyEntireScript}>
                    📋 Copy toàn bộ
                  </button>
                  <button className="btn btn-secondary" onClick={reset}>
                    🔄 Tạo mới
                  </button>
                </div>
              </div>

              {/* Character Casting Step */}
              {castingStep && (
                <div className="casting-panel">
                  <div className="casting-header">
                    <h3>🎭 Cast nhân vật từ Library</h3>
                    <p className="casting-hint">Chọn entity từ Library để đảm bảo AI giữ nguyên ngoại hình nhân vật</p>
                  </div>
                  <div className="casting-table">
                    <div className="casting-row casting-row-header">
                      <span>Character</span>
                      <span>Mô tả ngoại hình</span>
                      <span>Entity Library</span>
                    </div>
                    {characterCasting.map((char) => (
                      <div key={char.name} className="casting-row">
                        <span className="casting-char-name">{char.name}</span>
                        <div className="casting-char-desc-cell">
                          {char.imagePrompt ? (
                            <div className="casting-desc-from-library">
                              <span className="desc-source">📚 Từ Library:</span>
                              <input
                                type="text"
                                className="form-input casting-desc-input"
                                value={char.description || ''}
                                onChange={(e) => updateCharacterDescription(char.name, e.target.value)}
                                placeholder="Mô tả ngoại hình..."
                              />
                            </div>
                          ) : char.entity ? (
                            <input
                              type="text"
                              className="form-input casting-desc-input"
                              value={char.description || ''}
                              onChange={(e) => updateCharacterDescription(char.name, e.target.value)}
                              placeholder="Nhập mô tả ngoại hình..."
                            />
                          ) : (
                            <span className="casting-no-desc">-</span>
                          )}
                        </div>
                        <div className="casting-action">
                          {char.entity ? (
                            <div className="casting-selected">
                              {char.entity.reference_image_url && (
                                <img
                                  src={char.entity.reference_image_url.startsWith('http')
                                    ? char.entity.reference_image_url
                                    : `${window.location.origin}${char.entity.reference_image_url}`}
                                  alt={char.entity.name}
                                  className="casting-thumb"
                                />
                              )}
                              <span className="casting-entity-name">{char.entity.name}</span>
                              <button
                                className="casting-remove"
                                onClick={() => removeCharacterCast(char.name)}
                                title="Bỏ chọn"
                              >
                                ✕
                              </button>
                            </div>
                          ) : (
                            <button
                              className="btn btn-secondary casting-select-btn"
                              onClick={() => {
                                setSelectingCharacter(char.name);
                                setShowLibrary(true);
                              }}
                            >
                              Chọn ảnh
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="casting-footer">
                    {castingModified && selectedScriptId && (
                      <button
                        className="btn btn-warning"
                        onClick={handleSaveCharactersToScript}
                      >
                        💾 Lưu & Cập nhật kịch bản
                      </button>
                    )}
                    <button className="btn btn-primary" onClick={finishCasting}>
                      ✅ Xem kịch bản
                    </button>
                  </div>
                </div>
              )}

              {/* Scenes List */}
              <div className="scenes-list">
                {result.scenes.map((scene, idx) => (
                  <SceneCard
                    key={idx}
                    scene={scene}
                    index={idx}
                    isExpanded={expandedScenes.has(idx)}
                    onToggle={() => toggleScene(idx)}
                    selectedScriptId={selectedScriptId}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Library Modal */}
      {showLibrary && (
        <LibraryModal
          isOpen={showLibrary}
          onClose={() => setShowLibrary(false)}
          onSelect={handleSelectFromLibrary}
        />
      )}
    </div>
  );
}

export default ScriptGeneratorTab;
