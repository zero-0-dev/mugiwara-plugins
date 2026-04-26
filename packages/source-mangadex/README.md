# MangaDex Source Plugin for Mugiwara

A built-in source plugin for [Mugiwara](https://github.com/mugiwara/mugiwara) manga reader that enables importing manga from [MangaDex](https://mangadex.org).

## Status

This is an **internal built-in plugin** that comes pre-installed with Mugiwara. It is not published to NPM and is automatically registered when the server starts.

## Features

- **Search**: Search for manga by title on MangaDex
- **Metadata**: Automatic fetching of manga metadata including:
  - Title and alternative titles
  - Description
  - Author and artist information
  - Cover image
  - Genres and tags
  - Publication status
- **Chapters**: Browse and download chapters with:
  - Support for multiple languages (configurable)
  - Chapter sorting and ordering
  - Page-by-page streaming download
  - Automatic retry on failures
- **Rate Limiting**: Built-in rate limiting to respect MangaDex's API

## Configuration

The plugin can be configured via the Mugiwara server configuration:

```typescript
interface MangaDexConfig {
  // Base URL for MangaDex API (default: "https://api.mangadex.org")
  baseUrl?: string;

  // Preferred languages for manga content (default: ["en"])
  // Examples: ["en", "ja", "ko", "zh"]
  preferredLanguages?: string[];

  // Use data saver mode for smaller images (default: false)
  dataSaver?: boolean;

  // Request timeout in milliseconds (default: 30000)
  requestTimeout?: number;

  // User agent for API requests (default: "Mugiwara/1.0.0")
  userAgent?: string;
}
```

## Usage

Since this is a built-in plugin, you don't need to install anything. The source is automatically available with the ID `"mangadex"`.

### API Endpoints

#### Search for Manga

```bash
curl "http://localhost:3000/api/library/sources/mangadex/search?q=One%20Piece"
```

#### Get Manga Details

```bash
curl "http://localhost:3000/api/library/sources/mangadex/manga/{mangaId}"
```

Where `{mangaId}` is the MangaDex manga UUID.

#### Import Manga

```bash
curl -X POST "http://localhost:3000/api/library/import" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "mangadex",
    "sourceMangaId": "32d76d19-8a05-4db0-9fc2-e0b6068bb666",
    "storageBackendId": "default",
    "downloadAll": true
  }'
```

### Programmatic Usage

```typescript
import createMangaDexSource from "@mugiwara/source-mangadex";

// Create and initialize the source
const source = createMangaDexSource({
  config: {
    preferredLanguages: ["en", "ja"],
    dataSaver: false,
  },
});

await source.initialize({
  preferredLanguages: ["en", "ja"],
});

// Search for manga
const results = await source.search("One Piece");

// Get manga details
const manga = await source.getMangaDetails(results[0].sourceMangaId);

// Download a chapter
for await (const page of source.downloadChapter(
  manga.chapters[0].sourceChapterId,
)) {
  // page.data contains the image buffer
  // page.pageNumber is the page number
  // page.contentType is the MIME type
}
```

## Rate Limits

This plugin implements the following rate limiting to comply with MangaDex API guidelines:

- 100ms delay between page downloads
- Exponential backoff on retry (1s, 2s, 3s)
- 30-second timeout on API requests
- Maximum 3 retries per page

## License

MIT

## Disclaimer

This plugin is not affiliated with MangaDex. Please respect their terms of service and API guidelines when using this plugin.
