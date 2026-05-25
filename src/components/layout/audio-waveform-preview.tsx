import { useEffect, useRef, useState, type JSX } from 'react';

function decodeDataUrlToArrayBuffer(dataUrl: string): ArrayBuffer | undefined {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    return undefined;
  }
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  const binary = isBase64 ? window.atob(payload.replace(/\s+/g, '')) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function buildAudioPeaks(buffer: AudioBuffer, peakCount: number): number[] {
  const channelCount = Math.max(1, Math.min(buffer.numberOfChannels, 2));
  const peaks: number[] = [];
  const samplesPerPeak = Math.max(1, Math.floor(buffer.length / peakCount));

  for (let peakIndex = 0; peakIndex < peakCount; peakIndex += 1) {
    const start = peakIndex * samplesPerPeak;
    const end = Math.min(buffer.length, start + samplesPerPeak);
    let max = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      let mixed = 0;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        mixed += buffer.getChannelData(channelIndex)[sampleIndex] ?? 0;
      }
      max = Math.max(max, Math.abs(mixed / channelCount));
    }
    peaks.push(Math.min(1, max));
  }

  return peaks;
}

function canvasCssColor(canvas: HTMLCanvasElement, name: string, fallback: string): string {
  return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
}

function drawAudioWaveform(canvas: HTMLCanvasElement, peaks: number[], compact: boolean, progress: number): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  context.fillStyle = canvasCssColor(canvas, '--fp-audio-waveform-bg', compact ? '#f4f1ff' : '#f7f5ff');
  context.fillRect(0, 0, width, height);

  const centerY = height / 2;
  context.fillStyle = canvasCssColor(canvas, '--fp-audio-waveform-baseline', 'rgba(99, 102, 241, 0.24)');
  context.fillRect(0, centerY - 0.5, width, 1);

  if (peaks.length > 0) {
    const step = width / peaks.length;
    context.fillStyle = canvasCssColor(canvas, '--fp-audio-waveform-fill', '#f59e0b');
    for (let index = 0; index < peaks.length; index += 1) {
      const peak = peaks[index] ?? 0;
      const x = Math.floor(index * step);
      const barWidth = Math.max(1, Math.ceil(step));
      const barHeight = Math.max(1, peak * height * 0.86);
      context.fillRect(x, centerY - barHeight / 2, barWidth, barHeight);
    }
  }

  const clampedProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const progressX = Math.round(width * clampedProgress);
  context.fillStyle = canvasCssColor(canvas, '--fp-audio-waveform-progress', 'rgba(79, 70, 229, 0.92)');
  context.fillRect(Math.max(0, progressX - 1), 0, 2, height);
}

export function AudioWaveformPreview(props: { src: string; compact?: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackFrameRef = useRef<number | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function decode(): Promise<void> {
      const data = decodeDataUrlToArrayBuffer(props.src);
      if (!data) {
        setPeaks([]);
        return;
      }
      const AudioContextConstructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) {
        setPeaks([]);
        return;
      }
      const audioContext = new AudioContextConstructor();
      try {
        const decoded = await audioContext.decodeAudioData(data.slice(0));
        if (!cancelled) {
          setPeaks(buildAudioPeaks(decoded, props.compact ? 180 : 520));
        }
      } catch {
        if (!cancelled) {
          setPeaks([]);
        }
      } finally {
        await audioContext.close().catch(() => undefined);
      }
    }
    void decode();
    return () => {
      cancelled = true;
    };
  }, [props.src, props.compact]);

  useEffect(() => {
    setProgress(0);
  }, [props.src]);

  useEffect(() => {
    return () => {
      if (playbackFrameRef.current !== null) {
        window.cancelAnimationFrame(playbackFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const render = (): void => drawAudioWaveform(canvas, peaks, Boolean(props.compact), progress);
    render();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, [peaks, progress, props.compact]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const updateProgress = (): void => {
      const duration = audio.duration;
      setProgress(Number.isFinite(duration) && duration > 0 ? audio.currentTime / duration : 0);
    };
    const stopAnimation = (): void => {
      if (playbackFrameRef.current !== null) {
        window.cancelAnimationFrame(playbackFrameRef.current);
        playbackFrameRef.current = null;
      }
    };
    const animate = (): void => {
      updateProgress();
      playbackFrameRef.current = audio.paused || audio.ended
        ? null
        : window.requestAnimationFrame(animate);
    };
    const startAnimation = (): void => {
      stopAnimation();
      playbackFrameRef.current = window.requestAnimationFrame(animate);
    };
    const stopAndSync = (): void => {
      stopAnimation();
      updateProgress();
    };

    audio.addEventListener('loadedmetadata', updateProgress);
    audio.addEventListener('durationchange', updateProgress);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('play', startAnimation);
    audio.addEventListener('playing', startAnimation);
    audio.addEventListener('pause', stopAndSync);
    audio.addEventListener('seeking', updateProgress);
    audio.addEventListener('seeked', updateProgress);
    audio.addEventListener('ended', stopAndSync);
    return () => {
      stopAnimation();
      audio.removeEventListener('loadedmetadata', updateProgress);
      audio.removeEventListener('durationchange', updateProgress);
      audio.removeEventListener('timeupdate', updateProgress);
      audio.removeEventListener('play', startAnimation);
      audio.removeEventListener('playing', startAnimation);
      audio.removeEventListener('pause', stopAndSync);
      audio.removeEventListener('seeking', updateProgress);
      audio.removeEventListener('seeked', updateProgress);
      audio.removeEventListener('ended', stopAndSync);
    };
  }, [props.src]);

  return (
    <div className={`audio-waveform-preview ${props.compact ? 'compact' : 'full'}`}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <audio ref={audioRef} controls preload="metadata" src={props.src} />
    </div>
  );
}
