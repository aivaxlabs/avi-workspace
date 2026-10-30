export const PERMISSION_OPTIONS = Object.freeze([
  { id: 'read_only', label: 'Read-only', description: 'Only read and search; never modify', icon: 'ri-eye-line' },
  { id: 'ask_for_approval', label: 'Ask for approval', description: 'Ask before every tool call', icon: 'ri-shield-keyhole-line' },
  { id: 'approve_for_me', label: 'Approve for me', description: 'Ask only before destructive actions', icon: 'ri-shield-check-line' },
  { id: 'full_access', label: 'Full access', description: 'Run tool calls without approval', icon: 'ri-shield-flash-line' },
]);

export const BOT_PERMISSIONS = Object.freeze(PERMISSION_OPTIONS.filter((option) => option.id !== 'ask_for_approval'));