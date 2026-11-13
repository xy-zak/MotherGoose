// Package web holds the embedded admin dashboard, player shell, viewers, theme,
// fonts, and the sync script (sync.js and inject.js) added to game pages.
package web

import "embed"

//go:embed theme.css prefs.js tips.js ui.js tour.js fx.js icons.svg icons-LICENSE.txt sync.js inject.js fonts admin shell viewer vendor
var FS embed.FS
