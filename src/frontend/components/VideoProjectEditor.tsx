import React, { useState } from 'react';
import type { SceneData, SceneAsset, VideoProject } from '../types';
import StatusProgressBar, { StatusType } from './StatusProgressBar';

export default function VideoProjectEditor({ project, onBack, onRun, onSave }: {
    project: VideoProject;
    onBack: () => void;
    onRun: (sceneIndexes?: number[]) => void;
    onSave: (project: VideoProject) => void;
}) {
    const [selectedScenes, setSelectedScenes] = useState<Set<number>>(new Set());
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [searchQuery, setSearchQuery] = useState('');
    const [editingScene, setEditingScene] = useState<SceneData | null>(null);

    const toggleScene = (index: number) => {
        setSelectedScenes(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const selectAll = () => {
        if (selectedScenes.size === project.scenes.length) {
            setSelectedScenes(new Set());
        } else {
            setSelectedScenes(new Set(project.scenes.map(s => s.sceneIndex)));
        }
    };

    const handleRunSelected = () => {
        onRun(Array.from(selectedScenes).sort((a, b) => a - b));
    };

    const handleRunAll = () => {
        onRun(undefined);
    };

    const filteredScenes = project.scenes.filter(scene => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return scene.prompt.toLowerCase().includes(q) ||
            String(scene.sceneIndex).includes(q);
    });

    return (
        <div className="video-project-editor">
            <ProjectToolbar
                projectName={project.name}
                selectedCount={selectedScenes.size}
                totalCount={project.scenes.length}
                viewMode={viewMode}
                searchQuery={searchQuery}
                onBack={onBack}
                onSave={() => onSave(project)}
                onRunAll={handleRunAll}
                onRunSelected={handleRunSelected}
                onSelectAll={selectAll}
                onViewModeChange={setViewMode}
                onSearchChange={setSearchQuery}
            />

            <div className="video-project-body">
                <SceneList
                    scenes={project.scenes}
                    selectedScenes={selectedScenes}
                    onToggleScene={toggleScene}
                    onSelectAll={selectAll}
                    onEditScene={setEditingScene}
                />

                <div className="scene-grid-container">
                    {viewMode === 'grid' ? (
                        <div className="scene-grid">
                            {filteredScenes.map(scene => (
                                <SceneCard
                                    key={scene.sceneIndex}
                                    scene={scene}
                                    selected={selectedScenes.has(scene.sceneIndex)}
                                    onToggle={() => toggleScene(scene.sceneIndex)}
                                    onEdit={() => setEditingScene(scene)}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="scene-list-view">
                            {filteredScenes.map(scene => (
                                <SceneListItem
                                    key={scene.sceneIndex}
                                    scene={scene}
                                    selected={selectedScenes.has(scene.sceneIndex)}
                                    onToggle={() => toggleScene(scene.sceneIndex)}
                                    onEdit={() => setEditingScene(scene)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {editingScene && (
                <SceneEditModal
                    scene={editingScene}
                    onSave={(updated) => {
                        const newScenes = project.scenes.map(s =>
                            s.sceneIndex === updated.sceneIndex ? updated : s
                        );
                        onSave({ ...project, scenes: newScenes });
                        setEditingScene(null);
                    }}
                    onClose={() => setEditingScene(null)}
                />
            )}
        </div>
    );
}

function ProjectToolbar({ projectName, selectedCount, totalCount, viewMode, searchQuery, onBack, onSave, onRunAll, onRunSelected, onSelectAll, onViewModeChange, onSearchChange }: {
    projectName: string;
    selectedCount: number;
    totalCount: number;
    viewMode: 'grid' | 'list';
    searchQuery: string;
    onBack: () => void;
    onSave: () => void;
    onRunAll: () => void;
    onRunSelected: () => void;
    onSelectAll: () => void;
    onViewModeChange: (mode: 'grid' | 'list') => void;
    onSearchChange: (q: string) => void;
}) {
    return (
        <div className="project-toolbar">
            <div className="toolbar-left">
                <button className="btn btn-ghost" onClick={onBack}>← Back</button>
                <h2 className="project-title">{projectName}</h2>
                <span className="scene-count">{totalCount} scenes</span>
            </div>

            <div className="toolbar-center">
                <div className="search-box">
                    <input
                        type="text"
                        placeholder="Search scenes..."
                        value={searchQuery}
                        onChange={e => onSearchChange(e.target.value)}
                    />
                </div>
                <div className="view-toggle">
                    <button
                        className={`btn btn-sm ${viewMode === 'grid' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => onViewModeChange('grid')}
                    >
                        Grid
                    </button>
                    <button
                        className={`btn btn-sm ${viewMode === 'list' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => onViewModeChange('list')}
                    >
                        List
                    </button>
                </div>
            </div>

            <div className="toolbar-right">
                <button className="btn btn-ghost" onClick={onSave}>💾 Save</button>
                {selectedCount > 0 && (
                    <button className="btn btn-primary" onClick={onRunSelected}>
                        ▶️ Run Selected ({selectedCount})
                    </button>
                )}
                <button className="btn btn-success" onClick={onRunAll}>
                    ▶️ Run All
                </button>
            </div>
        </div>
    );
}

function SceneList({ scenes, selectedScenes, onToggleScene, onSelectAll, onEditScene }: {
    scenes: SceneData[];
    selectedScenes: Set<number>;
    onToggleScene: (index: number) => void;
    onSelectAll: () => void;
    onEditScene: (scene: SceneData) => void;
}) {
    return (
        <div className="scene-sidebar">
            <div className="scene-sidebar-header">
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={selectedScenes.size === scenes.length && scenes.length > 0}
                        onChange={onSelectAll}
                    />
                    <span>Select All</span>
                </label>
                <span className="selected-count">{selectedScenes.size} selected</span>
            </div>
            <div className="scene-sidebar-list">
                {scenes.map(scene => (
                    <div
                        key={scene.sceneIndex}
                        className={`scene-sidebar-item ${selectedScenes.has(scene.sceneIndex) ? 'selected' : ''}`}
                        onClick={() => onToggleScene(scene.sceneIndex)}
                    >
                        <input
                            type="checkbox"
                            checked={selectedScenes.has(scene.sceneIndex)}
                            onChange={() => onToggleScene(scene.sceneIndex)}
                            onClick={e => e.stopPropagation()}
                        />
                        <span className="scene-number">Scene {String(scene.sceneIndex).padStart(3, '0')}</span>
                        <span className={`scene-status-badge scene-status-${scene.status}`}>
                            {scene.status}
                        </span>
                        <button
                            className="btn btn-xs btn-ghost"
                            onClick={e => {
                                e.stopPropagation();
                                onEditScene(scene);
                            }}
                        >
                            Edit
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SceneCard({ scene, selected, onToggle, onEdit }: {
    scene: SceneData;
    selected: boolean;
    onToggle: () => void;
    onEdit: () => void;
}) {
    const mainImage = scene.assets.find(a => a.type === 'image')?.url;

    return (
        <div className={`scene-card ${selected ? 'selected' : ''}`} onClick={onToggle}>
            <div className="scene-card-checkbox">
                <input type="checkbox" checked={selected} onChange={onToggle} />
            </div>
            <div className="scene-card-image">
                {mainImage ? (
                    <img src={mainImage} alt={`Scene ${scene.sceneIndex}`} />
                ) : (
                    <div className="scene-card-placeholder">
                        <span>Scene {String(scene.sceneIndex).padStart(3, '0')}</span>
                    </div>
                )}
                {scene.status === 'generating' && (
                    <div className="scene-card-overlay">
                        <div className="progress-ring">
                            <div className="progress-fill" style={{ width: `${scene.progress || 0}%` }} />
                        </div>
                        <span>{scene.progress || 0}%</span>
                    </div>
                )}
                {scene.status === 'completed' && (
                    <div className="scene-card-badge completed">✓</div>
                )}
                {scene.status === 'failed' && (
                    <div className="scene-card-badge failed">✗</div>
                )}
            </div>
            <div className="scene-card-body">
                <div className="scene-card-title">
                    Scene {String(scene.sceneIndex).padStart(3, '0')}
                </div>
                <div className="scene-card-prompt">
                    {scene.prompt.slice(0, 100)}{scene.prompt.length > 100 ? '...' : ''}
                </div>
                <StatusProgressBar
                    status={(scene.status as StatusType) || 'pending'}
                    progress={scene.progress}
                    size="small"
                />
                <div className="scene-card-actions">
                    <button className="btn btn-xs btn-ghost" onClick={onEdit}>Edit</button>
                    <button className="btn btn-xs btn-primary">Regenerate</button>
                </div>
            </div>
        </div>
    );
}

function SceneListItem({ scene, selected, onToggle, onEdit }: {
    scene: SceneData;
    selected: boolean;
    onToggle: () => void;
    onEdit: () => void;
}) {
    const mainImage = scene.assets.find(a => a.type === 'image')?.url;

    return (
        <div className={`scene-list-item ${selected ? 'selected' : ''}`} onClick={onToggle}>
            <input type="checkbox" checked={selected} onChange={onToggle} />
            <div className="scene-list-thumb">
                {mainImage ? (
                    <img src={mainImage} alt="" />
                ) : (
                    <div className="thumb-placeholder">-</div>
                )}
            </div>
            <div className="scene-list-info">
                <div className="scene-list-title">
                    Scene {String(scene.sceneIndex).padStart(3, '0')}
                </div>
                <div className="scene-list-prompt">
                    {scene.prompt.slice(0, 150)}{scene.prompt.length > 150 ? '...' : ''}
                </div>
                <StatusProgressBar
                    status={(scene.status as StatusType) || 'pending'}
                    progress={scene.progress}
                    size="small"
                />
            </div>
            <div className={`scene-list-status scene-status-${scene.status}`}>
                {scene.status}
            </div>
            <div className="scene-list-actions">
                <button className="btn btn-xs btn-ghost" onClick={onEdit}>Edit</button>
                <button className="btn btn-xs btn-primary">Regenerate</button>
            </div>
        </div>
    );
}

function SceneEditModal({ scene, onSave, onClose }: {
    scene: SceneData;
    onSave: (scene: SceneData) => void;
    onClose: () => void;
}) {
    const [prompt, setPrompt] = useState(scene.prompt);
    const [negativePrompt, setNegativePrompt] = useState(scene.negativePrompt || '');
    const [duration, setDuration] = useState(scene.duration || '8s');

    const handleSave = () => {
        onSave({
            ...scene,
            prompt,
            negativePrompt,
            duration,
        });
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content scene-edit-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>Edit Scene {String(scene.sceneIndex).padStart(3, '0')}</h3>
                    <button className="btn btn-ghost" onClick={onClose}>×</button>
                </div>
                <div className="modal-body">
                    <div className="form-group">
                        <label>Prompt</label>
                        <textarea
                            value={prompt}
                            onChange={e => setPrompt(e.target.value)}
                            rows={4}
                        />
                    </div>
                    <div className="form-group">
                        <label>Negative Prompt</label>
                        <textarea
                            value={negativePrompt}
                            onChange={e => setNegativePrompt(e.target.value)}
                            rows={2}
                        />
                    </div>
                    <div className="form-group">
                        <label>Duration</label>
                        <select value={duration} onChange={e => setDuration(e.target.value)}>
                            <option value="4s">4s</option>
                            <option value="6s">6s</option>
                            <option value="8s">8s</option>
                            <option value="10s">10s</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Characters</label>
                        <input
                            type="text"
                            value={(scene.characters || []).join(', ')}
                            placeholder="Character names..."
                            readOnly
                        />
                    </div>
                    <div className="form-group">
                        <label>Scene Images</label>
                        <div className="scene-images-list">
                            {scene.assets.filter(a => a.type === 'image').map(asset => (
                                <div key={asset.id} className="scene-image-item">
                                    <img src={asset.url} alt={asset.name} />
                                    <span>{asset.name}</span>
                                </div>
                            ))}
                            {scene.assets.filter(a => a.type === 'image').length === 0 && (
                                <div className="empty-state">No images uploaded</div>
                            )}
                        </div>
                        <button className="btn btn-secondary btn-sm">+ Upload Images</button>
                    </div>
                </div>
                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" onClick={handleSave}>Save</button>
                </div>
            </div>
        </div>
    );
}
