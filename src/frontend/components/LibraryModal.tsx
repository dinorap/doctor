import React, { useState, useEffect, useCallback } from 'react';

export interface LibraryEntity {
  id: string;
  name: string;
  slug: string;
  entity_type: 'character' | 'location' | 'creature' | 'visual_asset' | 'generic_troop' | 'faction';
  description?: string;
  image_prompt?: string;
  reference_image_url?: string;
  media_id?: string;
}

interface LibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (entity: LibraryEntity) => void;
  projectId?: string;
  apiBase?: string;
}

const ENTITY_TYPE_LABELS: Record<string, { name: string; icon: string }> = {
  all: { name: 'All', icon: '🖼️' },
  character: { name: 'Characters', icon: '👤' },
  location: { name: 'Locations', icon: '🏠' },
  creature: { name: 'Creatures', icon: '🐉' },
  visual_asset: { name: 'Assets', icon: '🎭' },
  generic_troop: { name: 'Troops', icon: '⚔️' },
  faction: { name: 'Factions', icon: '🏴' },
};

export default function LibraryModal({
  isOpen,
  onClose,
  onSelect,
  projectId,
  apiBase = '/api',
}: LibraryModalProps) {
  const [activeTab, setActiveTab] = useState<string>('all');
  const [entities, setEntities] = useState<LibraryEntity[]>([]);
  const [allEntities, setAllEntities] = useState<LibraryEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedEntity, setSelectedEntity] = useState<LibraryEntity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchEntities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (projectId) params.append('project_id', projectId);

      const res = await fetch(`${apiBase}/library/entities?${params}`);

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const data = await res.json();

      // Flatten all entities from grouped response
      const flatEntities: LibraryEntity[] = [];
      if (data.grouped) {
        Object.values(data.grouped).forEach((arr: any[]) => {
          flatEntities.push(...arr);
        });
      } else {
        flatEntities.push(...(data.entities || []));
      }

      setAllEntities(flatEntities);
      setEntities(flatEntities);
    } catch (err) {
      console.error('[Library] Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, [apiBase, projectId]);

  useEffect(() => {
    if (isOpen) {
      fetchEntities();
    }
  }, [isOpen, fetchEntities]);

  // Filter by tab and search
  useEffect(() => {
    let filtered = allEntities;

    // Filter by type
    if (activeTab !== 'all') {
      filtered = filtered.filter(e => e.entity_type === activeTab);
    }

    // Filter by search
    if (search.trim()) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(e =>
        e.name?.toLowerCase().includes(searchLower) ||
        e.description?.toLowerCase().includes(searchLower)
      );
    }

    setEntities(filtered);
  }, [activeTab, search, allEntities]);

  const handleSelect = () => {
    if (selectedEntity) {
      onSelect(selectedEntity);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="library-overlay" onClick={onClose}>
      <div className="library-container" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="library-header">
          <h2>📚 Reference Images</h2>
          <button className="library-close" onClick={onClose}>×</button>
        </div>

        {/* Toolbar */}
        <div className="library-toolbar">
          <div className="library-tabs">
            {Object.entries(ENTITY_TYPE_LABELS).map(([type, { name, icon }]) => (
              <button
                key={type}
                className={`library-tab ${activeTab === type ? 'active' : ''}`}
                onClick={() => setActiveTab(type)}
              >
                <span className="tab-icon">{icon}</span>
                <span className="tab-name">{name}</span>
                {type !== 'all' && allEntities.filter(e => e.entity_type === type).length > 0 && (
                  <span className="tab-count">
                    {allEntities.filter(e => e.entity_type === type).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="library-search">
            <input
              type="text"
              placeholder="Search images..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="form-input"
            />
          </div>
        </div>

        {/* Content */}
        <div className="library-content">
          {error && (
            <div className="library-error">
              <span>⚠️</span> {error}
              <button onClick={fetchEntities}>Retry</button>
            </div>
          )}

          {loading ? (
            <div className="library-loading">
              <div className="spinner" />
              <span>Loading images...</span>
            </div>
          ) : entities.length === 0 ? (
            <div className="library-empty">
              <div className="library-empty-icon">🖼️</div>
              <h3>No images found</h3>
              <p>
                {search
                  ? `No results for "${search}"`
                  : 'Generate images in your project to see them here'}
              </p>
            </div>
          ) : (
            <div className="library-grid">
              {entities.map(entity => (
                <div
                  key={entity.id}
                  className={`library-card ${selectedEntity?.id === entity.id ? 'selected' : ''}`}
                  onClick={() => setSelectedEntity(entity)}
                >
                  <div className="library-card-image">
                    {entity.reference_image_url ? (
                      <img
                        src={entity.reference_image_url}
                        alt={entity.name}
                        loading="lazy"
                      />
                    ) : (
                      <div className="library-card-placeholder">
                        {ENTITY_TYPE_LABELS[entity.entity_type]?.icon || '🖼️'}
                      </div>
                    )}
                    {entity.media_id && (
                      <span className="library-card-badge">✓</span>
                    )}
                  </div>
                  <div className="library-card-info">
                    <span className="library-card-name">{entity.name}</span>
                    <span className="library-card-type">
                      {ENTITY_TYPE_LABELS[entity.entity_type]?.icon}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {selectedEntity && (
          <div className="library-footer">
            <div className="library-selected-preview">
              {selectedEntity.reference_image_url && (
                <img src={selectedEntity.reference_image_url} alt="" />
              )}
              <div className="library-selected-info">
                <strong>{selectedEntity.name}</strong>
                <span>{ENTITY_TYPE_LABELS[selectedEntity.entity_type]?.name}</span>
              </div>
            </div>
            <div className="library-actions">
              <button className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSelect}>
                Use as Reference
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .library-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.8);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
        }

        .library-container {
          background: var(--bg-primary, #1a1a2e);
          border-radius: 16px;
          width: 100%;
          max-width: 1200px;
          height: 80vh;
          max-height: 800px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }

        .library-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .library-header h2 {
          margin: 0;
          font-size: 1.25rem;
          font-weight: 600;
        }

        .library-close {
          width: 36px;
          height: 36px;
          border: none;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          font-size: 1.5rem;
          cursor: pointer;
          color: var(--text-secondary, #888);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }

        .library-close:hover {
          background: rgba(255, 255, 255, 0.2);
          color: var(--text-primary, #fff);
        }

        .library-toolbar {
          padding: 12px 20px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          display: flex;
          gap: 16px;
          align-items: center;
          flex-wrap: wrap;
        }

        .library-tabs {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          flex: 1;
        }

        .library-tab {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          border: 1px solid transparent;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 20px;
          cursor: pointer;
          font-size: 0.85rem;
          color: var(--text-secondary, #888);
          transition: all 0.2s;
        }

        .library-tab:hover {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text-primary, #fff);
        }

        .library-tab.active {
          background: rgba(99, 102, 241, 0.2);
          border-color: rgba(99, 102, 241, 0.5);
          color: #818cf8;
        }

        .tab-count {
          background: rgba(255, 255, 255, 0.1);
          padding: 2px 6px;
          border-radius: 10px;
          font-size: 0.75rem;
        }

        .library-tab.active .tab-count {
          background: rgba(99, 102, 241, 0.3);
        }

        .library-search {
          width: 200px;
        }

        .library-search input {
          width: 100%;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          color: var(--text-primary, #fff);
          font-size: 0.85rem;
        }

        .library-search input::placeholder {
          color: var(--text-secondary, #666);
        }

        .library-content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }

        .library-error {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 8px;
          color: #f87171;
          margin-bottom: 20px;
        }

        .library-error button {
          margin-left: auto;
          padding: 4px 12px;
          background: rgba(239, 68, 68, 0.2);
          border: none;
          border-radius: 4px;
          color: #f87171;
          cursor: pointer;
        }

        .library-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-secondary, #888);
          gap: 12px;
        }

        .spinner {
          width: 32px;
          height: 32px;
          border: 3px solid rgba(255, 255, 255, 0.1);
          border-top-color: #818cf8;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .library-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-secondary, #888);
          text-align: center;
        }

        .library-empty-icon {
          font-size: 4rem;
          margin-bottom: 16px;
          opacity: 0.5;
        }

        .library-empty h3 {
          margin: 0 0 8px;
          font-size: 1.25rem;
          color: var(--text-primary, #fff);
        }

        .library-empty p {
          margin: 0;
          font-size: 0.9rem;
        }

        .library-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 16px;
        }

        .library-card {
          background: rgba(255, 255, 255, 0.03);
          border: 2px solid transparent;
          border-radius: 12px;
          overflow: hidden;
          cursor: pointer;
          transition: all 0.2s;
        }

        .library-card:hover {
          background: rgba(255, 255, 255, 0.08);
          transform: translateY(-2px);
        }

        .library-card.selected {
          border-color: #818cf8;
          background: rgba(99, 102, 241, 0.1);
        }

        .library-card-image {
          aspect-ratio: 1;
          background: rgba(0, 0, 0, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
        }

        .library-card-image img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .library-card-placeholder {
          font-size: 2.5rem;
          opacity: 0.5;
        }

        .library-card-badge {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 22px;
          height: 22px;
          background: #22c55e;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
          color: white;
          font-weight: bold;
        }

        .library-card-info {
          padding: 10px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .library-card-name {
          font-size: 0.85rem;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }

        .library-card-type {
          font-size: 1rem;
          margin-left: 6px;
        }

        .library-footer {
          padding: 16px 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          background: rgba(0, 0, 0, 0.2);
        }

        .library-selected-preview {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .library-selected-preview img {
          width: 48px;
          height: 48px;
          border-radius: 8px;
          object-fit: cover;
        }

        .library-selected-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .library-selected-info strong {
          font-size: 0.95rem;
        }

        .library-selected-info span {
          font-size: 0.8rem;
          color: var(--text-secondary, #888);
        }

        .library-actions {
          display: flex;
          gap: 10px;
        }

        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-secondary {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text-primary, #fff);
        }

        .btn-secondary:hover {
          background: rgba(255, 255, 255, 0.15);
        }

        .btn-primary {
          background: #6366f1;
          color: white;
        }

        .btn-primary:hover {
          background: #4f46e5;
        }
      `}</style>
    </div>
  );
}
