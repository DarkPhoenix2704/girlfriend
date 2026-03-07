// ── Tool registry ────────────────────────────────────────────────────────────
// To add a new tool: create impl/<name>.ts exporting `definition: ToolDefinition`,
// then add one line here. Nothing else needs updating.

export { definition as Read }      from "./read.ts";
export { definition as Write }     from "./write.ts";
export { definition as Edit }      from "./edit.ts";
export { definition as Bash }      from "./bash.ts";
export { definition as Glob }      from "./glob.ts";
export { definition as Grep }      from "./grep.ts";
export { definition as WebFetch }  from "./web-fetch.ts";
export { definition as Memory }    from "./memory.ts";
export { definition as Task }      from "./task.ts";
