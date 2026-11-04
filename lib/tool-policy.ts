/** Only these tools may run without an operation confirmation. Unknown tools are denied by the executor. */
export const READ_ONLY_TOOLS = new Set(['list_tabs', 'read_page', 'extract', 'wait', 'capture_page', 'search_web', 'open_search_result']);

export function requiresApproval(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name);
}
