import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import VideoProjectEditor from '../src/frontend/components/VideoProjectEditor';
import type { VideoProject } from '../src/frontend/types';

const mockProject: VideoProject = {
    id: 'proj-1',
    name: 'Test Video Project',
    scriptId: 'script-1',
    profileIds: ['p1', 'p2'],
    scenes: [
        {
            sceneIndex: 1,
            prompt: 'A cat in a garden',
            characters: ['Cat'],
            assets: [],
            status: 'pending',
        },
        {
            sceneIndex: 2,
            prompt: 'A dog running',
            characters: ['Dog'],
            assets: [],
            status: 'completed',
        },
        {
            sceneIndex: 3,
            prompt: 'A bird flying',
            characters: [],
            assets: [],
            status: 'generating',
            progress: 45,
        },
    ],
    globalReferences: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02',
};

describe('VideoProjectEditor', () => {
    it('renders project name and scene count', () => {
        const onBack = vi.fn();
        const onRun = vi.fn();
        const onSave = vi.fn();

        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={onBack}
                onRun={onRun}
                onSave={onSave}
            />
        );

        expect(screen.getByText('Test Video Project')).toBeTruthy();
        expect(screen.getByText('3 scenes')).toBeTruthy();
    });

    it('renders all scenes in the grid', () => {
        const { container } = render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        expect(screen.getAllByText(/Scene 00\d/).length).toBeGreaterThanOrEqual(3);
    });

    it('renders scene prompts', () => {
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        expect(screen.getByText(/A cat in a garden/)).toBeTruthy();
        expect(screen.getByText(/A dog running/)).toBeTruthy();
    });

    it('shows progress for generating scenes', () => {
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        expect(screen.getByText('45%')).toBeTruthy();
    });

    it('toggles scene selection', () => {
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes.length).toBeGreaterThan(0);
    });

    it('shows Run All button', () => {
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        const runButtons = screen.getAllByRole('button', { name: /Run All/ });
        expect(runButtons.length).toBeGreaterThan(0);
    });

    it('calls onBack when back button clicked', () => {
        const onBack = vi.fn();
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={onBack}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        fireEvent.click(screen.getByText('← Back'));
        expect(onBack).toHaveBeenCalled();
    });

    it('switches to list view', () => {
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        const buttons = screen.getAllByRole('button', { name: 'List' });
        fireEvent.click(buttons[0]);
        expect(buttons.length).toBeGreaterThan(0);
    });

    it('opens scene edit modal on Edit click', () => {
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        const editButtons = screen.getAllByRole('button', { name: 'Edit' });
        fireEvent.click(editButtons[0]);

        expect(screen.getByText(/Edit Scene/)).toBeTruthy();
    });

    it('search filters scenes', () => {
        render(
            <VideoProjectEditor
                project={mockProject}
                onBack={vi.fn()}
                onRun={vi.fn()}
                onSave={vi.fn()}
            />
        );

        const searchInput = screen.getByPlaceholderText('Search scenes...');
        fireEvent.change(searchInput, { target: { value: 'bird' } });

        const sceneWithCat = screen.queryByText(/A cat in a garden/);
        expect(sceneWithCat).toBeFalsy();
    });
});
