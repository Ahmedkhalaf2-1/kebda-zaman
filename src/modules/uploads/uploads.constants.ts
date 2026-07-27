/** Images only — same allowlist enforced by both extension and MIME type. */
export const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const STATIC_UPLOADS_PREFIX = '/uploads';
