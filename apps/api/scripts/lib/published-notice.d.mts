export declare const PRODUCTION_ORIGIN: string;
export declare const MAX_SCRIPT_FILES: number;
export declare function entryScripts(html: string, origin: string): string[];
export declare function importedScripts(js: string, scriptUrl: string, origin: string): string[];
export declare function isNoticePublished(
  noticeLine: string,
  options?: { origin?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> },
): Promise<boolean>;
