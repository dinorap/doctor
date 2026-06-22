import React, { useState, useEffect, useCallback } from 'react';
import { useProfiles, useCloakBrowser, useFlowImages, useEntities } from '../hooks/useProfiles';
import { useFlowVideos } from '../hooks/useFlowVideos';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Profile, FlowProject, GeneratedImageResult } from '../types';
import { api } from '../services/api';
import FlowVideosTab from './FlowVideosTab';
import ScriptGeneratorTab from './ScriptGeneratorTab';
import '../styles/App.css';

// Helper to extract filename from path (browser-compatible)
const getFileName = (filePath: string) => filePath.split(/[/\\]/).pop() || filePath;

// Lightbox component
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
    return (
        <div
            style={{
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.9)', zIndex: 9999,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer'
            }}
            onClick={onClose}
        >
            <img
                src={src}
                alt={alt}
                style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }}
            />
            <button
                onClick={onClose}
                style={{
                    position: 'absolute', top: 20, right: 20,
                    background: 'rgba(255,255,255,0.2)', border: 'none',
                    color: 'white', fontSize: '24px', width: 40, height: 40,
                    borderRadius: '50%', cursor: 'pointer'
                }}
            >
                ×
            </button>
        </div>
    );
}

// Notification component
function Notification({ message, type, onClose }: { message: string; type: 'success' | 'error' | 'info'; onClose: () => void }) {
    useEffect(() => {
        const timer = setTimeout(onClose, 3000);
        return () => clearTimeout(timer);
    }, [onClose]);

    return (
        <div className={`notification ${type}`}>
            <span>{type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span>
            {message}
        </div>
    );
}

// Sidebar component
interface SidebarProps {
    activeTab: string;
    onTabChange: (tab: string) => void;
    totalProfiles: number;
    activeSessions: number;
    cloakStatus: { ready: boolean; available: boolean };
}

function Sidebar({ activeTab, onTabChange, totalProfiles, activeSessions, cloakStatus }: SidebarProps) {
    const getCloakBadgeClass = () => {
        if (cloakStatus.ready) return '';
        if (cloakStatus.available) return 'warning';
        return 'danger';
    };

    const getCloakBadgeText = () => {
        if (cloakStatus.ready) return '✓ Stealth Mode Ready';
        if (cloakStatus.available) return '⏳ Đang tải binary...';
        return '⚠ Not Available';
    };

    const menuItems = [
        { id: 'profiles', icon: '👤', label: 'Profile Manager' },
        { id: 'flow-projects', icon: '🌊', label: 'Flow Projects' },
        { id: 'entities', icon: '🎭', label: 'Entity Library' },
        { id: 'script-gen', icon: '✍️', label: 'Sinh Kịch Bản' },
        { id: 'settings', icon: '⚙️', label: 'Settings' },
    ];

    return (
        <div className="sidebar">
            <div className="sidebar-header">
                <div className="sidebar-logo">
                    <div className="sidebar-logo-icon">🌐</div>
                    <div>
                        <h1>Chromium</h1>
                        <p className="sidebar-subtitle">Profile Manager</p>
                    </div>
                </div>
            </div>

            <div className="sidebar-stats">
                <div className="stat-box">
                    <div className="stat-value">{totalProfiles}</div>
                    <div className="stat-label">Profiles</div>
                </div>
                <div className="stat-box">
                    <div className="stat-value">{activeSessions}</div>
                    <div className="stat-label">Active</div>
                </div>
            </div>

            <div className="sidebar-menu">
                {menuItems.map((item) => (
                    <div
                        key={item.id}
                        className={`menu-item ${activeTab === item.id ? 'active' : ''}`}
                        onClick={() => onTabChange(item.id)}
                    >
                        <div className="menu-item-icon">{item.icon}</div>
                        <span>{item.label}</span>
                    </div>
                ))}
            </div>

            <div className="sidebar-footer">
                <p>v1.0.0 • Playwright</p>
                <div className={`cloak-badge ${getCloakBadgeClass()}`}>
                    {getCloakBadgeText()}
                </div>
            </div>
        </div>
    );
}

// Tier Badge Component
function TierBadge({ tier, size = 'normal' }: { tier?: string; size?: 'normal' | 'large' }) {
    if (!tier) return null;

    const isUltra = tier === 'PAYGATE_TIER_TWO';
    const isUnknown = tier === 'UNKNOWN' || (!isUltra && tier !== 'PAYGATE_TIER_ONE');

    if (isUnknown) {
        return (
            <div className="profile-badge badge-tier-unknown" title="Tier chưa được xác định — chưa detect được từ extension hoặc Flow API">
                <span style={{ fontSize: size === 'large' ? '1rem' : '0.85rem' }}>?</span>
                <span style={{ fontWeight: 600 }}>Unknown</span>
            </div>
        );
    }

    return (
        <div className={`profile-badge ${isUltra ? 'badge-tier-two' : 'badge-tier-one'}`}>
            <span style={{ fontSize: size === 'large' ? '1rem' : '0.85rem' }}>
                {isUltra ? '👑' : '⭐'}
            </span>
            <span style={{ fontWeight: 600 }}>
                {isUltra ? 'Ultra' : 'Pro'}
            </span>
        </div>
    );
}

// Profile Card Component
interface ProfileCardProps {
    profile: Profile;
    onOpen: (id: string, openFlow?: boolean, useStealth?: boolean) => void;
    onClose: (id: string) => void;
    onSave: (id: string) => void;
    onEdit: (profile: Profile) => void;
    onDelete: (id: string) => void;
    onRefreshTier: (id: string) => void;
    onSetProxy: (profile: Profile) => void;
}

function ProfileCard({ profile, onOpen, onClose, onSave, onEdit, onDelete, onRefreshTier, onSetProxy }: ProfileCardProps) {
    const formatRelativeTime = (dateStr: string | undefined) => {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        if (minutes < 1) return 'Vừa xong';
        if (minutes < 60) return `${minutes} phút trước`;
        if (hours < 24) return `${hours} giờ trước`;
        return `${days} ngày trước`;
    };

    const formatDate = (dateStr: string | undefined) => {
        if (!dateStr) return '—';
        const date = new Date(dateStr);
        return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };

    return (
        <div className={`profile-card ${profile.isActive ? 'active' : ''}`}>
            <div className="profile-header">
                <div className="profile-title">
                    <div className="profile-avatar">{profile.name.charAt(0).toUpperCase()}</div>
                    <div>
                        <div className="profile-name">{profile.name}</div>
                        <div className="profile-id">#{profile.id.substring(0, 8)}</div>
                    </div>
                </div>
                <div className="profile-badges">
                    <div className={`profile-badge ${profile.isActive ? 'badge-active' : 'badge-inactive'}`}>
                        <span>{profile.isActive ? '●' : '○'}</span>
                        {profile.isActive ? 'Active' : 'Offline'}
                    </div>
                    {profile.tier && <TierBadge tier={profile.tier} />}
                </div>
            </div>

            <div className="profile-description">
                {profile.metadata?.description || ''}
            </div>

            <div className="profile-meta">
                <div className="meta-item">
                    <span className="meta-label">Ngày tạo</span>
                    <span className="meta-value">{formatDate(profile.createdAt)}</span>
                </div>
                <div className="meta-item">
                    <span className="meta-label">Trạng thái</span>
                    <span className="meta-value">
                        {profile.isActive ? (
                            <span className="profile-badge badge-active">● Đang chạy</span>
                        ) : (
                            <span className="profile-badge badge-inactive">○ Offline</span>
                        )}
                    </span>
                </div>
                {profile.proxy && (
                    <div className="meta-item">
                        <span className="meta-label">Proxy</span>
                        <span className="meta-value" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {profile.proxy.host}:{profile.proxy.port}
                        </span>
                    </div>
                )}
                {profile.isActive && profile.tier && (
                    <div className="meta-item">
                        <span className="meta-label">Tier</span>
                        <span className="meta-value">
                            <TierBadge tier={profile.tier} />
                        </span>
                    </div>
                )}
            </div>

            <div className="profile-actions">
                {!profile.isActive ? (
                    <>
                        <button className="btn btn-success" onClick={() => onOpen(profile.id, true, true)}>
                            🌊 Mở Flow
                        </button>
                        <button className="btn btn-ghost" onClick={() => onSetProxy(profile)} title={profile.proxy ? `Proxy: ${profile.proxy.host}:${profile.proxy.port}` : 'Set proxy'}>
                            {profile.proxy ? '🟢' : '🌐'}
                        </button>
                        <button className="btn btn-ghost" onClick={() => onEdit(profile)}>✏️</button>
                        <button className="btn btn-danger" onClick={() => onDelete(profile.id)}>🗑️</button>
                    </>
                ) : (
                    <>
                        <button className="btn btn-warning" onClick={() => onClose(profile.id)}>⏸️ Đóng</button>
                        <button className="btn btn-info" onClick={() => onSave(profile.id)}>💾 Save</button>
                        <button className="btn btn-ghost" onClick={() => onRefreshTier(profile.id)} title="Refresh Tier">🔄</button>
                    </>
                )}
            </div>
        </div>
    );
}

// Modal Component
interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}

function Modal({ isOpen, onClose, title, children }: ModalProps) {
    if (!isOpen) return null;

    return (
        <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal">
                <div className="modal-header">
                    <h3>{title}</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>
                {children}
            </div>
        </div>
    );
}

// Create Profile Modal
function CreateProfileModal({ isOpen, onClose, onSubmit, submitting }: { isOpen: boolean; onClose: () => void; onSubmit: (name: string, desc: string, openFlow: boolean) => Promise<void> | void; submitting?: boolean }) {
    const [name, setName] = useState('');
    const [desc, setDesc] = useState('');
    const [openFlow, setOpenFlow] = useState(false);

    // Reset fields whenever the modal is freshly opened — otherwise the
    // previous (already-submitted) values linger and the next "Tạo" call
    // submits empty/leftover data.
    useEffect(() => {
        if (isOpen) {
            setName('');
            setDesc('');
            setOpenFlow(false);
        }
    }, [isOpen]);

    const handleSubmit = async () => {
        if (!name.trim() || submitting) return;
        // Reset the form BEFORE the async submit so the UI feels snappy and
        // a double-click can't double-submit.
        const submittedName = name.trim();
        const submittedDesc = desc.trim();
        const submittedOpenFlow = openFlow;
        setName('');
        setDesc('');
        setOpenFlow(false);
        // Close the modal up-front so the user isn't staring at it while
        // the (potentially slow) create+open request is in flight. The
        // caller still receives the openFlow flag and will trigger the
        // browser open independently.
        onClose();
        try {
            await onSubmit(submittedName, submittedDesc, submittedOpenFlow);
        } catch {
            // Error notification is handled by the parent. We already
            // closed the modal — restoring the form is unnecessary because
            // the user can re-open it from the toolbar.
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="➕ Tạo Profile Mới">
            <div className="form-group">
                <label className="form-label">Tên Profile</label>
                <input type="text" className="form-input" placeholder="VD: Profile Marketing 1" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="form-group">
                <label className="form-label">Mô tả</label>
                <textarea className="form-input" placeholder="Mô tả ngắn về profile này..." value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="form-group">
                <label className="checkbox-wrapper">
                    <input type="checkbox" checked={openFlow} onChange={(e) => setOpenFlow(e.target.checked)} />
                    <span className="checkbox-label">🌊 Tự động mở Google Flow sau khi tạo</span>
                </label>
            </div>
            <div className="modal-actions">
                <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Hủy</button>
                <button className="btn btn-primary" onClick={handleSubmit} disabled={!name.trim() || submitting}>
                    {submitting ? 'Đang tạo...' : 'Tạo Profile'}
                </button>
            </div>
        </Modal>
    );
}

// Edit Profile Modal
function EditProfileModal({ isOpen, onClose, profile, onSubmit }: { isOpen: boolean; onClose: () => void; profile: Profile | null; onSubmit: (id: string, name: string, desc: string) => void }) {
    const [name, setName] = useState('');
    const [desc, setDesc] = useState('');

    useEffect(() => {
        if (profile) {
            setName(profile.name);
            setDesc(profile.metadata?.description || '');
        }
    }, [profile]);

    const handleSubmit = () => {
        if (name.trim() && profile) {
            onSubmit(profile.id, name.trim(), desc.trim());
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="✏️ Chỉnh sửa Profile">
            <div className="form-group">
                <label className="form-label">Tên Profile</label>
                <input type="text" className="form-input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-group">
                <label className="form-label">Mô tả</label>
                <textarea className="form-input" placeholder="Mô tả ngắn về profile này..." value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="modal-actions">
                <button className="btn btn-ghost" onClick={onClose}>Hủy</button>
                <button className="btn btn-primary" onClick={handleSubmit}>Lưu</button>
            </div>
        </Modal>
    );
}

// Proxy Modal
function ProxyModal({ isOpen, onClose, profile, onSubmit }: { isOpen: boolean; onClose: () => void; profile: Profile | null; onSubmit: (id: string, proxy: string | null) => void }) {
    const [proxyText, setProxyText] = useState('');

    useEffect(() => {
        if (profile) {
            if (profile.proxy) {
                const { host, port, username, password } = profile.proxy;
                setProxyText([host, port, username, password].filter(Boolean).join(':'));
            } else {
                setProxyText('');
            }
        }
    }, [profile]);

    if (!profile) return null;

    const parsed = parseProxyString(proxyText.trim());

    const handleSubmit = () => {
        if (proxyText.trim() === '') {
            onSubmit(profile.id, null);
        } else {
            onSubmit(profile.id, proxyText.trim());
        }
    };

    const handleClear = () => {
        setProxyText('');
        onSubmit(profile.id, null);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="🌐 Cấu hình Proxy">
            <div className="form-group">
                <label className="form-label">Proxy</label>
                <input
                    type="text"
                    className="form-input"
                    placeholder="ip:port:user:pass"
                    value={proxyText}
                    onChange={(e) => setProxyText(e.target.value)}
                    style={{ fontFamily: 'monospace' }}
                />
                <small style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '4px', display: 'block' }}>
                    Format: <code>ip:port:user:pass</code> - Phần user:pass là tùy chọn
                </small>
            </div>
            {proxyText.trim() && (
                <div className="form-group">
                    <label className="form-label">Xem trước</label>
                    {parsed.error ? (
                        <div style={{ color: 'var(--error)', fontSize: '0.85rem' }}>⚠️ {parsed.error}</div>
                    ) : (
                        <div style={{ background: 'var(--bg-secondary)', padding: '12px', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'monospace' }}>
                            <div>Host: <strong>{parsed.host}</strong></div>
                            <div>Port: <strong>{parsed.port}</strong></div>
                            {parsed.username && <div>User: <strong>{parsed.username}</strong></div>}
                            {parsed.password && <div>Pass: <strong>{'*'.repeat(parsed.password.length)}</strong></div>}
                        </div>
                    )}
                </div>
            )}
            <div className="modal-actions">
                {profile.proxy && (
                    <button className="btn btn-danger" onClick={handleClear}>🗑️ Xóa Proxy</button>
                )}
                <button className="btn btn-ghost" onClick={onClose}>Hủy</button>
                <button className="btn btn-primary" onClick={handleSubmit} disabled={!!parsed.error}>Lưu</button>
            </div>
        </Modal>
    );
}

function parseProxyString(text: string): { host?: string; port?: number; username?: string; password?: string; error?: string } {
    if (!text) return { error: 'Proxy trống' };
    const parts = text.split(':');
    if (parts.length < 2) return { error: 'Cần ít nhất ip:port' };
    const host = parts[0].trim();
    const port = parseInt(parts[1].trim(), 10);
    if (!host) return { error: 'Host trống' };
    if (isNaN(port) || port < 1 || port > 65535) return { error: 'Port không hợp lệ' };
    const result: any = { host, port };
    if (parts[2]?.trim()) result.username = parts[2].trim();
    if (parts[3]?.trim()) result.password = parts[3].trim();
    return result;
}

// Profiles Tab
function ProfilesTab({ profiles, loading, onCreateProfile, onOpenProfile, onCloseProfile, onSaveSession, onUpdateProfile, onDeleteProfile, onRefreshTier, onSetProxy, creatingProfile }: any) {
    const [showCreate, setShowCreate] = useState(false);
    const [showEdit, setShowEdit] = useState(false);
    const [showProxy, setShowProxy] = useState(false);
    const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
    const [proxyProfile, setProxyProfile] = useState<Profile | null>(null);

    const handleEdit = (profile: Profile) => {
        setEditingProfile(profile);
        setShowEdit(true);
    };

    const handleSetProxy = (profile: Profile) => {
        setProxyProfile(profile);
        setShowProxy(true);
    };

    const handleProxySubmit = async (id: string, proxy: string | null) => {
        await onSetProxy(id, proxy);
        setShowProxy(false);
        setProxyProfile(null);
    };

    // Wrapper that closes the modal BEFORE the create completes so the
    // user gets immediate feedback. The create handler in App is async
    // (network + db) so closing on the call-site is too late.
    const handleCreateSubmit = async (name: string, desc: string, openFlow: boolean) => {
        await onCreateProfile(name, desc, openFlow);
    };

    return (
        <>
            <div className="content-header">
                <div className="header-left">
                    <h2><span>👥</span> Profile Manager</h2>
                </div>
                <div className="header-actions">
                    <button className="btn btn-ghost" onClick={() => window.dispatchEvent(new CustomEvent('refresh-profiles'))}>🔄 Làm Mới</button>
                    <button className="btn btn-primary" onClick={() => setShowCreate(true)} disabled={creatingProfile}>+ Tạo Profile</button>
                </div>
            </div>

            <div className="content-body">
                {loading ? (
                    <div className="loading">
                        <div className="loading-spinner"></div>
                        <p>Đang tải profiles...</p>
                    </div>
                ) : profiles.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon">📭</div>
                        <h3>Chưa có profile nào</h3>
                        <p>Nhấn "Tạo Profile" để bắt đầu quản lý trình duyệt của bạn.</p>
                        <button className="btn btn-primary" onClick={() => setShowCreate(true)} disabled={creatingProfile}>+ Tạo Profile Đầu Tiên</button>
                    </div>
                ) : (
                    <div className="profiles-grid">
                        {profiles.map((profile: Profile) => (
                            <ProfileCard
                                key={profile.id}
                                profile={profile}
                                onOpen={onOpenProfile}
                                onClose={onCloseProfile}
                                onSave={onSaveSession}
                                onEdit={handleEdit}
                                onDelete={onDeleteProfile}
                                onRefreshTier={onRefreshTier}
                                onSetProxy={handleSetProxy}
                            />
                        ))}
                    </div>
                )}
            </div>

            <CreateProfileModal
                isOpen={showCreate}
                onClose={() => setShowCreate(false)}
                onSubmit={handleCreateSubmit}
                submitting={creatingProfile}
            />
            <EditProfileModal isOpen={showEdit} onClose={() => { setShowEdit(false); setEditingProfile(null); }} profile={editingProfile} onSubmit={onUpdateProfile} />
            <ProxyModal isOpen={showProxy} onClose={() => { setShowProxy(false); setProxyProfile(null); }} profile={proxyProfile} onSubmit={handleProxySubmit} />
        </>
    );
}

// Entities Tab
interface EntityReference {
    id: string;
    name: string;
    description: string;
    entityType: string;
    materialId: string;
    mediaId: string;
    localPath: string;
    remoteUrl: string;
    profileId: string;
    projectId: string;
    aspectRatio: string;
    upscaleResolution: string;
    metadata: string;
    createdAt: string;
}

interface MaterialStyle {
    id: string;
    label: string;
    color: string;
    style_instruction: string;
    negative_prompt: string;
    scene_prefix: string;
    lighting: string;
}

interface EntitiesTabProps {
    profiles: Profile[];
    onOpenProfile?: (profileId: string) => Promise<void>;
    onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
    onOpenLightbox?: (src: string, alt: string) => void;
}

const DEFAULT_MATERIALS: MaterialStyle[] = [
    { id: '3d_pixar', label: '3D Pixar', color: '#4CAF50', style_instruction: '3D animated style, Pixar-quality rendering, Disney-Pixar aesthetic. Smooth subsurface scattering skin, expressive cartoon eyes, stylized proportions, vibrant saturated colors.', negative_prompt: 'NOT photorealistic, NOT photograph, NOT live action, NOT anime, NOT flat 2D.', scene_prefix: '3D animated Pixar-quality rendering, vibrant colors, cinematic lighting.', lighting: 'Studio lighting, global illumination, highly detailed' },
    { id: 'realistic', label: 'Photorealistic', color: '#2196F3', style_instruction: 'Photorealistic RAW photograph, shot on Canon EOS R5, 35mm lens, natural available light, real footage.', negative_prompt: 'NOT 3D render, NOT CGI, NOT digital art, NOT illustration, NOT anime, NOT painting, NOT cartoon.', scene_prefix: 'Real RAW photograph, shot on Canon EOS R5, 35mm lens, natural available light.', lighting: 'Studio lighting, highly detailed' },
    { id: 'anime', label: 'Anime', color: '#E91E63', style_instruction: 'Japanese anime style, cel-shaded rendering, vibrant saturated colors, clean sharp linework, large expressive eyes, stylized anatomy. High-quality anime production, studio Ghibli meets modern anime aesthetic.', negative_prompt: 'NOT photorealistic, NOT 3D render, NOT oil painting, NOT sketch, NOT watercolor, NOT Western cartoon.', scene_prefix: 'Anime style, cel-shaded, vibrant colors, clean linework, dramatic anime lighting.', lighting: 'Anime-style dramatic lighting, highly detailed' },
    { id: 'ghibli', label: 'Studio Ghibli', color: '#9C27B0', style_instruction: 'Studio Ghibli anime style, hand-painted watercolor backgrounds, soft pastel colors, gentle rounded character designs, whimsical atmosphere. Hayao Miyazaki aesthetic, detailed natural environments, magical realism.', negative_prompt: 'NOT photorealistic, NOT 3D render, NOT dark, NOT gritty, NOT sharp edges, NOT Western cartoon.', scene_prefix: 'Studio Ghibli anime style, hand-painted watercolor backgrounds, soft pastel colors, gentle whimsical atmosphere.', lighting: 'Soft natural Ghibli lighting, golden hour warmth, dappled sunlight' },
    { id: 'comic_book', label: 'Comic Book', color: '#FF9800', style_instruction: 'American comic book art style, bold black ink outlines, flat vibrant colors with halftone dot shading, dynamic action poses, dramatic foreshortening. Marvel/DC superhero comic aesthetic, Ben-Day dots, speech bubble ready.', negative_prompt: 'NOT photorealistic, NOT 3D render, NOT anime, NOT watercolor, NOT soft edges, NOT muted colors.', scene_prefix: 'Comic book style, bold ink outlines, vibrant flat colors, halftone shading, dynamic composition.', lighting: 'High contrast comic lighting, dramatic shadows, rim light' },
    { id: 'cyberpunk', label: 'Cyberpunk', color: '#00BCD4', style_instruction: 'Cyberpunk sci-fi aesthetic, neon-lit dark urban environment, holographic displays, rain-slicked streets reflecting neon signs. Blade Runner meets Ghost in the Shell, high-tech low-life, chrome and glass, purple and cyan color palette.', negative_prompt: 'NOT natural environment, NOT bright daylight, NOT historical, NOT cartoon, NOT fantasy medieval.', scene_prefix: 'Cyberpunk aesthetic, neon-lit dark urban, holographic displays, rain-slicked streets, purple and cyan neon.', lighting: 'Neon rim lighting, volumetric fog, cyan and magenta' },
    { id: 'stop_motion', label: 'Stop Motion', color: '#795548', style_instruction: 'Stop-motion animation style with handcrafted felt and wood puppets. Visible felt fabric texture, wooden joints and dowels, miniature handmade set pieces, warm craft workshop lighting. Laika Studios / Wes Anderson stop-motion aesthetic.', negative_prompt: 'NOT photorealistic, NOT 3D render, NOT digital, NOT anime, NOT smooth surfaces, NOT plastic.', scene_prefix: 'Stop-motion style, handcrafted felt and wood puppets, miniature set, warm workshop lighting.', lighting: 'Warm practical miniature lighting, macro photography detail' },
    { id: 'minecraft', label: 'Minecraft', color: '#8BC34A', style_instruction: 'Minecraft voxel art style, blocky cubic geometry, pixel textures, 16x16 texture resolution aesthetic, square heads and bodies. Everything made of cubes and rectangular prisms. Minecraft game screenshot aesthetic.', negative_prompt: 'NOT smooth, NOT round, NOT photorealistic, NOT anime, NOT organic curves, NOT high-poly.', scene_prefix: 'Minecraft style, blocky voxel world, pixel textures, cubic geometry, game screenshot aesthetic.', lighting: 'Minecraft-style ambient lighting, block shadows' },
    { id: 'oil_painting', label: 'Oil Painting', color: '#FFC107', style_instruction: 'Classical oil painting on canvas, visible thick brushstrokes, rich impasto texture, warm color palette, chiaroscuro lighting. Renaissance masters meets impressionist technique. Museum-quality fine art painting.', negative_prompt: 'NOT photorealistic, NOT digital art, NOT 3D render, NOT anime, NOT flat colors, NOT cartoon.', scene_prefix: 'Oil painting style, visible brushstrokes, rich impasto texture, warm palette, dramatic chiaroscuro lighting.', lighting: 'Dramatic chiaroscuro lighting, rich tonal depth' },
    { id: 'watercolor', label: 'Watercolor', color: '#03A9F4', style_instruction: 'Soft watercolor painting on cold-press paper, loose wet brushwork, translucent color washes bleeding into each other, white paper showing through. Delicate ink outlines, impressionistic and dreamy.', negative_prompt: 'NOT photorealistic, NOT 3D render, NOT digital art, NOT anime, NOT sharp edges, NOT bold outlines.', scene_prefix: 'Watercolor painting style, soft wet brushwork, translucent color washes, delicate ink outlines.', lighting: 'Soft diffused natural light, watercolor wash' },
    { id: 'claymation', label: 'Claymation', color: '#FF5722', style_instruction: 'Clay animation style, characters made of modeling clay with visible fingerprint textures, slightly imperfect sculpted features. Wallace & Gromit / Aardman aesthetic, miniature handmade sets, warm practical lighting on tiny clay world.', negative_prompt: 'NOT photorealistic, NOT digital, NOT anime, NOT smooth skin, NOT 3D render, NOT glass or metal surfaces.', scene_prefix: 'Claymation style, clay puppet characters with fingerprint textures, miniature handmade sets, warm practical lighting.', lighting: 'Warm miniature set lighting, soft shadows, macro detail' },
    { id: 'lego', label: 'LEGO', color: '#F44336', style_instruction: 'LEGO brick style, characters are LEGO minifigures with yellow skin and claw hands, environments built entirely from LEGO bricks and plates. Visible brick studs, ABS plastic texture, The LEGO Movie aesthetic.', negative_prompt: 'NOT photorealistic, NOT organic, NOT smooth, NOT anime, NOT round shapes, NOT natural materials.', scene_prefix: 'LEGO style, minifigure characters, brick-built environments, visible studs, plastic ABS texture.', lighting: 'Bright toy photography lighting, sharp focus, product shot quality' },
    { id: 'retro_vhs', label: 'Retro VHS', color: '#9E9E9E', style_instruction: '1980s VHS tape aesthetic, analog video noise and scan lines, slightly washed-out warm colors, CRT TV curvature, tracking artifacts. Retro camcorder footage feel, date stamp overlay, nostalgic grain.', negative_prompt: 'NOT modern, NOT 4K, NOT clean, NOT digital, NOT anime, NOT sharp, NOT high-definition.', scene_prefix: 'Retro VHS style, analog scan lines, warm washed-out colors, CRT curvature, nostalgic 80s grain.', lighting: 'Warm tungsten lighting, CRT glow, analog video bloom' },
];

function EntitiesTab({ profiles, onOpenProfile, onWaitForProfileReady, onOpenLightbox }: EntitiesTabProps) {
    const { generating, lastResult, error, generateEntity, upscaleEntity, reset: resetResult } = useEntities();
    const [generatingEntity, setGeneratingEntity] = useState<{
        name: string;
        entityType: string;
        materialId: string;
        materialStyle: any;
        profileId: string;
        projectId?: string;
        modelKey: string;
        aspectRatio: string;
        upscaleResolution: string;
    } | null>(null);
    const [entities, setEntities] = useState<EntityReference[]>([]);
    const [loading, setLoading] = useState(true);
    const [upscallingId, setUpscallingId] = useState<string | null>(null);
    // Cascading selectors
    const [selectedProjectName, setSelectedProjectName] = useState<string>('');
    const [selectedProfileIdx, setSelectedProfileIdx] = useState<number>(0);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [entityType, setEntityType] = useState('character');
    const [materialId, setMaterialId] = useState('3d_pixar');
    const [modelKey, setModelKey] = useState('NANO_BANANA_PRO');
    const [aspectRatio, setAspectRatio] = useState('IMAGE_ASPECT_RATIO_PORTRAIT');
    const [upscaleResolution, setUpscaleResolution] = useState('UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL');
    const [filter, setFilter] = useState<string>('all');
    // Material style manager
    const [materials, setMaterials] = useState<MaterialStyle[]>(DEFAULT_MATERIALS);
    const [showMaterialEditor, setShowMaterialEditor] = useState(false);
    const [editingMaterial, setEditingMaterial] = useState<MaterialStyle | null>(null);
    const [materialForm, setMaterialForm] = useState<MaterialStyle>({ id: '', label: '', color: '#4CAF50', style_instruction: '', negative_prompt: '', scene_prefix: '', lighting: '' });
    const [entityTypePrompts, setEntityTypePrompts] = useState<Record<string, string>>({});
    const [showEntityTypeEditor, setShowEntityTypeEditor] = useState(false);
    const [editingEntityType, setEditingEntityType] = useState<string | null>(null);
    const [entityTypeForm, setEntityTypeForm] = useState({ value: '', prompt: '' });

    const DEFAULT_ENTITY_PROMPTS: Record<string, string> = {
        character: 'Comprehensive character design sheet layout. Must include four distinct sections: 1. Body shots (Full body, half body, three-quarter body, and close-up). 2. Multi-angle character turnaround (A three-view: front, side, back rotation chart). 3. Expression sheet (Showing basic emotional states). 4. Pose sheet (Showing typical actions). Use a clean, neutral background.',
        location: 'Comprehensive environment design sheet layout. Must include four distinct sections: 1. Master establishing shot (Wide angle showing the full environment). 2. Alternate angle (Reverse shot or different perspective). 3. Detail callouts (Close-up of key architectural, natural, or thematic details). 4. Lighting/Mood variation (Showing how the environment looks under different lighting or weather conditions). Maintain consistent spatial layout and atmosphere.',
        creature: 'Comprehensive creature design sheet layout. Must include four distinct sections: 1. Body shots (Full body and close-up of face/head). 2. Multi-angle turnaround (Front, side, and back views). 3. Action/Movement poses (Showing natural stance, locomotion, or attack pose). 4. Detail callouts (Close-ups of specific anatomical features like claws, scales, or wings). Use a clean, neutral background.',
        visual_asset: 'Comprehensive prop and asset design sheet layout. Must include four distinct sections: 1. Main beauty shot (Angled three-quarter perspective). 2. Orthographic views (Top, front, and side profiles). 3. Functional/Mechanical views (Showing how it opens, moves, or is held/used). 4. Material/Texture detail (Close-ups showcasing the surface materials and wear/tear). Use a clean, neutral background with proper scale reference.',
        generic_troop: 'Comprehensive troop and uniform design sheet layout. Must include four distinct sections: 1. Uniform turnaround (Front, side, and back views of the standard loadout). 2. Gear breakdown (Detailed callouts of weapons, armor, and equipment). 3. Rank/Class variations (Showing slight modifications for different roles). 4. Action poses (Showing the troop in a combat or tactical stance). Use a clean, neutral background.',
        faction: 'Comprehensive faction uniform design sheet layout. Must include four distinct sections: 1. Uniform turnaround (Front, side, and back views of the standard loadout). 2. Gear breakdown (Detailed callouts of weapons, armor, and equipment). 3. Rank/Class variations (Showing slight modifications for different roles). 4. Action poses (Showing the troop in a combat or tactical stance). Use a clean, neutral background.',
    };

    const ENTITY_TYPES = [
        { value: 'character', label: 'Character', icon: '👤' },
        { value: 'location', label: 'Location', icon: '🏔️' },
        { value: 'creature', label: 'Creature', icon: '🐉' },
        { value: 'visual_asset', label: 'Visual Asset', icon: '⚔️' },
        { value: 'generic_troop', label: 'Troop', icon: '🛡️' },
        { value: 'faction', label: 'Faction', icon: '🏴' },
    ];

    // Group profiles by project name (cascading)
    type ProjectEntry = { profile: Profile; projectIdx: number; projectName: string };
    const projectGroups: Record<string, ProjectEntry[]> = {};
    profiles.forEach((profile) => {
        const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
        flowProjects.forEach((proj: any, idx: number) => {
            const name = proj.name || `Project ${idx + 1}`;
            if (!projectGroups[name]) projectGroups[name] = [];
            projectGroups[name].push({ profile, projectIdx: idx, projectName: name });
        });
    });

    const projectNames = Object.keys(projectGroups).sort();
    const selectedEntries = projectGroups[selectedProjectName] || [];
    const selectedEntry = selectedEntries[selectedProfileIdx];
    const selectedProfile = selectedEntry?.profile;
    const selectedProjectIdx = selectedEntry?.projectIdx ?? 0;
    const selectedProjectObj = selectedProfile ? (selectedProfile.metadata as any)?.flowProjects?.[selectedProjectIdx] : null;

    // Load all entities globally
    const loadEntities = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/entities');
            const data = await res.json();
            if (data.success) {
                setEntities(data.data);
            }
        } catch (e) {
            console.error('Failed to load entities:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadEntities();
    }, [loadEntities]);

    const handleGenerate = async () => {
        if (!selectedProfile || !name.trim() || generating) return;

        const selectedMaterial = materials.find(m => m.id === materialId);

        // Track generation params for potential regenerate
        setGeneratingEntity({
            name: name.trim(),
            entityType,
            materialId,
            materialStyle: selectedMaterial,
            profileId: selectedProfile.id,
            projectId: selectedProjectObj?.projectId,
            modelKey,
            aspectRatio,
            upscaleResolution,
        });

        // Auto-open profile if not already running and wait for it to be ready
        if (selectedProfile.status !== 'running') {
            if (onOpenProfile) {
                try {
                    await onOpenProfile(selectedProfile.id);
                } catch (e) {
                    console.warn('Could not auto-open profile:', e);
                }
            }
        }

        // Wait for profile to be ready (extension connected, flowKey captured)
        if (onWaitForProfileReady) {
            try {
                await onWaitForProfileReady(selectedProfile.id, 30000);
            } catch (e) {
                console.warn('Profile may not be fully ready:', e);
            }
        }

        try {
            const result = await generateEntity({
                name: name.trim(),
                description: description.trim(),
                entityType,
                materialId,
                profileId: selectedProfile.id,
                projectId: selectedProjectObj?.projectId,
                materialStyle: selectedMaterial,
                modelKey,
                aspectRatio,
                upscaleResolution,
                entityTypePrompt: entityTypePrompts[entityType],
            });
            if (result) {
                setEntities(prev => [result, ...prev]);
                setName('');
                setDescription('');
            }
        } catch (e) {
            // error is surfaced via `error` prop from useEntities
        } finally {
            setGeneratingEntity(null);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Delete this entity?')) return;
        try {
            const res = await fetch(`/api/entities/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                setEntities(prev => prev.filter(e => e.id !== id));
            }
        } catch (e) {
            alert('Failed to delete entity');
        }
    };

    const handleRegenerate = async (entity: EntityReference) => {
        if (generating) return;

        // Parse materialStyle from metadata
        let materialStyle: any = null;
        try {
            if (entity.metadata) {
                materialStyle = JSON.parse(entity.metadata);
            }
        } catch (e) {
            // Use default material style
        }

        // Get material from materials list or create one from metadata
        const materialId = entity.materialId;
        let selectedMaterial = materials.find(m => m.id === materialId);
        if (!selectedMaterial && materialStyle) {
            selectedMaterial = materialStyle;
        }
        if (!selectedMaterial) {
            selectedMaterial = materials.find(m => m.id === '3d_pixar');
        }

        // Set generating entity state
        setGeneratingEntity({
            name: entity.name,
            entityType: entity.entityType,
            materialId: entity.materialId,
            materialStyle: selectedMaterial,
            profileId: entity.profileId,
            projectId: entity.projectId,
            modelKey: 'NANO_BANANA_PRO',
            aspectRatio: entity.aspectRatio || 'IMAGE_ASPECT_RATIO_PORTRAIT',
            upscaleResolution: entity.upscaleResolution || 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
        });

        try {
            const result = await generateEntity({
                name: entity.name,
                description: entity.description,
                entityType: entity.entityType,
                materialId: entity.materialId,
                profileId: entity.profileId,
                projectId: entity.projectId,
                materialStyle: selectedMaterial,
                modelKey: 'NANO_BANANA_PRO',
                aspectRatio: entity.aspectRatio || 'IMAGE_ASPECT_RATIO_PORTRAIT',
                upscaleResolution: entity.upscaleResolution || 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
                entityTypePrompt: entityTypePrompts[entity.entityType],
            });
            if (result) {
                setEntities(prev => [result, ...prev]);
            }
        } catch (e) {
            // error is surfaced via `error` prop from useEntities
        } finally {
            setGeneratingEntity(null);
        }
    };

    const handleUpscale = async (id: string, resolution: string) => {
        const resolutionLabel = resolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '4K' : '2K';
        if (!confirm(`Upscale to ${resolutionLabel}? This will replace the current image.`)) return;

        setUpscallingId(id);
        try {
            const updated = await upscaleEntity(id, resolution);
            if (updated) {
                setEntities(prev => prev.map(e => e.id === id ? updated : e));
            }
        } catch (e: any) {
            alert(`Upscale failed: ${e.message}`);
        } finally {
            setUpscallingId(null);
        }
    };

    const getEntityIcon = (type: string) => ENTITY_TYPES.find(t => t.value === type)?.icon || '📦';
    const getMaterialColor = (id: string) => materials.find(m => m.value === id)?.color || materials.find(m => m.id === id)?.color || '#666';
    const getMaterialLabel = (id: string) => materials.find(m => m.value === id)?.label || materials.find(m => m.id === id)?.label || id;

    const filteredEntities = filter === 'all'
        ? entities
        : entities.filter(e => e.entityType === filter);

    // Material style editor handlers
    const openAddMaterial = () => {
        setMaterialForm({ id: '', label: '', color: '#4CAF50', style_instruction: '', negative_prompt: '', scene_prefix: '', lighting: '' });
        setEditingMaterial(null);
        setShowMaterialEditor(true);
    };

    const openEditMaterial = (mat: MaterialStyle) => {
        setMaterialForm({ ...mat });
        setEditingMaterial(mat);
        setShowMaterialEditor(true);
    };

    const saveMaterial = () => {
        if (!materialForm.id.trim() || !materialForm.label.trim()) {
            alert('ID and Label are required');
            return;
        }
        if (editingMaterial) {
            setMaterials(prev => prev.map(m => m.id === editingMaterial.id ? { ...materialForm, id: materialForm.id } : m));
        } else {
            if (materials.find(m => m.id === materialForm.id)) {
                alert('Material ID already exists');
                return;
            }
            setMaterials(prev => [...prev, { ...materialForm }]);
        }
        setShowMaterialEditor(false);
    };

    const deleteMaterial = (id: string) => {
        if (!confirm('Delete material "' + materials.find(m => m.id === id)?.label + '"?')) return;
        setMaterials(prev => prev.filter(m => m.id !== id));
    };

    const openEntityTypeEditor = (typeValue: string) => {
        setEditingEntityType(typeValue);
        setEntityTypeForm({ value: typeValue, prompt: entityTypePrompts[typeValue] || DEFAULT_ENTITY_PROMPTS[typeValue] || '' });
        setShowEntityTypeEditor(true);
    };

    const saveEntityTypePrompt = () => {
        setEntityTypePrompts(prev => ({ ...prev, [entityTypeForm.value]: entityTypeForm.prompt }));
        setShowEntityTypeEditor(false);
        setEditingEntityType(null);
    };

    return (
        <>
            <div className="content-header">
                <div className="header-left">
                    <h2><span>🎭</span> Entity Library</h2>
                </div>
            </div>
            <div className="content-body">
                <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', gap: '24px' }}>
                    {/* Left: Generate Form */}
                    <div className="profile-card">
                        <div className="profile-header">
                            <div className="profile-title">
                                <div className="profile-avatar">✨</div>
                                <div>
                                    <div className="profile-name">Generate Entity</div>
                                    <div className="profile-path">Create reference images for projects</div>
                                </div>
                            </div>
                        </div>
                        <div style={{ padding: '16px' }}>
                            {projectNames.length === 0 ? (
                                <div className="empty-state">
                                    <p>No profiles with Flow projects available.</p>
                                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Create a Flow project first.</p>
                                </div>
                            ) : (
                                <>
                                    {/* Cascading: Project → Profile */}
                                    <div className="form-group">
                                        <label className="form-label">Project</label>
                                        <select
                                            className="form-input"
                                            value={selectedProjectName}
                                            onChange={(e) => {
                                                setSelectedProjectName(e.target.value);
                                                setSelectedProfileIdx(0);
                                            }}
                                        >
                                            <option value="">-- Chọn project --</option>
                                            {projectNames.map(name => (
                                                <option key={name} value={name}>{name} ({projectGroups[name].length} profile)</option>
                                            ))}
                                        </select>
                                    </div>

                                    {selectedProjectName && selectedEntries.length > 1 && (
                                        <div className="form-group">
                                            <label className="form-label">Profile trong dự án</label>
                                            <select
                                                className="form-input"
                                                value={selectedProfileIdx}
                                                onChange={(e) => setSelectedProfileIdx(Number(e.target.value))}
                                            >
                                                {selectedEntries.map((entry, idx) => (
                                                    <option key={idx} value={idx}>{entry.profile.name} (Tier: {entry.profile.tier || 'N/A'})</option>
                                                ))}
                                            </select>
                                        </div>
                                    )}

                                    {selectedProfile && (
                                        <div style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '0.82rem', marginBottom: '12px' }}>
                                            <div><strong>Profile:</strong> {selectedProfile.name}</div>
                                            <div><strong>Project ID:</strong> <code>{selectedProjectObj?.projectId || '(chưa có)'}</code></div>
                                        </div>
                                    )}

                                    <div className="form-group">
                                        <label className="form-label">Entity Name *</label>
                                        <input
                                            type="text"
                                            className="form-input"
                                            placeholder="e.g., Hero Warrior"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                        />
                                    </div>

                                    <div className="form-group">
                                        <label className="form-label">Description</label>
                                        <textarea
                                            className="form-input"
                                            rows={2}
                                            placeholder="A brave knight in silver armor with a crimson cape..."
                                            value={description}
                                            onChange={(e) => setDescription(e.target.value)}
                                            style={{ resize: 'vertical' }}
                                        />
                                    </div>

                                    <div className="form-group">
                                        <label className="form-label">Entity Type</label>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                                            {ENTITY_TYPES.map(type => (
                                                <div
                                                    key={type.value}
                                                    style={{ position: 'relative' }}
                                                >
                                                    <div
                                                        onClick={() => setEntityType(type.value)}
                                                        style={{
                                                            padding: '8px 6px',
                                                            borderRadius: '8px',
                                                            background: entityType === type.value ? 'var(--primary-color)' : 'var(--bg-secondary)',
                                                            color: entityType === type.value ? 'white' : 'var(--text)',
                                                            cursor: 'pointer',
                                                            textAlign: 'center',
                                                            transition: 'all 0.2s',
                                                            border: entityType === type.value ? '2px solid var(--primary-color)' : '2px solid transparent',
                                                        }}
                                                    >
                                                        <div style={{ fontSize: '1rem' }}>{type.icon}</div>
                                                        <div style={{ fontSize: '0.7rem' }}>{type.label}</div>
                                                    </div>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); openEntityTypeEditor(type.value); }}
                                                        style={{
                                                            position: 'absolute',
                                                            top: '-4px',
                                                            right: '-4px',
                                                            width: '16px',
                                                            height: '16px',
                                                            borderRadius: '50%',
                                                            background: entityTypePrompts[type.value] ? 'var(--primary-color)' : 'var(--text-secondary)',
                                                            color: 'white',
                                                            border: 'none',
                                                            cursor: 'pointer',
                                                            fontSize: '9px',
                                                            lineHeight: '16px',
                                                            textAlign: 'center',
                                                            padding: 0,
                                                        }}
                                                        title="Edit entity type prompt"
                                                    >✎</button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="form-group">
                                        <label className="form-label">Model</label>
                                        <select
                                            className="form-input"
                                            value={modelKey}
                                            onChange={(e) => setModelKey(e.target.value)}
                                        >
                                            <option value="NANO_BANANA_PRO">NANO_BANANA_PRO</option>
                                            <option value="NANO_BANANA_2">NANO_BANANA_2</option>
                                            <option value="IMAGEN_4">IMAGEN_4</option>
                                        </select>
                                    </div>

                                    <div className="form-group">
                                        <label className="form-label">Tỷ lệ khung hình</label>
                                        <select
                                            className="form-input"
                                            value={aspectRatio}
                                            onChange={(e) => setAspectRatio(e.target.value)}
                                        >
                                            <option value="IMAGE_ASPECT_RATIO_LANDSCAPE">16:9 Ngang (Landscape)</option>
                                            <option value="IMAGE_ASPECT_RATIO_PORTRAIT">9:16 Dọc (Portrait)</option>
                                            <option value="IMAGE_ASPECT_RATIO_SQUARE">1:1 Vuông (Square)</option>
                                            <option value="IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE">4:3 Ngang (Classic)</option>
                                            <option value="IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR">3:4 Dọc (Portrait 3:4)</option>
                                        </select>
                                    </div>

                                    <div className="form-group">
                                        <label className="form-label">Upscale Resolution</label>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                                            <div
                                                onClick={() => setUpscaleResolution('UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL')}
                                                style={{
                                                    padding: '8px 6px',
                                                    borderRadius: '8px',
                                                    background: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' ? '#6366f1' : 'var(--bg-secondary)',
                                                    color: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' ? 'white' : 'var(--text)',
                                                    cursor: 'pointer',
                                                    textAlign: 'center',
                                                    transition: 'all 0.2s',
                                                    border: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' ? '2px solid #6366f1' : '2px solid transparent',
                                                }}
                                            >
                                                <div style={{ fontSize: '1rem' }}>📷</div>
                                                <div style={{ fontSize: '0.7rem' }}>Original</div>
                                            </div>
                                            <div
                                                onClick={() => setUpscaleResolution('UPSAMPLE_IMAGE_RESOLUTION_2K')}
                                                style={{
                                                    padding: '8px 6px',
                                                    borderRadius: '8px',
                                                    background: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_2K' ? '#22c55e' : 'var(--bg-secondary)',
                                                    color: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_2K' ? 'white' : 'var(--text)',
                                                    cursor: 'pointer',
                                                    textAlign: 'center',
                                                    transition: 'all 0.2s',
                                                    border: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_2K' ? '2px solid #22c55e' : '2px solid transparent',
                                                }}
                                            >
                                                <div style={{ fontSize: '1rem' }}>🖼️</div>
                                                <div style={{ fontSize: '0.7rem' }}>2K</div>
                                            </div>
                                            <div
                                                onClick={() => setUpscaleResolution('UPSAMPLE_IMAGE_RESOLUTION_4K')}
                                                style={{
                                                    padding: '8px 6px',
                                                    borderRadius: '8px',
                                                    background: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '#f59e0b' : 'var(--bg-secondary)',
                                                    color: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? 'white' : 'var(--text)',
                                                    cursor: 'pointer',
                                                    textAlign: 'center',
                                                    transition: 'all 0.2s',
                                                    border: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '2px solid #f59e0b' : '2px solid transparent',
                                                }}
                                            >
                                                <div style={{ fontSize: '1rem' }}>🏔️</div>
                                                <div style={{ fontSize: '0.7rem' }}>4K</div>
                                            </div>
                                        </div>
                                    </div>

                                    {selectedProfile && (
                                        <div style={{ padding: '10px 12px', background: selectedProfile.tier === 'PAYGATE_TIER_TWO' ? 'rgba(255, 215, 0, 0.1)' : 'rgba(59, 130, 246, 0.1)', borderRadius: '6px', fontWeight: 600, color: selectedProfile.tier === 'PAYGATE_TIER_TWO' ? '#ffd700' : '#3b82f6' }}>
                                            Tier: {selectedProfile.tier === 'PAYGATE_TIER_TWO' ? '👑 Ultra' : '⭐ Pro'}
                                            <span style={{ marginLeft: '8px', fontSize: '0.8rem', opacity: 0.7 }}>({selectedProfile.tier})</span>
                                        </div>
                                    )}

                                    <div className="form-group">
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                            <label className="form-label" style={{ margin: 0 }}>Material Style</label>
                                            <button
                                                className="btn btn-ghost"
                                                style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                                                onClick={openAddMaterial}
                                            >
                                                + Add
                                            </button>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                                            {materials.map(mat => (
                                                <div key={mat.id} style={{ position: 'relative' }}>
                                                    <div
                                                        onClick={() => setMaterialId(mat.id)}
                                                        style={{
                                                            padding: '6px 12px',
                                                            borderRadius: '16px',
                                                            background: materialId === mat.id ? mat.color : 'var(--bg-secondary)',
                                                            color: materialId === mat.id ? 'white' : 'var(--text)',
                                                            cursor: 'pointer',
                                                            fontSize: '0.8rem',
                                                            transition: 'all 0.2s',
                                                            border: materialId === mat.id ? '2px solid ' + mat.color : '2px solid transparent',
                                                        }}
                                                    >
                                                        {mat.label}
                                                    </div>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); openEditMaterial(mat); }}
                                                        style={{
                                                            position: 'absolute',
                                                            top: '-4px',
                                                            right: '-4px',
                                                            width: '16px',
                                                            height: '16px',
                                                            borderRadius: '50%',
                                                            background: 'var(--text-secondary)',
                                                            color: 'white',
                                                            border: 'none',
                                                            cursor: 'pointer',
                                                            fontSize: '10px',
                                                            lineHeight: '16px',
                                                            textAlign: 'center',
                                                            padding: 0,
                                                        }}
                                                        title="Edit material"
                                                    >✎</button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <button
                                        className="btn btn-primary"
                                        onClick={handleGenerate}
                                        disabled={!selectedProfile || !name.trim() || generating}
                                        style={{ width: '100%', marginTop: '8px' }}
                                    >
                                        {generating ? '⏳ Generating...' : '✨ Generate'}
                                    </button>

                                    {/* Error display */}
                                    {error && (
                                        <div style={{ color: 'var(--error)', fontSize: '0.9rem', marginTop: '12px', padding: '8px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px' }}>
                                            ✗ {error}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {/* Right: Entity Gallery */}
                    <div>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                            <div
                                onClick={() => setFilter('all')}
                                style={{
                                    padding: '8px 16px',
                                    borderRadius: '20px',
                                    background: filter === 'all' ? 'var(--primary-color)' : 'var(--bg-secondary)',
                                    color: filter === 'all' ? 'white' : 'var(--text)',
                                    cursor: 'pointer',
                                }}
                            >
                                All ({entities.length})
                            </div>
                            {ENTITY_TYPES.map(type => {
                                const count = entities.filter(e => e.entityType === type.value).length;
                                return (
                                    <div
                                        key={type.value}
                                        onClick={() => setFilter(type.value)}
                                        style={{
                                            padding: '8px 16px',
                                            borderRadius: '20px',
                                            background: filter === type.value ? 'var(--primary-color)' : 'var(--bg-secondary)',
                                            color: filter === type.value ? 'white' : 'var(--text)',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {type.icon} {type.label} ({count})
                                    </div>
                                );
                            })}
                        </div>

                        {loading ? (
                            <div className="loading-spinner">Loading...</div>
                        ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
                                {/* Generating Card */}
                                {generatingEntity && (
                                    <div className="profile-card" style={{ overflow: 'hidden', border: '2px dashed var(--primary-color)' }}>
                                        <div style={{ position: 'relative', paddingTop: '100%', background: 'var(--bg-secondary)' }}>
                                            <div style={{
                                                position: 'absolute',
                                                top: 0,
                                                left: 0,
                                                width: '100%',
                                                height: '100%',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(168, 85, 247, 0.1) 100%)',
                                            }}>
                                                <div style={{
                                                    width: '60px',
                                                    height: '60px',
                                                    border: '4px solid var(--primary-color)',
                                                    borderTop: '4px solid transparent',
                                                    borderRadius: '50%',
                                                    animation: 'spin 1s linear infinite',
                                                    marginBottom: '12px',
                                                }} />
                                                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary-color)' }}>
                                                    Generating...
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px', textAlign: 'center', padding: '0 8px' }}>
                                                    {generatingEntity.name}
                                                </div>
                                            </div>
                                            <div style={{
                                                position: 'absolute',
                                                top: '8px',
                                                left: '8px',
                                                background: getMaterialColor(generatingEntity.materialId),
                                                color: 'white',
                                                padding: '2px 8px',
                                                borderRadius: '10px',
                                                fontSize: '0.7rem',
                                                fontWeight: 600,
                                            }}>
                                                {getMaterialLabel(generatingEntity.materialId)}
                                            </div>
                                            <div style={{
                                                position: 'absolute',
                                                top: '8px',
                                                right: '8px',
                                                background: 'rgba(0,0,0,0.7)',
                                                padding: '4px 8px',
                                                borderRadius: '4px',
                                                fontSize: '1rem',
                                            }}>
                                                {getEntityIcon(generatingEntity.entityType)}
                                            </div>
                                        </div>
                                        <div style={{ padding: '12px' }}>
                                            <div style={{ fontWeight: 600, marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {generatingEntity.name}
                                            </div>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                🔄 In progress...
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Regular Entity Cards */}
                                {filteredEntities.map(entity => (
                                    <div key={entity.id} className="profile-card" style={{ overflow: 'hidden' }}>
                                        <div style={{ position: 'relative', paddingTop: '100%', background: 'var(--bg-secondary)', cursor: 'pointer' }}>
                                            {entity.localPath ? (
                                                <img
                                                    src={`/data/entity-references/${entity.profileId}/${getFileName(entity.localPath)}`}
                                                    alt={entity.name}
                                                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                                                    onClick={() => onOpenLightbox?.(`/data/entity-references/${entity.profileId}/${getFileName(entity.localPath)}`, entity.name)}
                                                />
                                            ) : entity.remoteUrl ? (
                                                <img
                                                    src={entity.remoteUrl}
                                                    alt={entity.name}
                                                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                                                    onClick={() => onOpenLightbox?.(entity.remoteUrl, entity.name)}
                                                />
                                            ) : (
                                                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: '3rem' }}>
                                                    {getEntityIcon(entity.entityType)}
                                                </div>
                                            )}
                                            <div style={{
                                                position: 'absolute',
                                                top: '8px',
                                                left: '8px',
                                                background: getMaterialColor(entity.materialId),
                                                color: 'white',
                                                padding: '2px 8px',
                                                borderRadius: '10px',
                                                fontSize: '0.7rem',
                                                fontWeight: 600,
                                            }}>
                                                {getMaterialLabel(entity.materialId)}
                                            </div>
                                            {/* Resolution badge */}
                                            {entity.mediaId?.endsWith('_2k') && (
                                                <div style={{
                                                    position: 'absolute',
                                                    bottom: '8px',
                                                    left: '8px',
                                                    background: '#22c55e',
                                                    color: 'white',
                                                    padding: '2px 6px',
                                                    borderRadius: '4px',
                                                    fontSize: '0.65rem',
                                                    fontWeight: 700,
                                                }}>
                                                    2K
                                                </div>
                                            )}
                                            {entity.mediaId?.endsWith('_4k') && (
                                                <div style={{
                                                    position: 'absolute',
                                                    bottom: '8px',
                                                    left: '8px',
                                                    background: '#f59e0b',
                                                    color: 'white',
                                                    padding: '2px 6px',
                                                    borderRadius: '4px',
                                                    fontSize: '0.65rem',
                                                    fontWeight: 700,
                                                }}>
                                                    4K
                                                </div>
                                            )}
                                            <div style={{
                                                position: 'absolute',
                                                top: '8px',
                                                right: '8px',
                                                background: 'rgba(0,0,0,0.7)',
                                                padding: '4px 8px',
                                                borderRadius: '4px',
                                                fontSize: '1rem',
                                            }}>
                                                {getEntityIcon(entity.entityType)}
                                            </div>
                                        </div>
                                        <div style={{ padding: '12px' }}>
                                            <div style={{ fontWeight: 600, marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {entity.name}
                                            </div>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                                                {new Date(entity.createdAt).toLocaleDateString()}
                                            </div>
                                            {/* Upscale buttons */}
                                            <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                                                <button
                                                    className="btn btn-small"
                                                    onClick={() => handleUpscale(entity.id, 'UPSAMPLE_IMAGE_RESOLUTION_2K')}
                                                    disabled={upscallingId === entity.id}
                                                    style={{
                                                        flex: 1,
                                                        padding: '4px 6px',
                                                        fontSize: '0.75rem',
                                                        background: entity.mediaId?.endsWith('_2k') ? '#22c55e' : 'var(--bg-secondary)',
                                                        color: entity.mediaId?.endsWith('_2k') ? 'white' : 'var(--text)',
                                                        border: '1px solid var(--border)',
                                                        borderRadius: '4px',
                                                        cursor: upscallingId === entity.id ? 'wait' : 'pointer',
                                                    }}
                                                >
                                                    {upscallingId === entity.id ? '⏳' : '🖼️'} 2K
                                                </button>
                                                <button
                                                    className="btn btn-small"
                                                    onClick={() => handleUpscale(entity.id, 'UPSAMPLE_IMAGE_RESOLUTION_4K')}
                                                    disabled={upscallingId === entity.id}
                                                    style={{
                                                        flex: 1,
                                                        padding: '4px 6px',
                                                        fontSize: '0.75rem',
                                                        background: entity.mediaId?.endsWith('_4k') ? '#f59e0b' : 'var(--bg-secondary)',
                                                        color: entity.mediaId?.endsWith('_4k') ? 'white' : 'var(--text)',
                                                        border: '1px solid var(--border)',
                                                        borderRadius: '4px',
                                                        cursor: upscallingId === entity.id ? 'wait' : 'pointer',
                                                    }}
                                                >
                                                    {upscallingId === entity.id ? '⏳' : '🏔️'} 4K
                                                </button>
                                            </div>
                                            <button
                                                className="btn btn-ghost"
                                                onClick={() => handleDelete(entity.id)}
                                                style={{ width: '100%', fontSize: '0.85rem', padding: '6px' }}
                                            >
                                                🗑️ Delete
                                            </button>
                                            <button
                                                className="btn btn-ghost"
                                                onClick={() => handleRegenerate(entity)}
                                                disabled={generating}
                                                style={{
                                                    width: '100%',
                                                    fontSize: '0.85rem',
                                                    padding: '6px',
                                                    marginTop: '4px',
                                                    background: 'var(--bg-secondary)',
                                                    color: 'var(--text)',
                                                }}
                                            >
                                                🔄 Regenerate
                                            </button>
                                        </div>
                                    </div>
                                ))}

                                {/* Empty State */}
                                {filteredEntities.length === 0 && !generatingEntity && (
                                    <div className="empty-state">
                                        <div style={{ fontSize: '3rem' }}>🎭</div>
                                        <p>No entities yet</p>
                                        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                            Generate your first entity reference image!
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Material Style Editor Modal */}
            {showMaterialEditor && (
                <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && setShowMaterialEditor(false)}>
                    <div className="modal" style={{ maxWidth: '700px', maxHeight: '90vh', overflowY: 'auto' }}>
                        <div className="modal-header">
                            <h3>{editingMaterial ? '✏️ Edit Material Style' : '➕ Add Material Style'}</h3>
                            <button className="modal-close" onClick={() => setShowMaterialEditor(false)}>×</button>
                        </div>
                        <div className="modal-body">
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                <div className="form-group">
                                    <label className="form-label">ID *</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="e.g., my_custom_style"
                                        value={materialForm.id}
                                        onChange={(e) => setMaterialForm(f => ({ ...f, id: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
                                        disabled={!!editingMaterial}
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Label *</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="e.g., My Custom Style"
                                        value={materialForm.label}
                                        onChange={(e) => setMaterialForm(f => ({ ...f, label: e.target.value }))}
                                    />
                                </div>
                            </div>
                            <div className="form-group">
                                <label className="form-label">Color</label>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <input
                                        type="color"
                                        value={materialForm.color}
                                        onChange={(e) => setMaterialForm(f => ({ ...f, color: e.target.value }))}
                                        style={{ width: '40px', height: '36px', padding: '2px', borderRadius: '6px', border: '1px solid var(--border)', cursor: 'pointer' }}
                                    />
                                    <input
                                        type="text"
                                        className="form-input"
                                        value={materialForm.color}
                                        onChange={(e) => setMaterialForm(f => ({ ...f, color: e.target.value }))}
                                        style={{ flex: 1 }}
                                    />
                                </div>
                            </div>
                            <div className="form-group">
                                <label className="form-label">Style Instruction (prompt chính)</label>
                                <textarea
                                    className="form-input"
                                    rows={3}
                                    placeholder="3D animated style, Pixar-quality rendering..."
                                    value={materialForm.style_instruction}
                                    onChange={(e) => setMaterialForm(f => ({ ...f, style_instruction: e.target.value }))}
                                    style={{ resize: 'vertical' }}
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">Negative Prompt (tránh)</label>
                                <textarea
                                    className="form-input"
                                    rows={2}
                                    placeholder="NOT photorealistic, NOT 3D render..."
                                    value={materialForm.negative_prompt}
                                    onChange={(e) => setMaterialForm(f => ({ ...f, negative_prompt: e.target.value }))}
                                    style={{ resize: 'vertical' }}
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">Scene Prefix</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="3D animated Pixar-quality rendering..."
                                    value={materialForm.scene_prefix}
                                    onChange={(e) => setMaterialForm(f => ({ ...f, scene_prefix: e.target.value }))}
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">Lighting</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="Studio lighting, global illumination..."
                                    value={materialForm.lighting}
                                    onChange={(e) => setMaterialForm(f => ({ ...f, lighting: e.target.value }))}
                                />
                            </div>
                            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                                <button className="btn btn-primary" onClick={saveMaterial} style={{ flex: 1 }}>
                                    💾 Save
                                </button>
                                {editingMaterial && (
                                    <>
                                        <button className="btn btn-ghost" onClick={() => deleteMaterial(editingMaterial.id)} style={{ color: 'var(--error)' }}>
                                            🗑️ Delete
                                        </button>
                                        <button className="btn btn-ghost" onClick={() => setShowMaterialEditor(false)}>
                                            Cancel
                                        </button>
                                    </>
                                )}
                                {!editingMaterial && (
                                    <button className="btn btn-ghost" onClick={() => setShowMaterialEditor(false)}>
                                        Cancel
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Entity Type Prompt Editor Modal */}
            {showEntityTypeEditor && (
                <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && setShowEntityTypeEditor(false)}>
                    <div className="modal" style={{ maxWidth: '700px', maxHeight: '90vh', overflowY: 'auto' }}>
                        <div className="modal-header">
                            <h3>✏️ Edit Entity Type Prompt</h3>
                            <button className="modal-close" onClick={() => setShowEntityTypeEditor(false)}>×</button>
                        </div>
                        <div className="modal-body">
                            <div className="form-group">
                                <label className="form-label">Entity Type</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    value={ENTITY_TYPES.find(t => t.value === entityTypeForm.value)?.label || entityTypeForm.value}
                                    disabled
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">Custom Prompt</label>
                                <textarea
                                    className="form-input"
                                    rows={6}
                                    placeholder="Comprehensive character design sheet layout. Must include..."
                                    value={entityTypeForm.prompt}
                                    onChange={(e) => setEntityTypeForm(f => ({ ...f, prompt: e.target.value }))}
                                    style={{ resize: 'vertical' }}
                                />
                                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '6px' }}>
                                    Nếu để trống, hệ thống sẽ dùng prompt mặc định tương ứng với loại entity.
                                </p>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                                <button className="btn btn-primary" onClick={saveEntityTypePrompt} style={{ flex: 1 }}>
                                    💾 Save
                                </button>
                                <button className="btn btn-ghost" onClick={() => setShowEntityTypeEditor(false)}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

// About Tab
function AboutTab({ cloakStatus }: { cloakStatus: { ready: boolean; available: boolean } }) {
    return (
        <>
            <div className="content-header">
                <div className="header-left">
                    <h2><span>🛡️</span> CloakBrowser Integration</h2>
                </div>
            </div>
            <div className="content-body">
                <div className="empty-state" style={{ borderStyle: 'solid', background: 'var(--bg-card)' }}>
                    <div className="empty-icon">🛡️</div>
                    <h3>CloakBrowser - Stealth Chromium</h3>
                    <p>Passes every bot detection test with source-level fingerprint patches.</p>
                    <div style={{ textAlign: 'left', background: 'var(--bg-secondary)', padding: '24px', borderRadius: '12px', marginTop: '20px' }}>
                        <h4 style={{ color: 'var(--success)', marginBottom: '16px' }}>✨ Key Features</h4>
                        <ul style={{ color: 'var(--text-secondary)', lineHeight: '2', paddingLeft: '20px' }}>
                            <li>58 source-level C++ patches for canvas, WebGL, audio, fonts, GPU</li>
                            <li>reCAPTCHA v3 score: 0.9 (human-level, server-verified)</li>
                            <li>Passes Cloudflare Turnstile, FingerprintJS, BrowserScan</li>
                            <li>Human-like mouse curves, keyboard timing, scroll patterns</li>
                            <li>Auto-updating stealth binary</li>
                        </ul>
                    </div>
                </div>
            </div>
        </>
    );
}

function formatDate(dateStr: string | undefined) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatRelativeTime(dateStr: string | undefined) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return 'Vừa xong';
    if (minutes < 60) return `${minutes} phút trước`;
    if (hours < 24) return `${hours} giờ trước`;
    return `${days} ngày trước`;
}

// FlowProject Card Component
interface FlowProjectCardProps {
    project: FlowProject;
    profile?: Profile;
}

function FlowProjectCard({ project, profile }: FlowProjectCardProps) {
    const profileName = profile?.name || '—';
    const profileShortId = profile?.id ? `#${profile.id.substring(0, 8)}` : '—';

    return (
        <div className="profile-card">
            <div className="profile-header">
                <div className="profile-title">
                    <div className="profile-avatar">🌊</div>
                    <div>
                        <div className="profile-name">{project.name || 'Project'}</div>
                        <div className="profile-id">{project.projectId ? `Project ID: ${project.projectId}` : `#${project.id.substring(0, 8)}`}</div>
                    </div>
                </div>
                <div className="profile-badges">
                    <div className="profile-badge badge-active">
                        <span>●</span>
                        Đã tạo
                    </div>
                </div>
            </div>

            <div className="profile-description">
                {project.description || 'Không có mô tả'}
            </div>

            <div className="profile-meta">
                <div className="meta-item">
                    <span className="meta-label">Profile</span>
                    <span className="meta-value">
                        {profileName} ({profileShortId})
                    </span>
                </div>
                <div className="meta-item">
                    <span className="meta-label">Tool</span>
                    <span className="meta-value">{project.toolName || 'PINHOLE'}</span>
                </div>
                <div className="meta-item">
                    <span className="meta-label">Ngày tạo</span>
                    <span className="meta-value">{formatDate(project.createdAt)}</span>
                </div>
                <div className="meta-item">
                    <span className="meta-label">Trạng thái</span>
                    <span className="meta-value">
                        <span className="profile-badge badge-active">● Đã tạo</span>
                    </span>
                </div>
            </div>
        </div>
    );
}

// Flow Projects Tab
function FlowProjectsTab({ profiles, onCreateProjectsBatch, onUpdateProfileMetadata, onOpenProfile, onOpenProjectDetail }: {
    profiles: Profile[];
    onCreateProjectsBatch: (data: { profileIds: string[]; name: string; description?: string; toolName?: string }) => Promise<any>;
    onUpdateProfileMetadata: (profileId: string, metadata: Record<string, any>) => Promise<any>;
    onOpenProfile?: (profileId: string, openFlow?: boolean) => Promise<void>;
    onOpenProjectDetail: (name: string) => void;
}) {
    const [showModal, setShowModal] = useState(false);
    const [projectName, setProjectName] = useState('');
    const [projectDescription, setProjectDescription] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [creating, setCreating] = useState(false);
    const [results, setResults] = useState<any[] | null>(null);
    const [, setRefreshKey] = useState(0); // Force re-render

    // Derive flow projects from profile metadata
    const allProjects: FlowProject[] = profiles.flatMap((profile) => {
        const items: FlowProject[] = [];
        const rawProjects = Array.isArray((profile.metadata || {}).flowProjects)
            ? ((profile.metadata || {}).flowProjects as any[])
            : [];
        rawProjects.forEach((raw, idx) => {
            items.push({
                id: raw.projectId || `${profile.id}-${idx}`,
                profileId: profile.id,
                profileName: profile.name,
                name: raw.name,
                description: raw.description,
                toolName: raw.toolName,
                createdAt: raw.createdAt,
                projectId: raw.projectId,
            });
        });
        return items;
    });

    // Group projects by name only (each profile has its own projectId)
    const groupedProjects = allProjects.reduce((acc, project) => {
        const key = project.name;
        if (!acc[key]) {
            acc[key] = {
                name: project.name,
                description: project.description,
                profiles: [],
            };
        }
        acc[key].profiles.push({
            profileId: project.profileId,
            profileName: project.profileName,
            projectId: project.projectId,
        });
        return acc;
    }, {} as Record<string, { name: string; description?: string; profiles: { profileId: string; profileName: string; projectId?: string }[] }>);

    const groupedProjectsList = Object.values(groupedProjects);

    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

    const toggleProfile = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        setSelectedIds(selectedIds.size === profiles.length ? new Set() : new Set(profiles.map((p) => p.id)));
    };

    const handleSubmit = async () => {
        if (!projectName.trim() || selectedIds.size === 0 || creating) return;
        setCreating(true);
        setResults(null);
        try {
            const response = await onCreateProjectsBatch({
                profileIds: Array.from(selectedIds),
                name: projectName.trim(),
                description: projectDescription.trim() || undefined,
                toolName: 'PINHOLE',
            });
            const data = Array.isArray(response?.data) ? response.data : [];
            const normalized = data.map((item: any) => ({
                status: item.status || (item.projectId ? 'success' : 'error'),
                profileId: item.profileId,
                projectId: item.projectId,
                error: item.error,
            }));
            setResults(normalized);

            // Check if all succeeded
            const allSuccess = normalized.every((item: any) => item.status === 'success');
            if (allSuccess) {
                // Close modal and show success notification
                setTimeout(() => {
                    resetAndClose();
                    window.dispatchEvent(new CustomEvent('show-notification', {
                        detail: { message: `Đã tạo project "${projectName.trim()}" trên ${normalized.length} profile!`, type: 'success' }
                    }));
                }, 800);
            }

            // Refresh immediately to show new projects
            setRefreshKey(k => k + 1);
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent('refresh-profiles'));
            }, 500);
        } catch (err) {
            setResults([
                {
                    status: 'error',
                    profileId: undefined,
                    projectId: undefined,
                    error: err instanceof Error ? err.message : 'Lỗi không xác định',
                },
            ]);
        } finally {
            setCreating(false);
        }
    };

    // Handle open profile with Flow project URL
    const handleOpenProject = async (profileId: string, projectId: string) => {
        if (!projectId) return;
        if (onOpenProfile) {
            // Open profile with Flow and navigate to specific project URL
            const projectUrl = `https://labs.google/fx/vi/tools/flow/project/${projectId}`;
            await onOpenProfile(profileId, true, false, projectUrl);
        }
    };

    const resetAndClose = () => {
        setShowModal(false);
        setProjectName('');
        setProjectDescription('');
        setSelectedIds(new Set());
        setResults(null);
    };

    return (
        <>
            <div className="content-header">
                <div className="header-left">
                    <h2><span>🌊</span> Flow Projects</h2>
                </div>
                <div className="header-actions">
                    <button className="btn btn-ghost" onClick={() => window.dispatchEvent(new CustomEvent('refresh-profiles'))}>🔄 Làm Mới</button>
                    <button className="btn btn-primary" onClick={() => setShowModal(true)}>
                        + Tạo Project Mới
                    </button>
                </div>
            </div>
            <div className="content-body">
                {profiles.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon">👤</div>
                        <h3>Chưa có profile nào</h3>
                        <p>Hãy tạo profile trước, rồi quay lại đây để tạo project trên Flow.</p>
                    </div>
                ) : groupedProjectsList.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon">🌊</div>
                        <h3>Chưa có Flow Project nào</h3>
                        <p>Nhấn "Tạo Project Mới" để bắt đầu tạo project trên Google Flow.</p>
                        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Tạo Project Đầu Tiên</button>
                    </div>
                ) : (
                    <div className="flow-projects-grid">
                        {groupedProjectsList.map((group) => (
                            <div key={`${group.name}-${group.projectId}`} className="flow-project-card" style={{ cursor: 'pointer' }}>
                                <div className="flow-project-card-header" onClick={() => onOpenProjectDetail(group.name)}>
                                    <div className="flow-project-icon">🌊</div>
                                    <div className="flow-project-info">
                                        <div className="flow-project-name">{group.name}</div>
                                        <div className="flow-project-count">
                                            {group.profiles.length} profile{group.profiles.length > 1 ? 's' : ''}
                                        </div>
                                    </div>
                                </div>
                                {group.description && (
                                    <div className="flow-project-description">{group.description}</div>
                                )}
                                <div className="flow-project-profiles-list">
                                    {group.profiles.map((p) => (
                                        <div key={p.profileId} className="flow-project-profile-item">
                                            <div className="flow-project-profile-info">
                                                <span className="flow-project-profile-name">{p.profileName}</span>
                                                <span
                                                    className={`flow-project-profile-id ${p.projectId ? 'clickable' : ''}`}
                                                    onClick={() => handleOpenProject(p.profileId, p.projectId || '')}
                                                    title={p.projectId ? `Mở project ${group.name} trên profile ${p.profileName}` : 'Chưa có ID'}
                                                >
                                                    {p.projectId || 'Chưa có ID'}
                                                </span>
                                            </div>
                                            <div className="flow-project-profile-actions">
                                                {p.projectId && (
                                                    <button
                                                        className="btn btn-ghost btn-xs"
                                                        onClick={() => handleOpenProject(p.profileId, p.projectId || '')}
                                                        title={`Mở ${group.name} trên ${p.profileName}`}
                                                    >
                                                        🌐 Mở
                                                    </button>
                                                )}
                                                <div className="flow-project-tier">
                                                    {(() => {
                                                        const profile = profiles.find(pr => pr.id === p.profileId);
                                                        return profile?.tier ? (
                                                            <span className={`profile-badge badge-tier-${profile.tier.toLowerCase().replace('_', '-')}`}>
                                                                {profile.tier === 'PAYGATE_TIER_ONE' ? 'Pro' : profile.tier === 'PAYGATE_TIER_TWO' ? 'Ultra' : '?'}
                                                            </span>
                                                        ) : null;
                                                    })()}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="flow-project-actions">
                                    <button
                                        className="btn btn-danger btn-sm"
                                        onClick={() => {
                                            if (confirm(`Xóa dự án "${group.name}" khỏi tất cả profiles?`)) {
                                                group.profiles.forEach(p => {
                                                    const profile = profiles.find(pr => pr.id === p.profileId);
                                                    if (profile) {
                                                        const metadata = { ...profile.metadata } || {};
                                                        metadata.flowProjects = (metadata.flowProjects || []).filter(
                                                            (proj: any) => proj.name !== group.name
                                                        );
                                                        onUpdateProfileMetadata(profile.id, metadata);
                                                    }
                                                });
                                            }
                                        }}
                                        title="Xóa dự án"
                                    >
                                        🗑️ Xóa
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {showModal && (
                <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && resetAndClose()}>
                    <div className="modal" style={{ maxWidth: '640px' }}>
                        <div className="modal-header">
                            <h3>🌊 Tạo Project Flow trên nhiều Profile</h3>
                            <button className="modal-close" onClick={resetAndClose}>×</button>
                        </div>
                        <div className="modal-body">
                            <div className="form-group">
                                <label className="form-label">Tên Project</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="VD: Dự án chạy quảng cáo tháng 6"
                                    value={projectName}
                                    onChange={(e) => setProjectName(e.target.value)}
                                    autoFocus
                                />
                            </div>

                            <div className="form-group">
                                <label className="form-label">Mô tả (tùy chọn)</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="VD: Quảng cáo sản phẩm A"
                                    value={projectDescription}
                                    onChange={(e) => setProjectDescription(e.target.value)}
                                />
                            </div>

                            <div className="form-group">
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                                    <label className="form-label" style={{ margin: 0 }}>Chọn Profile</label>
                                    <button
                                        type="button"
                                        className="btn btn-ghost"
                                        style={{ fontSize: '0.8rem' }}
                                        onClick={toggleAll}
                                    >
                                        {selectedIds.size === profiles.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                                    </button>
                                </div>
                                <div style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                                    {profiles.map((profile: Profile) => (
                                        <label
                                            key={profile.id}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '10px',
                                                padding: '10px 12px',
                                                borderBottom: '1px solid var(--border)',
                                                cursor: 'pointer',
                                                background: selectedIds.has(profile.id) ? 'rgba(79, 142, 247, 0.08)' : 'transparent',
                                            }}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.has(profile.id)}
                                                onChange={() => toggleProfile(profile.id)}
                                            />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 600 }}>{profile.name}</div>
                                                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                    #{profile.id.substring(0, 8)}
                                                </div>
                                            </div>
                                            <TierBadge tier={profile.tier} />
                                        </label>
                                    ))}
                                    {profiles.length === 0 && (
                                        <div style={{ padding: '16px', color: 'var(--text-secondary)' }}>Chưa có profile nào.</div>
                                    )}
                                </div>
                            </div>

                            {results && (
                                <div className="form-group">
                                    <label className="form-label">Kết quả</label>
                                    <div style={{ maxHeight: '220px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--border)' }}>
                                        {results.map((item: any, idx: number) => {
                                            const success = item.status === 'success';
                                            return (
                                                <div
                                                    key={idx}
                                                    style={{
                                                        padding: '10px 12px',
                                                        borderBottom: idx !== results.length - 1 ? '1px solid var(--border)' : 'none',
                                                        background: success ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                                                    }}
                                                >
                                                    <div style={{ fontWeight: 600 }}>
                                                        {success ? '✓' : '✗'} {item.profileId ? `#${item.profileId.substring(0, 8)}` : '—'}
                                                    </div>
                                                    {success ? (
                                                        <div style={{ fontSize: '0.85rem', marginTop: '4px' }}>
                                                            Project ID: <code>{item.projectId || '(đã tạo)'}</code>
                                                        </div>
                                                    ) : (
                                                        <div style={{ fontSize: '0.85rem', color: 'var(--error)', marginTop: '4px' }}>
                                                            {item.error || 'Lỗi không xác định'}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-ghost" onClick={resetAndClose} disabled={creating}>
                                {results ? 'Đóng' : 'Hủy'}
                            </button>
                            {!results && (
                                <button
                                    className="btn btn-primary"
                                    onClick={handleSubmit}
                                    disabled={!projectName.trim() || selectedIds.size === 0 || creating}
                                >
                                    {creating ? `Đang tạo (${selectedIds.size})...` : `Tạo project (${selectedIds.size})`}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

// Flow Images Tab
function FlowImagesTab({
    profiles,
    onGenerateImage,
    generating,
    lastResult,
    error,
    onClearResult,
    onOpenProfile,
    onWaitForProfileReady,
}: {
    profiles: Profile[];
    onGenerateImage: (data: {
        profileId: string;
        prompt: string;
        projectId?: string;
        modelKey?: string;
        aspectRatio?: string;
        userPaygateTier?: 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO';
    }) => Promise<GeneratedImageResult | void>;
    generating: boolean;
    lastResult: GeneratedImageResult | null;
    error: string | null;
    onClearResult: () => void;
    onOpenProfile?: (profileId: string) => Promise<void>;
    onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
}) {
    // Cascading: first select project, then select which profile/project-instance to use
    const [selectedProjectName, setSelectedProjectName] = useState<string>('');
    const [selectedProfileIdx, setSelectedProfileIdx] = useState<number>(0);
    const [prompt, setPrompt] = useState('');
    const [modelKey, setModelKey] = useState('NANO_BANANA_PRO');
    const [aspectRatio, setAspectRatio] = useState('IMAGE_ASPECT_RATIO_LANDSCAPE');
    const [submitting, setSubmitting] = useState(false);
    // Store last successful params for retry
    const [lastParams, setLastParams] = useState<{
        prompt: string;
        modelKey: string;
        aspectRatio: string;
        profileId: string;
        projectId?: string;
    } | null>(null);

    // Group profiles by project name
    type ProjectEntry = { profile: Profile; projectIdx: number; projectName: string };
    const projectGroups: Record<string, ProjectEntry[]> = {};
    profiles.forEach((profile) => {
        const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
        flowProjects.forEach((proj: any, idx: number) => {
            const name = proj.name || `Project ${idx + 1}`;
            if (!projectGroups[name]) projectGroups[name] = [];
            projectGroups[name].push({ profile, projectIdx: idx, projectName: name });
        });
    });

    const projectNames = Object.keys(projectGroups).sort();
    const selectedEntries = projectGroups[selectedProjectName] || [];
    const selectedEntry = selectedEntries[selectedProfileIdx];
    const selectedProfile = selectedEntry?.profile;
    const selectedProjectIdx = selectedEntry?.projectIdx ?? 0;
    const selectedProjectObj = selectedProfile ? (selectedProfile.metadata as any)?.flowProjects?.[selectedProjectIdx] : null;
    const tier = selectedProfile?.tier || 'PAYGATE_TIER_TWO';

    const handleSubmit = async () => {
        if (!selectedProfile || !prompt.trim() || submitting) return;

        setSubmitting(true);
        try {
            // Auto-open profile if not already running and wait for it to be ready
            if (selectedProfile.status !== 'running') {
                if (onOpenProfile) {
                    try {
                        await onOpenProfile(selectedProfile.id);
                    } catch (e) {
                        console.warn('Could not auto-open profile:', e);
                    }
                }
            }

            // Wait for profile to be ready (extension connected, flowKey captured)
            if (onWaitForProfileReady) {
                try {
                    await onWaitForProfileReady(selectedProfile.id, 30000);
                } catch (e) {
                    console.warn('Profile may not be fully ready:', e);
                }
            }

            await onGenerateImage({
                profileId: selectedProfile.id,
                prompt: prompt.trim(),
                projectId: selectedProjectObj?.projectId,
                modelKey,
                aspectRatio,
            });
            // Store successful params for retry
            setLastParams({
                prompt: prompt.trim(),
                modelKey,
                aspectRatio,
                profileId: selectedProfile.id,
                projectId: selectedProjectObj?.projectId,
            });
        } catch {
            // error is surfaced via `error` prop
        } finally {
            setSubmitting(false);
        }
    };

    // Auto-select first project if none selected
    useEffect(() => {
        if (!selectedProjectName && projectNames.length > 0) {
            setSelectedProjectName(projectNames[0]);
            setSelectedProfileIdx(0);
        }
    }, [projectNames, selectedProjectName]);

    const canSubmit = !!selectedProfile && !!prompt.trim() && !submitting && !generating;

    return (
        <>
            <div className="content-header">
                <div className="header-left">
                    <h2><span>🖼️</span> Flow Images</h2>
                </div>
                <div className="header-actions">
                    <button className="btn btn-ghost" onClick={onClearResult}>🗑️ Xoá kết quả</button>
                </div>
            </div>
            <div className="content-body">
                {projectNames.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon">🌊</div>
                        <h3>Chưa có Project nào</h3>
                        <p>Hãy tạo ít nhất một Project trong tab "Flow Projects" trước khi tạo ảnh.</p>
                    </div>
                ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                        <div className="profile-card">
                            <div className="profile-header">
                                <div className="profile-title">
                                    <div className="profile-avatar">🎛️</div>
                                    <div>
                                        <div className="profile-name">Tạo ảnh mới</div>
                                        <div className="profile-id">Chọn Project rồi chọn Profile</div>
                                    </div>
                                </div>
                            </div>
                            <div className="profile-meta" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                                {/* Cascading: Project → Profile */}
                                <div className="form-group">
                                    <label className="form-label">Project</label>
                                    <select
                                        className="form-input"
                                        value={selectedProjectName}
                                        onChange={(e) => {
                                            setSelectedProjectName(e.target.value);
                                            setSelectedProfileIdx(0);
                                        }}
                                    >
                                        <option value="">-- Chọn project --</option>
                                        {projectNames.map((name) => (
                                            <option key={name} value={name}>{name} ({projectGroups[name].length} profile)</option>
                                        ))}
                                    </select>
                                </div>

                                {selectedProjectName && selectedEntries.length > 1 && (
                                    <div className="form-group">
                                        <label className="form-label">Profile trong dự án</label>
                                        <select
                                            className="form-input"
                                            value={selectedProfileIdx}
                                            onChange={(e) => setSelectedProfileIdx(Number(e.target.value))}
                                        >
                                            {selectedEntries.map((entry, idx) => (
                                                <option key={idx} value={idx}>
                                                    {entry.profile.name} (Tier: {entry.profile.tier || 'N/A'})
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                {selectedProfile && (
                                    <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: '8px', fontSize: '0.85rem' }}>
                                        <div><strong>Profile:</strong> {selectedProfile.name}</div>
                                        <div><strong>Tier:</strong> {tier}</div>
                                        <div><strong>Project ID:</strong> <code>{selectedProjectObj?.projectId || '(chưa có)'}</code></div>
                                    </div>
                                )}

                                <div className="form-group">
                                    <label className="form-label">Prompt</label>
                                    <textarea
                                        className="form-input"
                                        rows={3}
                                        placeholder="Mô tả ảnh bạn muốn tạo..."
                                        value={prompt}
                                        onChange={(e) => setPrompt(e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Model</label>
                                    <select
                                        className="form-input"
                                        value={modelKey}
                                        onChange={(e) => setModelKey(e.target.value)}
                                    >
                                        <option value="NANO_BANANA_PRO">NANO_BANANA_PRO</option>
                                        <option value="NANO_BANANA_2">NANO_BANANA_2</option>
                                        <option value="IMAGEN_4">IMAGEN_4</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Tỷ lệ khung hình</label>
                                    <select
                                        className="form-input"
                                        value={aspectRatio}
                                        onChange={(e) => setAspectRatio(e.target.value)}
                                    >
                                        <option value="IMAGE_ASPECT_RATIO_LANDSCAPE">16:9 Ngang (Landscape)</option>
                                        <option value="IMAGE_ASPECT_RATIO_PORTRAIT">9:16 Dọc (Portrait)</option>
                                        <option value="IMAGE_ASPECT_RATIO_SQUARE">1:1 Vuông (Square)</option>
                                        <option value="IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE">4:3 Ngang (Classic)</option>
                                        <option value="IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR">3:4 Dọc (Portrait 3:4)</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Tier</label>
                                    <div style={{
                                        padding: '10px 12px',
                                        background: tier === 'PAYGATE_TIER_TWO' ? 'rgba(255, 215, 0, 0.1)' : 'rgba(59, 130, 246, 0.1)',
                                        borderRadius: '6px',
                                        fontWeight: 600,
                                        color: tier === 'PAYGATE_TIER_TWO' ? '#ffd700' : '#3b82f6'
                                    }}>
                                        {tier === 'PAYGATE_TIER_TWO' ? '👑 Ultra' : '⭐ Pro'}
                                        <span style={{ marginLeft: '8px', fontSize: '0.8rem', opacity: 0.7 }}>({tier})</span>
                                    </div>
                                </div>
                                <button
                                    className="btn btn-primary"
                                    onClick={handleSubmit}
                                    disabled={!canSubmit}
                                >
                                    {generating || submitting ? 'Đang tạo ảnh...' : 'Tạo ảnh'}
                                </button>
                            </div>
                        </div>

                        <div className="profile-card">
                            <div className="profile-header">
                                <div className="profile-title">
                                    <div className="profile-avatar">🖼️</div>
                                    <div>
                                        <div className="profile-name">Kết quả</div>
                                        <div className="profile-id">
                                            {lastResult ? 'Đã tạo xong' : 'Chưa có ảnh nào được tạo'}
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="profile-meta" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                                {generating || submitting ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', gap: '16px' }}>
                                        <div className="loading-spinner" style={{ width: 60, height: 60, border: '4px solid var(--border)', borderTopColor: 'var(--primary-color)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                        <div style={{ color: 'var(--text-secondary)' }}>Đang tạo ảnh...</div>
                                    </div>
                                ) : error ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                        <div style={{
                                            padding: '16px',
                                            background: 'rgba(239, 68, 68, 0.1)',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(239, 68, 68, 0.3)',
                                            color: 'var(--error)',
                                            fontSize: '0.9rem'
                                        }}>
                                            <div style={{ fontWeight: 600, marginBottom: '8px' }}>
                                                {error.includes('403') ? '⚠️ Lỗi Captcha' : '❌ Lỗi tạo ảnh'}
                                            </div>
                                            <div>{error.includes('403') ? 'Google yêu cầu xác minh captcha. Vui lòng thử lại.' : error}</div>
                                        </div>
                                        {lastParams && (
                                            <button
                                                className="btn btn-primary"
                                                onClick={() => {
                                                    // Restore params and retry
                                                    setPrompt(lastParams.prompt);
                                                    setModelKey(lastParams.modelKey);
                                                    setAspectRatio(lastParams.aspectRatio);
                                                    handleSubmit();
                                                }}
                                            >
                                                🔄 Tạo lại
                                            </button>
                                        )}
                                    </div>
                                ) : lastResult ? (
                                    <>
                                        <div style={{ fontSize: '0.9rem' }}>
                                            <strong>Model:</strong> {lastResult.modelKey}
                                        </div>
                                        <div style={{ fontSize: '0.9rem' }}>
                                            <strong>Project:</strong> <code style={{ fontSize: '0.8rem' }}>{lastResult.projectId}</code>
                                        </div>
                                        <div style={{ fontSize: '0.9rem' }}>
                                            <strong>Tier:</strong> {lastResult.userPaygateTier}
                                        </div>
                                        {lastResult.mediaId && (
                                            <div style={{ fontSize: '0.85rem', background: 'var(--bg-secondary)', padding: '8px', borderRadius: '6px' }}>
                                                <strong>Media ID:</strong> <code style={{ fontSize: '0.75rem' }}>{lastResult.mediaId}</code>
                                            </div>
                                        )}
                                        {lastResult.localPath ? (
                                            <div style={{ marginTop: '8px' }}>
                                                <div style={{ fontSize: '0.85rem', color: 'var(--success)', marginBottom: '8px' }}>
                                                    ✓ Đã tải ảnh về local
                                                </div>
                                                <img
                                                    src={`/data/entity-references/${lastParams?.profileId}/${getFileName(lastResult.localPath)}`}
                                                    alt="Generated image"
                                                    style={{ maxWidth: '100%', borderRadius: '12px', border: '1px solid var(--border)' }}
                                                    onError={(e) => {
                                                        e.currentTarget.style.display = 'none';
                                                    }}
                                                />
                                            </div>
                                        ) : lastResult.servingUri || lastResult.downloadUrl ? (
                                            <div style={{ marginTop: '8px' }}>
                                                <img
                                                    src={lastResult.servingUri || lastResult.downloadUrl || ''}
                                                    alt="Generated image"
                                                    style={{ maxWidth: '100%', borderRadius: '12px', border: '1px solid var(--border)' }}
                                                    onError={(e) => {
                                                        e.currentTarget.style.display = 'none';
                                                        e.currentTarget.nextElementSibling?.classList.remove('hidden');
                                                    }}
                                                />
                                                <div className="hidden" style={{ display: 'none', padding: '16px', background: 'var(--bg-secondary)', borderRadius: '8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                                                    <p style={{ marginBottom: '8px' }}>URL ảnh có thể đã hết hạn</p>
                                                    <p style={{ fontSize: '0.85rem' }}>Media ID: <code>{lastResult.mediaId}</code></p>
                                                </div>
                                            </div>
                                        ) : (
                                            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                                                <p>Chưa nhận được URL ảnh.</p>
                                                {lastResult.mediaId && (
                                                    <p style={{ marginTop: '8px' }}>Media ID: <code>{lastResult.mediaId}</code></p>
                                                )}
                                            </div>
                                        )}
                                        <details style={{ marginTop: '8px' }}>
                                            <summary style={{ cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                                Raw result ({Object.keys(lastResult.rawResult || {}).length} keys)
                                            </summary>
                                            <pre style={{ fontSize: '0.7rem', marginTop: '8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '300px', overflow: 'auto', background: 'var(--bg-secondary)', padding: '12px', borderRadius: '6px' }}>
                                                {JSON.stringify(lastResult.rawResult, null, 2)}
                                            </pre>
                                        </details>
                                        {lastParams && (
                                            <button
                                                className="btn btn-secondary"
                                                onClick={() => {
                                                    setPrompt(lastParams.prompt);
                                                    setModelKey(lastParams.modelKey);
                                                    setAspectRatio(lastParams.aspectRatio);
                                                    handleSubmit();
                                                }}
                                                style={{ marginTop: '12px' }}
                                            >
                                                🔄 Tạo lại ảnh này
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                        Nhập prompt và chọn project để bắt đầu tạo ảnh.
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}

// Main App
// Library Placeholder Page
function LibraryPlaceholderPage({ title, description }: { title: string; description: string }) {
    return (
        <>
            <div className="content-header">
                <div className="header-left">
                    <h2><span>📚</span> {title}</h2>
                </div>
            </div>
            <div className="content-body">
                <div className="empty-state">
                    <div className="empty-icon">📚</div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                    <div style={{ marginTop: '16px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                        Tính năng đang được phát triển...
                    </div>
                </div>
            </div>
        </>
    );
}

// Project Detail Page - contains Videos/Images tabs
interface ProjectDetailPageProps {
    projectName: string;
    projectTab: 'videos' | 'images';
    profiles: Profile[];
    onUpdateProfileMetadata: (profileId: string, metadata: Record<string, any>) => Promise<any>;
    onOpenProfile?: (profileId: string, openFlow?: boolean) => Promise<void>;
    onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
    generatingImage: boolean;
    lastGeneratedImage: GeneratedImageResult | null;
    imageError: string | null;
    generateImage: (data: {
        profileId: string;
        prompt: string;
        projectId?: string;
        modelKey?: string;
        aspectRatio?: string;
        userPaygateTier?: 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO';
        upscaleResolution?: string;
    }) => Promise<GeneratedImageResult | void>;
    resetGeneratedImage: () => void;
    onBack: () => void;
}

function ProjectDetailPage({
    projectName,
    projectTab,
    profiles,
    onUpdateProfileMetadata,
    onOpenProfile,
    onWaitForProfileReady,
    generatingImage,
    lastGeneratedImage,
    imageError,
    generateImage,
    resetGeneratedImage,
    onBack,
}: ProjectDetailPageProps) {
    const [activeProjectTab, setActiveProjectTab] = useState<'videos' | 'images'>(projectTab);

    // Get profiles that have this specific project
    const projectProfiles = profiles.filter((profile) => {
        const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
        return flowProjects.some((proj: any) => proj.name === projectName);
    });

    const getProjectIdx = (profile: Profile) => {
        const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
        return flowProjects.findIndex((proj: any) => proj.name === projectName);
    };

    // Project info (from first profile that has it)
    const firstProfile = projectProfiles[0];
    const firstProjIdx = firstProfile ? getProjectIdx(firstProfile) : 0;
    const projectMeta = firstProfile
        ? ((firstProfile.metadata as any)?.flowProjects || [])[firstProjIdx]
        : null;

    const getProjectProfilesWithMeta = () => {
        return projectProfiles.map(profile => {
            const idx = getProjectIdx(profile);
            const meta = ((profile.metadata as any)?.flowProjects || [])[idx] || {};
            return { profile, projectId: meta.projectId };
        });
    };

    const projectProfilesWithMeta = getProjectProfilesWithMeta();

    // Delete entire project from all profiles
    const handleDeleteProject = () => {
        if (!confirm(`Xóa dự án "${projectName}" khỏi tất cả profiles?`)) return;
        projectProfilesWithMeta.forEach(({ profile }) => {
            const metadata = { ...profile.metadata } || {};
            metadata.flowProjects = (metadata.flowProjects || []).filter(
                (proj: any) => proj.name !== projectName
            );
            onUpdateProfileMetadata(profile.id, metadata);
        });
        window.dispatchEvent(new CustomEvent('refresh-profiles'));
        window.dispatchEvent(new CustomEvent('show-notification', {
            detail: { message: `Đã xóa project "${projectName}"`, type: 'success' }
        }));
    };

    return (
        <>
            <div className="project-detail-header">
                <div className="project-detail-header-top">
                    <button className="btn btn-ghost" onClick={onBack}>
                        ← Back
                    </button>
                    <div className="project-detail-title">
                        <h2><span>🌊</span> {projectName}</h2>
                        {projectMeta?.description && (
                            <p className="project-detail-desc">{projectMeta.description}</p>
                        )}
                    </div>
                    <div className="project-detail-actions">
                        <button className="btn btn-danger btn-sm" onClick={handleDeleteProject}>
                            🗑️ Xóa Project
                        </button>
                    </div>
                </div>

                {/* Project Profiles Summary */}
                {projectProfilesWithMeta.length > 0 && (
                    <div className="project-detail-profiles">
                        {projectProfilesWithMeta.map(({ profile, projectId }) => (
                            <div key={profile.id} className="project-profile-chip">
                                <span className={`status-dot ${profile.isActive ? 'active' : ''}`}>●</span>
                                <span>{profile.name}</span>
                                <span className="project-id-chip">{projectId ? `#${projectId.substring(0, 8)}` : '(chưa có ID)'}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Project Tab Navigation */}
            <div className="content-tabs">
                <button
                    className={`content-tab ${activeProjectTab === 'videos' ? 'active' : ''}`}
                    onClick={() => setActiveProjectTab('videos')}
                >
                    🎬 Videos
                </button>
                <button
                    className={`content-tab ${activeProjectTab === 'images' ? 'active' : ''}`}
                    onClick={() => setActiveProjectTab('images')}
                >
                    🖼️ Images
                </button>
            </div>

            <div className="content-body">
                {activeProjectTab === 'videos' ? (
                    <ProjectVideosTab
                        profiles={projectProfiles}
                        projectName={projectName}
                        onOpenProfile={onOpenProfile}
                        onWaitForProfileReady={onWaitForProfileReady}
                    />
                ) : (
                    <ProjectImagesTab
                        profiles={projectProfiles}
                        projectName={projectName}
                        generating={generatingImage}
                        lastResult={lastGeneratedImage}
                        error={imageError}
                        onGenerateImage={generateImage}
                        onClearResult={resetGeneratedImage}
                        onOpenProfile={onOpenProfile}
                        onWaitForProfileReady={onWaitForProfileReady}
                    />
                )}
            </div>
        </>
    );
}

// Project Videos Tab - renders FlowVideosTab content but scoped to this project's profiles
function ProjectVideosTab({
    profiles,
    projectName,
    onOpenProfile,
    onWaitForProfileReady,
}: {
    profiles: Profile[];
    projectName: string;
    onOpenProfile?: (profileId: string, openFlow?: boolean) => Promise<void>;
    onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
}) {
    const getProjectIdx = (profile: Profile) => {
        const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
        return flowProjects.findIndex((proj: any) => proj.name === projectName);
    };

    if (profiles.length === 0) {
        return (
            <div className="empty-state">
                <div className="empty-icon">🎬</div>
                <h3>Chưa có Profile nào trong dự án</h3>
                <p>Hãy thêm profile vào dự án "{projectName}" trước.</p>
            </div>
        );
    }

    return (
        <FlowVideosTab
            profiles={profiles}
            projectName={projectName}
            onOpenProfile={onOpenProfile}
            onWaitForProfileReady={onWaitForProfileReady}
        />
    );
}

// Project Images Tab - renders FlowImagesTab content but scoped to this project's profiles
function ProjectImagesTab({
    profiles,
    projectName,
    generating,
    lastResult,
    error,
    onGenerateImage,
    onClearResult,
    onOpenProfile,
    onWaitForProfileReady,
}: {
    profiles: Profile[];
    projectName: string;
    generating: boolean;
    lastResult: GeneratedImageResult | null;
    error: string | null;
    onGenerateImage: (data: {
        profileId: string;
        prompt: string;
        projectId?: string;
        modelKey?: string;
        aspectRatio?: string;
        userPaygateTier?: 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO';
        upscaleResolution?: string;
    }) => Promise<GeneratedImageResult | void>;
    onClearResult: () => void;
    onOpenProfile?: (profileId: string) => Promise<void>;
    onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
}) {
    const [selectedProfileIdx, setSelectedProfileIdx] = useState(0);
    const [prompt, setPrompt] = useState('');
    const [modelKey, setModelKey] = useState('NANO_BANANA_PRO');
    const [aspectRatio, setAspectRatio] = useState('IMAGE_ASPECT_RATIO_LANDSCAPE');
    const [upscaleResolution, setUpscaleResolution] = useState('UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL');
    const [submitting, setSubmitting] = useState(false);

    const selectedProfile = profiles[selectedProfileIdx];
    const getProjectIdx = (profile: Profile) => {
        const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
        return flowProjects.findIndex((proj: any) => proj.name === projectName);
    };
    const selectedProjectIdx = selectedProfile ? getProjectIdx(selectedProfile) : 0;
    const selectedProjectObj = selectedProfile
        ? ((selectedProfile.metadata as any)?.flowProjects || [])[selectedProjectIdx]
        : null;

    const handleSubmit = async () => {
        if (!selectedProfile || !prompt.trim() || submitting) return;
        setSubmitting(true);
        try {
            if (selectedProfile.status !== 'running' && onOpenProfile) {
                try { await onOpenProfile(selectedProfile.id); } catch (e) { console.warn('Auto-open failed:', e); }
            }
            if (onWaitForProfileReady) {
                try { await onWaitForProfileReady(selectedProfile.id, 30000); } catch (e) { console.warn('Profile not ready:', e); }
            }
            await onGenerateImage({
                profileId: selectedProfile.id,
                prompt: prompt.trim(),
                projectId: selectedProjectObj?.projectId,
                modelKey,
                aspectRatio,
                upscaleResolution,
            });
        } finally {
            setSubmitting(false);
        }
    };

    if (profiles.length === 0) {
        return (
            <div className="empty-state">
                <div className="empty-icon">🖼️</div>
                <h3>Chưa có Profile nào</h3>
            </div>
        );
    }

    return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            <div className="profile-card">
                <div className="profile-header">
                    <div className="profile-title">
                        <div className="profile-avatar">🖼️</div>
                        <div>
                            <div className="profile-name">Tạo ảnh mới</div>
                            <div className="profile-id">{projectName}</div>
                        </div>
                    </div>
                </div>
                <div className="profile-meta" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="form-group">
                        <label className="form-label">Profile</label>
                        <select
                            className="form-input"
                            value={selectedProfileIdx}
                            onChange={(e) => setSelectedProfileIdx(Number(e.target.value))}
                        >
                            {profiles.map((p, idx) => (
                                <option key={p.id} value={idx}>
                                    {p.name} (Tier: {p.tier || 'N/A'})
                                </option>
                            ))}
                        </select>
                    </div>
                    {selectedProfile && (
                        <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: '8px', fontSize: '0.85rem' }}>
                            <div><strong>Profile:</strong> {selectedProfile.name}</div>
                            <div><strong>Tier:</strong> {selectedProfile.tier || 'N/A'}</div>
                            <div><strong>Project ID:</strong> <code>{selectedProjectObj?.projectId || '(chưa có)'}</code></div>
                        </div>
                    )}
                    <div className="form-group">
                        <label className="form-label">Prompt</label>
                        <textarea
                            className="form-input"
                            rows={3}
                            placeholder="Mô tả ảnh bạn muốn tạo..."
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Model</label>
                        <select className="form-input" value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
                            <option value="NANO_BANANA_PRO">🍌 Nano Banana Pro</option>
                            <option value="IMAGE_GENERATION_V2">🎨 Image V2</option>
                            <option value="IMAGE_GENERATION_V3">🎨 Image V3</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label className="form-label">Aspect Ratio</label>
                        <select className="form-input" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                            <option value="IMAGE_ASPECT_RATIO_LANDSCAPE">🖼️ Landscape (16:9)</option>
                            <option value="IMAGE_ASPECT_RATIO_PORTRAIT">📱 Portrait (9:16)</option>
                            <option value="IMAGE_ASPECT_RATIO_SQUARE">⬜ Square (1:1)</option>
                        </select>
                    </div>

                    <div className="form-group">
                        <label className="form-label">Upscale Resolution</label>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                            <div
                                onClick={() => setUpscaleResolution('UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL')}
                                style={{
                                    padding: '8px 6px',
                                    borderRadius: '8px',
                                    background: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' ? '#6366f1' : 'var(--bg-secondary)',
                                    color: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' ? 'white' : 'var(--text)',
                                    cursor: 'pointer',
                                    textAlign: 'center',
                                    transition: 'all 0.2s',
                                    border: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' ? '2px solid #6366f1' : '2px solid transparent',
                                }}
                            >
                                <div style={{ fontSize: '1rem' }}>📷</div>
                                <div style={{ fontSize: '0.7rem' }}>Original</div>
                            </div>
                            <div
                                onClick={() => setUpscaleResolution('UPSAMPLE_IMAGE_RESOLUTION_2K')}
                                style={{
                                    padding: '8px 6px',
                                    borderRadius: '8px',
                                    background: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_2K' ? '#22c55e' : 'var(--bg-secondary)',
                                    color: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_2K' ? 'white' : 'var(--text)',
                                    cursor: 'pointer',
                                    textAlign: 'center',
                                    transition: 'all 0.2s',
                                    border: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_2K' ? '2px solid #22c55e' : '2px solid transparent',
                                }}
                            >
                                <div style={{ fontSize: '1rem' }}>🖼️</div>
                                <div style={{ fontSize: '0.7rem' }}>2K</div>
                            </div>
                            <div
                                onClick={() => setUpscaleResolution('UPSAMPLE_IMAGE_RESOLUTION_4K')}
                                style={{
                                    padding: '8px 6px',
                                    borderRadius: '8px',
                                    background: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '#f59e0b' : 'var(--bg-secondary)',
                                    color: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? 'white' : 'var(--text)',
                                    cursor: 'pointer',
                                    textAlign: 'center',
                                    transition: 'all 0.2s',
                                    border: upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '2px solid #f59e0b' : '2px solid transparent',
                                }}
                            >
                                <div style={{ fontSize: '1rem' }}>🏔️</div>
                                <div style={{ fontSize: '0.7rem' }}>4K</div>
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            className="btn btn-primary"
                            onClick={handleSubmit}
                            disabled={!selectedProfile || !prompt.trim() || submitting || generating}
                        >
                            {generating ? '⏳ Đang tạo...' : '🚀 Tạo ảnh'}
                        </button>
                        <button className="btn btn-ghost" onClick={onClearResult}>🗑️ Xoá</button>
                    </div>
                </div>
            </div>

            {/* Result Panel */}
            <div className="profile-card">
                <div className="profile-header">
                    <div className="profile-title">
                        <div className="profile-avatar">📸</div>
                        <div>
                            <div className="profile-name">Kết quả</div>
                            <div className="profile-id">
                                {generating ? '⏳ Đang xử lý...' : lastResult ? '✓ Hoàn thành' : 'Chưa có kết quả'}
                            </div>
                        </div>
                    </div>
                </div>
                <div style={{ padding: '12px' }}>
                    {error && (
                        <div style={{ color: 'var(--error)', padding: '12px', background: 'rgba(255,0,0,0.1)', borderRadius: '8px', marginBottom: '12px' }}>
                            ⚠️ {error}
                        </div>
                    )}
                    {lastResult ? (
                        <div>
                            {(lastResult.servingUri || lastResult.downloadUrl || lastResult.localPath) ? (
                                <img
                                    src={lastResult.servingUri || lastResult.downloadUrl || lastResult.localPath || ''}
                                    alt="Generated"
                                    style={{ width: '100%', borderRadius: '8px', cursor: 'pointer' }}
                                    onClick={() => window.open(lastResult.servingUri || lastResult.downloadUrl || lastResult.localPath || '#', '_blank')}
                                />
                            ) : null}
                            <div style={{ marginTop: '12px', padding: '10px', background: 'var(--bg-secondary)', borderRadius: '8px', fontSize: '0.85rem' }}>
                                <div><strong>Model:</strong> {lastResult.modelKey}</div>
                                <div><strong>Aspect:</strong> {lastResult.aspectRatio}</div>
                                <div><strong>Media ID:</strong> <code>{lastResult.mediaId || 'N/A'}</code></div>
                            </div>
                        </div>
                    ) : (
                        <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px 0' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '12px' }}>🖼️</div>
                            <p>Chưa có kết quả. Tạo ảnh để xem ở đây.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function App() {
    const [activeTab, setActiveTab] = useState('profiles');
    const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
    const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
    const [activeProject, setActiveProject] = useState<string | null>(null);

    const { profiles, loading, creating: creatingProfile, loadProfiles, createProfile, updateProfile, deleteProfile, openProfile, closeProfile, saveSession, refreshTier, setProxy, createFlowProjectsBatch, waitForProfileReady } = useProfiles();
    const { status: cloakStatus } = useCloakBrowser();
    const { generating: generatingImage, lastResult: lastGeneratedImage, error: imageError, generateImage, reset: resetGeneratedImage } = useFlowImages();
    const videoState = useFlowVideos();
    useWebSocket();

    const showNotification = useCallback((message: string, type: 'success' | 'error' | 'info') => {
        setNotification({ message, type });
    }, []);

    const handleCreateProfile = async (name: string, desc: string, openFlow: boolean) => {
        try {
            const created = await createProfile(name, { description: desc });
            showNotification(`Đã tạo profile: ${name}`, 'success');
            setTimeout(() => loadProfiles(), 200);
            // If the user ticked "Tự động mở Google Flow" we open the new
            // profile right away. The modal already closed, so this just
            // kicks off the browser launch in the background.
            if (openFlow && created?.id) {
                showNotification('Đang mở profile mới trên Flow...', 'info');
                try {
                    await openProfile(created.id, true, true);
                } catch (openErr) {
                    showNotification(openErr instanceof Error ? openErr.message : 'Lỗi khi mở profile', 'error');
                }
            }
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi tạo profile', 'error');
            throw e; // bubble so the modal can re-enable its submit button if it weren't closed
        }
    };

    const handleOpenProfile = async (id: string, openFlow?: boolean, useStealth?: boolean, projectUrl?: string) => {
        try {
            showNotification(`Đang mở profile...`, 'info');
            await openProfile(id, openFlow, useStealth, projectUrl);
            showNotification('Profile đã được mở! Tier sẽ được cập nhật tự động.', 'success');
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi mở profile', 'error');
        }
    };

    const handleCloseProfile = async (id: string) => {
        try {
            showNotification('Đang đóng profile...', 'info');
            await closeProfile(id);
            showNotification('Profile đã được đóng', 'success');
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi đóng profile', 'error');
        }
    };

    const handleSaveSession = async (id: string) => {
        try {
            showNotification('Đang lưu session...', 'info');
            await saveSession(id);
            showNotification('Session đã được lưu!', 'success');
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi lưu session', 'error');
        }
    };

    const handleRefreshTier = async (id: string) => {
        try {
            showNotification('Đang refresh tier từ Extension...', 'info');
            await refreshTier(id);
            showNotification('Tier đã được cập nhật!', 'success');
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi refresh tier', 'error');
        }
    };

    const handleSetProxy = async (id: string, proxy: string | null) => {
        try {
            await setProxy(id, proxy);
            showNotification(proxy ? 'Đã cập nhật proxy!' : 'Đã xóa proxy!', 'success');
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi cập nhật proxy', 'error');
        }
    };

    const handleUpdateProfile = async (id: string, name: string, desc: string) => {
        try {
            await updateProfile(id, { name, metadata: { description: desc } });
            showNotification('Đã cập nhật profile!', 'success');
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi cập nhật', 'error');
        }
    };

    const handleUpdateProfileMetadata = async (profileId: string, metadata: Record<string, any>) => {
        try {
            await api.updateProfileMetadata(profileId, metadata);
            await loadProfiles();
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi cập nhật', 'error');
        }
    };

    const handleDeleteProfile = async (id: string) => {
        if (!confirm('Bạn có chắc muốn xóa profile này?')) return;
        try {
            const profileToDelete = profiles.find(p => p.id === id);
            if (!profileToDelete) {
                showNotification('Không tìm thấy profile!', 'error');
                return;
            }

            const profileProjects = profileToDelete.metadata?.flowProjects || [];

            // Group projects by name to check which ones have multiple profiles
            const projectNameCount = new Map<string, number>();
            profiles.forEach(p => {
                const projects = p.metadata?.flowProjects || [];
                projects.forEach((proj: any) => {
                    if (proj.name) {
                        projectNameCount.set(proj.name, (projectNameCount.get(proj.name) || 0) + 1);
                    }
                });
            });

            // Separate projects: shared (exists on multiple profiles) vs only-on-deleted-profile
            const projectsShared: string[] = [];
            const projectsOnlyOnDeleted: string[] = [];

            profileProjects.forEach((proj: any) => {
                if (proj.name) {
                    const count = projectNameCount.get(proj.name) || 0;
                    if (count === 1) {
                        projectsOnlyOnDeleted.push(proj.name);
                    } else {
                        projectsShared.push(proj.name);
                    }
                }
            });

            // For shared projects: only remove this profile's entry (other profiles keep the project)
            for (const projectName of projectsShared) {
                const profile = profiles.find(p => p.id === id);
                if (profile?.metadata?.flowProjects) {
                    // Remove only this profile's entry for this project name
                    const updatedProjects = profile.metadata.flowProjects.filter((p: any) => p.name !== projectName);
                    await api.updateProfileMetadata(id, {
                        ...profile.metadata,
                        flowProjects: updatedProjects
                    });
                }
            }
            // Note: projectsOnlyOnDeleted don't need to be removed from this profile
            // since the profile itself is being deleted anyway

            await deleteProfile(id);
            showNotification('Đã xóa profile!', 'success');
        } catch (e) {
            showNotification(e instanceof Error ? e.message : 'Lỗi khi xóa', 'error');
        }
    };

    const handleCreateFlowProjectsBatch = async (data: { profileIds: string[]; name: string; description?: string; toolName?: string }) => {
        return createFlowProjectsBatch(data);
    };

    // Listen for refresh events
    useEffect(() => {
        const handleRefresh = () => loadProfiles();
        const handleShowNotification = (e: Event) => {
            const customEvent = e as CustomEvent<{ message: string; type: 'success' | 'error' | 'info' }>;
            showNotification(customEvent.detail.message, customEvent.detail.type);
        };
        window.addEventListener('refresh-profiles', handleRefresh);
        window.addEventListener('show-notification', handleShowNotification);
        return () => {
            window.removeEventListener('refresh-profiles', handleRefresh);
            window.removeEventListener('show-notification', handleShowNotification);
        };
    }, [loadProfiles, showNotification]);

    const activeCount = profiles.filter((p: Profile) => p.isActive).length;

    const isProjectTab = (tab: string) => tab.startsWith('project:');

    const handleTabChange = (tab: string) => {
        setActiveTab(tab);
        setActiveProject(isProjectTab(tab) ? tab.replace('project:', '') : null);
    };

    const handleOpenProjectDetail = (name: string) => {
        setActiveProject(name);
        setActiveTab(`project:${name}`);
    };

    const handleBackToProjects = () => {
        setActiveProject(null);
        setActiveTab('flow-projects');
    };

    // Get the project-specific tab (Videos/Images) within a project
    const activeProjectTab = isProjectTab(activeTab)
        ? (activeTab.split(':').pop() as 'videos' | 'images' || 'videos')
        : 'videos';

    return (
        <div className="app-container">
            <Sidebar
                activeTab={activeTab}
                onTabChange={handleTabChange}
                totalProfiles={profiles.length}
                activeSessions={activeCount}
                cloakStatus={cloakStatus}
            />

            <div className="main-content">
                {/* Profile Manager */}
                <div className={`tab-content ${activeTab === 'profiles' ? 'active' : ''}`}>
                    <ProfilesTab
                        profiles={profiles}
                        loading={loading}
                        creatingProfile={creatingProfile}
                        onCreateProfile={handleCreateProfile}
                        onOpenProfile={handleOpenProfile}
                        onCloseProfile={handleCloseProfile}
                        onSaveSession={handleSaveSession}
                        onUpdateProfile={handleUpdateProfile}
                        onDeleteProfile={handleDeleteProfile}
                        onRefreshTier={handleRefreshTier}
                        onSetProxy={handleSetProxy}
                    />
                </div>

                {/* Flow Projects - grid list */}
                <div className={`tab-content ${activeTab === 'flow-projects' ? 'active' : ''}`}>
                    <FlowProjectsTab
                        profiles={profiles}
                        onCreateProjectsBatch={handleCreateFlowProjectsBatch}
                        onUpdateProfileMetadata={handleUpdateProfileMetadata}
                        onOpenProfile={handleOpenProfile}
                        onOpenProjectDetail={handleOpenProjectDetail}
                    />
                </div>

                {/* Project Detail - with Videos/Images tabs */}
                {isProjectTab(activeTab) && activeProject && (
                    <ProjectDetailPage
                        projectName={activeProject}
                        projectTab={activeProjectTab}
                        profiles={profiles}
                        onUpdateProfileMetadata={handleUpdateProfileMetadata}
                        onOpenProfile={openProfile}
                        onWaitForProfileReady={waitForProfileReady}
                        generatingImage={generatingImage}
                        lastGeneratedImage={lastGeneratedImage}
                        imageError={imageError}
                        generateImage={generateImage}
                        resetGeneratedImage={resetGeneratedImage}
                        onBack={handleBackToProjects}
                    />
                )}

                {/* Entity Library */}
                <div className={`tab-content ${activeTab === 'entities' ? 'active' : ''}`}>
                    <EntitiesTab profiles={profiles} onOpenProfile={openProfile} onWaitForProfileReady={waitForProfileReady} onOpenLightbox={(src, alt) => setLightbox({ src, alt })} />
                </div>

                {/* Script Generator */}
                <div className={`tab-content ${activeTab === 'script-gen' ? 'active' : ''}`}>
                    <ScriptGeneratorTab />
                </div>

                {/* Settings */}
                <div className={`tab-content ${activeTab === 'settings' ? 'active' : ''}`}>
                    <AboutTab cloakStatus={cloakStatus} />
                </div>
            </div>

            {notification && (
                <Notification message={notification.message} type={notification.type} onClose={() => setNotification(null)} />
            )}

            {lightbox && (
                <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
            )}
        </div>
    );
}
