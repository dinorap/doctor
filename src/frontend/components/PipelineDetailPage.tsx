import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../services/api';
import type { VideoPipeline, PipelineStatusResponse, SceneTask } from '../types';
import StatusProgressBar, { StatusType } from './StatusProgressBar';

export default function PipelineDetailPage({ pipelineId, onBack }: { pipelineId: string; onBack: () => void }) {
  const [pipeline, setPipeline] = useState<VideoPipeline | null>(null);
  const [status, setStatus] = useState<PipelineStatusResponse | null>(null);
  const [scenes, setScenes] = useState<SceneTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showJson, setShowJson] = useState(false);
  const [jsonOutput, setJsonOutput] = useState<string>('');
  const [showFinalize, setShowFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalOutput, setFinalOutput] = useState<any | null>(null);
  const [finalizeForm, setFinalizeForm] = useState({
    mode: 'concat',
    transition: 'none',
    transitionDurationSeconds: 1,
    originalAudioVolumePercent: 100,
    musicPath: '',
    musicVolume: 0.2,
    logoPath: '',
    logoWidth: 200,
    logoHeight: null as number | null,
    logoPosition: 'bottom-right',
    logoXPercent: 0,
    logoYPercent: 0,
    logoZoomPercent: 100,
    textOverlay: '',
    textBgOpacityPercent: 0,
  });

  const load = async () => {
    setLoading(true);
    try {
      const [p, s, t] = await Promise.all([
        api.getPipeline(pipelineId),
        api.getPipelineStatus(pipelineId),
        api.getPipelineScenes(pipelineId),
      ]);
      setPipeline(p);
      setStatus(s);
      setScenes(t);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [pipelineId]);

  const handleStart = async () => {
    try {
      const uploadResult = await api.uploadReferenceImages(pipelineId);
      if (uploadResult.totalImages > 0) {
        console.log(`Uploaded ${uploadResult.successfulUploads.length}/${uploadResult.totalImages * uploadResult.totalProfiles} reference images`);
      }
    } catch (e) {
      console.warn('Reference image upload failed, proceeding without:', e);
    }
    await api.startPipeline(pipelineId);
    load();
  };

  const handlePause = async () => {
    await api.pausePipeline(pipelineId);
    load();
  };

  const handleStop = async () => {
    if (!confirm('Dừng pipeline?')) return;
    await api.stopPipeline(pipelineId);
    load();
  };

  const handleRetry = async () => {
    await api.retryPipeline(pipelineId);
    load();
  };

  const handleRetryCaptcha = async () => {
    const result = await api.retryCaptchaErrors(pipelineId);
    if (result.retriedCount > 0) {
      load();
    } else {
      alert('Không có task nào bị captcha để retry');
    }
  };

  const handleDelete = async () => {
    if (!confirm('Xóa pipeline?')) return;
    await api.deletePipeline(pipelineId);
    onBack();
  };

  const handleShowJson = async () => {
    if (showJson) {
      setShowJson(false);
      return;
    }
    try {
      const p = await api.getPipeline(pipelineId);
      const t = await api.getPipelineScenes(pipelineId);
      const output = {
        meta: {
          title: p.name,
          total_scenes: p.totalScenes,
          created_at: p.createdAt,
          updated_at: p.updatedAt,
        },
        scenes: t.map(task => {
          const sceneData: any = (() => { try { return JSON.parse(task.sceneData); } catch { return {}; } })();
          return {
            scene_id: task.sceneIndex,
            video_prompt: String(sceneData?.visual_prompt || sceneData?.prompt || ''),
            tts_script: String(sceneData?.tts_script || sceneData?.narration || ''),
            status: task.status === 'completed' ? 'done' : task.status,
            video_url: task.videoUrl || undefined,
            image_url: task.imageUrl || undefined,
            character: sceneData?.character || undefined,
            assigned_profile_id: task.assignedProfileId || undefined,
            generated_at: task.completedAt || undefined,
            error: task.error || undefined,
          };
        }),
        is_setting_up: false,
        is_running: p.status === 'processing',
        is_retrying: false,
        last_updated: Date.now(),
        tts_completed: false,
        video_completed: p.completedScenes === p.totalScenes && p.failedScenes === 0,
        run_error_message: p.errorMessage || undefined,
      };
      setJsonOutput(JSON.stringify(output, null, 2));
      setShowJson(true);
    } catch (e) {
      console.error(e);
    }
  };

  const handleLoadFinalOutput = async () => {
    try {
      const data = await api.getFinalOutput(pipelineId);
      setFinalOutput(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFinalAssemble = async () => {
    setFinalizing(true);
    try {
      const payload = {
        ...finalizeForm,
        mode: finalizeForm.mode as 'concat' | 'xfade',
        logoHeight: finalizeForm.logoHeight ?? undefined,
        musicPath: finalizeForm.musicPath || undefined,
        logoPath: finalizeForm.logoPath || undefined,
        textOverlay: finalizeForm.textOverlay || undefined,
      };
      const result = await api.finalAssemblePipeline(pipelineId, payload);
      alert(`Final assemble hoàn tất: ${result.finalVideoFileName}`);
      await handleLoadFinalOutput();
      load();
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    } finally {
      setFinalizing(false);
    }
  };

  const captchaTasks = useMemo(() => scenes.filter(t => t.status === 'failed' && /captcha|blocked|verify/i.test(t.error || '')), [scenes]);
  const progress = status && status.totalScenes > 0
    ? Math.round(((status.completedScenes + status.failedScenes) / status.totalScenes) * 100)
    : 0;

  const statusLabel: Record<string, string> = {
    pending: '⏳ Chưa chạy',
    processing: '🔄 Đang xử lý',
    paused: '⏸️ Tạm dừng',
    completed: '✅ Hoàn thành',
    failed: '❌ Lỗi',
  };

  if (loading && !pipeline) return <div className="tab-content">Đang tải...</div>;
  if (!pipeline) return <div className="tab-content">Pipeline not found</div>;

  return (
    <div className="tab-content">
      <div className="pipeline-detail-header">
        <button className="btn btn-ghost" onClick={onBack}>← Back</button>
        <h2>{pipeline.name}</h2>
        <div className="pipeline-actions">
          {pipeline.status === 'pending' && <button className="btn btn-success" onClick={handleStart}>▶️ Start</button>}
          {pipeline.status === 'processing' && <button className="btn btn-ghost" onClick={handlePause}>⏸️ Pause</button>}
          {pipeline.status === 'paused' && <button className="btn btn-success" onClick={handleStart}>▶️ Resume</button>}
          {(pipeline.status === 'processing' || pipeline.status === 'paused') && <button className="btn btn-danger" onClick={handleStop}>⏹️ Stop</button>}
          {(pipeline.status === 'completed' || pipeline.status === 'failed') && <button className="btn btn-primary" onClick={handleRetry}>🔄 Retry All</button>}
          {captchaTasks.length > 0 && <button className="btn btn-warning" onClick={handleRetryCaptcha}>🔓 Retry Captcha ({captchaTasks.length})</button>}
          <button className="btn btn-ghost" onClick={handleShowJson}>📊 JSON</button>
          <button className="btn btn-primary" onClick={() => setShowFinalize(s => !s)}>🎬 Final Assemble</button>
          <button className="btn btn-danger" onClick={handleDelete}>🗑️ Delete</button>
        </div>
      </div>

      <div className="pipeline-status-badge">
        <span className={`badge badge-${pipeline.status}`}>{statusLabel[pipeline.status] ?? pipeline.status}</span>
      </div>

      <div className="pipeline-stats">
        <div className="stat-box">
          <div className="stat-value">{status?.completedScenes ?? 0}/{pipeline.totalScenes}</div>
          <div className="stat-label">Hoàn thành</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{progress}%</div>
          <div className="stat-label">Tiến độ</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{status?.failedScenes ?? 0}</div>
          <div className="stat-label">Thất bại</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{scenes.filter(t => t.status === 'generating' || t.status === 'assigned').length}</div>
          <div className="stat-label">Đang xử lý</div>
        </div>
      </div>

      <div className="pipeline-progress-bar">
        <div className="progress-bar large">
          <div className="progress-fill" style={{ width: progress + '%' }} />
          <div className="progress-text">{progress}%</div>
        </div>
      </div>

      {showFinalize && (
        <div className="finalize-panel">
          <h3>Final Assemble</h3>
          <div className="finalize-form">
            <div className="form-row">
              <label>Mode</label>
              <select value={finalizeForm.mode} onChange={e => setFinalizeForm({ ...finalizeForm, mode: e.target.value })}>
                <option value="concat">Concat</option>
                <option value="xfade">Xfade</option>
              </select>
            </div>
            <div className="form-row">
              <label>Transition</label>
              <select value={finalizeForm.transition} onChange={e => setFinalizeForm({ ...finalizeForm, transition: e.target.value })}>
                <option value="none">None</option>
                <option value="fade">Fade</option>
                <option value="dissolve">Dissolve</option>
                <option value="slideleft">Slide Left</option>
                <option value="slideright">Slide Right</option>
                <option value="zoomin">Zoom In</option>
              </select>
            </div>
            <div className="form-row">
              <label>Original Audio %</label>
              <input type="number" min="0" max="100" value={finalizeForm.originalAudioVolumePercent} onChange={e => setFinalizeForm({ ...finalizeForm, originalAudioVolumePercent: Number(e.target.value) })} />
            </div>
            <div className="form-row">
              <label>Music Path</label>
              <input value={finalizeForm.musicPath} onChange={e => setFinalizeForm({ ...finalizeForm, musicPath: e.target.value })} placeholder="/absolute/path/music.mp3" />
            </div>
            <div className="form-row">
              <label>Music Volume</label>
              <input type="number" min="0" max="1" step="0.1" value={finalizeForm.musicVolume} onChange={e => setFinalizeForm({ ...finalizeForm, musicVolume: Number(e.target.value) })} />
            </div>
            <div className="form-row">
              <label>Logo Path</label>
              <input value={finalizeForm.logoPath} onChange={e => setFinalizeForm({ ...finalizeForm, logoPath: e.target.value })} placeholder="/absolute/path/logo.png" />
            </div>
            <div className="form-row">
              <label>Logo Width</label>
              <input type="number" min="0" value={finalizeForm.logoWidth} onChange={e => setFinalizeForm({ ...finalizeForm, logoWidth: Number(e.target.value) })} />
            </div>
            <div className="form-row">
              <label>Logo Position</label>
              <select value={finalizeForm.logoPosition} onChange={e => setFinalizeForm({ ...finalizeForm, logoPosition: e.target.value })}>
                <option value="bottom-right">Bottom Right</option>
                <option value="bottom-left">Bottom Left</option>
                <option value="top-left">Top Left</option>
                <option value="top-right">Top Right</option>
              </select>
            </div>
            <div className="form-row">
              <label>Text Overlay</label>
              <input value={finalizeForm.textOverlay} onChange={e => setFinalizeForm({ ...finalizeForm, textOverlay: e.target.value })} placeholder="Text to overlay" />
            </div>
            <div className="form-actions">
              <button className="btn btn-success" disabled={finalizing} onClick={handleFinalAssemble}>{finalizing ? 'Đang xử lý...' : 'Chạy Final Assemble'}</button>
              <button className="btn btn-ghost" onClick={handleLoadFinalOutput}>Tải thông tin output</button>
            </div>
          </div>

          {finalOutput && (
            <div className="finalize-output">
              <h4>Output</h4>
              <div>Status: {finalOutput.status}</div>
              <div>Final video: {finalOutput.finalVideoPath ? <a href={finalOutput.finalVideoPath} target="_blank" rel="noreferrer">{finalOutput.finalVideoPath}</a> : 'Chưa có'}</div>
              <pre>{JSON.stringify(finalOutput.finalize, null, 2)}</pre>
            </div>
          )}
        </div>
      )}

      {showJson && (
        <div className="json-viewer">
          <div className="json-header">
            <h3>JSON Output</h3>
            <button className="btn btn-ghost" onClick={handleShowJson}>Đóng</button>
          </div>
          <pre className="json-content">{jsonOutput}</pre>
        </div>
      )}

      <div className="scenes-list">
        <h3>Scenes ({scenes.length})</h3>
        {scenes.map(task => {
          const sceneData: any = (() => { try { return JSON.parse(task.sceneData); } catch { return {}; } })();
          const isCaptcha = /captcha|blocked|verify/i.test(task.error || '');
          return (
            <div key={task.id} className={`scene-card scene-${task.status}${isCaptcha ? ' scene-captcha' : ''}`}>
              <div className="scene-header">
                <strong>Scene {task.sceneIndex}</strong>
                <span className={`scene-status scene-${task.status}`}>
                  {task.status === 'generating' ? `🔄 ${task.progress}%` : task.status}
                </span>
              </div>
              <div className="scene-body">
                <div className="scene-prompt">{String(sceneData?.visual_prompt || sceneData?.prompt || '')}</div>
                <div className="scene-meta">
                  <span>Profile: {task.assignedProfileId || 'unassigned'}</span>
                  {task.progress > 0 && task.progress < 100 && <span>Progress: {task.progress}%</span>}
                </div>
                <StatusProgressBar
                  status={(task.status as StatusType) || 'pending'}
                  progress={task.progress}
                  size="medium"
                />
                {task.videoUrl && <div className="scene-result">✅ Video: {task.videoUrl}</div>}
                {task.imageUrl && <div className="scene-result">🖼️ Image: {task.imageUrl}</div>}
                {task.error && <div className={`scene-error ${isCaptcha ? 'captcha-error' : ''}`}>
                  {isCaptcha && '🔓 '}<strong>Error:</strong> {task.error}
                </div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
