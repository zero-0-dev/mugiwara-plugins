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

interface WeebCentralConfig {
  baseUrl?: string;
  requestTimeout?: number;
  userAgent?: string;
  searchLimit?: number;
}

const SERIES_ID_REGEX = /\/series\/([A-Za-z0-9]+)\//;

class WeebCentralSource extends BaseSource {
  readonly metadata: PluginMetadata = {
    id: "weebcentral",
    name: "Weeb Central",
    version: "1.0.0",
    type: "source",
    description: "Import manga from WeebCentral.com",
    author: "Mugiwara Team",
    compatibleCore: "^1.0.0",
  };

  private config: Required<WeebCentralConfig> = {
    baseUrl: "https://weebcentral.com",
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
    const limit = this.config.searchLimit;
    const offset = (page - 1) * limit;

    const params = new URLSearchParams();
    params.set("text", query);
    params.set("limit", limit.toString());
    params.set("offset", offset.toString());
    params.set("sort", "Best Match");
    params.set("order", "Descending");
    params.set("display_mode", "Full Display");

    const html = await this.makeHtmlRequest(
      `/search/data?${params.toString()}`,
    );

    return this.parseSearchResults(html);
  }

  async getMangaDetails(sourceMangaId: string): Promise<SourceManga> {
    const [seriesHtml, chaptersHtml] = await Promise.all([
      this.makeHtmlRequest(`/series/${sourceMangaId}`),
      this.makeHtmlRequest(`/series/${sourceMangaId}/full-chapter-list`, {
        headers: { "HX-Request": "true" },
      }),
    ]);

    const chapters = this.parseChapterList(chaptersHtml);
    const details = this.parseSeriesDetails(seriesHtml);

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
    const params = new URLSearchParams();
    params.set("is_prev", "False");
    params.set("current_page", "1");
    params.set("reading_style", "long_strip");

    const html = await this.makeHtmlRequest(
      `/chapters/${sourceChapterId}/images?${params.toString()}`,
      { headers: { "HX-Request": "true" } },
    );

    const imageUrls = this.extractImageUrls(html);

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
    const rssXml = await this.makeHtmlRequest(`/series/${sourceMangaId}/rss`);

    const chapters: SourceChapter[] = [];
    let passedLast = !lastChapterId;

    const $ = cheerio.load(rssXml, { xmlMode: true });
    const items = $("item");

    for (let i = 0; i < items.length; i++) {
      const item = items.eq(i);
      const chapterId = item.find("guid").text().trim();
      const fullTitle = item.find("title").text().trim();
      const pubDate = item.find("pubDate").text().trim();

      if (!chapterId || !fullTitle) continue;

      if (!passedLast) {
        if (chapterId === lastChapterId) {
          passedLast = true;
        }
        continue;
      }

      const label = fullTitle.replace(/^.*?\s+/, "");

      chapters.push({
        sourceChapterId: chapterId,
        chapterId: label,
        title: label,
        sortOrder: this.parseChapterSortOrder(label),
        publishedAt: pubDate ? new Date(pubDate).toISOString() : undefined,
      });
    }

    return chapters;
  }

  private parseSearchResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const $ = cheerio.load(html);

    $("a.line-clamp-1.link.link-hover").each((_, el) => {
      const link = $(el);
      const href = link.attr("href") || "";
      const match = href.match(SERIES_ID_REGEX);
      if (!match) return;

      const sourceMangaId = match[1];
      const title = link.text().trim() || "Unknown";
      const article = link.parents("article").first();

      const coverSrc =
        article.find('source[srcset*="cover/normal"]').attr("srcset") || "";
      const coverIdMatch = coverSrc.match(
        /cover\/normal\/([A-Za-z0-9]+)\.webp/,
      );
      const coverImageUrl = coverIdMatch
        ? `https://temp.compsci88.com/cover/normal/${coverIdMatch[1]}.webp`
        : undefined;

      const authorEl = article.find('a[href*="?author="]').first();
      const articleText = article.text();

      const statusText = articleText.match(/Status:\s*(\w+)/)?.[1] || "";
      const typeText = articleText.match(/Type:\s*(\w+)/)?.[1] || "";

      results.push({
        sourceMangaId,
        title,
        coverImageUrl,
        description: undefined,
        author: authorEl.text().trim() || undefined,
        artist: undefined,
        status: this.mapStatus(statusText),
        mediaType: this.mapSeriesType(typeText),
      });
    });

    return results;
  }

  private parseSeriesDetails(html: string): {
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

    const title = $("h1").first().text().trim() || "Unknown";

    const descEl = $("p.whitespace-pre-wrap").first();
    const description = descEl.text().trim() || undefined;

    const coverSrc =
      $('source[srcset*="cover/normal"]').first().attr("srcset") || "";
    const coverIdMatch = coverSrc.match(/cover\/normal\/([A-Za-z0-9]+)\.webp/);
    const coverImageUrl = coverIdMatch
      ? `https://temp.compsci88.com/cover/normal/${coverIdMatch[1]}.webp`
      : undefined;

    const author =
      $('li:has(strong:contains("Author(s):")) a').first().text().trim() ||
      undefined;

    const statusText = $('li:has(strong:contains("Status:")) a')
      .first()
      .text()
      .trim();
    const status = this.mapStatus(statusText);

    const typeText = $('li:has(strong:contains("Type:")) a')
      .first()
      .text()
      .trim();
    const mediaType = this.mapSeriesType(typeText);

    const tags: string[] = [];
    $('li:has(strong:contains("Tags(s):")) a').each((_, el) => {
      tags.push($(el).text().trim());
    });

    return {
      title,
      altTitles: [],
      description,
      author,
      artist: undefined,
      status,
      mediaType,
      coverImageUrl,
      genres: [],
      tags,
    };
  }

  private parseChapterList(html: string): SourceChapter[] {
    const chapters: SourceChapter[] = [];
    const $ = cheerio.load(html);

    $('a[href*="/chapters/"]').each((_, el) => {
      const link = $(el);
      const href = link.attr("href") || "";
      const chapterIdMatch = href.match(/\/chapters\/([A-Za-z0-9]+)/);
      if (!chapterIdMatch) return;

      const sourceChapterId = chapterIdMatch[1];
      const label =
        link.find("span.grow span").first().text().trim() || "Unknown";
      const timeEl = link.find("time").first();
      const publishedAt = timeEl.attr("datetime") || undefined;

      chapters.push({
        sourceChapterId,
        chapterId: label,
        title: label,
        sortOrder: this.parseChapterSortOrder(label),
        publishedAt: publishedAt
          ? new Date(publishedAt).toISOString()
          : undefined,
        pageCount: undefined,
        language: undefined,
        scanlationGroup: undefined,
      });
    });

    return chapters;
  }

  private extractImageUrls(html: string): string[] {
    const urls: string[] = [];
    const $ = cheerio.load(html);

    $("img[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src && !src.includes("broken_image")) urls.push(src);
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

  private mapStatus(
    status: string,
  ): "ongoing" | "completed" | "hiatus" | "cancelled" | undefined {
    const s = status.toLowerCase();
    if (s === "ongoing") return "ongoing";
    if (s === "complete" || s === "completed") return "completed";
    if (s === "hiatus") return "hiatus";
    if (s === "cancelled" || s === "canceled") return "cancelled";
    return undefined;
  }

  private mapSeriesType(
    type: string,
  ): "manga" | "manhwa" | "manhua" | "webtoon" | "unknown" {
    const t = type.toLowerCase();
    if (t === "manga") return "manga";
    if (t === "manhwa") return "manhwa";
    if (t === "manhua") return "manhua";
    if (t === "oel") return "webtoon";
    return "unknown";
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
          `WeebCentral error: ${response.status} ${response.statusText}`,
        );
      }

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
      this.abortControllers.delete(controller);
    }
  }
}

export default function createWeebCentralSource(options: {
  config: PluginConfig;
}): WeebCentralSource {
  return new WeebCentralSource();
}

export { WeebCentralSource };
export type { WeebCentralConfig };
