import React, { useRef, useState } from 'react';
import type { Profile, InputMode } from './types';
import { LANGUAGES, GEMINI_MODELS } from './types';

interface ScriptInputPanelProps {
  profiles: Profile[];
  projectNames: string[];
  selectedProjectName: string;
  onProjectChange: (name: string) => void;
  selectedProfileIdx: number;
  onProfileIdxChange: (idx: number) => void;
  
  inputMode: InputMode;
  onInputModeChange: (mode: InputMode) => void;
  youtubeUrl: string;
  onYoutubeUrlChange: (url: string) => void;
  topic: string;
  onTopicChange: (topic: string) => void;
  uploadedFiles: File[];
  onUploadedFilesChange: (files: File[]) => void;
  
  language: string;
  onLanguageChange: (lang: string) => void;
  storytellingMode: string;
  onStorytellingModeChange: (mode: string) => void;
  durationMinutes: number;
  onDurationMinutesChange: (mins: number) => void;
  copyRatio: number;
  onCopyRatioChange: (ratio: number) => void;
  additionalDesc: string;
  onAdditionalDescChange: (desc: string) => void;
  temperature: number;
  onTemperatureChange: (temp: number) => void;
  noVoice: boolean;
  onNoVoiceChange: (noVoice: boolean) => void;
  noMusic: boolean;
  onNoMusicChange: (noMusic: boolean) => void;
  
  geminiApiKeys: string;
  onGeminiApiKeysChange: (keys: string) => void;
  geminiModel: string;
  onGeminiModelChange: (model: string) => void;
  onSaveSettings: () => void;
  settingsSaved: boolean;
  
  onGenerate: () => void;
  generating: boolean;
}

export function ScriptInputPanel({
  profiles,
  projectNames,
  selectedProjectName,
  onProjectChange,
  selectedProfileIdx,
  onProfileIdxChange,
  inputMode,
  onInputModeChange,
  youtubeUrl,
  onYoutubeUrlChange,
  topic,
  onTopicChange,
  uploadedFiles,
  onUploadedFilesChange,
  language,
  onLanguageChange,
  storytellingMode,
  onStorytellingModeChange,
  durationMinutes,
  onDurationMinutesChange,
  copyRatio,
  onCopyRatioChange,
  additionalDesc,
  onAdditionalDescChange,
  temperature,
  onTemperatureChange,
  noVoice,
  onNoVoiceChange,
  noMusic,
  onNoMusicChange,
  geminiApiKeys,
  onGeminiApiKeysChange,
  geminiModel,
  onGeminiModelChange,
  onSaveSettings,
  settingsSaved,
  onGenerate,
  generating,
}: ScriptInputPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Build selectedEntries for multi-profile display
  const projectGroups: Record<string, { profile: Profile; projectIdx: number }[]> = {};
  profiles.forEach((profile) => {
    const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
    flowProjects.forEach((proj, idx) => {
      const name = proj.name || `Project ${idx + 1}`;
      if (!projectGroups[name]) projectGroups[name] = [];
      projectGroups[name].push({ profile, projectIdx: idx });
    });
  });
  const selectedEntries = projectGroups[selectedProjectName] || [];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    onUploadedFilesChange(files);
  };

  return (
    <div className="script-gen-left">
      {/* Project Selection */}
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
          <select
            className="form-input"
            value={selectedProjectName}
            onChange={(e) => {
              onProjectChange(e.target.value);
              onProfileIdxChange(0);
            }}
          >
            {projectNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {selectedEntries.length > 1 && (
            <select
              className="form-input"
              value={selectedProfileIdx}
              onChange={(e) => onProfileIdxChange(Number(e.target.value))}
            >
              {selectedEntries.map((entry, idx) => (
                <option key={idx} value={idx}>
                  {entry.profile.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Input Mode Selection */}
      <div className="profile-card">
        <div className="profile-header">
          <div className="profile-title">
            <div className="profile-avatar">📥</div>
            <div>
              <div className="profile-name">Input Source</div>
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
                onClick={() => onInputModeChange(tab.id as InputMode)}
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
                onChange={e => onTopicChange(e.target.value)}
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
                onChange={e => onYoutubeUrlChange(e.target.value)}
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
                    onChange={e => onCopyRatioChange(Number(e.target.value))}
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
                          onUploadedFilesChange(uploadedFiles.filter((_, idx) => idx !== i));
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

          {/* Settings Divider */}
          <div className="settings-divider" />

          {/* Gemini API Keys */}
          <div className="form-group">
            <label className="form-label">Gemini API Key</label>
            <input
              type="password"
              className="form-input"
              placeholder="AI..."
              value={geminiApiKeys}
              onChange={e => onGeminiApiKeysChange(e.target.value)}
            />
            <div className="input-hint">API key để gọi Gemini (nếu không có sẽ dùng mặc định)</div>
          </div>

          {/* Gemini Model */}
          <div className="form-group">
            <label className="form-label">Model</label>
            <select
              className="form-input"
              value={geminiModel}
              onChange={e => onGeminiModelChange(e.target.value)}
            >
              {GEMINI_MODELS.map(m => (
                <option key={m.value} value={m.value}>
                  {m.icon} {m.label} - {m.desc}
                </option>
              ))}
            </select>
          </div>

          {/* Save Settings Button */}
          <button
            className="btn btn-secondary"
            style={{ width: '100%', marginBottom: 16 }}
            onClick={onSaveSettings}
          >
            {settingsSaved ? '✓ Đã lưu!' : '💾 Lưu cài đặt'}
          </button>

          {/* Language */}
          <div className="form-group">
            <label className="form-label">Ngôn ngữ</label>
            <select
              className="form-input"
              value={language}
              onChange={e => onLanguageChange(e.target.value)}
            >
              {LANGUAGES.map(l => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>

          {/* Storytelling Mode */}
          <div className="form-group">
            <label className="form-label">Chế độ kể chuyện</label>
            <select
              className="form-input"
              value={storytellingMode}
              onChange={e => onStorytellingModeChange(e.target.value)}
            >
              <option value="auto">Tự động</option>
              <option value="narration">Hướng dẫn (Narrator)</option>
              <option value="dialogue">Đối thoại (Dialogue)</option>
              <option value="mixed">Kết hợp</option>
            </select>
          </div>

          {/* Duration */}
          <div className="form-group">
            <label className="form-label">Thời lượng video (phút)</label>
            <input
              type="number"
              className="form-input"
              min="1"
              max="60"
              value={durationMinutes}
              onChange={e => onDurationMinutesChange(Number(e.target.value))}
            />
          </div>

          {/* Temperature */}
          <div className="form-group">
            <label className="form-label">Sáng tạo (Temperature): {temperature}</label>
            <input
              type="range"
              className="form-input"
              min="0.1"
              max="1"
              step="0.1"
              value={temperature}
              onChange={e => onTemperatureChange(Number(e.target.value))}
            />
            <div className="input-hint">Cao = sáng tạo hơn, Thấp = nhất quán hơn</div>
          </div>

          {/* Options */}
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={noVoice}
                onChange={e => onNoVoiceChange(e.target.checked)}
              />
              Không tạo script TTS (không có lời bình)
            </label>
          </div>

          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={noMusic}
                onChange={e => onNoMusicChange(e.target.checked)}
              />
              Không tạo nhạc nền
            </label>
          </div>

          {/* Additional Description */}
          <div className="form-group">
            <label className="form-label">Yêu cầu thêm</label>
            <textarea
              className="form-input"
              rows={2}
              placeholder="VD: Style hoạt hình, màu sắc tươi sáng..."
              value={additionalDesc}
              onChange={e => onAdditionalDescChange(e.target.value)}
            />
          </div>

          {/* Generate Button */}
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={onGenerate}
            disabled={generating || (!topic.trim() && !youtubeUrl.trim())}
          >
            {generating ? (
              <>
                <span className="loading-spinner" /> Đang sinh...
              </>
            ) : (
              <>🎬 Sinh kịch bản</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
