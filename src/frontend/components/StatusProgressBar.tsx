import React from 'react';

export type StatusType = 'idle' | 'pending' | 'processing' | 'polling' | 'downloading' | 'uploading' | 'completed' | 'failed' | 'done' | 'error' | 'retrying';

export interface StatusProgressProps {
  status: StatusType;
  progress?: number; // 0-100
  label?: string;
  showProgress?: boolean;
  size?: 'small' | 'medium' | 'large';
  animated?: boolean;
  retryCount?: number;
  maxRetries?: number;
}

const STATUS_CONFIG: Record<StatusType, { color: string; bgColor: string; label: string; animated: boolean }> = {
  idle: { color: '#6b7280', bgColor: 'rgba(107, 114, 128, 0.2)', label: 'Idle', animated: false },
  pending: { color: '#9ca3af', bgColor: 'rgba(156, 163, 175, 0.2)', label: 'Chờ', animated: false },
  processing: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang xử lý', animated: true },
  polling: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang kiểm tra', animated: true },
  downloading: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang tải về', animated: true },
  uploading: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang tải lên', animated: true },
  retrying: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.2)', label: 'Đang thử lại', animated: true },
  completed: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.2)', label: 'Hoàn thành', animated: false },
  done: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.2)', label: 'Xong', animated: false },
  failed: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.2)', label: 'Lỗi', animated: false },
  error: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.2)', label: 'Lỗi', animated: false },
};

export function StatusProgressBar({
  status,
  progress,
  label,
  showProgress = true,
  size = 'medium',
  animated = true,
  retryCount,
  maxRetries = 2,
}: StatusProgressProps) {
  // If retrying, override status for display
  const displayStatus = retryCount && retryCount > 0 ? 'retrying' : status;
  const config = STATUS_CONFIG[displayStatus] || STATUS_CONFIG.pending;
  const displayLabel = label || config.label;
  const shouldAnimate = animated && config.animated;

  const heights = {
    small: 4,
    medium: 6,
    large: 8,
  };

  return (
    <div className="status-progress-bar" style={{ width: '100%' }}>
      <div
        className={`status-progress-track ${shouldAnimate ? 'status-progress-animated' : ''}`}
        style={{
          height: heights[size],
          backgroundColor: config.bgColor,
          borderRadius: heights[size] / 2,
          overflow: 'hidden',
        }}
      >
        <div
          className="status-progress-fill"
          style={{
            width: showProgress && progress !== undefined ? `${progress}%` : status === 'completed' || status === 'done' ? '100%' : '30%',
            height: '100%',
            backgroundColor: config.color,
            borderRadius: heights[size] / 2,
            transition: shouldAnimate ? 'none' : 'width 0.3s ease',
          }}
        />
      </div>
      <div
        className="status-progress-label"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 4,
          fontSize: size === 'small' ? '0.7rem' : size === 'large' ? '0.85rem' : '0.75rem',
          color: config.color,
        }}
      >
        <span className={shouldAnimate ? 'status-progress-text-animated' : ''}>
          {shouldAnimate && '● '}{displayLabel}
          {retryCount && retryCount > 0 && (
            <span style={{ marginLeft: 6, opacity: 0.8, fontSize: '0.9em' }}>
              (thử lại {retryCount}/{maxRetries})
            </span>
          )}
        </span>
        {showProgress && progress !== undefined && (
          <span>{progress}%</span>
        )}
      </div>
    </div>
  );
}

export default StatusProgressBar;
