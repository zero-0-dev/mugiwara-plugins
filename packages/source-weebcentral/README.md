# Weeb Central Source Plugin for Mugiwara

A built-in source plugin for [Mugiwara](https://github.com/mugiwara/mugiwara) manga reader that enables importing manga from [Weeb Central](https://weebcentral.com).

## Status

This is an **internal built-in plugin** that comes pre-installed with Mugiwara. It is not published to NPM and is automatically registered when the server starts.

## Features

- **Search**: Search for manga by title using advanced search with pagination
- **Metadata**: Automatic fetching of manga metadata including:
  - Title
  - Description
  - Author information
  - Cover image
  - Tags
  - Publication status and type (Manga/Manhwa/Manhua/OEL)
- **Chapters**: Browse and download all chapters with:
  - Chapter listing with published dates
  - Page-by-page streaming download
  - Automatic retry on failures

## Configuration

The plugin can be configured via the Mugiwara server configuration:

```typescript
interface WeebCentralConfig {
  // Base URL for Weeb Central (default: "https://weebcentral.com")
  baseUrl?: string;

  // Request timeout in milliseconds (default: 30000)
  requestTimeout?: number;

  // User agent for requests (default: "Mugiwara/1.0.0")
  userAgent?: string;

  // Number of search results per page (default: 20)
  searchLimit?: number;
}
```

## Usage

Since this is a built-in plugin, you don't need to install anything. The source is automatically available with the ID `"weebcentral"`.

### API Endpoints

#### Search for Manga

```bash
curl "http://localhost:3000/api/library/sources/weebcentral/search?q=One%20Piece"
```

#### Get Manga Details

```bash
curl "http://localhost:3000/api/library/sources/weebcentral/manga/{seriesId}"
```

Where `{seriesId}` is the Weeb Central series ULID (e.g., `01J76XYGGM22WZP7T4TKA4ZFAF`).

#### Import Manga

```bash
curl -X POST "http://localhost:3000/api/library/import" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "weebcentral",
    "sourceMangaId": "01J76XYGGM22WZP7T4TKA4ZFAF",
    "storageBackendId": "default",
    "downloadAll": true
  }'
```

### Programmatic Usage

```typescript
import createWeebCentralSource from "@mugiwara/source-weebcentral";

const source = createWeebCentralSource({
  config: {},
});

await source.initialize({});

const results = await source.search("Kagurabachi");
const manga = await source.getMangaDetails(results[0].sourceMangaId);

for await (const page of source.downloadChapter(
  manga.chapters[0].sourceChapterId,
)) {
  // page.data contains the image buffer
  // page.pageNumber is the page number
  // page.contentType is the MIME type
}
```

## Technical Notes

This plugin works by parsing server-rendered HTML pages since Weeb Central does not provide a REST API. The following endpoints are used:

- **Search**: `GET /search/data?text=...&limit=...&offset=...`
- **Series details**: `GET /series/{seriesId}`
- **Chapter list**: `GET /series/{seriesId}/full-chapter-list`
- **Chapter images**: `GET /chapters/{chapterId}/images?reading_style=long_strip` (with HTMX headers)
- **Updates**: `GET /series/{seriesId}/rss`

## Retry Logic

The plugin implements the following retry behavior for page downloads:

- 100ms delay between page downloads
- Exponential backoff on retry (1s, 2s, 3s)
- 30-second timeout on requests
- Maximum 3 retries per page

## License

MIT

## Disclaimer

This plugin is not affiliated with Weeb Central. Please respect their terms of service when using this plugin.
