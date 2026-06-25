import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import logger from '../utils/logger';

export interface FinalizeOptions {
    mode?: 'concat' | 'xfade';
    transition?: string;
    transitionDurationSeconds?: number;
    originalAudioVolumePercent?: number;
    musicPath?: string;
    musicVolume?: number;
    logoPath?: string;
    logoWidth?: number;
    logoHeight?: number;
    logoPosition?: string;
    logoXPercent?: number;
    logoYPercent?: number;
    logoZoomPercent?: number;
    textOverlay?: string;
    textBgOpacityPercent?: number;
}

export interface AssembleVideoOptions {
    sceneVideos: string[];
    outputPath: string;
    audioPath?: string;
    transitionSeconds?: number;
    finalize?: FinalizeOptions;
}

export class VideoAssembler {
    async assembleVideo(options: AssembleVideoOptions): Promise<string> {
        const { sceneVideos, outputPath, audioPath } = options;

        if (!sceneVideos.length) {
            throw new Error('No scene videos to assemble');
        }

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        if (sceneVideos.length === 1) {
            fs.copyFileSync(sceneVideos[0], outputPath);
            if (audioPath) await this.addAudio(outputPath, audioPath, outputPath);
            return outputPath;
        }

        const listPath = path.join(dir, `concat_${Date.now()}.txt`);
        fs.writeFileSync(listPath, sceneVideos.map(v => `file '${v.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');

        await this.runFfmpeg([
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-c', 'copy',
            outputPath,
        ]);

        if (audioPath) {
            await this.addAudio(outputPath, audioPath, outputPath);
        }

        fs.rmSync(listPath, { force: true });
        return outputPath;
    }

    async assembleFinal(options: AssembleVideoOptions): Promise<string> {
        const { sceneVideos, outputPath, finalize = {} } = options;

        if (!sceneVideos.length) {
            throw new Error('No scene videos to assemble');
        }

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const hasEffects = this.hasFinalEffects(finalize);
        if (sceneVideos.length === 1 && !hasEffects) {
            fs.copyFileSync(sceneVideos[0], outputPath);
            if (finalize.musicPath && fs.existsSync(finalize.musicPath)) {
                await this.addAudio(outputPath, finalize.musicPath, outputPath);
            }
            return outputPath;
        }

        const mode = finalize.mode || 'concat';
        const transition = finalize.transition;
        const useXfade =
            mode === 'xfade' &&
            transition &&
            transition !== 'none' &&
            sceneVideos.length >= 2;

        if (!useXfade) {
            await this.concatWithEffects(sceneVideos, outputPath, finalize);
            return outputPath;
        }

        await this.xfadeWithEffects(sceneVideos, outputPath, finalize);
        return outputPath;
    }

    async addAudio(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
        if (!fs.existsSync(audioPath)) {
            logger.warn(`[VideoAssembler] Audio file missing: ${audioPath}`);
            return videoPath;
        }

        const tmp = outputPath + '.with-audio.mp4';
        await this.runFfmpeg([
            '-i', videoPath,
            '-i', audioPath,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-shortest',
            tmp,
        ]);
        fs.renameSync(tmp, outputPath);
        return outputPath;
    }

    async createThumbnail(videoPath: string, timestampSeconds = 1): Promise<string | null> {
        if (!fs.existsSync(videoPath)) return null;
        const out = videoPath.replace(/\.mp4$/i, '_thumb.jpg');
        try {
            await this.runFfmpeg([
                '-ss', String(timestampSeconds),
                '-i', videoPath,
                '-frames:v', '1',
                '-q:v', '2',
                out,
            ]);
            return out;
        } catch (err) {
            logger.warn(`[VideoAssembler] Thumbnail failed for ${videoPath}: ${String(err)}`);
            return null;
        }
    }

    private hasFinalEffects(finalize: FinalizeOptions): boolean {
        return !!(
            finalize.originalAudioVolumePercent !== undefined ||
            (finalize.musicPath && fs.existsSync(finalize.musicPath)) ||
            (finalize.logoPath && fs.existsSync(finalize.logoPath)) ||
            (finalize.textOverlay && finalize.textOverlay.trim().length > 0)
        );
    }

    private async concatWithEffects(sceneVideos: string[], outputPath: string, finalize: FinalizeOptions): Promise<void> {
        const dir = path.dirname(outputPath);
        const listPath = path.join(dir, `concat_${Date.now()}.txt`);
        try {
            fs.writeFileSync(
                listPath,
                sceneVideos.map(v => `file '${v.replace(/'/g, "'\\''")}'`).join('\n'),
                'utf-8'
            );

            const args: string[] = [
                '-f', 'concat',
                '-safe', '0',
                '-i', listPath,
            ];

            const filterComplex: string[] = [];
            let currentVideoMap = '[0:v]';
            let audioMap = '[0:a]';
            let extraInputIndex = sceneVideos.length;

            if (finalize.originalAudioVolumePercent !== undefined) {
                const vol = Math.max(0, Math.min(100, Math.round(finalize.originalAudioVolumePercent))) / 100;
                filterComplex.push(`[0:a]volume=${vol.toFixed(4)}[a_out]`);
                audioMap = '[a_out]';
            }

            if (finalize.musicPath && fs.existsSync(finalize.musicPath)) {
                const musicVolume = Math.max(0, Math.min(1, finalize.musicVolume ?? 0.2));
                args.push('-stream_loop', '-1', '-i', finalize.musicPath);
                const musicInput = `[#{(extraInputIndex + 1)}:a]`;
                if (finalize.originalAudioVolumePercent !== undefined) {
                    filterComplex.push(`${musicInput}volume=${musicVolume.toFixed(4)}[bg]`);
                    filterComplex.push(`[a_out][bg]amix=inputs=2:duration=first:dropout_transition=0[a_mix]`);
                    audioMap = '[a_mix]';
                } else {
                    filterComplex.push(`${musicInput}volume=${musicVolume.toFixed(4)}[a_mix]`);
                    audioMap = '[a_mix]';
                }
                extraInputIndex += 1;
            }

            if (finalize.logoPath && fs.existsSync(finalize.logoPath)) {
                const logoEsc = finalize.logoPath.replace(/\\/g, '/').replace(/'/g, "\\'");
                const lower = logoEsc.toLowerCase();
                if (lower.endsWith('.gif')) {
                    filterComplex.push(`movie='${logoEsc}':loop=0,setpts=N/FRAME_RATE/TB[logo_v]`);
                } else {
                    args.push('-loop', '1', '-i', finalize.logoPath);
                    filterComplex.push(`[#{(extraInputIndex + 1)}:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuva420p[logo_v]`);
                    extraInputIndex += 1;
                }

                const scaleFilter = this.buildLogoScaleFilter(finalize);
                filterComplex.push(`[logo_v]${scaleFilter}[logo_scaled]`);

                const { x, y } = this.buildLogoPosition(finalize);
                filterComplex.push(`[0:v][logo_scaled]overlay=${x}:${y}[v_logo]`);
                currentVideoMap = '[v_logo]';
            }

            if (finalize.textOverlay && finalize.textOverlay.trim().length > 0) {
                const escapedText = finalize.textOverlay.replace(/'/g, "\\'").replace(/:/g, "\\:");
                const bgOpacity = Math.max(0, Math.min(1, (finalize.textBgOpacityPercent ?? 0) / 100));
                const fontSize = 28;
                const boxOpacity = bgOpacity > 0 ? `box=1:boxcolor=black@${bgOpacity.toFixed(2)}:boxborderw=8` : 'box=0';
                filterComplex.push(
                    `${currentVideoMap}drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=40:y=40:${boxOpacity}:borderw=2:bordercolor=black[outv]`
                );
                currentVideoMap = '[outv]';
            }

            const filter = filterComplex.join(';');
            if (filter) {
                args.push('-filter_complex', filter);
                args.push('-map', currentVideoMap);
                args.push('-map', audioMap);
            } else {
                args.push('-c', 'copy');
            }

            args.push('-shortest');
            args.push('-pix_fmt', 'yuv420p');
            args.push('-movflags', '+faststart');
            args.push(outputPath);

            await this.runFfmpeg(args);
        } finally {
            if (fs.existsSync(listPath)) fs.rmSync(listPath, { force: true });
        }
    }

    private async xfadeWithEffects(sceneVideos: string[], outputPath: string, finalize: FinalizeOptions): Promise<void> {
        const transition = finalize.transition || 'fade';
        const transitionDuration = Math.max(0.25, Math.min(3, finalize.transitionDurationSeconds ?? 1));
        const n = sceneVideos.length;

        const tmpDir = path.dirname(outputPath);
        const baseTag = String(Date.now());

        try {
            if (n > 80) {
                const maxPerBatch = 40;
                const tmpOutputs: string[] = [];
                for (let idx = 0; idx < n; idx += maxPerBatch) {
                    const batch = sceneVideos.slice(idx, idx + maxPerBatch);
                    const tmpOut = path.join(tmpDir, `xfade_batch_${baseTag}_${idx}.mp4`);
                    await this.xfadeWithEffects(batch, tmpOut, finalize);
                    tmpOutputs.push(tmpOut);
                }

                if (tmpOutputs.length === 1) {
                    fs.copyFileSync(tmpOutputs[0], outputPath);
                    return;
                }

                const listFile = path.join(tmpDir, `concat_batches_${baseTag}.txt`);
                fs.writeFileSync(
                    listFile,
                    tmpOutputs.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
                    'utf-8'
                );
                await this.runFfmpeg([
                    '-f', 'concat', '-safe', '0', '-i', listFile,
                    '-c', 'copy', outputPath,
                ]);
                return;
            }

            const durations: number[] = [];
            for (const v of sceneVideos) {
                const d = this.getDuration(v);
                if (d <= 0) {
                    await this.concatWithEffects(sceneVideos, outputPath, finalize);
                    return;
                }
                durations.push(d);
            }

            if (n === 1) {
                await this.concatWithEffects(sceneVideos, outputPath, finalize);
                return;
            }

            const offsets: number[] = [];
            let cum = 0;
            for (let i = 0; i < n - 1; i++) {
                cum += durations[i];
                offsets.push(cum + transitionDuration * i);
            }

            const baseFps = this.getFps(sceneVideos[0]) || 24;
            const targetFps = Math.max(1, Math.round(baseFps));

            const dims = sceneVideos.map(v => this.getDimensions(v));
            const maxW = Math.max(...dims.map(d => d[0]));
            const maxH = Math.max(...dims.map(d => d[1]));
            const targetW = Math.max(2, maxW - (maxW % 2));
            const targetH = Math.max(2, maxH - (maxH % 2));

            const parts: string[] = [];
            for (let i = 0; i < n; i++) {
                const d = durations[i];
                const base = `[${i}:v]trim=start=0:end=${d},setpts=PTS-STARTPTS,` +
                    `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
                    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps},format=yuv420p`;
                if (i === 0) {
                    parts.push(`${base},tpad=stop_duration=${transitionDuration}:stop_mode=clone[v${i}]`);
                } else {
                    parts.push(`${base},tpad=start_duration=${transitionDuration}:start_mode=clone[v${i}]`);
                }
            }

            const audioParts: string[] = [];
            const silenceParts: string[] = [];
            for (let i = 0; i < n; i++) {
                const d = durations[i];
                if (this.hasAudio(sceneVideos[i])) {
                    audioParts.push(`[${i}:a]atrim=start=0:end=${d},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
                } else {
                    audioParts.push(`anullsrc=r=48000:cl=stereo,atrim=start=0:end=${d},asetpts=PTS-STARTPTS[a${i}]`);
                }
                if (i < n - 1) {
                    silenceParts.push(`anullsrc=r=48000:cl=stereo,atrim=start=0:end=${transitionDuration}[s${i}]`);
                }
            }

            let videoFilter = '';
            if (n === 2) {
                videoFilter = `[v0][v1]xfade=transition=${transition}:duration=${transitionDuration}:offset=${offsets[0]}[outv]`;
            } else {
                const chain: string[] = [];
                chain.push(`[v0][v1]xfade=transition=${transition}:duration=${transitionDuration}:offset=${offsets[0]}[x01]`);
                for (let i = 2; i < n; i++) {
                    const prevLabel = `[x0${i - 1}]`;
                    const prevPad = `[x0${i - 1}p]`;
                    const outLabel = i === n - 1 ? '[outv]' : `[x0${i}]`;
                    chain.push(`${prevLabel}tpad=stop_duration=${transitionDuration}:stop_mode=clone${prevPad}`);
                    chain.push(`${prevPad}[v${i}]xfade=transition=${transition}:duration=${transitionDuration}:offset=${offsets[i - 1]}${outLabel}`);
                }
                videoFilter = chain.join(';');
            }

            const audioSeq: string[] = [];
            for (let i = 0; i < n; i++) {
                audioSeq.push(`[a${i}]`);
                if (i < n - 1) audioSeq.push(`[s${i}]`);
            }
            const audioChain = `${audioSeq.join('')}concat=n=${audioSeq.length}:v=0:a=1[outa]`;

            const filterComplex = [audioParts.join(';'), silenceParts.join(';'), ...parts, videoFilter, audioChain].filter(Boolean).join(';');

            const args: string[] = ['-y', '-hwaccel', 'none'];
            for (const v of sceneVideos) {
                args.push('-i', v);
            }
            args.push('-filter_complex', filterComplex);
            args.push('-map', '[outv]');
            args.push('-map', '[outa]');
            args.push('-r', String(targetFps));
            args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23');
            args.push('-c:a', 'aac', '-b:a', '192k');
            args.push('-pix_fmt', 'yuv420p');
            args.push('-movflags', '+faststart');
            args.push(outputPath);

            await this.runFfmpeg(args);
        } finally {
            const tmpFiles = fs.readdirSync(tmpDir).filter(name => name.includes(`xfade_batch_${baseTag}`));
            for (const file of tmpFiles) {
                const full = path.join(tmpDir, file);
                try { if (fs.existsSync(full)) fs.rmSync(full, { force: true }); } catch { /* ignore */ }
            }
            const listFile = path.join(tmpDir, `concat_batches_${baseTag}.txt`);
            try { if (fs.existsSync(listFile)) fs.rmSync(listFile, { force: true }); } catch { /* ignore */ }
        }
    }

    private buildLogoScaleFilter(finalize: FinalizeOptions): string {
        const logoWidth = finalize.logoWidth ?? 200;
        const logoHeight = finalize.logoHeight ?? null;
        if (logoHeight && logoHeight > 0) {
            return `scale=${logoWidth}:${logoHeight}:force_original_aspect_ratio=decrease`;
        }
        return `scale=${logoWidth}:-1`;
    }

    private buildLogoPosition(finalize: FinalizeOptions): { x: string; y: string } {
        const position = String(finalize.logoPosition || 'bottom-right').toLowerCase();
        const xPercent = Math.max(0, Math.min(100, finalize.logoXPercent ?? 0));
        const yPercent = Math.max(0, Math.min(100, finalize.logoYPercent ?? 0));

        if (position.includes('left')) {
            return { x: `${xPercent}%`, y: `${yPercent}%` };
        }
        if (position.includes('right')) {
            return { x: `(W-w-${100 - xPercent}%ofW)`, y: `${yPercent}%` };
        }
        if (position.includes('top')) {
            return { x: `(W-w)/2+${xPercent}%ofW-w/2`, y: `${yPercent}%` };
        }
        return { x: `(W-w)/2+${xPercent}%ofW-w/2`, y: `(H-h-${100 - yPercent}%ofH)` };
    }

    private getDuration(videoPath: string): number {
        if (!fs.existsSync(videoPath)) return 0;
        try {
            const cmd = [this.ffmpegPath(), '-hide_banner', '-i', videoPath];
            const res = execSync(this.quoteCommand(cmd), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) as string;
            const stderr = res || '';
            const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
            if (!match) return 0;
            return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        } catch {
            return 0;
        }
    }

    private getFps(videoPath: string): number {
        if (!fs.existsSync(videoPath)) return 0;
        try {
            const cmd = [this.ffmpegPath(), '-hide_banner', '-i', videoPath];
            const res = execSync(this.quoteCommand(cmd), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) as string;
            const stderr = res || '';
            const match = stderr.match(/(\d+(?:\.\d+)?)\s+fps/);
            return match ? Number(match[1]) : 0;
        } catch {
            return 0;
        }
    }

    private getDimensions(videoPath: string): [number, number] {
        if (!fs.existsSync(videoPath)) return [1920, 1080];
        try {
            const cmd = [this.ffmpegPath(), '-hide_banner', '-i', videoPath];
            const res = execSync(this.quoteCommand(cmd), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) as string;
            const stderr = res || '';
            const match = stderr.match(/,\s*(\d+)x(\d+)/);
            if (match) return [Number(match[1]), Number(match[2])];
        } catch { /* ignore */ }
        return [1920, 1080];
    }

    private hasAudio(videoPath: string): boolean {
        if (!fs.existsSync(videoPath)) return false;
        try {
            const cmd = [this.ffmpegPath(), '-hide_banner', '-i', videoPath];
            const res = execSync(this.quoteCommand(cmd), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) as string;
            return (res || '').includes('Audio:');
        } catch {
            return false;
        }
    }

    private ffmpegPath(): string {
        return 'ffmpeg';
    }

    private async runFfmpeg(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            
            proc.on('error', (err) => {
                reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
            });
            
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('close', code => {
                if (code === 0) return resolve();
                reject(new Error(`ffmpeg failed with code ${code}: ${stderr}`));
            });
        });
    }

    private quoteCommand(args: string[]): string {
        return args.map(arg => /[ "]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg).join(' ');
    }
}
