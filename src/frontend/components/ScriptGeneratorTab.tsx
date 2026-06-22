import React, { useState, useRef, useEffect } from 'react';
import { api } from '../services/api';

type InputMode = 'youtube_url' | 'topic' | 'upload_files';
type ScriptScene = {
  scene_id: number;
  scene_title: string;
  description: string;
  image_prompt: string;
  tts_script: string;
  duration_seconds: number;
  suggested_visual?: string;
  transition?: string;
};

type ScriptResult = {
  title: string;
  topic: string;
  duration_seconds: number;
  total_scenes: number;
  summary?: string;
  style_notes?: string;
  scenes: ScriptScene[];
};

interface ScriptGeneratorTabProps {
  onSendToFlowVideos?: (scenes: ScriptScene[], totalDuration: number) => void;
}

const LANGUAGES = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'zh', label: '中文' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
];

const GEMINI_MODELS = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', desc: 'Nhanh, chi phí thấp', icon: '⚡' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: 'Mới nhất, cân bằng', icon: '✨' },
  { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', desc: 'Siêu nhẹ, miễn phí', icon: '🌟' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: 'Ổn định, phổ biến', icon: '🔷' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', desc: 'Tiết kiệm quota', icon: '💎' },
];

export default function ScriptGeneratorTab({ onSendToFlowVideos }: ScriptGeneratorTabProps) {
  const [inputMode, setInputMode] = useState<InputMode>('topic');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [topic, setTopic] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [language, setLanguage] = useState('vi');
  const [durationMinutes, setDurationMinutes] = useState(10); // phút
  const [copyRatio, setCopyRatio] = useState(90);
  const [additionalDesc, setAdditionalDesc] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [geminiApiKeys, setGeminiApiKeys] = useState(''); // multi-line string
  const [geminiModel, setGeminiModel] = useState('gemini-3.5-flash');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScriptResult | null>(null);
  const [activeScene, setActiveScene] = useState<number | null>(null);
  const [copiedField, setCopiedField] = useState<{ sceneId: number; field: string } | null>(null);
  const [expandedScenes, setExpandedScenes] = useState<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [noVoice, setNoVoice] = useState(false);
  const [noMusic, setNoMusic] = useState(false);

  // Load saved settings on mount
  useEffect(() => {
    api.getGeminiSettings().then(res => {
      if (res?.apiKeys !== undefined) setGeminiApiKeys(res.apiKeys);
      if (res?.model) setGeminiModel(res.model);
    }).catch(() => {});
  }, []);

  const handleSaveSettings = async () => {
    try {
      await api.saveGeminiSettings({ apiKeys: geminiApiKeys, model: geminiModel });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch { /* silent */ }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setUploadedFiles(files);
  };

  const handleGenerate = async () => {
    if (inputMode === 'youtube_url' && !youtubeUrl.trim()) {
      setError('Vui lòng nhập URL YouTube');
      return;
    }
    if (inputMode === 'topic' && !topic.trim()) {
      setError('Vui lòng nhập chủ đề video');
      return;
    }

    setGenerating(true);
    setError(null);
    setResult(null);
    setActiveScene(null);

    try {
      const data = await api.generateScript({
        input_type: inputMode,
        youtube_url: inputMode === 'youtube_url' ? youtubeUrl : undefined,
        topic: inputMode === 'topic' ? topic : undefined,
        language,
        duration_minutes: durationMinutes,
        copy_ratio: copyRatio,
        additional_description: additionalDesc,
        temperature,
        gemini_api_keys: geminiApiKeys,
        gemini_model: geminiModel,
        no_voice: noVoice,
        no_music: noMusic,
      });
      setResult(data);
      setExpandedScenes(new Set(data.scenes.map((_: any, i: number) => i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi khi sinh kịch bản');
    } finally {
      setGenerating(false);
    }
  };

  const copyToClipboard = async (text: string, sceneId: number, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField({ sceneId, field });
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedField({ sceneId, field });
      setTimeout(() => setCopiedField(null), 1500);
    }
  };

  const toggleScene = (idx: number) => {
    setExpandedScenes(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const totalScriptDuration = result?.scenes.reduce((sum, s) => sum + (s.duration_seconds || 8), 0) || 0;

  return (
    <div className="script-generator-tab">
      <div className="script-gen-grid">
        {/* LEFT: Input Panel */}
        <div className="script-gen-left">
          {/* Input Mode Selection */}
          <div className="profile-card">
            <div className="profile-header">
              <div className="profile-title">
                <div className="profile-avatar">📝</div>
                <div>
                  <div className="profile-name">Sinh Kịch Bản Video</div>
                  <div className="profile-id">Gemini AI-powered script generator</div>
                </div>
              </div>
            </div>
            <div className="profile-content">
              <div className="input-mode-tabs">
                {[
                  { id: 'topic', label: 'Chủ đề', icon: '💡' },
                  { id: 'youtube_url', label: 'YouTube URL', icon: '▶️' },
                  { id: 'upload_files', label: 'Upload File', icon: '📄' },
                ].map(tab => (
                  <button
                    key={tab.id}
                    className={`input-mode-btn ${inputMode === tab.id ? 'active' : ''}`}
                    onClick={() => { setInputMode(tab.id as InputMode); setError(null); setResult(null); }}
                  >
                    <span>{tab.icon}</span>
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* Topic Input */}
              {inputMode === 'topic' && (
                <div className="form-group">
                  <label className="form-label">Chủ đề video *</label>
                  <textarea
                    className="form-input"
                    rows={4}
                    placeholder={
                      language === 'vi'
                        ? 'VD: Lịch sử Ai Cập cổ đại - từ thời Vương triều đến sự sụp đổ...'
                        : 'VD: History of Ancient Egypt - from the Old Kingdom to the fall of the Pharaohs...'
                    }
                    value={topic}
                    onChange={e => setTopic(e.target.value)}
                  />
                  <div className="input-hint">
                    Mô tả chủ đề chi tiết để Gemini tạo kịch bản chính xác hơn
                  </div>
                </div>
              )}

              {/* YouTube URL Input */}
              {inputMode === 'youtube_url' && (
                <div className="form-group">
                  <label className="form-label">YouTube URL *</label>
                  <input
                    type="url"
                    className="form-input"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={youtubeUrl}
                    onChange={e => setYoutubeUrl(e.target.value)}
                  />
                  <div className="input-hint">
                    Gemini sẽ phân tích video và tạo kịch bản mới dựa trên nội dung
                  </div>
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label className="form-label">Tỷ lệ copy nội dung gốc</label>
                    <div className="copy-ratio-control">
                      <input
                        type="range"
                        min="50"
                        max="100"
                        value={copyRatio}
                        onChange={e => setCopyRatio(Number(e.target.value))}
                        className="ratio-slider"
                      />
                      <div className="ratio-labels">
                        <span>50% (Sáng tạo)</span>
                        <span className="ratio-value">{copyRatio}% Copy</span>
                        <span>100% (Giữ nguyên)</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Upload Files */}
              {inputMode === 'upload_files' && (
                <div className="form-group">
                  <label className="form-label">Upload tài liệu</label>
                  <div
                    className="file-drop-zone"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept=".pdf,.txt,.doc,.docx,.md"
                      style={{ display: 'none' }}
                      onChange={handleFileChange}
                    />
                    <div className="file-drop-icon">📂</div>
                    <div className="file-drop-text">
                      {uploadedFiles.length > 0
                        ? `${uploadedFiles.length} file(s) selected`
                        : 'Kéo thả file hoặc click để chọn'}
                    </div>
                    <div className="file-drop-hint">PDF, TXT, DOC, MD</div>
                  </div>
                  {uploadedFiles.length > 0 && (
                    <div className="uploaded-files-list">
                      {uploadedFiles.map((f, i) => (
                        <div key={i} className="uploaded-file-item">
                          <span className="file-icon">📄</span>
                          <span className="file-name">{f.name}</span>
                          <button
                            className="file-remove"
                            onClick={e => {
                              e.stopPropagation();
                              setUploadedFiles(prev => prev.filter((_, idx) => idx !== i));
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Common Settings */}
              <div className="settings-divider" />

              {/* Gemini API Keys */}
              <div className="form-group">
                <label className="form-label">Gemini API Keys <span className="optional-tag">Hỗ trợ nhiều key, xuống dòng / dấu phẩy / chấm phẩy</span></label>
                <textarea
                  className="form-input"
                  rows={3}
                  placeholder="AIzaSyD...\nAIzaSyC...\nAIzaSyB..."
                  value={geminiApiKeys}
                  onChange={e => setGeminiApiKeys(e.target.value)}
                />
                <div className="input-hint">
                  Key đầu tiên được dùng. Nếu bị rate-limit, hệ thống tự xoay sang key tiếp theo.
                  Nếu không nhập, sẽ dùng GEMINI_API_KEY từ .env
                </div>
                <div className="settings-save-row">
                  <button
                    className={`btn-save-settings ${settingsSaved ? 'saved' : ''}`}
                    onClick={handleSaveSettings}
                    type="button"
                  >
                    {settingsSaved ? '✓ Đã lưu' : '💾 Lưu cài đặt'}
                  </button>
                  <span className="save-hint">Lưu vĩnh viễn, không cần nhập lại lần sau</span>
                </div>
              </div>

              {/* Gemini Model */}
              <div className="form-group">
                <label className="form-label">Model Gemini</label>
                <div className="gemini-model-grid">
                  {GEMINI_MODELS.map(model => (
                    <button
                      key={model.value}
                      className={`gemini-model-btn ${geminiModel === model.value ? 'active' : ''}`}
                      onClick={() => setGeminiModel(model.value)}
                      title={model.desc}
                    >
                      <span className="model-icon">{model.icon}</span>
                      <span className="model-label">{model.label}</span>
                    </button>
                  ))}
                </div>
                <div className="model-desc">
                  {GEMINI_MODELS.find(m => m.value === geminiModel)?.desc}
                </div>
              </div>

              {/* Language */}
              <div className="form-group">
                <label className="form-label">Ngôn ngữ TTS</label>
                <select
                  className="form-input"
                  value={language}
                  onChange={e => setLanguage(e.target.value)}
                >
                  {LANGUAGES.map(l => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              </div>

              {/* Duration Number */}
              <div className="form-group">
                <label className="form-label">Thời lượng video</label>
                <div className="duration-minute-input">
                  <input
                    type="number"
                    className="form-input duration-num-input"
                    min={0.1}
                    max={9999}
                    step={0.1}
                    value={durationMinutes}
                    onChange={e => setDurationMinutes(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
                  />
                  <span className="duration-unit">phút</span>
                </div>
                <div className="input-hint">Từ 0.1 phút đến vô hạn. VD: 0.5, 10, 60, 120...</div>
              </div>

              {/* Additional Description */}
              <div className="form-group">
                <label className="form-label">Mô tả thêm <span className="optional-tag">Optional</span></label>
                <textarea
                  className="form-input"
                  rows={2}
                  placeholder="Phong cách, tâm trạng, đối tượng khán giả..."
                  value={additionalDesc}
                  onChange={e => setAdditionalDesc(e.target.value)}
                />
              </div>

              {/* Advanced Settings */}
              <details className="advanced-settings">
                <summary>Tuỳ chỉnh bổ sung</summary>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>

                  {/* No Voice */}
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={noVoice}
                      onChange={e => setNoVoice(e.target.checked)}
                    />
                    <span>Không có thoại (không tạo tts_script cho các cảnh)</span>
                  </label>

                  {/* No Music */}
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={noMusic}
                      onChange={e => setNoMusic(e.target.checked)}
                    />
                    <span>Không có nhạc nền (thêm "No background music..." vào video prompt)</span>
                  </label>

                  {/* Temperature */}
                  <div className="form-group" style={{ marginTop: 8 }}>
                    <label className="form-label">
                      Temperature: <strong>{temperature}</strong>
                      <span className="temp-hint">
                        {temperature < 0.3 ? ' (Chính xác)' : temperature < 0.7 ? ' (Cân bằng)' : ' (Sáng tạo)'}
                      </span>
                    </label>
                    <input
                      type="range"
                      min="0.1"
                      max="1.2"
                      step="0.1"
                      value={temperature}
                      onChange={e => setTemperature(Number(e.target.value))}
                      className="ratio-slider"
                    />
                  </div>
                </div>
              </details>

              {error && (
                <div className="error-message">
                  ⚠️ {error}
                </div>
              )}

              {/* Generate Button */}
              <button
                className="btn btn-primary btn-generate"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? (
                  <>
                    <span className="loading-dots">
                      <span>.</span><span>.</span><span>.</span>
                    </span>
                    Đang sinh kịch bản...
                  </>
                ) : (
                  <>🎬 Sinh Kịch Bản Video</>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: Results Panel */}
        <div className="script-gen-right">
          {!result && !generating && (
            <div className="empty-script-state">
              <div className="empty-icon">📜</div>
              <h3>Chưa có kịch bản</h3>
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
          )}

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
                    <span className="stat-chip">🌐 {LANGUAGES.find(l => l.value === language)?.label}</span>
                  </div>
                </div>
                {(result.summary || result.style_notes) && (
                  <div className="script-meta">
                    {result.summary && <p className="script-summary">📋 {result.summary}</p>}
                    {result.style_notes && <p className="script-notes">💡 {result.style_notes}</p>}
                  </div>
                )}
                <div className="script-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      const scriptText = result.scenes.map(s =>
                        `[Cảnh ${s.scene_id}] ${s.scene_title}\n` +
                        `📝 Mô tả: ${s.description}\n` +
                        `🖼️ Image Prompt: ${s.image_prompt}\n` +
                        `🔊 TTS: ${s.tts_script}\n` +
                        `⏱ ${s.duration_seconds}s\n` +
                        (s.transition ? `➡️ Chuyển cảnh: ${s.transition}\n` : '')
                      ).join('\n\n');
                      navigator.clipboard.writeText(scriptText);
                    }}
                  >
                    📋 Copy toàn bộ
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setResult(null)}
                  >
                    🔄 Tạo mới
                  </button>
                </div>
              </div>

              {/* Scenes List */}
              <div className="scenes-list">
                {result.scenes.map((scene, idx) => {
                  const isExpanded = expandedScenes.has(idx);
                  return (
                    <div key={idx} className={`scene-card ${activeScene === idx ? 'active' : ''}`}>
                      <div
                        className="scene-card-header"
                        onClick={() => {
                          setActiveScene(activeScene === idx ? null : idx);
                          toggleScene(idx);
                        }}
                      >
                        <div className="scene-number">{scene.scene_id}</div>
                        <div className="scene-info">
                          <div className="scene-title">{scene.scene_title}</div>
                          <div className="scene-meta-row">
                            <span className="scene-duration">⏱ {scene.duration_seconds}s</span>
                            <span className="scene-desc-short">{scene.description.slice(0, 60)}{scene.description.length > 60 ? '...' : ''}</span>
                          </div>
                        </div>
                        <div className="scene-toggle">{isExpanded ? '▲' : '▼'}</div>
                      </div>

                      {isExpanded && (
                        <div className="scene-card-body">
                          {/* Description */}
                          <div className="scene-field">
                            <div className="field-header">
                              <span className="field-label">📝 Mô tả cảnh quay</span>
                              <button
                                className={`copy-btn ${copiedField?.sceneId === idx && copiedField?.field === 'desc' ? 'copied' : ''}`}
                                onClick={() => copyToClipboard(scene.description, idx, 'desc')}
                              >
                                {copiedField?.sceneId === idx && copiedField?.field === 'desc' ? '✓ Đã copy' : '📋 Copy'}
                              </button>
                            </div>
                            <p className="field-content">{scene.description}</p>
                          </div>

                          {/* Image Prompt */}
                          <div className="scene-field image-prompt-field">
                            <div className="field-header">
                              <span className="field-label">🖼️ Image Prompt</span>
                              <button
                                className={`copy-btn ${copiedField?.sceneId === idx && copiedField?.field === 'img' ? 'copied' : ''}`}
                                onClick={() => copyToClipboard(scene.image_prompt, idx, 'img')}
                              >
                                {copiedField?.sceneId === idx && copiedField?.field === 'img' ? '✓ Đã copy' : '📋 Copy'}
                              </button>
                            </div>
                            <p className="field-content image-prompt-text">{scene.image_prompt}</p>
                          </div>

                          {/* TTS Script */}
                          <div className="scene-field tts-field">
                            <div className="field-header">
                              <span className="field-label">🔊 TTS Script</span>
                              <button
                                className={`copy-btn ${copiedField?.sceneId === idx && copiedField?.field === 'tts' ? 'copied' : ''}`}
                                onClick={() => copyToClipboard(scene.tts_script, idx, 'tts')}
                              >
                                {copiedField?.sceneId === idx && copiedField?.field === 'tts' ? '✓ Đã copy' : '📋 Copy'}
                              </button>
                            </div>
                            <p className="field-content tts-text">{scene.tts_script}</p>
                          </div>

                          {/* Extras */}
                          <div className="scene-extras">
                            {scene.suggested_visual && (
                              <div className="scene-extra-item">
                                <span className="extra-label">✨ Gợi ý hình ảnh:</span>
                                <span className="extra-value">{scene.suggested_visual}</span>
                              </div>
                            )}
                            {scene.transition && (
                              <div className="scene-extra-item">
                                <span className="extra-label">➡️ Chuyển cảnh:</span>
                                <span className="extra-value">{scene.transition}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <style>{`
        .script-generator-tab {
          padding: 20px;
          height: 100%;
          overflow-y: auto;
          background: #0f0f1a;
        }

        .script-gen-grid {
          display: grid;
          grid-template-columns: 420px 1fr;
          gap: 20px;
          max-width: 1600px;
          margin: 0 auto;
        }

        .script-gen-left,
        .script-gen-right {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        /* Input Mode Tabs */
        .input-mode-tabs {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 6px;
          margin-bottom: 4px;
        }

        .input-mode-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 10px 8px;
          border: 2px solid #333355;
          background: #1e1e3f;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s;
          color: #a0a0b0;
          font-size: 0.8rem;
          font-weight: 500;
        }

        .input-mode-btn:hover {
          border-color: #667eea;
          color: #ffffff;
        }

        .input-mode-btn.active {
          border-color: #667eea;
          background: linear-gradient(135deg, rgba(102, 126, 234, 0.3), rgba(118, 75, 162, 0.3));
          color: #ffffff;
          box-shadow: 0 0 15px rgba(102, 126, 234, 0.2);
        }

        .input-mode-btn span:first-child {
          font-size: 1.2rem;
        }

        /* Hint */
        .input-hint {
          font-size: 0.75rem;
          color: #a0a0b0;
          margin-top: 6px;
          line-height: 1.4;
        }

        .optional-tag {
          font-size: 0.7rem;
          color: #a0a0b0;
          font-weight: normal;
          margin-left: 6px;
        }

        /* Copy Ratio */
        .copy-ratio-control {
          margin-top: 8px;
        }

        .ratio-slider {
          width: 100%;
          accent-color: #667eea;
          cursor: pointer;
        }

        .ratio-labels {
          display: flex;
          justify-content: space-between;
          font-size: 0.7rem;
          color: #a0a0b0;
          margin-top: 4px;
        }

        .ratio-value {
          font-weight: 600;
          color: #667eea;
        }

        /* File Drop */
        .file-drop-zone {
          border: 2px dashed #333355;
          border-radius: 12px;
          padding: 32px 16px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s;
          background: #1a1a2e;
        }

        .file-drop-zone:hover {
          border-color: #667eea;
          background: rgba(102, 126, 234, 0.1);
        }

        .file-drop-icon {
          font-size: 2.5rem;
          margin-bottom: 8px;
        }

        .file-drop-text {
          font-size: 0.9rem;
          color: #ffffff;
          margin-bottom: 4px;
        }

        .file-drop-hint {
          font-size: 0.75rem;
          color: #606080;
        }

        .uploaded-files-list {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .uploaded-file-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: #1e1e3f;
          border-radius: 8px;
          border: 1px solid #333355;
        }

        .file-icon { font-size: 1.1rem; }

        .file-name {
          flex: 1;
          font-size: 0.85rem;
          color: #ffffff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .file-remove {
          background: none;
          border: none;
          color: #ef4444;
          cursor: pointer;
          font-size: 0.9rem;
          padding: 2px 6px;
        }

        .file-remove:hover { color: #ff6b6b; }

        /* Settings Divider */
        .settings-divider {
          border-top: 1px solid #333355;
          margin: 8px 0;
        }

        /* Duration Presets */
        .duration-presets {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
        }

        .duration-preset-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          padding: 10px 6px;
          border: 2px solid #333355;
          background: #1e1e3f;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
          color: #a0a0b0;
        }

        .duration-preset-btn:hover {
          border-color: #667eea;
          color: #ffffff;
        }

        .duration-preset-btn.active {
          border-color: #22c55e;
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.05));
          color: #ffffff;
          box-shadow: 0 0 10px rgba(34, 197, 94, 0.2);
        }

        .preset-label {
          font-size: 0.9rem;
          font-weight: 700;
        }

        .preset-scenes {
          font-size: 0.65rem;
          opacity: 0.7;
        }

        /* Gemini Model Grid */
        .gemini-model-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin-bottom: 6px;
        }

        .gemini-model-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          padding: 10px 8px;
          border: 2px solid #333355;
          background: #1e1e3f;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s;
          color: #a0a0b0;
          font-size: 0.78rem;
          font-weight: 500;
        }

        .gemini-model-btn:hover {
          border-color: #667eea;
          color: #ffffff;
        }

        .gemini-model-btn.active {
          border-color: #667eea;
          background: linear-gradient(135deg, rgba(102, 126, 234, 0.3), rgba(118, 75, 162, 0.3));
          color: #ffffff;
          box-shadow: 0 0 15px rgba(102, 126, 234, 0.2);
        }

        .gemini-model-btn .model-icon {
          font-size: 1.2rem;
        }

        .gemini-model-btn .model-label {
          font-size: 0.72rem;
          line-height: 1.2;
          text-align: center;
        }

        .model-desc {
          font-size: 0.75rem;
          color: #667eea;
          text-align: center;
          font-style: italic;
          margin-bottom: 8px;
        }

        .settings-save-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #333355;
        }

        .btn-save-settings {
          padding: 8px 20px;
          border: 2px solid #667eea;
          background: transparent;
          color: #667eea;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          font-size: 0.85rem;
          transition: all 0.2s;
        }

        .btn-save-settings:hover {
          background: rgba(102, 126, 234, 0.15);
          box-shadow: 0 0 12px rgba(102, 126, 234, 0.3);
        }

        .btn-save-settings.saved {
          border-color: #22c55e;
          color: #22c55e;
          background: rgba(34, 197, 94, 0.1);
        }

        .save-hint {
          font-size: 0.72rem;
          color: #666688;
          font-style: italic;
        }

        /* Duration minute input */
        .duration-minute-input {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .duration-num-input {
          width: 120px !important;
          text-align: center;
          font-size: 1.1rem;
          font-weight: 600;
          padding: 8px 12px !important;
        }

        .duration-unit {
          font-size: 0.9rem;
          color: #a0a0b0;
          font-weight: 500;
        }

        /* Advanced */
        .advanced-settings {
          margin-top: 4px;
        }

        .advanced-settings summary {
          cursor: pointer;
          padding: 8px 0;
          color: #a0a0b0;
          font-size: 0.85rem;
        }

        .advanced-settings summary:hover { color: #667eea; }

        .temp-hint {
          font-weight: normal;
          color: #a0a0b0;
          font-size: 0.75rem;
          margin-left: 4px;
        }

        /* Generate Button */
        .btn-generate {
          width: 100%;
          padding: 16px;
          font-size: 1rem;
          border-radius: 12px;
          background: linear-gradient(135deg, #667eea, #764ba2);
          color: white;
          font-weight: 600;
        }

        .btn-generate:hover:not(:disabled) {
          box-shadow: 0 4px 20px rgba(102, 126, 234, 0.5);
          transform: translateY(-2px);
        }

        .btn-generate:disabled {
          opacity: 0.7;
          cursor: not-allowed;
          transform: none;
        }

        .loading-dots span {
          animation: blink 1.4s infinite both;
        }
        .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
        .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes blink { 0%, 80%, 100% { opacity: 0; } 40% { opacity: 1; } }

        .error-message {
          padding: 12px;
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.4);
          border-radius: 8px;
          color: #ff6b6b;
          font-size: 0.85rem;
        }

        /* Empty State */
        .empty-script-state {
          text-align: center;
          padding: 60px 24px;
          background: #1a1a2e;
          border-radius: 16px;
          border: 2px dashed #333355;
        }

        .empty-script-state .empty-icon {
          font-size: 4rem;
          margin-bottom: 16px;
          opacity: 0.6;
        }

        .empty-script-state h3 {
          font-size: 1.3rem;
          color: #ffffff;
          margin-bottom: 8px;
        }

        .empty-script-state p {
          color: #a0a0b0;
          font-size: 0.9rem;
          max-width: 400px;
          margin: 0 auto 24px;
          line-height: 1.5;
        }

        .feature-highlights {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          max-width: 420px;
          margin: 0 auto;
        }

        .feature-highlight {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          background: #1e1e3f;
          border-radius: 10px;
          border: 1px solid #333355;
          font-size: 0.85rem;
          color: #a0a0b0;
        }

        .fh-icon { font-size: 1.3rem; }

        /* Generating State */
        .generating-state {
          text-align: center;
          padding: 60px 24px;
          background: #1a1a2e;
          border-radius: 16px;
          border: 1px solid #333355;
        }

        .gen-animation {
          display: flex;
          justify-content: center;
          gap: 8px;
          margin-bottom: 20px;
        }

        .gen-dot {
          width: 14px;
          height: 14px;
          background: #667eea;
          border-radius: 50%;
          animation: bounce 1.4s infinite ease-in-out;
        }
        .gen-dot:nth-child(1) { animation-delay: -0.32s; }
        .gen-dot:nth-child(2) { animation-delay: -0.16s; }
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }

        .generating-state h3 {
          color: #ffffff;
          margin-bottom: 8px;
          font-size: 1.2rem;
        }

        .generating-state p {
          color: #a0a0b0;
          font-size: 0.9rem;
          margin-bottom: 24px;
        }

        .gen-steps {
          display: flex;
          flex-direction: column;
          gap: 10px;
          text-align: left;
          max-width: 300px;
          margin: 0 auto;
        }

        .gen-step {
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 0.85rem;
          background: #1e1e3f;
          border: 1px solid #333355;
        }

        .gen-step.done { color: #22c55e; border-color: rgba(34, 197, 94, 0.3); }
        .gen-step.active { color: #667eea; border-color: rgba(102, 126, 234, 0.4); background: rgba(102, 126, 234, 0.1); }
        .gen-step.pending { color: #606080; }

        /* Script Header Card */
        .script-header-card {
          border: 1px solid #22c55e;
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), rgba(34, 197, 94, 0.03));
        }

        .script-stats {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .stat-chip {
          padding: 4px 10px;
          background: rgba(102, 126, 234, 0.2);
          border: 1px solid rgba(102, 126, 234, 0.3);
          border-radius: 20px;
          font-size: 0.75rem;
          color: #a0a0b0;
          font-weight: 500;
        }

        .script-meta {
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          border-top: 1px solid rgba(34, 197, 94, 0.2);
        }

        .script-summary,
        .script-notes {
          font-size: 0.85rem;
          color: #c0c0d0;
          line-height: 1.5;
        }

        .script-actions {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid rgba(34, 197, 94, 0.2);
        }

        .script-actions .btn {
          flex: 1;
          justify-content: center;
        }

        /* Scenes List */
        .scenes-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .scene-card {
          background: #1a1a2e;
          border-radius: 12px;
          border: 1px solid #333355;
          overflow: hidden;
          transition: border-color 0.2s;
        }

        .scene-card:hover {
          border-color: #444477;
        }

        .scene-card.active {
          border-color: #667eea;
          box-shadow: 0 0 20px rgba(102, 126, 234, 0.15);
        }

        .scene-card-header {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 14px 16px;
          cursor: pointer;
          transition: background 0.2s;
        }

        .scene-card-header:hover {
          background: rgba(102, 126, 234, 0.08);
        }

        .scene-number {
          width: 36px;
          height: 36px;
          background: linear-gradient(135deg, #667eea, #764ba2);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 0.9rem;
          color: white;
          flex-shrink: 0;
        }

        .scene-info {
          flex: 1;
          min-width: 0;
        }

        .scene-title {
          font-weight: 600;
          font-size: 0.95rem;
          color: #ffffff;
          margin-bottom: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .scene-meta-row {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 0.75rem;
        }

        .scene-duration {
          color: #22c55e;
          font-weight: 600;
          flex-shrink: 0;
        }

        .scene-desc-short {
          color: #a0a0b0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .scene-toggle {
          color: #a0a0b0;
          font-size: 0.8rem;
          flex-shrink: 0;
        }

        .scene-card-body {
          padding: 0 16px 16px;
          border-top: 1px solid #2a2a4a;
          display: flex;
          flex-direction: column;
          gap: 12px;
          animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        /* Scene Fields */
        .scene-field {
          background: #16162a;
          border-radius: 10px;
          border: 1px solid #2a2a4a;
          overflow: hidden;
        }

        .field-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: #1e1e3f;
          border-bottom: 1px solid #2a2a4a;
        }

        .field-label {
          font-size: 0.8rem;
          font-weight: 600;
          color: #a0a0b0;
        }

        .copy-btn {
          padding: 3px 10px;
          background: rgba(102, 126, 234, 0.2);
          border: 1px solid rgba(102, 126, 234, 0.3);
          border-radius: 6px;
          color: #667eea;
          font-size: 0.75rem;
          cursor: pointer;
          transition: all 0.2s;
          font-weight: 500;
        }

        .copy-btn:hover {
          background: rgba(102, 126, 234, 0.3);
          border-color: #667eea;
        }

        .copy-btn.copied {
          background: rgba(34, 197, 94, 0.2);
          border-color: rgba(34, 197, 94, 0.4);
          color: #22c55e;
        }

        .field-content {
          padding: 10px 12px;
          font-size: 0.88rem;
          color: #d0d0e0;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .image-prompt-field .field-header {
          background: rgba(102, 126, 234, 0.1);
        }

        .image-prompt-field .field-label {
          color: #8b8bc0;
        }

        .image-prompt-text {
          color: #b0b0d0;
          font-family: 'SF Mono', 'Consolas', monospace;
          font-size: 0.82rem;
        }

        .tts-field .field-header {
          background: rgba(34, 197, 94, 0.08);
        }

        .tts-text {
          color: #e0e8d0;
        }

        /* Scene Extras */
        .scene-extras {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px 12px;
          background: #16162a;
          border-radius: 8px;
          border: 1px solid #2a2a4a;
        }

        .scene-extra-item {
          display: flex;
          gap: 8px;
          font-size: 0.8rem;
          line-height: 1.5;
        }

        .extra-label {
          color: #a0a0b0;
          font-weight: 500;
          flex-shrink: 0;
        }

        .extra-value {
          color: #c0c0d0;
        }

        /* Scrollbar */
        .script-generator-tab::-webkit-scrollbar,
        .scenes-list::-webkit-scrollbar {
          width: 8px;
        }

        .script-generator-tab::-webkit-scrollbar-track,
        .scenes-list::-webkit-scrollbar-track {
          background: #1a1a2e;
        }

        .script-generator-tab::-webkit-scrollbar-thumb,
        .scenes-list::-webkit-scrollbar-thumb {
          background: #333355;
          border-radius: 4px;
        }

        .script-generator-tab::-webkit-scrollbar-thumb:hover,
        .scenes-list::-webkit-scrollbar-thumb:hover {
          background: #444477;
        }

        @media (max-width: 900px) {
          .script-gen-grid {
            grid-template-columns: 1fr;
          }
        }

        .toggle-label {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          font-size: 0.85rem;
          color: #ccc;
        }

        .toggle-label input[type="checkbox"] {
          width: 16px;
          height: 16px;
          accent-color: #7c6fcd;
        }

        .toggle-label:hover {
          color: #fff;
        }
      `}</style>
    </div>
  );
}
