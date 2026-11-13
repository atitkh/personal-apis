// The sections of the Settings page: one list for the sub-nav, the hash routes (#/settings/<id>) and the
// command palette. General is the default.
export const SETTINGS_SECTIONS = [
    { id: 'general', title: 'General', keywords: 'time zone timezone' },
    { id: 'appearance', title: 'Appearance', keywords: 'theme dark light' },
    { id: 'account', title: 'Account', keywords: 'session sign out' },
    { id: 'backups', title: 'Backups', keywords: 'backup folder schedule' },
    { id: 'webhooks', title: 'Webhooks', keywords: 'notifications push' },
    { id: 'shortcuts', title: 'Shortcuts', keywords: 'keyboard keys' },
    { id: 'about', title: 'About', keywords: 'version uptime database' },
];
export const DEFAULT_SETTINGS_SECTION = 'general';
