import type { AssetGenerationJob, AssetGenerationKind } from '../../shared/types';
import { localize } from '../i18n';
import type { LanguagePreference } from './app-types';

export const generationKindOptions: AssetGenerationKind[] = [
  'image_2d',
  'ui_2d',
  'texture_2d',
  'animation_2d_frames',
  'animation_2d_rig',
  'model_3d',
  'animation_3d',
  'audio_sfx',
  'audio_music',
  'voice'
];

export function formatGenerationKind(kind: AssetGenerationKind, language: LanguagePreference): string {
  const labels: Record<AssetGenerationKind, string> = {
    image_2d: localize(language, '2D 图片', '2D Image'),
    ui_2d: localize(language, '2D UI', '2D UI'),
    texture_2d: localize(language, '2D 纹理', '2D Texture'),
    animation_2d_frames: localize(language, '2D 序列帧', '2D Frame Animation'),
    animation_2d_rig: localize(language, '2D 骨骼动画', '2D Rig Animation'),
    model_3d: localize(language, '3D 模型', '3D Model'),
    animation_3d: localize(language, '3D 动画', '3D Animation'),
    audio_sfx: localize(language, '音效', 'Sound Effect'),
    audio_music: localize(language, '音乐循环', 'Music Loop'),
    voice: localize(language, '语音', 'Voice')
  };
  return labels[kind];
}

export function defaultTitleForKind(kind: AssetGenerationKind, language: LanguagePreference): string {
  const labels: Record<AssetGenerationKind, string> = {
    image_2d: localize(language, '新图片素材', 'New Image Asset'),
    ui_2d: localize(language, '新 UI 素材', 'New UI Asset'),
    texture_2d: localize(language, '新纹理素材', 'New Texture Asset'),
    animation_2d_frames: localize(language, '新序列帧动画', 'New Frame Animation'),
    animation_2d_rig: localize(language, '新骨骼动画', 'New Rig Animation'),
    model_3d: localize(language, '新 3D 模型', 'New 3D Model'),
    animation_3d: localize(language, '新 3D 动画', 'New 3D Animation'),
    audio_sfx: localize(language, '新音效', 'New Sound Effect'),
    audio_music: localize(language, '新音乐循环', 'New Music Loop'),
    voice: localize(language, '新语音', 'New Voice')
  };
  return labels[kind];
}

export function isVisualGenerationKind(kind: AssetGenerationKind): boolean {
  return kind === 'image_2d' || kind === 'ui_2d' || kind === 'texture_2d' || kind === 'animation_2d_frames';
}

export function isAudioGenerationKind(kind: AssetGenerationKind): boolean {
  return kind === 'audio_sfx' || kind === 'audio_music' || kind === 'voice';
}

export function formatGenerationJobStatus(job: AssetGenerationJob, language: LanguagePreference): string {
  if (job.status === 'completed') return localize(language, '已完成', 'Completed');
  if (job.status === 'running') return localize(language, '生成中', 'Running');
  if (job.status === 'queued') return localize(language, '排队中', 'Queued');
  if (job.status === 'cancelled') return localize(language, '已取消', 'Cancelled');
  return localize(language, '失败', 'Failed');
}
