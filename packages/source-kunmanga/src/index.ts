import {
  BaseSource,
  PluginMetadata,
  PluginConfig,
  SearchResult,
  SourceManga,
  SourceChapter,
  PageData,
} from "@mugiwara-manga/plugin-api";
import * as cheerio from "cheerio";

interface KunMangaConfig {
  baseUrl?: string;
  requestTimeout?: number;
  userAgent?: string;
  searchLimit?: number;
}

interface ChapterApiItem {
  comic_id: number;
  chapter_id: number;
  chapter_num: string;
  chapter_name: string;
  chapter_slug: string;
  updated_at: string;
  view: number;
}

interface ChapterApiResponse {
  success: boolean;
  data: {
    chapters: ChapterApiItem[];
    total: number;
    current_page: number;
    per_page: number;
    last_page: number;
  };
}

class KunMangaSource extends BaseSource {
  readonly metadata: PluginMetadata = {
    id: "kunmanga",
    name: "KunManga",
    version: "1.0.0",
    type: "source",
    description: "Import manga from KunManga.co.uk",
    author: "Mugiwara Team",
    compatibleCore: "^1.0.0",
  };

  private config: Required<KunMangaConfig> = {
    baseUrl: "https://www.kunmanga.co.uk",
    requestTimeout: 30000,
    userAgent: "Mugiwara/1.0.0",
    searchLimit: 20,
  };

  private abortControllers = new Set<AbortController>();

  async initialize(pluginConfig: PluginConfig): Promise<void> {
    this.config = {
      ...this.config,
      ...pluginConfig,
    };
  }

  async shutdown(): Promise<void> {
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  async search(query: string, page = 1): Promise<SearchResult[]> {
    const searchPath = page <= 1
      ? "/home"
      : `/home/page/${page}`;

    const params = new URLSearchParams();
    params.set("s", query);
    params.set("post_type", "wp-manga");

    const html = await this.makeHtmlRequest(
      `${searchPath}?${params.toString()}`,
    );

    return this.parseSearchResults(html);
  }

  async getMangaDetails(sourceMangaId: string): Promise<SourceManga> {
    const [detailHtml, chaptersJson] = await Promise.all([
      this.makeHtmlRequest(`/manga/${sourceMangaId}/`),
      this.makeJsonRequest<ChapterApiResponse>(
        `/api/comics/${sourceMangaId}/chapters?per_page=-1&order=desc`,
      ),
    ]);

    const details = this.parseMangaDetails(detailHtml, sourceMangaId);
    const chapters = this.mapChaptersFromApi(
      chaptersJson,
      sourceMangaId,
    );

    return {
      sourceMangaId,
      title: details.title,
      altTitles: details.altTitles,
      description: details.description,
      author: details.author,
      artist: details.artist,
      status: details.status,
      mediaType: details.mediaType,
      coverImageUrl: details.coverImageUrl,
      genres: details.genres,
      tags: details.tags,
      chapters,
    };
  }

  async *downloadChapter(
    sourceChapterId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PageData, void, unknown> {
    const slashIdx = sourceChapterId.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(`Invalid sourceChapterId format: ${sourceChapterId}`);
    }

    const mangaSlug = sourceChapterId.slice(0, slashIdx);
    const chapterSlug = sourceChapterId.slice(slashIdx + 1);

    const html = await this.makeHtmlRequest(
      `/manga/${mangaSlug}/${chapterSlug}/`,
    );

    const imageUrls = this.extractImageUrls(html);

    if (imageUrls.length === 0) {
      throw new Error(
        `No images found for chapter: ${sourceChapterId}`,
      );
    }

    for (let i = 0; i < imageUrls.length; i++) {
      if (signal?.aborted) {
        throw new Error("Download aborted");
      }

      let lastError: Error | undefined;
      let retries = 3;

      while (retries > 0) {
        try {
          const response = await fetch(imageUrls[i], {
            headers: {
              "User-Agent": this.config.userAgent,
              Referer: `${this.config.baseUrl}/`,
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
            this.getContentType(imageUrls[i]);

          yield {
            pageNumber: i + 1,
            data,
            contentType,
          };

          if (i < imageUrls.length - 1) {
            await this.delay(100);
          }

          break;
        } catch (error) {
          lastError = error as Error;
          retries--;

          if (retries > 0) {
            console.warn(
              `Retrying page ${i + 1} download, ${retries} attempts left`,
            );
            await this.delay(1000 * (4 - retries));
          }
        }
      }

      if (retries === 0 && lastError) {
        throw lastError;
      }
    }
  }

  async checkForUpdates(
    sourceMangaId: string,
    lastChapterId?: string,
  ): Promise<SourceManga["chapters"]> {
    const chaptersJson = await this.makeJsonRequest<ChapterApiResponse>(
      `/api/comics/${sourceMangaId}/chapters?per_page=-1&order=desc`,
    );

    const allChapters = chaptersJson.data.chapters;
    const chapters: SourceChapter[] = [];
    let passedLast = !lastChapterId;

    for (const ch of allChapters) {
      if (!passedLast) {
        if (ch.chapter_slug === lastChapterId) {
          passedLast = true;
        }
        continue;
      }

      chapters.push({
        sourceChapterId: `${sourceMangaId}/${ch.chapter_slug}`,
        chapterId: ch.chapter_slug,
        title: ch.chapter_name,
        sortOrder: this.parseChapterSortOrder(ch.chapter_num),
        publishedAt: new Date(ch.updated_at).toISOString(),
      });
    }

    return chapters;
  }

  private parseSearchResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const $ = cheerio.load(html);

    $(".c-tabs-item__content").each((_, el) => {
      const $el = $(el);

      const titleEl = $el.find(".post-title h3 a");
      const title = titleEl.text().trim();
      const href = titleEl.attr("href") || "";

      const mangaMatch = href.match(/\/manga\/([^/]+)/);
      if (!mangaMatch) return;
      const sourceMangaId = mangaMatch[1];

      const img = $el.find(".tab-thumb img");
      const coverImageUrl =
        img.attr("data-src") || img.attr("src") || undefined;

      let status: SourceManga["status"] = undefined;
      const statusText = $el
        .find(".post-content_item.mg_status .summary-content")
        .text()
        .trim();
      if (statusText) {
        status = this.mapStatus(statusText);
      }

      let author: string | undefined;
      const authorEl = $el.find(
        '.post-content_item:has(.summary-heading:contains("Author")) .summary-content a',
      );
      if (authorEl.length > 0) {
        author = authorEl.first().text().trim();
      }

      const genres: string[] = [];
      $el.find(".genres-content a").each((_, genreEl) => {
        genres.push($(genreEl).text().trim());
      });

      const mediaType = this.inferMediaType(title, genres);

      results.push({
        sourceMangaId,
        title,
        coverImageUrl: coverImageUrl,
        description: undefined,
        author,
        artist: undefined,
        status,
        mediaType,
      });
    });

    return results;
  }

  private parseMangaDetails(
    html: string,
    sourceMangaId: string,
  ): {
    title: string;
    altTitles: string[];
    description: string | undefined;
    author: string | undefined;
    artist: string | undefined;
    status: SourceManga["status"];
    mediaType: SourceManga["mediaType"];
    coverImageUrl: string | undefined;
    genres: string[];
    tags: string[];
  } {
    const $ = cheerio.load(html);

    const title = $(".post-title h1").text().trim();

    const img = $(".summary_image img");
    const coverImageUrl =
      img.attr("data-src") || img.attr("src") || undefined;

    const description = $(".summary__content").text().trim() || undefined;

    const metadata: Record<string, string> = {};
    $(".post-content_item").each((_, el) => {
      const $el = $(el);
      const heading = $el.find(".summary-heading").text().trim().replace(":", "").toLowerCase();
      const content = $el.find(".summary-content").text().trim();
      if (heading && content) {
        metadata[heading] = content;
      }
    });

    const altTitles = (metadata["alternative"] || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    const status = this.mapStatus(metadata["status"] || "");

    const genres: string[] = [];
    $(".genres-content a").each((_, el) => {
      genres.push($(el).text().trim());
    });

    const mediaType = this.inferMediaType(title, genres);

    let author: string | undefined;
    const authorLink = $(
      '.post-content_item:has(.summary-heading:contains("Author")) .summary-content a',
    ).first();
    if (authorLink.length > 0) {
      author = authorLink.text().trim();
    }

    const tags: string[] = [];

    return {
      title,
      altTitles,
      description,
      author,
      artist: undefined,
      status,
      mediaType,
      coverImageUrl,
      genres,
      tags,
    };
  }

  private mapChaptersFromApi(
    response: ChapterApiResponse,
    sourceMangaId: string,
  ): SourceChapter[] {
    const chapters: SourceChapter[] = [];

    if (!response.success || !response.data?.chapters) {
      return chapters;
    }

    for (const ch of response.data.chapters) {
      chapters.push({
        sourceChapterId: `${sourceMangaId}/${ch.chapter_slug}`,
        chapterId: ch.chapter_slug,
        title: ch.chapter_name,
        sortOrder: this.parseChapterSortOrder(ch.chapter_num),
        publishedAt: new Date(ch.updated_at).toISOString(),
        pageCount: undefined,
        language: "en",
        scanlationGroup: undefined,
      });
    }

    return chapters;
  }

  private extractImageUrls(html: string): string[] {
    const urls: string[] = [];
    const $ = cheerio.load(html);

    $(".page-break img").each((_, el) => {
      const $img = $(el);
      const url =
        $img.attr("data-src") ||
        $img.attr("src") ||
        "";
      if (url) {
        urls.push(url);
      }
    });

    return urls;
  }

  private parseChapterSortOrder(label: string): number {
    const numericMatch = label.match(/(\d+)(?:\.(\d+))?/);
    if (numericMatch) {
      const base = parseInt(numericMatch[1]) * 1000;
      const decimal = numericMatch[2] ? parseInt(numericMatch[2]) : 0;
      return base + decimal;
    }
    return 999999;
  }

  private inferMediaType(
    title: string,
    genres: string[],
  ): "manga" | "manhwa" | "manhua" | "webtoon" | "unknown" {
    const lowerTitle = title.toLowerCase();
    const lowerGenres = genres.map((g) => g.toLowerCase());

    const combined = [...lowerGenres, lowerTitle].join(" ");

    if (
      combined.includes("webtoon") ||
      combined.includes("oel") ||
      combined.includes("web comic")
    ) {
      return "webtoon";
    }
    if (combined.includes("manhwa")) {
      return "manhwa";
    }
    if (combined.includes("manhua")) {
      return "manhua";
    }
    if (combined.includes("manga")) {
      return "manga";
    }

    return "unknown";
  }

  private mapStatus(
    status: string,
  ): "ongoing" | "completed" | "hiatus" | "cancelled" | undefined {
    const s = status.toLowerCase();
    if (s === "ongoing") return "ongoing";
    if (s === "completed" || s === "complete") return "completed";
    if (s === "hiatus" || s === "on hiatus") return "hiatus";
    if (s === "cancelled" || s === "canceled" || s === "dropped") return "cancelled";
    return undefined;
  }

  private getContentType(fileName: string): string {
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async makeHtmlRequest(
    endpoint: string,
    options?: RequestInit,
  ): Promise<string> {
    const controller = new AbortController();
    this.abortControllers.add(controller);

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeout);

    try {
      const url = `${this.config.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        ...options,
        headers: {
          Accept: "text/html, */*",
          "User-Agent": this.config.userAgent,
          ...options?.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `KunManga error: ${response.status} ${response.statusText}`,
        );
      }

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
      this.abortControllers.delete(controller);
    }
  }

  private async makeJsonRequest<T>(endpoint: string): Promise<T> {
    const controller = new AbortController();
    this.abortControllers.add(controller);

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
          `KunManga API error: ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
      this.abortControllers.delete(controller);
    }
  }
}

export default function createKunMangaSource(options: {
  config: PluginConfig;
}): KunMangaSource {
  return new KunMangaSource();
}

export { KunMangaSource };
export type { KunMangaConfig };
