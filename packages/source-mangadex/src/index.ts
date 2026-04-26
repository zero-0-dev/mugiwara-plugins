import {
  BaseSource,
  PluginMetadata,
  PluginConfig,
  SearchResult,
  SourceManga,
  SourceChapter,
  PageData,
} from "@mugiwara-manga/plugin-api";

// MangaDex API Types
interface MangaDexManga {
  id: string;
  type: "manga";
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    description: Record<string, string>;
    status: "ongoing" | "completed" | "hiatus" | "cancelled";
    contentRating: "safe" | "suggestive" | "erotica" | "pornographic";
    availableTranslatedLanguages: string[];
    tags: MangaDexTag[];
    year?: number;
    originalLanguage: string;
    lastChapter?: string;
    lastVolume?: string;
    publicationDemographic?: string;
  };
  relationships: MangaDexRelationship[];
}

interface MangaDexTag {
  id: string;
  type: "tag";
  attributes: {
    name: Record<string, string>;
    group: string;
  };
}

interface MangaDexChapter {
  id: string;
  type: "chapter";
  attributes: {
    title: string | null;
    volume: string | null;
    chapter: string | null;
    pages: number;
    translatedLanguage: string;
    uploader: string;
    externalUrl: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
    publishAt: string;
    readableAt: string;
  };
  relationships: MangaDexRelationship[];
}

interface MangaDexRelationship {
  id: string;
  type: string;
  attributes?: {
    fileName?: string;
    name?: string;
  };
}

interface MangaDexSearchResponse {
  result: "ok";
  response: "collection";
  data: MangaDexManga[];
  limit: number;
  offset: number;
  total: number;
}

interface MangaDexChapterResponse {
  result: "ok";
  response: "collection";
  data: MangaDexChapter[];
  limit: number;
  offset: number;
  total: number;
}

interface MangaDexServerResponse {
  result: "ok";
  baseUrl: string;
  chapter: {
    hash: string;
    data: string[];
    dataSaver: string[];
  };
}

interface MangaDexMangaResponse {
  result: "ok";
  response: "entity";
  data: MangaDexManga;
}

interface MangaDexPingResponse {
  result: "ok";
}

// Configuration interface
interface MangaDexConfig {
  baseUrl?: string;
  preferredLanguages?: string[];
  dataSaver?: boolean;
  requestTimeout?: number;
  userAgent?: string;
}

class MangaDexSource extends BaseSource {
  readonly metadata: PluginMetadata = {
    id: "mangadex",
    name: "MangaDex",
    version: "1.0.0",
    type: "source",
    description: "Import manga from MangaDex.org",
    author: "Mugiwara Team",
    compatibleCore: "^1.0.0",
  };

  private config: Required<MangaDexConfig> = {
    baseUrl: "https://api.mangadex.org",
    preferredLanguages: ["en"],
    dataSaver: false,
    requestTimeout: 30000,
    userAgent: "Mugiwara/1.0.0",
  };

  private abortControllers = new Set<AbortController>();

  async initialize(pluginConfig: PluginConfig): Promise<void> {
    this.config = {
      ...this.config,
      ...pluginConfig,
    };

    // Validate that MangaDex is accessible
    try {
      const response = await this.makeRequest<MangaDexPingResponse>("/ping");
      if (response.result !== "ok") {
        throw new Error("MangaDex API is not responding correctly");
      }
    } catch (error) {
      console.warn(
        "MangaDex API might be unavailable, plugin will retry on operations",
      );
    }
  }

  async shutdown(): Promise<void> {
    // Abort all ongoing requests
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  async search(query: string, page = 1): Promise<SearchResult[]> {
    const limit = 20;
    const offset = (page - 1) * limit;

    const params = new URLSearchParams();
    params.set("title", query);
    params.set("limit", limit.toString());
    params.set("offset", offset.toString());

    // Add includes as array parameters
    params.append("includes[]", "cover_art");
    params.append("includes[]", "author");
    params.append("includes[]", "artist");

    // Add content ratings
    params.append("contentRating[]", "safe");
    params.append("contentRating[]", "suggestive");
    params.append("contentRating[]", "erotica");

    // Add order - MangaDex uses bracket notation for order fields
    params.set("order[relevance]", "desc");

    const response = await this.makeRequest<MangaDexSearchResponse>(
      `/manga?${params.toString()}`,
    );

    if (!response.data || !Array.isArray(response.data)) {
      return [];
    }

    return response.data.map((manga) => this.mapMangaToSearchResult(manga));
  }

  async getMangaDetails(sourceMangaId: string): Promise<SourceManga> {
    // Get manga details
    const params = new URLSearchParams();
    params.append("includes[]", "cover_art");
    params.append("includes[]", "author");
    params.append("includes[]", "artist");

    const mangaResponse = await this.makeRequest<MangaDexMangaResponse>(
      `/manga/${sourceMangaId}?${params.toString()}`,
    );

    const manga = mangaResponse.data;

    // Get chapters
    const chapters = await this.fetchAllChapters(sourceMangaId);

    return this.mapMangaToSourceManga(manga, chapters);
  }

  async *downloadChapter(
    sourceChapterId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PageData, void, unknown> {
    // Get chapter page URLs from MangaDex@Home
    const serverResponse = await this.makeRequest<MangaDexServerResponse>(
      `/at-home/server/${sourceChapterId}`,
    );

    if (serverResponse.result !== "ok") {
      throw new Error(`Failed to get chapter server for ${sourceChapterId}`);
    }

    const { baseUrl, chapter } = serverResponse;
    const pageFiles = this.config.dataSaver ? chapter.dataSaver : chapter.data;

    for (let i = 0; i < pageFiles.length; i++) {
      // Check for abort signal
      if (signal?.aborted) {
        throw new Error("Download aborted");
      }

      const pageFile = pageFiles[i];
      const quality = this.config.dataSaver ? "data-saver" : "data";
      const imageUrl = `${baseUrl}/${quality}/${chapter.hash}/${pageFile}`;

      // Download the image with retries
      let lastError: Error | undefined;
      let retries = 3;

      while (retries > 0) {
        try {
          const response = await fetch(imageUrl, {
            headers: {
              "User-Agent": this.config.userAgent,
            },
            signal,
          });

          if (!response.ok) {
            throw new Error(
              `Failed to download page ${i + 1}: ${response.statusText}`,
            );
          }

          const arrayBuffer = await response.arrayBuffer();
          const data = Buffer.from(arrayBuffer);
          const contentType =
            response.headers.get("content-type") ||
            this.getContentTypeFromFileName(pageFile);

          yield {
            pageNumber: i + 1,
            data,
            contentType,
          };

          // Add small delay between pages to be nice to the server
          if (i < pageFiles.length - 1) {
            await this.delay(100);
          }

          break; // Success, move to next page
        } catch (error) {
          lastError = error as Error;
          retries--;

          if (retries > 0) {
            console.warn(
              `Retrying page ${i + 1} download, ${retries} attempts left`,
            );
            await this.delay(1000 * (4 - retries)); // Exponential backoff
          }
        }
      }

      if (retries === 0 && lastError) {
        throw lastError;
      }
    }
  }

  private async fetchAllChapters(mangaId: string): Promise<MangaDexChapter[]> {
    const allChapters: MangaDexChapter[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams();
      params.set("limit", limit.toString());
      params.set("offset", offset.toString());
      params.append("includes[]", "scanlation_group");
      params.set("order[chapter]", "asc");

      // Add preferred languages filter
      for (const lang of this.config.preferredLanguages) {
        params.append("translatedLanguage[]", lang);
      }

      const response = await this.makeRequest<MangaDexChapterResponse>(
        `/manga/${mangaId}/feed?${params.toString()}`,
      );

      if (!response.data || !Array.isArray(response.data)) {
        break;
      }

      // Filter out chapters with 0 pages, as they are not useful for import
      const validChapters = response.data.filter(ch => ch.attributes.pages > 0);

      allChapters.push(...validChapters);

      if (response.data.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    return allChapters;
  }

  private mapMangaToSearchResult(manga: MangaDexManga): SearchResult {
    const attributes = manga.attributes;
    const title = this.getLocalizedTitle(
      attributes.title,
      attributes.altTitles,
    );
    const coverImage = this.getCoverImageUrl(manga);
    const authors = this.getAuthors(manga);

    return {
      sourceMangaId: manga.id,
      title,
      coverImageUrl: coverImage,
      description: this.getLocalizedDescription(attributes.description),
      author: authors.author,
      artist: authors.artist,
      status: attributes.status,
      mediaType: this.mapContentRatingToMediaType(attributes.contentRating),
    };
  }

  private mapMangaToSourceManga(
    manga: MangaDexManga,
    chapters: MangaDexChapter[],
  ): SourceManga {
    const attributes = manga.attributes;
    const title = this.getLocalizedTitle(
      attributes.title,
      attributes.altTitles,
    );
    const coverImage = this.getCoverImageUrl(manga);
    const authors = this.getAuthors(manga);

    // Extract alt titles
    const altTitles = attributes.altTitles
      .map((t) => Object.values(t)[0])
      .filter(Boolean);

    // Extract tags/genres
    const genres = attributes.tags
      .filter((tag) => tag.attributes.group === "genre")
      .map((tag) => Object.values(tag.attributes.name)[0]);

    const tags = attributes.tags
      .filter((tag) => tag.attributes.group === "theme")
      .map((tag) => Object.values(tag.attributes.name)[0]);

    // Map chapters
    const mappedChapters: SourceChapter[] = chapters.map((chapter, index) => {
      const chAttributes = chapter.attributes;
      const chapterId = chAttributes.chapter || `extra-${index}`;
      const scanlationGroup = chapter.relationships.find(
        (r) => r.type === "scanlation_group",
      );

      return {
        sourceChapterId: chapter.id,
        chapterId,
        title:
          chAttributes.title ||
          (chAttributes.chapter
            ? `Chapter ${chAttributes.chapter}`
            : "Unknown"),
        sortOrder: this.chapterToSortOrder(chapterId),
        publishedAt: chAttributes.publishAt,
        pageCount: chAttributes.pages,
        language: chAttributes.translatedLanguage,
        scanlationGroup:
          scanlationGroup?.attributes?.name || undefined,
      };
    });

    return {
      sourceMangaId: manga.id,
      title,
      altTitles,
      description: this.getLocalizedDescription(attributes.description),
      author: authors.author,
      artist: authors.artist,
      status: attributes.status,
      mediaType: this.mapContentRatingToMediaType(attributes.contentRating),
      coverImageUrl: coverImage,
      genres,
      tags,
      chapters: mappedChapters,
    };
  }

  private getLocalizedTitle(
    title: Record<string, string>,
    altTitles: Record<string, string>[],
  ): string {
    // Try preferred languages in order
    for (const lang of this.config.preferredLanguages) {
      if (title[lang]) {
        return title[lang];
      }
    }

    // Try English as fallback
    if (title.en) {
      return title.en;
    }

    // Try any available language
    const firstTitle = Object.values(title)[0];
    if (firstTitle) {
      return firstTitle;
    }

    // Check alt titles
    for (const lang of this.config.preferredLanguages) {
      const altTitle = altTitles.find((t) => t[lang]);
      if (altTitle) {
        return altTitle[lang];
      }
    }

    return "Unknown Title";
  }

  private getLocalizedDescription(
    description: Record<string, string>,
  ): string | undefined {
    // Try preferred languages in order
    for (const lang of this.config.preferredLanguages) {
      if (description[lang]) {
        return description[lang];
      }
    }

    // Try English as fallback
    if (description.en) {
      return description.en;
    }

    // Try any available language
    return Object.values(description)[0];
  }

  private getCoverImageUrl(manga: MangaDexManga): string | undefined {
    const coverArt = manga.relationships.find(
      (rel) => rel.type === "cover_art",
    );

    if (coverArt?.attributes?.fileName) {
      return `https://uploads.mangadex.org/covers/${manga.id}/${coverArt.attributes.fileName}`;
    }

    return undefined;
  }

  private getAuthors(manga: MangaDexManga): {
    author?: string;
    artist?: string;
  } {
    const author = manga.relationships.find((rel) => rel.type === "author");
    const artist = manga.relationships.find((rel) => rel.type === "artist");

    return {
      author: author?.attributes?.name,
      artist: artist?.attributes?.name,
    };
  }

  private mapContentRatingToMediaType(
    rating: string,
  ): "manga" | "manhwa" | "manhua" | "webtoon" | "unknown" {
    // MangaDex doesn't provide explicit manga type, so we infer from content
    // This is a simple mapping - in practice, you might want to use tags or other heuristics
    return "manga";
  }

  private chapterToSortOrder(chapterId: string): number {
    // Handle special chapters like "extra", "bonus", "omake"
    if (!/^\d/.test(chapterId)) {
      // Non-numeric chapters go to end with high sort order based on name
      return 900000 + chapterId.charCodeAt(0);
    }

    // Parse numeric chapter with optional decimal
    const match = chapterId.match(/^(\d+)(?:\.(\d+))?/);
    if (match) {
      const base = parseInt(match[1]) * 1000;
      const decimal = match[2] ? parseInt(match[2]) : 0;
      return base + decimal;
    }

    return 999999;
  }

  private getContentTypeFromFileName(fileName: string): string {
    const ext = fileName.toLowerCase().split(".").pop();
    switch (ext) {
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
      default:
        return "image/jpeg";
    }
  }

  private async makeRequest<T>(endpoint: string): Promise<T> {
    const controller = new AbortController();
    this.abortControllers.add(controller);

    // Set timeout
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeout);

    try {
      const url = `${this.config.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": this.config.userAgent,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `MangaDex API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      return data as T;
    } finally {
      clearTimeout(timeoutId);
      this.abortControllers.delete(controller);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Factory function
export default function createMangaDexSource(options: {
  config: PluginConfig;
}): MangaDexSource {
  return new MangaDexSource();
}

export { MangaDexSource };
export type { MangaDexConfig };
