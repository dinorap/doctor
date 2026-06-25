import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../services/api';
import type { VideoPipeline, PipelineStatusResponse, SceneTask } from '../types';

function PipelineCard({ pipeline, onClick }: { pipeline: VideoPipeline; onClick: (id: string) => void }) {
  const [status, setStatus] = useState<PipelineStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await api.getPipelineStatus(pipeline.id);
        if (!cancelled) setStatus(s);
      } catch {
        // ignore
      }
    };
    load();
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pipeline.id]);

  const progress = useMemo(() => {
    if (!status) return 0;
    if (status.totalScenes === 0) return 0;
    return Math.round(((status.completedScenes + status.failedScenes) / status.totalScenes) * 100);
  }, [status]);

  const statusLabel: Record<string, string> = {
    pending: '⏳ Chưa chạy',
    processing: '🔄 Đang xử lý',
    paused: '⏸️ Tạm dừng',
    completed: '✅ Hoàn thành',
    failed: '❌ Lỗi',
  };

  return (
    <div className="pipeline-card" onClick={() => onClick(pipeline.id)}>
      <div className="pipeline-card-header">
        <div>
          <div className="pipeline-name">{pipeline.name}</div>
          <div className="pipeline-meta">
            Scenes: {pipeline.totalScenes} | {statusLabel[pipeline.status] ?? pipeline.status}
          </div>
        </div>
        <div className="pipeline-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: progress + '%' }} />
          </div>
          <div className="progress-text">{progress}%</div>
        </div>
      </div>
      <div className="pipeline-card-footer">
        <div>Done: {status ? status.completedScenes : 0} | Failed: {status ? status.failedScenes : 0}</div>
        <div className="pipeline-ids">#{pipeline.id.substring(0, 8)}</div>
      </div>
    </div>
  );
}

export default function PipelineTab({ onOpenPipeline }: { onOpenPipeline: (id: string) => void }) {
  const [pipelines, setPipelines] = useState<VideoPipeline[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scriptId, setScriptId] = useState('');
  const [outputFolder, setOutputFolder] = useState('output');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getPipelines();
      setPipelines(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !scriptId) return;
    setCreating(true);
    try {
      const scripts = await api.getScripts();
      const script = scripts.find((s: any) => s.id === scriptId || s.script_id === scriptId);
      if (!script) {
        alert('Script not found');
        return;
      }
      const scenes = Array.isArray(script.scenes) ? script.scenes : [];
      const payload = {
        name,
        scriptId,
        selectedProfileIds: [],
        outputFolder: outputFolder + '/' + scriptId,
        scenes: scenes.map((s: any, idx: number) => ({
          sceneIndex: s.scene_id ?? idx + 1,
          name: s.scene_title || s.scene_id || idx + 1,
          description: s.visual_prompt || '',
          imagePrompt: s.visual_prompt,
          entityId: s.entityId,
        })),
      };
      const pipeline = await api.createPipeline(payload);
      setPipelines(prev => [pipeline, ...prev]);
      setName('');
      setScriptId('');
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="tab-content">
      <div className="pipeline-header">
        <h2>🎬 Pipeline Video</h2>
        <form className="pipeline-create" onSubmit={onCreate}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên pipeline" />
          <input value={scriptId} onChange={e => setScriptId(e.target.value)} placeholder="Script ID" />
          <input value={outputFolder} onChange={e => setOutputFolder(e.target.value)} placeholder="Thư mục output" />
          <button className="btn btn-primary" disabled={creating || !name || !scriptId}>
            {creating ? 'Đang tạo...' : 'Tạo pipeline'}
          </button>
        </form>
      </div>

      {loading && pipelines.length === 0 && <div className="empty-state">Đang tải pipelines...</div>}
      {!loading && pipelines.length === 0 && <div className="empty-state">Chưa có pipeline nào</div>}

      <div className="pipeline-list">
        {pipelines.map(p => (
          <PipelineCard key={p.id} pipeline={p} onClick={onOpenPipeline} />
        ))}
      </div>
    </div>
  );
}
