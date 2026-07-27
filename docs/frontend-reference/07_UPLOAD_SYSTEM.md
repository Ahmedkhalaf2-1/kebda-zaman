# 07 — Upload System

Source: `src/modules/uploads/*`, `src/main.ts` (static serving), `src/config/configuration.ts` (env-driven paths).

## The one endpoint

```
POST /api/v1/admin/uploads/image
Authorization: Bearer <admin accessToken>
Content-Type: multipart/form-data

file: <binary>
```

- **Auth**: ADMIN role only.
- **Field name is exactly `file`** — the interceptor is `FileInterceptor('file')`; sending it under any other field name results in the file being silently ignored by Multer, and the handler then throwing `400 FILE_REQUIRED`.
- Only **one** file per request is accepted (single-file interceptor, not an array).

### Success response — `201 Created`
```json
{ "imageUrl": "http://localhost:3000/uploads/85cb9ce0-5ea7-4b14-b39f-eafe9bad1123.png" }
```
That's the entire response body. `imageUrl` is a **complete, absolute, publicly-fetchable URL** — no further
concatenation with a base URL is needed on the frontend; use it exactly as returned.

## Validation

| Rule | Detail |
|---|---|
| Allowed extensions | `.jpg`, `.jpeg`, `.png`, `.webp` (checked on the original filename, case-insensitive) |
| Allowed MIME types | `image/jpeg`, `image/png`, `image/webp` — **both** the extension AND the MIME type must match the allowlist, or the request is rejected |
| Max file size | 5 MB by default (`UPLOAD_MAX_FILE_SIZE_MB` env var, server-configurable, not exposed via any API) |
| Filename | Server-generated: `${randomUUID()}${originalExtension}` — the original filename is **discarded**, never trusted, never exposed |

### Failure responses

| Status | `code` | Cause |
|---|---|---|
| `400` | `INVALID_FILE_TYPE` | Extension or MIME type not in the allowlist |
| `400` | `FILE_REQUIRED` | No file present under the `file` field |
| `413` | `PAYLOAD_TOO_LARGE` (via `PayloadTooLargeException`, message `"File too large"`) | File exceeds the configured size limit |
| `401` / `403` | standard auth errors | Missing/invalid token, or a non-ADMIN token |

All of these use the same canonical error envelope described in `02_API_REFERENCE.md`.

## Storage & public URLs

- Files are written to a directory on disk, configured server-side by `UPLOAD_DIR` (default `./uploads`,
  resolved to an absolute path relative to the process working directory). In the Docker deployment this is
  backed by a named volume so uploads survive container rebuilds/restarts.
- The directory is created automatically at server boot if it doesn't exist — no manual provisioning needed.
- Uploaded files are served back as **plain static assets** at:
  ```
  GET /uploads/<generated-filename>
  ```
  **Note the path has no `/api/v1` prefix** — it is intentionally outside the versioned API surface (a static
  asset isn't an API version-bound resource). `imageUrl` in the upload response already contains this full path
  — you never need to construct it manually.
- The public origin used to build `imageUrl` comes from `PUBLIC_BASE_URL` (server env var, e.g.
  `https://api.kebdazaman.com` in production, `http://localhost:3000` locally). This means **the exact host in
  a returned `imageUrl` depends on which environment issued it** — don't hardcode assumptions about the host in
  frontend code, always use the URL string as returned.
- Images are served with `Cross-Origin-Resource-Policy: cross-origin` (deliberately relaxed from Helmet's
  default) specifically so a web admin panel on a different origin can render `<img src="...">` against these
  URLs without being blocked by the browser.

## Reuse across features

This is a **single, generic, entity-agnostic** endpoint — it has no knowledge of "menu item" or any other
entity. The pattern for any feature that needs an image is:

1. `POST /admin/uploads/image` → get back `{ imageUrl }`.
2. Include that `imageUrl` string as a plain field in whatever entity's create/update request body accepts one.

**Currently wired to actually accept the resulting URL**:
- `MenuItem.imageUrl` via `POST/PUT /admin/menu/items*` (optional, nullable — see `02_API_REFERENCE.md`).

**Not yet wired, even though the upload endpoint itself would work fine for them** (do not assume these accept an uploaded image URL without checking the DTO in `03_DTO_REFERENCE.md` first):
- Categories use a separate `iconUrl` field (`CategoryDto.iconUrl`) — same plain-string contract, so pasting an uploaded `imageUrl` into `iconUrl` works, but there's no dedicated "category image" concept distinct from icon.
- Promos (`PromoDto`) have **no image field at all** in the schema.
- Notification campaigns (`CampaignDto.imageUrl`) **do** accept an image URL — this one already works.

## Example (curl)

```bash
curl -X POST http://localhost:3000/api/v1/admin/uploads/image \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@photo.png;type=image/png"
```
```json
{ "imageUrl": "http://localhost:3000/uploads/0b2b213c-4721-4961-9c78-eff1e6a3c75d.png" }
```

Then, to attach it to a menu item:
```bash
curl -X POST http://localhost:3000/api/v1/admin/menu/items \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"categoryId":"...","nameAr":"...","nameEn":"...","descriptionAr":"...","descriptionEn":"...","basePrice":20,"imageUrl":"http://localhost:3000/uploads/0b2b213c-4721-4961-9c78-eff1e6a3c75d.png"}'
```

## Frontend integration notes

- **Two-step flow, not one.** There is no "create menu item with embedded image bytes" endpoint — always upload
  first, then create/update the entity with the returned URL as a second call.
- **The image preview shown immediately after picking a file (before upload) is purely local state** — nothing
  reaches the server until the upload call is actually made. If a "Save" button on a menu-item form doesn't
  call this endpoint before calling `POST/PUT /admin/menu/items`, the picked image is silently lost and the item
  is saved with no `imageUrl` (or its previous one, on update). This is very likely the root cause if a
  previously-reported bug was "image preview works but the saved item has no image" — check that the create/edit
  form actually awaits the upload call and threads its `imageUrl` into the item payload.
- Do not attempt to delete/replace a previously-uploaded file server-side — there is no `DELETE /admin/uploads/*`
  endpoint. Orphaned files (e.g. from an abandoned edit) are simply not cleaned up; this is a known limitation,
  not a bug to work around client-side.
