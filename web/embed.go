// Package web holds the embedded admin dashboard, player shell, viewers, theme,
// fonts and the script injected into game pages.
package web

import "embed"

//go:embed theme.css prefs.js tips.js ui.js tour.js icons.svg icons-LICENSE.txt inject.js fonts admin shell viewer vendor
var FS embed.FS
