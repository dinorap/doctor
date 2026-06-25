import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import type { Profile, VideoProject, VideoPipeline, SceneData, SceneAsset, CharacterRef } from '../types';
import VideoProjectEditor from './VideoProjectEditor';
import CharacterReferencePanel from './CharacterReferencePanel';
import GlobalReferences from './GlobalReferences';
import '../styles/App.css';

export default function VideoProjectTab({ profiles, onOpenProfile }: { profiles: Profile[]; onOpenProfile: (id: string, openFlow?: boolean) => void }) {
    const [projects, setProjects] = useState<(VideoProject | VideoPipeline)[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [projectName, setProjectName] = useState('');
    const [showCreateModal, setShowCreateModal] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            const pipelines = await api.getPipelines();
            const videoProjects: VideoProject[] = pipelines.map((p: any) => {
                const scenes = (p.scenes || []).map((s: any) => ({
                    sceneIndex: s.sceneIndex || s.scene_id || 0,
                    prompt: s.video_prompt || s.prompt || '',
                    negativePrompt: s.negative_prompt || '',
                    duration: s.duration || '8s',
                    characters: s.characters || [],
                    assets: [],
                    status: s.status === 'done' ? 'completed' : (s.status || 'pending'),
                    progress: s.progress,
                }));
                return {
                    id: p.id,
                    name: p.name,
                    scriptId: p.scriptId,
                    profileIds: typeof p.profileIds === 'string' ? JSON.parse(p.profileIds) : [],
                    scenes,
                    globalReferences: [],
                    createdAt: p.createdAt,
                    updatedAt: p.updatedAt,
                };
            });
            setProjects(videoProjects);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        const id = setInterval(load, 5000);
        return () => clearInterval(id);
    }, []);

    const handleCreateProject = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!projectName.trim()) return;
        setLoading(true);
        try {
            const script = {
                id: `script-${Date.now()}`,
                name: projectName,
                scenes: [
                    { scene_id: 1, video_prompt: 'Scene 1', characters: [] },
                    { scene_id: 2, video_prompt: 'Scene 2', characters: [] },
                ],
            };
            const payload = {
                name: projectName,
                scriptId: script.id,
                selectedProfileIds: profiles.slice(0, 2).map(p => p.id),
                outputFolder: `output/${script.id}`,
                scenes: script.scenes.map((s: any, idx: number) => ({
                    sceneIndex: s.scene_id ?? idx + 1,
                    name: s.scene_title || '',
                    description: s.visual_prompt || '',
                    imagePrompt: s.visual_prompt,
                    entityId: s.entityId,
                })),
            };
            const pipeline = await api.createPipeline(payload);
            setProjects(prev => [pipeline, ...prev]);
            setProjectName('');
            setShowCreateModal(false);
        } catch (e) {
            alert(String(e instanceof Error ? e.message : e));
        } finally {
            setLoading(false);
        }
    };

    const handleOpenProject = (projectId: string) => {
        setSelectedProjectId(projectId);
    };

    const handleBackToProjects = () => {
        setSelectedProjectId(null);
        load();
    };

    const handleRunProject = async (sceneIndexes?: number[]) => {
        if (!selectedProjectId) return;
        try {
            await api.startPipeline(selectedProjectId);
        } catch (e) {
            console.error(e);
        }
    };

    const handleSaveProject = (updated: VideoProject) => {
        setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
    };

    if (selectedProjectId) {
        const project = projects.find(p => p.id === selectedProjectId);
        if (!project) return <div className="tab-content">Project not found</div>;
        return (
            <div className="tab-content">
                <VideoProjectEditor
                    project={project as VideoProject}
                    onBack={handleBackToProjects}
                    onRun={handleRunProject}
                    onSave={handleSaveProject}
                />
            </div>
        );
    }

    return (
        <div className="tab-content">
            <div className="video-projects-header">
                <div className="header-left">
                    <h2>🎬 Video Projects</h2>
                    <p className="header-subtitle">Create and manage multi-scene video generation projects</p>
                </div>
                <button className="btn btn-success" onClick={() => setShowCreateModal(true)}>
                    + New Project
                </button>
            </div>

            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>Create Video Project</h3>
                            <button className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>×</button>
                        </div>
                        <form onSubmit={handleCreateProject}>
                            <div className="modal-body">
                                <div className="form-group">
                                    <label>Project Name</label>
                                    <input
                                        type="text"
                                        value={projectName}
                                        onChange={e => setProjectName(e.target.value)}
                                        placeholder="My Video Project"
                                        autoFocus
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Profiles ({profiles.length} available)</label>
                                    <div className="selected-profiles">
                                        {profiles.slice(0, 5).map(p => (
                                            <div key={p.id} className="profile-chip">
                                                <span>{p.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={loading || !projectName.trim()}>
                                    {loading ? 'Creating...' : 'Create Project'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {loading && projects.length === 0 && <div className="empty-state">Loading projects...</div>}
            {!loading && projects.length === 0 && (
                <div className="empty-state">
                    <p>No video projects yet.</p>
                    <p>Click "New Project" to create your first video project.</p>
                </div>
            )}

            <div className="video-projects-grid">
                {(projects as VideoProject[]).filter((p): p is VideoProject => 'scenes' in p).map(project => (
                    <div
                        key={project.id}
                        className="video-project-card"
                        onClick={() => handleOpenProject(project.id)}
                    >
                        <div className="video-project-card-header">
                            <div className="video-project-icon">🎬</div>
                            <div className="video-project-info">
                                <div className="video-project-name">{project.name}</div>
                                <div className="video-project-meta">
                                    {project.scenes.length} scenes • {project.profileIds.length} profiles
                                </div>
                            </div>
                        </div>
                        <div className="video-project-footer">
                            <span className="video-project-date">
                                {new Date(project.updatedAt).toLocaleDateString()}
                            </span>
                            <button className="btn btn-sm btn-primary">Open Editor</button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
