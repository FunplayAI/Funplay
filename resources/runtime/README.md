# PPTX Preview Runtime

This directory is for local development or custom enterprise packaging only.
Funplay does not bundle LibreOffice or Poppler by default because LibreOffice is
too large for the standard desktop package.

Default preview order:

1. Use a locally installed LibreOffice plus `pdftoppm` when available.
2. Fall back to macOS QuickLook thumbnails.
3. Fall back to text-only slide extraction if no thumbnail renderer is available.

Optional local layouts:

```text
resources/runtime/
  LibreOffice.app/Contents/MacOS/soffice
  poppler/bin/pdftoppm
```

or:

```text
resources/runtime/
  LibreOffice/program/soffice
  poppler/bin/pdftoppm
```

Development lookup order:

1. `FUNPLAY_LIBREOFFICE_PATH` and `FUNPLAY_PDFTOPPM_PATH`
2. `resources/runtime/...`
3. System installs such as `/Applications/LibreOffice.app/...`, `soffice`, and `pdftoppm`

Packaged lookup order:

1. `FUNPLAY_LIBREOFFICE_PATH` and `FUNPLAY_PDFTOPPM_PATH`
2. System installs such as `/Applications/LibreOffice.app/...`, `soffice`, and `pdftoppm`
3. `Contents/Resources/runtime/...` if a custom build chooses to copy one there

The runtime binaries are intentionally gitignored because LibreOffice and
Poppler are large platform artifacts. Keep this README and `.gitkeep` tracked.
