// ── Tool registry ────────────────────────────────────────────────────────────
// To add a new tool: create impl/<name>.ts exporting `definition: ToolDefinition`,
// then add one line here. Nothing else needs updating.

export { definition as Read }          from "./read.ts";
export { definition as Write }         from "./write.ts";
export { definition as Edit }          from "./edit.ts";
export { definition as Bash }          from "./bash.ts";
export { definition as Glob }          from "./glob.ts";
export { definition as Grep }          from "./grep.ts";
export { definition as WebFetch }      from "./web-fetch.ts";
export { definition as Memory }        from "./memory.ts";
export { definition as Task }          from "./task.ts";
// Phase 1 — structured memory + search
export { definition as RememberFact }  from "./remember-fact.ts";
export { definition as SearchMemory }  from "./search-memory.ts";
export { definition as ForgetFact }    from "./forget-fact.ts";
export { definition as SearchHistory } from "./search-history.ts";
export { definition as GetEvents }     from "./get-events.ts";
// Phase 2 — cron job management
export { definition as CronCreate } from "./cron-create.ts";
export { definition as CronList }   from "./cron-list.ts";
export { definition as CronDelete } from "./cron-delete.ts";
export { definition as CronUpdate } from "./cron-update.ts";
// Phase 4 — browser automation + web search
export { definition as BrowserOpen }       from "./browser-open.ts";
export { definition as BrowserClick }      from "./browser-click.ts";
export { definition as BrowserFill }       from "./browser-fill.ts";
export { definition as BrowserScreenshot } from "./browser-screenshot.ts";
export { definition as BrowserExtract }    from "./browser-extract.ts";
export { definition as BrowserScroll }     from "./browser-scroll.ts";
export { definition as BrowserClose }      from "./browser-close.ts";
export { definition as Search }            from "./search.ts";
