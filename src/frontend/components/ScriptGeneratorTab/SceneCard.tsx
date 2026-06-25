import React, { useState } from 'react';
import type { ScriptScene } from './types';
import { api } from '../../services/api';

interface SceneCardProps {
  scene: ScriptScene;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  selectedScriptId: string | null;
}

export function SceneCard({ scene, index, isExpanded, onToggle, selectedScriptId }: SceneCardProps) {
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState({
    scene_title: scene.scene_title || '',
    visual_prompt: scene.visual_prompt || '',
    tts_script: scene.tts_script || '',
  });
  const [saving, setSaving] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    }
  };

  const handleSave = async () => {
    if (!selectedScriptId) return;
    setSaving(true);
    try {
      await api.updateScriptScene({
        scriptId: selectedScriptId,
        scenes: [{
          scene_id: scene.scene_id,
          scene_title: editFields.scene_title || undefined,
          visual_prompt: editFields.visual_prompt || undefined,
          tts_script: editFields.tts_script || undefined,
        }],
      });
      setEditing(false);
    } catch (err) {
      console.error('Failed to save scene:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scene-card">
      <div className="scene-card-header" onClick={onToggle}>
        <div className="scene-number">{scene.scene_id}</div>
        <div className="scene-info">
          <div className="scene-title">{editing ? editFields.scene_title : scene.scene_title}</div>
          <div className="scene-meta-row">
            <span className="scene-duration">⏱ {scene.duration_seconds}s</span>
            <span className="scene-desc-short">
              {(editing ? editFields.visual_prompt : scene.visual_prompt).slice(0, 60)}
              {(editing ? editFields.visual_prompt : scene.visual_prompt).length > 60 ? '...' : ''}
            </span>
          </div>
        </div>
        <div className="scene-actions">
          {!editing ? (
            <>
              <button
                className="btn btn-xs btn-secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                disabled={!selectedScriptId}
                title="Sửa scene"
              >
                ✏️
              </button>
              <button
                className="btn btn-xs btn-secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  copyToClipboard(JSON.stringify(scene, null, 2), 'json');
                }}
                title="Copy JSON"
              >
                📋
              </button>
            </>
          ) : (
            <span className="scene-saving">{saving ? 'Đang lưu...' : 'Đang sửa'}</span>
          )}
          <div className="scene-toggle">{isExpanded ? '▲' : '▼'}</div>
        </div>
      </div>

      {isExpanded && (
        <div className="scene-card-body">
          {editing ? (
            <>
              <div className="scene-field">
                <div className="field-header">
                  <span className="field-label">📝 Tiêu đề cảnh</span>
                </div>
                <input
                  className="form-input scene-edit-input"
                  value={editFields.scene_title}
                  onChange={e => setEditFields(prev => ({ ...prev, scene_title: e.target.value }))}
                />
              </div>

              <div className="scene-field">
                <div className="field-header">
                  <span className="field-label">🖼️ Visual Prompt</span>
                  <button
                    className="btn btn-xs btn-secondary"
                    onClick={() => copyToClipboard(editFields.visual_prompt, 'visual')}
                  >
                    {copiedField === 'visual' ? '✓' : '📋'}
                  </button>
                </div>
                <textarea
                  className="form-input scene-edit-textarea"
                  value={editFields.visual_prompt}
                  onChange={e => setEditFields(prev => ({ ...prev, visual_prompt: e.target.value }))}
                  rows={3}
                />
              </div>

              <div className="scene-field">
                <div className="field-header">
                  <span className="field-label">🔊 TTS Script</span>
                  <button
                    className="btn btn-xs btn-secondary"
                    onClick={() => copyToClipboard(editFields.tts_script, 'tts')}
                  >
                    {copiedField === 'tts' ? '✓' : '📋'}
                  </button>
                </div>
                <textarea
                  className="form-input scene-edit-textarea"
                  value={editFields.tts_script}
                  onChange={e => setEditFields(prev => ({ ...prev, tts_script: e.target.value }))}
                  rows={3}
                />
              </div>

              <div className="scene-field-buttons">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setEditing(false);
                    setEditFields({
                      scene_title: scene.scene_title || '',
                      visual_prompt: scene.visual_prompt || '',
                      tts_script: scene.tts_script || '',
                    });
                  }}
                >
                  Hủy
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Đang lưu...' : '💾 Lưu'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="scene-field">
                <div className="field-header">
                  <span className="field-label">🖼️ Visual Prompt</span>
                  <button
                    className="btn btn-xs btn-secondary"
                    onClick={() => copyToClipboard(scene.visual_prompt, 'visual')}
                  >
                    {copiedField === 'visual' ? '✓' : '📋'}
                  </button>
                </div>
                <div className="field-content">{scene.visual_prompt}</div>
              </div>

              <div className="scene-field">
                <div className="field-header">
                  <span className="field-label">🔊 TTS Script</span>
                  <button
                    className="btn btn-xs btn-secondary"
                    onClick={() => copyToClipboard(scene.tts_script, 'tts')}
                  >
                    {copiedField === 'tts' ? '✓' : '📋'}
                  </button>
                </div>
                <div className="field-content">{scene.tts_script}</div>
              </div>

              {scene.characters && scene.characters.length > 0 && (
                <div className="scene-field">
                  <div className="field-label">🎭 Characters</div>
                  <div className="field-content scene-characters">
                    {scene.characters.map((char, i) => (
                      <span key={i} className="character-tag">{char}</span>
                    ))}
                  </div>
                </div>
              )}

              {scene.transition && (
                <div className="scene-field">
                  <div className="field-label">➡️ Chuyển cảnh</div>
                  <div className="field-content">{scene.transition}</div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
