// ============================================================
// Hardline blocklist — ported from Hermes Agent
// (NousResearch/hermes-agent/tools/approval.py::UNRECOVERABLE_BLOCKLIST)
// ============================================================

interface HardlineMatch {
  pattern: string;
  reason: string;
}

const UNRECOVERABLE_PATTERNS: { regex: RegExp; reason: string }[] = [
  {
    // rm -rf / with no path after the / (just whitespace or end)
    regex: /\brm\s+-rf\s+\/(\s|$)/,
    reason: "Wipes the filesystem root",
  },
  {
    // rm -rf --no-preserve-root /
    regex: /\brm\s+-rf\s+--no-preserve-root\s+\/(\s|$)/,
    reason: "Explicit 'yes I mean root' variant",
  },
  {
    // Fork bomb
    regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Fork bomb — pegs the host until reboot",
  },
  {
    // mkfs on /dev/ block device
    regex: /\bmkfs\.\w+\s+\/dev\//i,
    reason: "Formats a mounted filesystem",
  },
  {
    // dd from /dev/zero to /dev/sd* (disk zeroing)
    regex: /\bdd\s+if=\/dev\/zero\s+of=\/dev\/sd/i,
    reason: "Zeroes a physical disk",
  },
];

export function checkHardline(command: string): HardlineMatch | null {
  for (const entry of UNRECOVERABLE_PATTERNS) {
    if (entry.regex.test(command)) {
      return { pattern: entry.regex.source, reason: entry.reason };
    }
  }
  return null;
}
