import type { AssetGenerationKind, AssetGenerationRequest, AssetGenerationOutputSpec } from './types/asset-generation';

export const ASSET_GENERATION_IMAGE_DIMENSION_LIMITS = {
  maxEdge: 3840,
  multiple: 16,
  maxAspectRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400
} as const;

export type AssetGenerationImageDimensionValidationCode =
  | 'missing'
  | 'not_integer'
  | 'max_edge'
  | 'multiple'
  | 'aspect_ratio'
  | 'total_pixels';

export type AssetGenerationImageDimensionValidation =
  | { ok: true; width: number; height: number; pixels: number }
  | { ok: false; code: AssetGenerationImageDimensionValidationCode; width?: number; height?: number; pixels?: number };

export function isAssetGenerationImageDimensionConstrainedKind(kind: AssetGenerationKind): boolean {
  return kind === 'image_2d' || kind === 'ui_2d' || kind === 'texture_2d' || kind === 'animation_2d_frames';
}

export function validateAssetGenerationImageDimensions(
  width: number | undefined,
  height: number | undefined
): AssetGenerationImageDimensionValidation {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, code: 'missing', width, height };
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, code: 'not_integer', width, height };
  }
  if (Math.max(width, height) > ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxEdge) {
    return { ok: false, code: 'max_edge', width, height };
  }
  if (width % ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.multiple !== 0 || height % ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.multiple !== 0) {
    return { ok: false, code: 'multiple', width, height };
  }
  if (Math.max(width, height) / Math.min(width, height) > ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxAspectRatio) {
    return { ok: false, code: 'aspect_ratio', width, height };
  }
  const pixels = width * height;
  if (pixels < ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.minPixels || pixels > ASSET_GENERATION_IMAGE_DIMENSION_LIMITS.maxPixels) {
    return { ok: false, code: 'total_pixels', width, height, pixels };
  }
  return { ok: true, width, height, pixels };
}

export function validateAssetGenerationRequestImageDimensions(
  request: Pick<AssetGenerationRequest, 'kind' | 'outputSpec'>
): AssetGenerationImageDimensionValidation | undefined {
  if (!isAssetGenerationImageDimensionConstrainedKind(request.kind)) {
    return undefined;
  }
  const spec: AssetGenerationOutputSpec | undefined = request.outputSpec;
  if (typeof spec?.width !== 'number' && typeof spec?.height !== 'number') {
    return undefined;
  }
  return validateAssetGenerationImageDimensions(spec?.width, spec?.height);
}

export function formatAssetGenerationImageDimensionValidation(
  validation: Exclude<AssetGenerationImageDimensionValidation, { ok: true }>,
  language: 'zh-CN' | 'en-US' = 'zh-CN'
): string {
  const limits = ASSET_GENERATION_IMAGE_DIMENSION_LIMITS;
  const minPixels = limits.minPixels.toLocaleString('en-US');
  const maxPixels = limits.maxPixels.toLocaleString('en-US');
  const zh: Record<AssetGenerationImageDimensionValidationCode, string> = {
    missing: '请填写有效的宽度和高度。',
    not_integer: '宽度和高度必须是正整数。',
    max_edge: `最大边不能超过 ${limits.maxEdge}px。`,
    multiple: `宽度和高度都必须是 ${limits.multiple}px 的倍数。`,
    aspect_ratio: `长边 / 短边不能超过 ${limits.maxAspectRatio}:1。`,
    total_pixels: `总像素数必须在 ${minPixels} 到 ${maxPixels} 之间。`
  };
  const en: Record<AssetGenerationImageDimensionValidationCode, string> = {
    missing: 'Enter a valid width and height.',
    not_integer: 'Width and height must be positive integers.',
    max_edge: `The longest edge must be ${limits.maxEdge}px or less.`,
    multiple: `Width and height must both be multiples of ${limits.multiple}px.`,
    aspect_ratio: `The long-edge to short-edge ratio must be ${limits.maxAspectRatio}:1 or less.`,
    total_pixels: `Total pixels must be between ${minPixels} and ${maxPixels}.`
  };
  return language === 'en-US' ? en[validation.code] : zh[validation.code];
}
