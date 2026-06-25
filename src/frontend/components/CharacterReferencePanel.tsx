import React, { useState } from 'react';
import type { SceneAsset, CharacterRef } from '../types';

interface CharacterReferencePanelProps {
    characters: CharacterRef[];
    selectedProfileIds: string[];
    onAddCharacter: (name: string) => void;
    onAddImage: (characterId: string, file: File) => void;
    onRemoveImage: (characterId: string, imageId: string) => void;
}

export default function CharacterReferencePanel({
    characters,
    selectedProfileIds,
    onAddCharacter,
    onAddImage,
    onRemoveImage,
}: CharacterReferencePanelProps) {
    const [newCharName, setNewCharName] = useState('');
    const [expandedChar, setExpandedChar] = useState<string | null>(null);

    const handleAdd = () => {
        if (newCharName.trim()) {
            onAddCharacter(newCharName.trim());
            setNewCharName('');
        }
    };

    return (
        <div className="character-reference-panel">
            <div className="panel-header">
                <h3>Characters</h3>
                <span className="panel-count">{characters.length}</span>
            </div>

            <div className="add-character-form">
                <input
                    type="text"
                    placeholder="Add character..."
                    value={newCharName}
                    onChange={e => setNewCharName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAdd()}
                />
                <button className="btn btn-sm btn-primary" onClick={handleAdd}>
                    +
                </button>
            </div>

            <div className="character-list">
                {characters.map(char => (
                    <div
                        key={char.id}
                        className={`character-item ${expandedChar === char.id ? 'expanded' : ''}`}
                    >
                        <div
                            className="character-header"
                            onClick={() => setExpandedChar(expandedChar === char.id ? null : char.id)}
                        >
                            <span className="character-name">{char.name}</span>
                            <span className="character-image-count">
                                {char.images.length} images
                            </span>
                        </div>

                        {expandedChar === char.id && (
                            <div className="character-images">
                                {char.images.map(img => (
                                    <div key={img.id} className="character-image-item">
                                        <img src={img.url} alt={img.name} />
                                        <button
                                            className="btn btn-xs btn-danger"
                                            onClick={() => onRemoveImage(char.id, img.id)}
                                        >
                                            ×
                                        </button>
                                    </div>
                                ))}
                                {char.images.length === 0 && (
                                    <div className="empty-state">No images</div>
                                )}
                                <label className="upload-image-btn">
                                    <input
                                        type="file"
                                        accept="image/*"
                                        multiple
                                        onChange={e => {
                                            if (e.target.files?.[0]) {
                                                onAddImage(char.id, e.target.files[0]);
                                            }
                                        }}
                                        style={{ display: 'none' }}
                                    />
                                    + Add Image
                                </label>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
