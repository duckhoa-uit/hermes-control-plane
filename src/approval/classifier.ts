// ============================================================
// Dangerous command classifier — ported from Hermes Agent
// (NousResearch/hermes-agent/tools/approval.py)
// ============================================================
// Matches patterns that trigger approval prompts.
// Returns the matched pattern or null if safe.

interface ApprovalMatch {
  pattern: string;
  description: string;
}

const COMMAND_PATTERNS: { regex: RegExp; description: string }[] = [
  { regex: /\brm\s+-r[f]?\b/i, description: "Recursive delete" },
  { regex: /\brm\s+--recursive\b/i, description: "Recursive delete (long flag)" },
  { regex: /\brm\s+.*\/\b/i, description: "Delete in root path" },
  { regex: /\bchmod\s+.*(777|666|o\+w|a\+w)\b/i, description: "World/other-writable permissions" },
  { regex: /\bchmod\s+--recursive\b/i, description: "Recursive chmod" },
  { regex: /\bchown\s+-R\s+root\b/i, description: "Recursive chown to root" },
  { regex: /\bchown\s+--recursive\s+root\b/i, description: "Recursive chown to root" },
  { regex: /\bmkfs\b/i, description: "Format filesystem" },
  { regex: /\bdd\s+if=/i, description: "Disk copy" },
  { regex: />\s*\/dev\/sd/i, description: "Write to block device" },
  { regex: /\bDROP\s+(TABLE|DATABASE)\b/i, description: "SQL DROP" },
  { regex: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, description: "SQL DELETE without WHERE" },
  { regex: /\bTRUNCATE\s+TABLE\b/i, description: "SQL TRUNCATE" },
  { regex: />\s*\/etc\//i, description: "Overwrite system config" },
  {
    regex: /\bsystemctl\s+(stop|restart|disable|mask)\b/i,
    description: "Stop/disable system services",
  },
  { regex: /\bkill\s+-9\s+-1\b/i, description: "Kill all processes" },
  { regex: /\bpkill\s+-9\b/i, description: "Force kill processes" },
  { regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, description: "Fork bomb (bash)" },
  { regex: /\b(bash|sh|zsh|ksh)\s+-c\b/i, description: "Shell command via -c flag" },
  { regex: /\b(python|perl|ruby|node)\s+-[ec]\b/i, description: "Script execution via -e/-c flag" },
  { regex: /\bcurl\b.*\|.*\b(sh|bash)\b/i, description: "Pipe remote content to shell" },
  { regex: /\bwget\b.*\|.*\b(sh|bash)\b/i, description: "Pipe remote content to shell" },
  {
    regex: /\b(bash|sh)\s*<\s*\(\s*curl\b/i,
    description: "Execute remote script (process substitution)",
  },
  { regex: /\btee\s+.*\/(etc|\.ssh|\.hermes)\//i, description: "Tee to sensitive location" },
  { regex: /((>|>>)\s*.*\/(etc|\.ssh|\.hermes)\/)/i, description: "Write to sensitive location" },
  { regex: /\bxargs\s+rm\b/i, description: "xargs with rm" },
  { regex: /\bfind\s+.*-exec\s+rm\b/i, description: "find with destructive exec" },
  { regex: /\bfind\s+.*-delete\b/i, description: "find with delete" },
  { regex: /\b(cp|mv|install)\s+.*\/etc\//i, description: "Copy/move into system config" },
  { regex: /\bsed\s+-i\b.*\/etc\//i, description: "In-place edit of system config" },
  { regex: /\bsed\s+--in-place\b.*\/etc\//i, description: "In-place edit of system config" },
  { regex: /\b(pkill|killall)\s+(hermes|gateway)\b/i, description: "Self-termination attempt" },
];

export function classifyCommand(command: string): ApprovalMatch | null {
  for (const entry of COMMAND_PATTERNS) {
    if (entry.regex.test(command)) {
      return { pattern: entry.regex.source, description: entry.description };
    }
  }
  return null;
}
