import React, { useState } from 'react';

export interface SceneAsset {
    id: string;
    name: string;
    type: 'image' | 'video' | 'audio';
    url: string;
    thumbnailUrl?: string;
    localPath?: string;
    mediaId?: string;
}

interface GlobalReferencesProps {
    references: SceneAsset[];
    onAdd: (files: FileList | null) => void;
    onRemove: (id: string) => void;
}

export default function GlobalReferences({ references, onAdd, onRemove }: GlobalReferencesProps) {
    return (
        <div className="global-references-panel">
            <div className="panel-header">
                <h3>Global References</h3>
                <span className="panel-count">{references.length}</span>
            </div>

            <p className="panel-hint">
                These images will be automatically added to all scenes during generation.
            </p>

            <div className="global-references-list">
                {references.map(ref => (
                    <div key={ref.id} className="global-reference-item">
                        <img src={ref.url} alt={ref.name} />
                        <span className="reference-name">{ref.name}</span>
                        <button
                            className="btn btn-xs btn-danger"
                            onClick={() => onRemove(ref.id)}
                        >
                            ×
                        </button>
                    </div>
                ))}
                {references.length === 0 && (
                    <div className="empty-state">No global references uploaded</div>
                )}
            </div>

            <label className="upload-global-btn">
                <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={e => onAdd(e.target.files)}
                    style={{ display: 'none' }}
                />
                + Upload Global References
            </label>
        </div>
    );
}
