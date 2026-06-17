import React, { useState, useEffect, useCallback } from 'react';
import { useProfiles, useCloakBrowser } from '../hooks/useProfiles';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Profile, FlowProject } from '../types';
import '../styles/App.css';

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
        { id: 'about', icon: '🛡️', label: 'CloakBrowser' },
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
function FlowProjectsTab({ profiles, onCreateProjectsBatch }: { profiles: Profile[]; onCreateProjectsBatch: (data: { profileIds: string[]; name: string; description?: string; toolName?: string }) => Promise<any> }) {
    const [showModal, setShowModal] = useState(false);
    const [projectName, setProjectName] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [creating, setCreating] = useState(false);
    const [results, setResults] = useState<any[] | null>(null);

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
                name: raw.name,
                description: raw.description,
                toolName: raw.toolName,
                createdAt: raw.createdAt,
                projectId: raw.projectId,
            });
        });
        return items;
    });

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
            if (normalized.some((item: any) => item.status === 'success')) {
                window.dispatchEvent(new CustomEvent('refresh-profiles'));
            }
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

    const resetAndClose = () => {
        setShowModal(false);
        setProjectName('');
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
                ) : allProjects.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon">🌊</div>
                        <h3>Chưa có Flow Project nào</h3>
                        <p>Nhấn "Tạo Project Mới" để bắt đầu tạo project trên Google Flow.</p>
                        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Tạo Project Đầu Tiên</button>
                    </div>
                ) : (
                    <div className="profiles-grid">
                        {allProjects.map((project) => (
                            <FlowProjectCard
                                key={`${project.profileId}-${project.id}`}
                                project={project}
                                profile={profileMap.get(project.profileId)}
                            />
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

// Main App
export default function App() {
    const [activeTab, setActiveTab] = useState('profiles');
    const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

    const { profiles, loading, creating: creatingProfile, loadProfiles, createProfile, updateProfile, deleteProfile, openProfile, closeProfile, saveSession, refreshTier, setProxy, createFlowProjectsBatch, waitForProfileReady } = useProfiles();
    const { status: cloakStatus } = useCloakBrowser();
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

    const handleOpenProfile = async (id: string, openFlow?: boolean, useStealth?: boolean) => {
        try {
            showNotification(`Đang mở profile...`, 'info');
            await openProfile(id, openFlow, useStealth);
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

    const handleDeleteProfile = async (id: string) => {
        if (!confirm('Bạn có chắc muốn xóa profile này?')) return;
        try {
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
        window.addEventListener('refresh-profiles', handleRefresh);
        return () => window.removeEventListener('refresh-profiles', handleRefresh);
    }, [loadProfiles]);

    const activeCount = profiles.filter((p: Profile) => p.isActive).length;

    return (
        <div className="app-container">
            <Sidebar
                activeTab={activeTab}
                onTabChange={setActiveTab}
                totalProfiles={profiles.length}
                activeSessions={activeCount}
                cloakStatus={cloakStatus}
            />

            <div className="main-content">
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

                <div className={`tab-content ${activeTab === 'flow-projects' ? 'active' : ''}`}>
                    <FlowProjectsTab
                        profiles={profiles}
                        onCreateProjectsBatch={handleCreateFlowProjectsBatch}
                    />
                </div>

                <div className={`tab-content ${activeTab === 'about' ? 'active' : ''}`}>
                    <AboutTab cloakStatus={cloakStatus} />
                </div>
            </div>

            {notification && (
                <Notification message={notification.message} type={notification.type} onClose={() => setNotification(null)} />
            )}
        </div>
    );
}
